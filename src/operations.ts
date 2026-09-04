import { semanticHash, type Project } from "./project.js";

export type EditOperation =
  | { type: "reorder_scene"; sceneIds: string[] }
  | { type: "trim_scene"; sceneId: string; sourceInMs: number; sourceOutMs: number };

export type OperationResult =
  | { ok: true; project: Project }
  | { ok: false; code: "STALE_REVISION" | "INVALID_OPERATION"; detail: string };

export function applyOperations(project: Project, baseRevisionId: string, operations: EditOperation[]): OperationResult {
  if (baseRevisionId !== project.currentRevisionId) {
    return { ok: false, code: "STALE_REVISION", detail: "base revision is not current" };
  }

  const next = structuredClone(project) as Project;
  for (const operation of operations) {
    const error = apply(next, operation);
    if (error) return { ok: false, code: "INVALID_OPERATION", detail: error };
  }

  const revisionId = `revision-${semanticHash(next).slice(0, 16)}`;
  next.currentRevisionId = revisionId;
  next.revision = { id: revisionId, manifestSha256: semanticHash(next) };
  return { ok: true, project: next };
}

function apply(project: Project, operation: EditOperation): string | undefined {
  if (operation.type === "reorder_scene") {
    const expected = new Set(project.scenes.map((scene) => scene.id));
    if (operation.sceneIds.length !== expected.size || operation.sceneIds.some((id) => !expected.delete(id))) {
      return "reorder must contain every scene exactly once";
    }
    project.scenes = operation.sceneIds.map((id) => project.scenes.find((scene) => scene.id === id)!);
    return;
  }

  const scene = project.scenes.find((candidate) => candidate.id === operation.sceneId);
  const capture = project.captures.find((candidate) => candidate.id === scene?.captureId);
  if (!scene || !capture || !Number.isInteger(operation.sourceInMs) || !Number.isInteger(operation.sourceOutMs)) {
    return "scene, capture, and millisecond bounds are required";
  }
  if (operation.sourceInMs < 0 || operation.sourceOutMs <= operation.sourceInMs || operation.sourceOutMs > capture.durationMs) {
    return "trim range is outside the source capture";
  }
  Object.assign(scene, { sourceInMs: operation.sourceInMs, sourceOutMs: operation.sourceOutMs });
}
