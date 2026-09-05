import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { applyOperations } from "../src/operations.js";
import { createProject } from "../src/project.js";
import { reconcileCapture } from "../src/reconcile.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "replex-reconcile-"));
  await mkdir(join(root, "captures"), { recursive: true });
  for (const index of [0, 1, 2]) await writeFile(join(root, "captures", `${index}.mp4`), `capture-${index}`);
  const project = createProject({ projectId: "reconcile-project", brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 }, environment: normalEnvironment("http://127.0.0.1:4173"), flow: normalFlow("http://127.0.0.1:4173"), captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 10000, sha256: createHash("sha256").update(`capture-${index}`).digest("hex") })) });
  const edited = applyOperations(project, project.currentRevisionId, [{ type: "set_title", overlay: { id: "agent-title", sceneId: project.scenes[1].id, kind: "title", text: "Results update", placement: "top", startMs: 0, endMs: 2000 } }]);
  if (!edited.ok) throw new Error(edited.detail);
  return { root, project: edited.project };
}

describe("selective recapture reconciliation", () => {
  it("changes only the target capture while retaining stable scene and unrelated agent edits", async () => {
    const { root, project } = await fixture();
    try {
      await writeFile(join(root, "captures", "0-new.mp4"), "replacement");
      const result = reconcileCapture(project, root, { id: "capture-0-new", sceneKey: "open-demo", path: "captures/0-new.mp4", durationMs: 10000, sha256: createHash("sha256").update("replacement").digest("hex"), changedStepIds: [project.scenes[0].checkpointActionId], reason: "known fixture state change" });
      expect(result).toMatchObject({ ok: true, preserved: true });
      if (!result.ok) return;
      expect(result.project.scenes[0]).toMatchObject({ id: project.scenes[0].id, captureId: "capture-0-new" });
      expect(result.project.scenes.slice(1)).toEqual(project.scenes.slice(1));
      expect(result.project.overlays["agent-title"]).toEqual(project.overlays["agent-title"]);
      expect(result.project.recaptureLineage.at(-1)).toMatchObject({ previousCaptureId: "capture-0", replacementCaptureId: "capture-0-new", changedStepIds: [project.scenes[0].checkpointActionId] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a replacement with the wrong durable scene key", async () => {
    const { root, project } = await fixture();
    try {
      const result = reconcileCapture(project, root, { id: "capture-wrong", sceneKey: "wrong-scene", path: "captures/0.mp4", durationMs: 10000, sha256: "a".repeat(64), changedStepIds: [project.scenes[0].checkpointActionId], reason: "bad input" });
      expect(result).toMatchObject({ ok: false, code: "INVALID_RECAPTURE" });
      expect(project.scenes[0].captureId).toBe("capture-0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
