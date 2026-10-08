import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutorServer } from "../../src/service/http.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";
import { scriptedModel } from "../service-fixture.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
type Job = { id: string; kind: string; state: string; result?: { revisionId?: string; assetId?: string; outputId?: string }; error?: { code: string } };

describe("V2 local workflow over the loopback service", () => {
  const roots: string[] = [];
  let server: LocalExecutorServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("imports, edits conversationally twice, and exports a verified final render", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-workflow-workspace-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-workflow-source-"));
    roots.push(workspaceRoot, sourceRoot);
    const sourcePath = join(sourceRoot, "product-demo.mp4");
    const fixture = spawnSync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
    ], { windowsHide: true, shell: false, timeout: 30_000 });
    expect(fixture.status, fixture.stderr?.toString()).toBe(0);

    const crop = { x: 0.1, y: 0.05, width: 0.8, height: 0.9 };
    const { model, inputs, trace } = scriptedModel({
      "Crop toward the product UI.": [{ type: "set_transform", clipId: "demo-clip", transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, crop }],
      "Keep the crop and lower the music.": [{ type: "set_volume", clipId: "demo-clip", audioGainDb: -9 }],
    });
    server = new LocalExecutorServer({ workspaceRoot, importRoots: [sourceRoot], media: { ffmpegPath, ffprobePath }, agentModel: model });
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
      return settle(queued.body as unknown as Job);
    };

    const capabilities = (await request("/capabilities")).body;
    expect(capabilities).toMatchObject({ availableCommands: expect.arrayContaining(["request_agent_edit", "render_preview", "render_final"]) });

    const created = (await request("/projects/create", { contractVersion: "v1", idempotencyKey: "workflow-create", name: "Launch video", brief: { targetDurationMs: 1000 } })).body as { projectId: string; revisionId: string };
    const projectId = created.projectId;
    const authorized = (await request("/local/imports/authorize", { hostContractVersion: "v1", sourcePath })).body as { token: string; filename: string };
    expect(JSON.stringify(authorized)).not.toContain(sourceRoot);

    const imported = await submit("/jobs/import-asset", {
      contractVersion: "v1", idempotencyKey: "workflow-import", projectId, baseRevisionId: created.revisionId,
      source: { kind: "local_token", ref: authorized.token }, declaredFilename: authorized.filename,
    });
    expect(imported.state).toBe("succeeded");
    const placed = await submit("/jobs/apply-operations", {
      contractVersion: "v1", idempotencyKey: "workflow-place", projectId, baseRevisionId: imported.result!.revisionId, actor: "user",
      operations: [{ type: "create_clip", clip: {
        id: "demo-clip", assetId: imported.result!.assetId, trackId: "track-video", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 1000,
        speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false,
      } }],
    });
    expect(placed.state).toBe("succeeded");

    const thread = { threadId: "launch-thread", preview: true };
    const first = await submit("/jobs/agent-edit", {
      contractVersion: "v1", idempotencyKey: "workflow-agent-1", projectId, baseRevisionId: placed.result!.revisionId, prompt: "Crop toward the product UI.", ...thread,
    });
    expect(first, trace()).toMatchObject({ kind: "agent_edit", state: "succeeded", result: { outputId: expect.any(String) } });
    const second = await submit("/jobs/agent-edit", {
      contractVersion: "v1", idempotencyKey: "workflow-agent-2", projectId, baseRevisionId: first.result!.revisionId, prompt: "Keep the crop and lower the music.", ...thread,
    });
    expect(second, trace()).toMatchObject({ state: "succeeded", result: { outputId: expect.any(String) } });
    expect(inputs.find(({ prompt }) => prompt === "Keep the crop and lower the music.")?.previousResponseId).toBeTruthy();

    const finalRevisionId = second.result!.revisionId!;
    const snapshot = (await request("/projects/open", { contractVersion: "v1", idempotencyKey: "workflow-open", projectId, revisionId: finalRevisionId })).body as {
      composition: { clips: Array<Record<string, unknown>> };
      revisions: Array<{ actor: string }>;
      verification: { status: string; refs: Array<{ id: string; revisionId: string; status: string }> };
    };
    expect(snapshot.composition.clips[0]).toMatchObject({ crop, audioGainDb: -9 });
    expect(snapshot.revisions.map(({ actor }) => actor)).toEqual(["user", "user", "user", "agent", "agent"]);
    const verificationRef = snapshot.verification.refs.find((ref) => ref.revisionId === finalRevisionId && ref.status === "passed")!;
    expect(verificationRef).toBeTruthy();

    const final = await submit("/jobs/render-final", { contractVersion: "v1", idempotencyKey: "workflow-final", projectId, revisionId: finalRevisionId, verificationRefId: verificationRef.id });
    expect(final).toMatchObject({ kind: "render_final", state: "succeeded", result: { revisionId: finalRevisionId, outputId: expect.any(String) } });

    const events = (await request(`/projects/${projectId}/events`)).body as { events: Array<{ type: string; artifact?: { outputId: string; ref: string; sha256: string; probe: { durationMs: number } } }> };
    const exported = events.events.find((event) => event.type === "render_artifact.created" && event.artifact?.outputId === final.result!.outputId)?.artifact;
    expect(exported).toBeTruthy();
    const bytes = await readFile(join(workspaceRoot, "projects", sha256(projectId), ...exported!.ref.split("/")));
    expect(sha256(bytes)).toBe(exported!.sha256);
    expect(exported!.probe.durationMs).toBeGreaterThan(900);
  }, 600_000);
});
