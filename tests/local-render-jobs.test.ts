import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mediaAvailable } from "./media.js";
import { projectWithClip } from "./service-fixture.js";

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

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
