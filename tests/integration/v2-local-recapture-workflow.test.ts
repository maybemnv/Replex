import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutorServer } from "../../src/service/http.js";
import { seedBrowserProject, startReleaseFixture, TARGET_CLIP_MS } from "../browser-fixture.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
type Job = { id: string; kind: string; state: string; result?: { revisionId?: string; assetId?: string; outputId?: string }; error?: { code: string } };

describe("V2 local selective recapture over the loopback service", () => {
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("recaptures one browser scene in a mixed project and renders the recaptured revision", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-recapture-workflow-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-recapture-source-"));
    roots.push(workspaceRoot, sourceRoot);
    // The initial browser capture is seeded through the store: start_browser_capture is not an executor job.
    const seeded = await seedBrowserProject(roots, workspaceRoot, fixture, "project-recapture-workflow");
    const projectId = seeded.project.projectId;
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
      return settle(queued.body as unknown as Job);
    };

    expect((await request("/capabilities")).body).toMatchObject({ availableCommands: expect.arrayContaining(["recapture_browser_scene"]), jobKinds: expect.arrayContaining(["browser_recapture"]) });

    const authorized = (await request("/local/imports/authorize", { hostContractVersion: "v1", sourcePath })).body as { token: string; filename: string };
    const imported = await submit("/jobs/import-asset", {
      contractVersion: "v1", idempotencyKey: "recapture-workflow-import", projectId, baseRevisionId: seeded.revisionId,
      source: { kind: "local_token", ref: authorized.token }, declaredFilename: authorized.filename,
    });
    expect(imported, JSON.stringify(imported)).toMatchObject({ state: "succeeded" });
    const placed = await submit("/jobs/apply-operations", {
      contractVersion: "v1", idempotencyKey: "recapture-workflow-place", projectId, baseRevisionId: imported.result!.revisionId, actor: "user",
      operations: [{ type: "create_clip", clip: {
        id: "clip-upload", assetId: imported.result!.assetId, trackId: "track-video", timelineStartMs: TARGET_CLIP_MS, sourceInMs: 0, sourceOutMs: 1000,
        speed: 1, transform: { x: 0, y: 0, scale: 1.05, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: -2, muted: false,
      } }],
    });
    expect(placed, JSON.stringify(placed)).toMatchObject({ state: "succeeded" });
    const before = (await request("/projects/open", { contractVersion: "v1", idempotencyKey: "recapture-workflow-open-before", projectId, revisionId: placed.result!.revisionId })).body as {
      assets: Array<{ id: string; sha256: string }>;
    };

    fixture.setNote("Release note: filters v2");
    const recaptured = await submit("/jobs/recapture-browser-scene", {
      contractVersion: "v1", idempotencyKey: "recapture-workflow-recapture", projectId, baseRevisionId: placed.result!.revisionId,
      assetId: seeded.targetAsset.id, changedActionIds: ["apply-filter"], reason: "The release note changed", executionTarget: "local",
    });
    expect(recaptured, JSON.stringify(recaptured)).toMatchObject({ kind: "browser_recapture", state: "succeeded", result: { revisionId: expect.any(String), assetId: expect.any(String) } });
    const revisionId = recaptured.result!.revisionId!;
    const replacementId = recaptured.result!.assetId!;

    const after = (await request("/projects/open", { contractVersion: "v1", idempotencyKey: "recapture-workflow-open-after", projectId, revisionId })).body as {
      assets: Array<{ id: string; sha256: string }>;
    };
    // Every prior asset, including the replaced capture and the upload, is retained byte-identically; one asset is added.
    expect(after.assets.filter(({ id }) => id !== replacementId)).toEqual(before.assets);
    expect(after.assets).toHaveLength(before.assets.length + 1);

    const preview = await submit("/jobs/render-preview", { contractVersion: "v1", idempotencyKey: "recapture-workflow-preview", projectId, revisionId });
    expect(preview, JSON.stringify(preview)).toMatchObject({ state: "succeeded", result: { revisionId, outputId: expect.any(String) } });
    const rendered = (await request("/projects/open", { contractVersion: "v1", idempotencyKey: "recapture-workflow-open-rendered", projectId, revisionId })).body as {
      verification: { status: string }; renderArtifacts: Array<{ outputId: string; ref: string; sha256: string }>;
    };
    expect(rendered.verification.status).toBe("passed");
    const artifact = rendered.renderArtifacts.find(({ outputId }) => outputId === preview.result!.outputId)!;
    expect(sha256(await readFile(join(seeded.projectRoot, ...artifact.ref.split("/"))))).toBe(artifact.sha256);

    const events = (await request(`/projects/${projectId}/events`)).body as { events: Array<{ type: string; revision?: { id: string; actor?: string } }> };
    expect(events.events.some((event) => event.type === "revision.created" && event.revision?.id === revisionId)).toBe(true);
  }, 300_000);
});
