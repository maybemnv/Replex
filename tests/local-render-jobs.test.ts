import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/service/executor.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

/** Shared real-media setup: a 1s fixture imported and placed on the video track. */
export async function projectWithClip(roots: string[], prefix: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `${prefix}-workspace-`));
  const sourceRoot = await mkdtemp(join(tmpdir(), `${prefix}-source-`));
  roots.push(workspaceRoot, sourceRoot);
  const sourcePath = join(sourceRoot, "walkthrough.mp4");
  const fixture = spawnSync(ffmpegPath, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
  ], { windowsHide: true, shell: false, timeout: 30_000 });
  expect(fixture.status, fixture.stderr?.toString()).toBe(0);

  const executor = new LocalExecutor({ workspaceRoot, media: { ffmpegPath, ffprobePath } });
  await executor.start();
  const project = await executor.createProject({ contractVersion: "v1", idempotencyKey: `${prefix}-create`, name: "Render jobs", brief: { targetDurationMs: 1000 } });
  const source = await executor.authorizeLocalImport(sourcePath, [sourceRoot]);
  const imported = await executor.waitForJob((await executor.submitImportAsset({
    contractVersion: "v1", idempotencyKey: `${prefix}-import`, projectId: project.projectId, baseRevisionId: project.revisionId,
    source: { kind: "local_token", ref: source.token }, declaredFilename: source.filename,
  })).id, 60_000);
  if (imported.state !== "succeeded") throw new Error("fixture import failed: " + JSON.stringify(imported));
  const placed = await executor.waitForJob((await executor.submitApplyOperations({
    contractVersion: "v1", idempotencyKey: `${prefix}-place`, projectId: project.projectId, baseRevisionId: imported.result.revisionId!, actor: "user",
    operations: [{ type: "create_clip", clip: {
      id: "clip-walkthrough", assetId: imported.result.assetId!, trackId: "track-video", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 1000,
      speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false,
    } }],
  })).id, 30_000);
  if (placed.state !== "succeeded") throw new Error("fixture clip failed: " + JSON.stringify(placed));
  return { executor, workspaceRoot, projectId: project.projectId, revisionId: placed.result.revisionId!, assetId: imported.result.assetId! };
}

describe("local render jobs", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("renders a verified preview, gates the final render, and rejects stale pins", async () => {
    const { executor, workspaceRoot, projectId, revisionId } = await projectWithClip(roots, "replex-render-jobs");
    try {
      const pin = { contractVersion: "v1" as const, projectId, revisionId };
      const submitted = await executor.submitRenderPreview({ ...pin, idempotencyKey: "preview-1" });
      expect(submitted).toMatchObject({ kind: "render_preview", state: "queued", revisionId });
      expect((await executor.submitRenderPreview({ ...pin, idempotencyKey: "preview-1" })).id).toBe(submitted.id);

      const preview = await executor.waitForJob(submitted.id, 120_000);
      expect(preview, JSON.stringify(preview)).toMatchObject({ state: "succeeded", result: { revisionId, outputId: expect.any(String) } });
      if (preview.state !== "succeeded") throw new Error("preview failed");

      const snapshot = await executor.openProject({ ...pin, idempotencyKey: "open-after-preview" });
      expect(snapshot.verification).toMatchObject({ revisionId, status: "passed" });
      const artifact = snapshot.renderArtifacts.find(({ outputId }) => outputId === preview.result.outputId)!;
      expect(artifact).toBeTruthy();
      const projectDirectory = join(workspaceRoot, "projects", createHash("sha256").update(projectId).digest("hex"));
      expect(sha256(await readFile(join(projectDirectory, ...artifact.ref.split("/"))))).toBe(artifact.sha256);

      const events = await executor.eventsAfter(projectId);
      expect(events.events.some((event) => event.type === "render_artifact.created" && event.artifact.outputId === artifact.outputId)).toBe(true);

      const ungated = await executor.waitForJob((await executor.submitRenderFinal({ ...pin, idempotencyKey: "final-ungated", verificationRefId: "verification-missing" })).id, 30_000);
      expect(ungated).toMatchObject({ state: "failed", error: { code: "VERIFICATION_FAILED" } });

      const final = await executor.waitForJob((await executor.submitRenderFinal({ ...pin, idempotencyKey: "final-1", verificationRefId: artifact.verificationRefId })).id, 120_000);
      expect(final, JSON.stringify(final)).toMatchObject({ state: "succeeded", kind: "render_final", result: { revisionId, outputId: expect.any(String) } });

      const edited = await executor.waitForJob((await executor.submitApplyOperations({
        contractVersion: "v1", idempotencyKey: "mute-after-render", projectId, baseRevisionId: revisionId, actor: "user",
        operations: [{ type: "mute_clip", clipId: "clip-walkthrough", muted: true }],
      })).id, 30_000);
      expect(edited.state).toBe("succeeded");
      const stale = await executor.waitForJob((await executor.submitRenderPreview({ ...pin, idempotencyKey: "preview-stale" })).id, 30_000);
      expect(stale).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT" } });
    } finally {
      await executor.stop();
    }
  }, 300_000);
});
