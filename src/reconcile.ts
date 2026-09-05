import type { Capture, Project } from "./schema.js";
import { applyOperations } from "./operations.js";

export interface RecaptureInput {
  id: string;
  sceneKey: string;
  path: string;
  sha256: string;
  durationMs: number;
  changedStepIds: string[];
  reason: string;
}

export type ReconcileResult =
  | { ok: true; project: Project; preserved: true }
  | { ok: false; code: "INVALID_RECAPTURE" | "PRESERVATION_MISMATCH"; detail: string };

/** Applies one verified capture replacement and proves all unrelated scene semantics stayed intact. */
export function reconcileCapture(project: Project, root: string, input: RecaptureInput): ReconcileResult {
  const target = project.scenes.find((scene) => scene.sceneKey === input.sceneKey);
  if (!target) return { ok: false, code: "INVALID_RECAPTURE", detail: "recapture scene key does not exist" };
  const previous = project.captures[target.captureId];
  if (!previous || input.id === previous.id || input.durationMs <= 0 || !input.changedStepIds.length) return { ok: false, code: "INVALID_RECAPTURE", detail: "recapture metadata is incomplete" };
  const expectedSteps = new Set(target.actionIds);
  if (input.changedStepIds.some((id) => !expectedSteps.has(id))) return { ok: false, code: "INVALID_RECAPTURE", detail: "changed steps must belong to the target scene" };
  const replacement: Capture = {
    ...previous,
    id: input.id,
    sceneKey: input.sceneKey,
    path: input.path,
    sha256: input.sha256,
    durationMs: input.durationMs,
    predecessorId: previous.id,
  };
  const before = unaffectedProjection(project, target.id);
  const withCapture: Project = { ...project, captures: { ...project.captures, [replacement.id]: replacement } };
  const mutation = applyOperations(withCapture, withCapture.currentRevisionId, [{ type: "replace_capture", sceneId: target.id, captureId: replacement.id, reason: input.reason }], { actor: "recapture", root });
  if (!mutation.ok) return { ok: false, code: "INVALID_RECAPTURE", detail: mutation.detail };
  if (unaffectedProjection(mutation.project, target.id) !== before) return { ok: false, code: "PRESERVATION_MISMATCH", detail: "unaffected scene, overlay, or capture semantics changed" };
  return { ok: true, project: mutation.project, preserved: true };
}

function unaffectedProjection(project: Project, targetSceneId: string): string {
  const targetSceneKey = project.scenes.find((scene) => scene.id === targetSceneId)?.sceneKey;
  const value = {
    scenes: project.scenes.filter((scene) => scene.id !== targetSceneId),
    overlays: Object.values(project.overlays).filter((overlay) => overlay.sceneId !== targetSceneId),
    captures: Object.values(project.captures).filter((capture) => capture.sceneKey !== targetSceneKey),
  };
  return JSON.stringify(value);
}
