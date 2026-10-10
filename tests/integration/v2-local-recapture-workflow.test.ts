import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutorServer } from "../../src/service/http.js";
import { startReleaseFixture, TARGET_CLIP_MS } from "../browser-fixture.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
type Job = { id: string; kind: string; state: string; result?: { revisionId?: string; assetId?: string; outputId?: string }; error?: { code: string } };
type Snapshot = {
  assets: Array<{ id: string; type: string; sha256: string; provenance: { kind: string; sceneKey?: string } }>;
  composition: { clips: Array<{ id: string; assetId: string }>; layers: unknown[] };
  verification: { status: string; refs: Array<{ id: string; status: string }> };
  renderArtifacts: Array<{ outputId: string; ref: string; sha256: string }>;
};
const clip = (id: string, assetId: string, timelineStartMs: number, sourceOutMs: number, scale = 1) => ({
  id, assetId, trackId: "track-video", timelineStartMs, sourceInMs: 0, sourceOutMs,
  speed: 1, transform: { x: 0, y: 0, scale, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false,
});

describe("V2 local capture and selective recapture over the loopback service", () => {
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("captures, composes with an upload, recaptures one scene, verifies, and exports a final render", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-capture-workflow-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-capture-source-"));
    roots.push(workspaceRoot, sourceRoot);
    const sourcePath = join(sourceRoot, "walkthrough.mp4");
    const upload = spawnSync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
    ], { windowsHide: true, shell: false, timeout: 30_000 });
    expect(upload.status, upload.stderr?.toString()).toBe(0);

    const server = new LocalExecutorServer({ workspaceRoot, importRoots: [sourceRoot], media: { ffmpegPath, ffprobePath }, browserTargets: fixture.browserTargets });
    closers.unshift(() => server.stop());
    const session = await server.start();
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(session.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const settle = async (job: Job): Promise<Job> => {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const current = (await request(`/jobs/${job.id}`)).body as Job;
        if (["succeeded", "failed", "cancelled"].includes(current.state)) return current;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error(`job ${job.id} did not settle`);
    };
    const submit = async (path: string, body: unknown): Promise<Job> => {
      const queued = await request(path, body);
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      const settled = await settle(queued.body as unknown as Job);
      expect(settled, JSON.stringify(settled)).toMatchObject({ state: "succeeded" });
      return settled;
    };
    const open = async (projectId: string, revisionId: string, key: string) =>
      (await request("/projects/open", { contractVersion: "v1", idempotencyKey: key, projectId, revisionId })).body as unknown as Snapshot;

    expect((await request("/capabilities")).body).toMatchObject({
      availableCommands: expect.arrayContaining(["start_browser_capture", "recapture_browser_scene", "verify_revision", "render_final"]),
      jobKinds: expect.arrayContaining(["browser_capture", "browser_recapture", "verify_revision"]),
    });
    const created = (await request("/projects/create", { contractVersion: "v1", idempotencyKey: "capture-workflow-create", name: "Release video", brief: { targetDurationMs: TARGET_CLIP_MS + 1000 } })).body as { projectId: string; revisionId: string };
    const projectId = created.projectId;

    // 1. Capture the approved flow into immutable scene assets.
    const captured = await submit("/jobs/start-browser-capture", {
      contractVersion: "v1", idempotencyKey: "capture-workflow-capture", projectId, baseRevisionId: created.revisionId,
      flowId: fixture.flow.id, approved: true, executionTarget: "local",
    });
    const scenes = (await open(projectId, captured.result!.revisionId!, "capture-workflow-open-captured")).assets.filter(({ type }) => type === "browser_capture");
    const target = scenes.find(({ provenance }) => provenance.sceneKey === "apply-filter")!;
    expect(scenes).toHaveLength(3);

    // 2. Compose the target scene with an uploaded clip and a title.
    const authorized = (await request("/local/imports/authorize", { hostContractVersion: "v1", sourcePath })).body as { token: string; filename: string };
    const imported = await submit("/jobs/import-asset", {
      contractVersion: "v1", idempotencyKey: "capture-workflow-import", projectId, baseRevisionId: captured.result!.revisionId,
      source: { kind: "local_token", ref: authorized.token }, declaredFilename: authorized.filename,
    });
    const composed = await submit("/jobs/apply-operations", {
      contractVersion: "v1", idempotencyKey: "capture-workflow-compose", projectId, baseRevisionId: imported.result!.revisionId, actor: "user",
      operations: [
        { type: "create_clip", clip: clip("clip-browser", target.id, 0, TARGET_CLIP_MS) },
        { type: "create_clip", clip: clip("clip-upload", imported.result!.assetId!, TARGET_CLIP_MS, 1000, 1.05) },
        { type: "add_text_layer", layer: { id: "layer-title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 400, properties: { text: "Release filters", fontSize: 36 }, keyframes: [] } },
      ],
    });
    const before = await open(projectId, composed.result!.revisionId!, "capture-workflow-open-before");

    // 3. The product changes; recapture only the affected scene.
    fixture.setNote("Release note: filters v2");
    const recaptured = await submit("/jobs/recapture-browser-scene", {
      contractVersion: "v1", idempotencyKey: "capture-workflow-recapture", projectId, baseRevisionId: composed.result!.revisionId,
      assetId: target.id, changedActionIds: ["apply-filter"], reason: "The release note changed", executionTarget: "local",
    });
    const revisionId = recaptured.result!.revisionId!;
    const replacementId = recaptured.result!.assetId!;
    const after = await open(projectId, revisionId, "capture-workflow-open-after");
    expect(after.assets.filter(({ id }) => id !== replacementId)).toEqual(before.assets);
    expect(after.assets).toHaveLength(before.assets.length + 1);
    expect(after.composition.clips.find(({ id }) => id === "clip-browser")!.assetId).toBe(replacementId);
    expect(after.composition.clips.filter(({ id }) => id !== "clip-browser")).toEqual(before.composition.clips.filter(({ id }) => id !== "clip-browser"));
    expect(after.composition.layers).toEqual(before.composition.layers);

    // 4. Verify the recaptured revision and export a final render gated on that verification.
    await submit("/jobs/verify-revision", { contractVersion: "v1", idempotencyKey: "capture-workflow-verify", projectId, revisionId });
    const verifiedSnapshot = await open(projectId, revisionId, "capture-workflow-open-verified");
    expect(verifiedSnapshot.verification.status).toBe("passed");
    const verificationRefId = verifiedSnapshot.verification.refs.at(-1)!.id;
    const final = await submit("/jobs/render-final", { contractVersion: "v1", idempotencyKey: "capture-workflow-final", projectId, revisionId, verificationRefId });
    const exported = await open(projectId, revisionId, "capture-workflow-open-exported");
    const artifact = exported.renderArtifacts.find(({ outputId }) => outputId === final.result!.outputId)!;
    const projectRoot = join(workspaceRoot, "projects", sha256(projectId));
    expect(sha256(await readFile(join(projectRoot, ...artifact.ref.split("/"))))).toBe(artifact.sha256);

    const events = (await request(`/projects/${projectId}/events`)).body as { events: Array<{ type: string; revision?: { id: string } }> };
    const types = events.events.map(({ type }) => type);
    expect(types).toEqual(expect.arrayContaining(["revision.created", "verification.updated", "render_artifact.created"]));
    expect(events.events.some((event) => event.type === "revision.created" && event.revision?.id === revisionId)).toBe(true);
  }, 300_000);
});
