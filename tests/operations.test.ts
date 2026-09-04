import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { applyOperations } from "../src/operations.js";
import { createProject } from "../src/project.js";

function project() {
  return createProject({
    projectId: "operation-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment("http://127.0.0.1:4173"),
    flow: normalFlow("http://127.0.0.1:4173"),
    captures: [
      { id: "capture-open", sceneKey: "open-demo", sourcePath: "captures/open.webm", durationMs: 10000 },
      { id: "capture-filter", sceneKey: "open-filter", sourcePath: "captures/filter.webm", durationMs: 10000 },
      { id: "capture-apply", sceneKey: "apply-filter", sourcePath: "captures/apply.webm", durationMs: 10000 },
    ],
  });
}

describe("operation reducer", () => {
  it("reorders the exact scene set into a new deterministic revision", () => {
    const source = project();
    const sceneIds = source.scenes.map((scene) => scene.id).reverse();
    const result = applyOperations(source, source.currentRevisionId, [{ type: "reorder_scene", sceneIds }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.scenes.map((scene) => scene.id)).toEqual(sceneIds);
    expect(result.project.currentRevisionId).not.toBe(source.currentRevisionId);
    expect(source.scenes.map((scene) => scene.id)).not.toEqual(sceneIds);
  });

  it("rejects stale revisions and invalid trim ranges without mutating the source", () => {
    const source = project();
    const stale = applyOperations(source, "revision-stale", []);
    const invalid = applyOperations(source, source.currentRevisionId, [
      { type: "trim_scene", sceneId: source.scenes[0].id, sourceInMs: 9000, sourceOutMs: 1000 },
    ]);

    expect(stale).toMatchObject({ ok: false, code: "STALE_REVISION" });
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
    expect(source.scenes[0]).not.toHaveProperty("sourceInMs");
  });
});
