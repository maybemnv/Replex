import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { probeVideo } from "./capture.js";
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
  ffprobePath?: string;
}

export type ReconcileResult =
  | { ok: true; project: Project; preserved: true }
  | { ok: false; code: "INVALID_RECAPTURE" | "PRESERVATION_MISMATCH" | "PERSISTENCE_ERROR"; detail: string };

/** Applies one verified capture replacement and proves all unrelated scene semantics stayed intact. */
export function reconcileCapture(project: Project, root: string, input: RecaptureInput): ReconcileResult {
  const target = project.scenes.find((scene) => scene.sceneKey === input.sceneKey);
  if (!target) return { ok: false, code: "INVALID_RECAPTURE", detail: "recapture scene key does not exist" };
  const previous = project.captures[target.captureId];
  if (!previous || input.id === previous.id || input.durationMs <= 0 || !input.changedStepIds.length) return { ok: false, code: "INVALID_RECAPTURE", detail: "recapture metadata is incomplete" };
  const sourcePath = safePath(root, input.path);
  if (!sourcePath || !existsSync(sourcePath) || createHash("sha256").update(readFileSync(sourcePath)).digest("hex") !== input.sha256) return { ok: false, code: "INVALID_RECAPTURE", detail: "replacement capture is missing or does not match its SHA-256" };
  let media: ReturnType<typeof probeVideo>;
  try {
    media = probeVideo(input.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe", sourcePath);
  } catch (error) {
    return { ok: false, code: "INVALID_RECAPTURE", detail: `replacement capture media probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const mediaDurationMs = Math.round(media.durationSeconds * 1000);
  if (Math.abs(mediaDurationMs - input.durationMs) > 100) return { ok: false, code: "INVALID_RECAPTURE", detail: "replacement capture duration does not match its probed media" };
  if (media.width !== previous.width || media.height !== previous.height || Math.abs(media.fps - previous.fps) > 0.01) {
    return { ok: false, code: "INVALID_RECAPTURE", detail: "replacement capture dimensions or frame rate are incompatible" };
  }
  const expectedSteps = new Set(target.actionIds);
  if (input.changedStepIds.some((id) => !expectedSteps.has(id))) return { ok: false, code: "INVALID_RECAPTURE", detail: "changed steps must belong to the target scene" };
  const replacement: Capture = {
    ...previous,
    id: input.id,
    sceneKey: input.sceneKey,
    path: input.path,
    sha256: input.sha256,
    durationMs: mediaDurationMs,
    predecessorId: previous.id,
  };
  let beforeOperations: unknown[];
  try {
    beforeOperations = readOperationRecords(root);
  } catch (error) {
    return { ok: false, code: "INVALID_RECAPTURE", detail: `operation log cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const before = unaffectedProjection(project, target.id, beforeOperations);
  const withCapture: Project = { ...project, captures: { ...project.captures, [replacement.id]: replacement } };
  const operation = [{ type: "replace_capture" as const, sceneId: target.id, captureId: replacement.id, changedStepIds: input.changedStepIds, reason: input.reason }];
  const mutation = applyOperations(withCapture, withCapture.currentRevisionId, operation, { actor: "recapture" });
  if (!mutation.ok) return { ok: false, code: "INVALID_RECAPTURE", detail: mutation.detail };
  if (unaffectedProjection(mutation.project, target.id, beforeOperations) !== before) return { ok: false, code: "PRESERVATION_MISMATCH", detail: "unaffected scene, overlay, capture, or operation semantics changed" };
  const persisted = applyOperations(withCapture, withCapture.currentRevisionId, operation, { actor: "recapture", root });
  if (!persisted.ok) return { ok: false, code: "PERSISTENCE_ERROR", detail: persisted.detail };
  try {
    const afterOperations = readOperationRecords(root).filter((record) => (record as { resultRevisionId?: string }).resultRevisionId !== persisted.revisionId);
    if (unaffectedProjection(persisted.project, target.id, afterOperations) !== before) return { ok: false, code: "PRESERVATION_MISMATCH", detail: "unaffected scene, overlay, capture, or operation semantics changed" };
  } catch (error) {
    return { ok: false, code: "PRESERVATION_MISMATCH", detail: `operation log cannot be validated: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, project: persisted.project, preserved: true };
}

function safePath(root: string, value: string): string | undefined {
  if (isAbsolute(value) || value.includes("..")) return undefined;
  const resolved = resolve(root, value);
  return relative(resolve(root), resolved).startsWith("..") ? undefined : resolved;
}

function unaffectedProjection(project: Project, targetSceneId: string, operations: unknown[]): string {
  const targetSceneKey = project.scenes.find((scene) => scene.id === targetSceneId)?.sceneKey;
  const value = {
    scenes: project.scenes.filter((scene) => scene.id !== targetSceneId),
    overlays: Object.values(project.overlays).filter((overlay) => overlay.sceneId !== targetSceneId),
    captures: Object.values(project.captures).filter((capture) => capture.sceneKey !== targetSceneKey),
    operations,
  };
  return JSON.stringify(value);
}

function readOperationRecords(root: string): unknown[] {
  const path = join(root, "operations.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
