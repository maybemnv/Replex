import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenAIV2ModelClientFromEnv } from "../agent-v2-openai.js";
import { LocalExecutorServer } from "../service/http.js";
import { LocalProjectStore } from "../service/project-store.js";
import { JobViewSchema, ProjectCreatedResponseSchema, ProjectSnapshotSchema, type JobView, type ProjectSnapshot } from "../service-contract/index.js";
import { LocalImportAuthorizationResponseV1Schema } from "../service-contract/local-host-v1.js";
import { startDemoFixture } from "./fixture.js";
import { checkDemoPrerequisites } from "./preflight.js";
import { createDemoScriptedModel } from "./scripted-model.js";

export interface DemoOptions {
  workspaceRoot: string;
  liveModel?: string;
  signal?: AbortSignal;
  progress?: (stage: string) => void;
}

async function sourceVideo(ffmpeg: string, path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ], { shell: false, windowsHide: true, stdio: "ignore", signal });
    let failed = false;
    const timeout = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 30_000);
    child.on("error", () => { failed = true; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (!failed && code === 0 && !signal.aborted) resolveDone();
      else reject(new Error("Demo could not generate its local sample footage."));
    });
  });
}

const clip = (id: string, assetId: string, timelineStartMs: number) => ({
  id, assetId, trackId: "track-video", timelineStartMs, sourceInMs: 0, sourceOutMs: 3000, speed: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false,
});

/** Runs the actual authenticated HTTP workflow and returns a local session; never exposes remote hosting. */
export async function startLocalDemo(options: DemoOptions) {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const media = checkDemoPrerequisites();
  const workspaceRoot = resolve(options.workspaceRoot);
  // An existing provider key alone never selects live mode.
  const model = options.liveModel ? createOpenAIV2ModelClientFromEnv(options.liveModel, workspaceRoot) : createDemoScriptedModel();
  const runId = randomUUID();
  const key = (stage: string) => `demo-${runId}-${stage}`;
  const sourceRoot = await mkdtemp(join(tmpdir(), "replex-demo-source-"));
  let fixture: Awaited<ReturnType<typeof startDemoFixture>> | undefined;
  let server: LocalExecutorServer | undefined;
  let closing: Promise<void> | undefined;
  const stopOnAbort = () => { void close().catch(() => undefined); };
  const close = () => closing ??= (async () => {
    signal.removeEventListener("abort", stopOnAbort);
    try { await server?.stop(); }
    finally { try { await fixture?.close(); } finally { await rm(sourceRoot, { recursive: true, force: true }); } }
  })();

  try {
    options.progress?.("preparing_local_media");
    const sourcePath = join(sourceRoot, "demo-upload.mp4");
    await sourceVideo(media.ffmpegPath, sourcePath, signal);
    fixture = await startDemoFixture();
    signal.throwIfAborted();
    server = new LocalExecutorServer({ workspaceRoot, importRoots: [sourceRoot], media, agentModel: model,
      browserTargets: fixture.browserTargets, fixtureGrants: fixture.fixtureGrants });
    const session = await server.start();
    signal.throwIfAborted();
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(session.url + path, {
        method: body === undefined ? "GET" : "POST", signal,
        headers: { authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("The local demo request was rejected; inspect the retained workspace job records."); }
      return response.json();
    };
    const submit = async (path: string, body: unknown): Promise<Extract<JobView, { state: "succeeded" }>> => {
      let job = JobViewSchema.parse(await request(path, body));
      const started = Date.now();
      while (!["succeeded", "failed", "cancelled"].includes(job.state)) {
        if (Date.now() - started > 180_000) throw new Error("The demo job exceeded its local wait limit.");
        await delay(100, undefined, { signal });
        job = JobViewSchema.parse(await request(`/jobs/${job.id}`));
      }
      if (job.state !== "succeeded") throw new Error(`The demo ${job.kind} job failed (${"error" in job ? job.error.code : "CANCELLATION"}); inspect the retained workspace job records.`);
      return job;
    };
    const created = ProjectCreatedResponseSchema.parse(await request("/projects/create", {
      contractVersion: "v1", idempotencyKey: key("create"), name: "Replex local demo", brief: { targetDurationMs: 6000 },
    }));
    const projectId = created.projectId;
    let revisionId = created.revisionId;
    const meta = (stage: string) => ({ contractVersion: "v1", idempotencyKey: key(stage), projectId });
    const open = async (): Promise<ProjectSnapshot> => ProjectSnapshotSchema.parse(await request("/projects/open", { ...meta("open"), revisionId }));
    options.progress?.("capturing");
    const captured = await submit("/jobs/start-browser-capture", { ...meta("capture"), baseRevisionId: revisionId,
      flowId: fixture.flow.id, approved: true, executionTarget: "local" });
    revisionId = captured.result.revisionId!;
    const scene = (await open()).assets.find((asset) => asset.type === "browser_capture" && asset.provenance.kind === "browser" && asset.provenance.sceneKey === "apply-filter");
    if (!scene) throw new Error("Demo browser scene is missing.");

    options.progress?.("importing");
    const authorized = LocalImportAuthorizationResponseV1Schema.parse(await request("/local/imports/authorize", { hostContractVersion: "v1", sourcePath }));
    const imported = await submit("/jobs/import-asset", { ...meta("import"), baseRevisionId: revisionId,
      source: { kind: "local_token", ref: authorized.token }, declaredFilename: authorized.filename });
    revisionId = imported.result.revisionId!;
    const composed = await submit("/jobs/apply-operations", { ...meta("compose"), baseRevisionId: revisionId, actor: "user", operations: [
      { type: "create_clip", clip: clip("demo-browser", scene.id, 0) },
      { type: "create_clip", clip: clip("demo-upload", imported.result.assetId!, 3000) },
      { type: "add_text_layer", layer: { id: "demo-title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 3000,
        properties: { text: "Your next release.", fontSize: 36, color: "#ffffff" }, keyframes: [] } },
    ] });
    revisionId = composed.result.revisionId!;

    options.progress?.(options.liveModel ? "live_agent_edit" : "scripted_agent_edit");
    const edited = await submit("/jobs/agent-edit", { ...meta("agent"), baseRevisionId: revisionId,
      prompt: 'Inspect the browser footage and change the existing demo-title text to "Ship the change." Keep its size/color and every clip unchanged. Produce a verified preview.',
      selectedAssetIds: [scene.id], selectedClipIds: ["demo-browser"], preview: true });
    revisionId = edited.result.revisionId!;
    // A live no-op turn can legitimately succeed without a preview; request one through the same job envelope.
    let previewOutputId = edited.result.outputId;
    if (!previewOutputId) previewOutputId = (await submit("/jobs/render-preview", { ...meta("preview"), revisionId })).result.outputId;
    const before = await open();

    options.progress?.("recapturing_changed_scene");
    fixture.change();
    const recaptured = await submit("/jobs/recapture-browser-scene", { ...meta("recapture"), baseRevisionId: revisionId,
      assetId: scene.id, changedActionIds: ["apply-filter"], reason: "The bundled fake product release note changed", executionTarget: "local" });
    revisionId = recaptured.result.revisionId!;
    const after = await open();
    const expectedClips = before.composition.clips.map((item) => item.assetId === scene.id ? { ...item, assetId: recaptured.result.assetId } : item);
    const preserved = JSON.stringify(after.assets.filter((item) => item.id !== recaptured.result.assetId)) === JSON.stringify(before.assets)
      && JSON.stringify(after.composition.clips) === JSON.stringify(expectedClips)
      && JSON.stringify(after.composition.layers) === JSON.stringify(before.composition.layers);
    if (!preserved) throw new Error("The local demo preservation check failed.");

    options.progress?.("verifying");
    await submit("/jobs/verify-revision", { ...meta("verify"), revisionId });
    const verified = await open();
    const verification = [...verified.verification.refs].reverse().find((ref) => ref.status === "passed" && ref.revisionId === revisionId);
    if (!verification) throw new Error("The demo revision has no passed verification.");
    options.progress?.("rendering_final");
    const rendered = await submit("/jobs/render-final", { ...meta("final"), revisionId, verificationRefId: verification.id });
    const exported = await open();
    const projectRoot = await new LocalProjectStore(workspaceRoot).projectRoot(projectId);
    const localArtifact = (outputId: string | undefined) => {
      // Public snapshots expose artifacts for their selected revision. Keep the pre-recapture preview view.
      const artifact = [...before.renderArtifacts, ...exported.renderArtifacts].find((item) => item.outputId === outputId);
      if (!artifact) throw new Error("Demo render artifact is missing.");
      const path = resolve(projectRoot, artifact.ref);
      const relation = relative(projectRoot, path);
      if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("Demo render artifact is outside its project.");
      return path;
    };
    const result = {
      mode: options.liveModel ? "live" as const : "scripted" as const, projectId, revisionId, previewRevisionId: before.revisionId, preservationPassed: preserved,
      previewPath: localArtifact(previewOutputId), finalPath: localArtifact(rendered.result.outputId),
      url: session.url, bearerToken: session.token, workspaceRoot,
    };
    signal.addEventListener("abort", stopOnAbort, { once: true });
    signal.throwIfAborted();
    return { ...result, close };
  } catch (error) { await close(); throw error; }
}
