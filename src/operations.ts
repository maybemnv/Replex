import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import {
  EditOperationSchema,
  OperationBatchSchema,
  OperationRecordSchema,
  ProjectSchema,
  type EditOperation,
  type OperationRecord,
  type Project,
  type Scene,
} from "./schema.js";
import { semanticHash } from "./project.js";

export type { EditOperation } from "./schema.js";

type Actor = OperationRecord["actor"];

export interface ApplyOperationsOptions {
  actor?: Actor;
  root?: string;
  artifactRoot?: string;
  operationsPath?: string;
  createdAt?: string;
}

export type OperationResult =
  | { ok: true; project: Project; revisionId: string; operationIds: string[] }
  | { ok: false; code: "STALE_REVISION" | "INVALID_OPERATION" | "PERSISTENCE_ERROR"; detail: string };

export function applyOperations(
  project: Project,
  baseRevisionId: string,
  operations: unknown,
  options: ApplyOperationsOptions = {},
): OperationResult {
  const actor = options.actor ?? "operator";
  const now = options.createdAt ?? new Date().toISOString();

  if (baseRevisionId !== project.currentRevisionId) {
    const failure = { code: "STALE_REVISION" as const, detail: "base revision is not current" };
    auditRejected(options, baseRevisionId, actor, operations, failure, now);
    return { ok: false, ...failure };
  }

  const parsedBatch = OperationBatchSchema.safeParse(operations);
  if (!parsedBatch.success) {
    const failure = { code: "INVALID_OPERATION" as const, detail: formatZodError(parsedBatch.error) };
    auditRejected(options, baseRevisionId, actor, operations, failure, now);
    return { ok: false, ...failure };
  }

  const revisionId = revisionIdFor(baseRevisionId, parsedBatch.data);
  const operationIds = parsedBatch.data.map((operation, index) =>
    `operation-${digest(canonicalJson({ revisionId, index, operation })).slice(0, 16)}`,
  );
  const next = structuredClone(project) as Project;

  for (const [index, operation] of parsedBatch.data.entries()) {
    const error = applyOperation(next, operation, revisionId);
    if (error) {
      const failure = { code: "INVALID_OPERATION" as const, detail: `operation ${index + 1}: ${error}` };
      auditRejected(options, baseRevisionId, actor, operations, failure, now);
      return { ok: false, ...failure };
    }
  }

  const projectError = validateProjectState(next);
  if (projectError) {
    const failure = { code: "INVALID_OPERATION" as const, detail: projectError };
    auditRejected(options, baseRevisionId, actor, operations, failure, now);
    return { ok: false, ...failure };
  }

  const manifestSha256 = semanticHash(next);
  const revision = {
    id: revisionId,
    parentId: baseRevisionId,
    actor,
    operationIds,
    manifestSha256,
    createdAt: now,
  } as const;
  next.currentRevisionId = revisionId;
  next.revisions = [...next.revisions, revision];

  try {
    ProjectSchema.parse(next);
    persistAccepted(options, next, baseRevisionId, revisionId, operationIds, parsedBatch.data, actor, now);
  } catch (error) {
    const failure = { code: "PERSISTENCE_ERROR" as const, detail: error instanceof Error ? error.message : String(error) };
    auditRejected(options, baseRevisionId, actor, operations, failure, now);
    return { ok: false, ...failure };
  }

  return { ok: true, project: next, revisionId, operationIds };
}

function applyOperation(project: Project, operation: EditOperation, revisionId: string): string | undefined {
  switch (operation.type) {
    case "create_scene": {
      const { scene } = operation;
      const capture = project.captures[scene.captureId];
      if (!capture) return "capture does not exist";
      if (capture.sceneKey !== scene.sceneKey) return "scene key does not match capture";
      if (project.scenes.some((candidate) => candidate.id === scene.id || candidate.sceneKey === scene.sceneKey)) {
        return "scene ID and scene key must be unique";
      }
      const linksError = validateSceneLinks(project, scene, capture.actionIds, capture.checkpointActionId);
      if (linksError) return linksError;
      if (project.scenes.some((candidate) => candidate.order === scene.order)) return "scene order must be unique";
      if (scene.sourceOutMs > capture.durationMs) return "scene range exceeds source capture";
      project.scenes = [...project.scenes, structuredClone(scene)];
      return;
    }
    case "trim_scene": {
      const scene = getScene(project, operation.sceneId);
      if (!scene) return "scene does not exist";
      const capture = project.captures[scene.captureId];
      if (!capture) return "scene capture does not exist";
      const rangeError = validateRange(operation.sourceInMs, operation.sourceOutMs, capture.durationMs, "trim range");
      if (rangeError) return rangeError;
      const oldRange = { sourceInMs: scene.sourceInMs, sourceOutMs: scene.sourceOutMs };
      Object.assign(scene, { sourceInMs: operation.sourceInMs, sourceOutMs: operation.sourceOutMs });
      const fitError = validateSceneLocalItems(project, scene);
      if (fitError) {
        Object.assign(scene, oldRange);
        return fitError;
      }
      return;
    }
    case "reorder_scene": {
      const currentIds = new Set(project.scenes.map((candidate) => candidate.id));
      if (operation.sceneIds.length !== currentIds.size || operation.sceneIds.some((id) => !currentIds.delete(id))) {
        return "reorder must contain every scene exactly once";
      }
      project.scenes = operation.sceneIds.map((id, order) => {
        const scene = project.scenes.find((candidate) => candidate.id === id)!;
        return { ...scene, order };
      });
      return;
    }
    case "replace_capture": {
      const scene = getScene(project, operation.sceneId);
      if (!scene) return "scene does not exist";
      const previous = project.captures[scene.captureId];
      const replacement = project.captures[operation.captureId];
      if (!previous || !replacement) return "capture does not exist";
      if (previous.id === replacement.id) return "replacement capture must differ from current capture";
      if (replacement.sceneKey !== scene.sceneKey) return "replacement capture has incompatible scene key";
      if (replacement.width !== previous.width || replacement.height !== previous.height || replacement.fps !== previous.fps) {
        return "replacement capture dimensions or frame rate are incompatible";
      }
      if (scene.sourceOutMs > replacement.durationMs) return "replacement capture is shorter than the retained scene range";
      const fitError = validateSceneLocalItems(project, scene, replacement.durationMs);
      if (fitError) return fitError;
      if (replacement.predecessorId && replacement.predecessorId !== previous.id) return "replacement lineage predecessor is invalid";
      const replacementRecord = replacement.predecessorId ? replacement : { ...replacement, predecessorId: previous.id };
      project.captures[replacement.id] = replacementRecord;
      scene.captureId = replacement.id;
      project.recaptureLineage = [
        ...project.recaptureLineage,
        {
          id: `lineage-${digest(`${revisionId}:${scene.id}:${previous.id}:${replacement.id}`).slice(0, 16)}`,
          sceneId: scene.id,
          previousCaptureId: previous.id,
          replacementCaptureId: replacement.id,
          changedStepIds: replacement.actionIds,
          reason: operation.reason,
          revisionId,
        },
      ];
      return;
    }
    case "set_speed": {
      const scene = getScene(project, operation.sceneId);
      if (!scene) return "scene does not exist";
      scene.speed = operation.speed;
      if (!totalDurationWithinTarget(project)) {
        return "resulting project duration must be between 25000 and 35000 milliseconds";
      }
      return;
    }
    case "set_focus": {
      const scene = getScene(project, operation.sceneId);
      if (!scene) return "scene does not exist";
      const focusError = validateFocus(operation.focus, scene);
      if (focusError) return focusError;
      scene.focus = structuredClone(operation.focus);
      return;
    }
    case "set_title":
    case "set_callout": {
      const scene = getScene(project, operation.overlay.sceneId);
      if (!scene) return "overlay scene does not exist";
      if (operation.overlay.kind !== (operation.type === "set_title" ? "title" : "callout")) return "overlay kind does not match operation";
      if (/[^\P{Cc}\t\r\n]/u.test(operation.overlay.text)) return "overlay text contains control characters";
      const current = project.overlays[operation.overlay.id];
      if (current && current.kind !== operation.overlay.kind) return "overlay kind cannot change";
      const rangeError = validateLocalRange(operation.overlay.startMs, operation.overlay.endMs, scene, "overlay range");
      if (rangeError) return rangeError;
      project.overlays[operation.overlay.id] = structuredClone(operation.overlay);
      return;
    }
    case "set_transition": {
      const scene = getScene(project, operation.sceneId);
      if (!scene) return "scene does not exist";
      scene.transition = structuredClone(operation.transition);
      return;
    }
  }
}

function validateProjectState(project: Project): string | undefined {
  const sceneIds = new Set<string>();
  const sceneKeys = new Set<string>();
  const orders = new Set<number>();
  for (const scene of project.scenes) {
    if (sceneIds.has(scene.id) || sceneKeys.has(scene.sceneKey)) return "scene IDs and scene keys must be unique";
    sceneIds.add(scene.id);
    sceneKeys.add(scene.sceneKey);
    if (orders.has(scene.order)) return "scene orders must be unique";
    orders.add(scene.order);
    const capture = project.captures[scene.captureId];
    if (!capture) return `scene ${scene.id} capture does not exist`;
    if (capture.sceneKey !== scene.sceneKey) return `scene ${scene.id} capture scene key does not match`;
    const linksError = validateSceneLinks(project, scene, capture.actionIds, capture.checkpointActionId);
    if (linksError) return linksError;
    const rangeError = validateRange(scene.sourceInMs, scene.sourceOutMs, capture.durationMs, `scene ${scene.id} range`);
    if (rangeError) return rangeError;
    const localError = validateSceneLocalItems(project, scene);
    if (localError) return localError;
  }
  for (const [id, overlay] of Object.entries(project.overlays)) {
    if (id !== overlay.id) return "overlay key must equal overlay ID";
    const scene = getScene(project, overlay.sceneId);
    if (!scene) return "overlay scene does not exist";
    const rangeError = validateLocalRange(overlay.startMs, overlay.endMs, scene, "overlay range");
    if (rangeError) return rangeError;
  }
  for (const scene of project.scenes) {
    if (scene.transition.type === "crossfade") {
      const neighbor = project.scenes.find((candidate) => candidate.order === scene.order + 1);
      if (!neighbor) return "crossfade requires a following neighboring scene";
      if (scene.transition.durationMs >= sceneDurationMs(scene) || scene.transition.durationMs >= sceneDurationMs(neighbor)) {
        return "transition duration must be shorter than both neighboring scenes";
      }
    }
  }
  if (!totalDurationWithinTarget(project)) return "resulting project duration must be between 25000 and 35000 milliseconds";
  return;
}

function validateSceneLinks(project: Project, scene: Scene, captureActionIds: string[], captureCheckpointId: string): string | undefined {
  const steps = new Map(project.flow.steps.map((step) => [step.id, step]));
  if (new Set(scene.actionIds).size !== scene.actionIds.length) return "scene action IDs must be unique";
  if (!scene.actionIds.every((id) => steps.has(id))) return "scene action ID does not exist in the approved flow";
  if (!scene.actionIds.every((id) => captureActionIds.includes(id))) return "scene action ID is not linked to the capture";
  if (!scene.actionIds.includes(scene.checkpointActionId) || scene.checkpointActionId !== captureCheckpointId) return "scene checkpoint does not match its capture";
  if (steps.get(scene.checkpointActionId)?.sceneKey !== scene.sceneKey) return "scene checkpoint belongs to another scene";
  if (scene.actionIds.some((id) => steps.get(id)?.sceneKey !== scene.sceneKey)) return "scene action belongs to another scene";
  return;
}

function validateSceneLocalItems(project: Project, scene: Scene, durationOverride?: number): string | undefined {
  const duration = durationOverride ?? sceneDurationMs(scene);
  if (scene.focus) {
    const focusError = validateLocalRange(scene.focus.startMs, scene.focus.endMs, scene, "focus range", duration);
    if (focusError) return focusError;
    if (scene.focus.bounds && (scene.focus.bounds.x + scene.focus.bounds.width > 1 || scene.focus.bounds.y + scene.focus.bounds.height > 1)) {
      return "focus bounds must remain inside normalized safe area";
    }
  }
  for (const overlay of Object.values(project.overlays)) {
    if (overlay.sceneId === scene.id) {
      const rangeError = validateLocalRange(overlay.startMs, overlay.endMs, scene, "overlay range", duration);
      if (rangeError) return rangeError;
    }
  }
  return;
}

function validateFocus(focus: Scene["focus"], scene: Scene): string | undefined {
  if (!focus) return "focus is required";
  if (focus.bounds && (focus.bounds.x + focus.bounds.width > 1 || focus.bounds.y + focus.bounds.height > 1)) return "focus bounds must remain inside normalized safe area";
  return validateLocalRange(focus.startMs, focus.endMs, scene, "focus range");
}

function validateLocalRange(start: number, end: number, scene: Scene, label: string, durationOverride?: number): string | undefined {
  const duration = durationOverride ?? sceneDurationMs(scene);
  if (start < 0 || end <= start || end > duration) return `${label} must fit within the scene duration`;
  return;
}

function validateRange(start: number, end: number, duration: number, label: string): string | undefined {
  if (start < 0 || end <= start || end > duration) return `${label} must fit within the source capture`;
  return;
}

function getScene(project: Project, sceneId: string): Scene | undefined {
  return project.scenes.find((candidate) => candidate.id === sceneId);
}

function sceneDurationMs(scene: Scene): number {
  return scene.sourceOutMs - scene.sourceInMs;
}

function totalDurationWithinTarget(project: Project): boolean {
  const total = project.scenes.reduce((sum, scene) => sum + sceneDurationMs(scene) / scene.speed, 0);
  return total >= 25000 && total <= 35000;
}

function revisionIdFor(baseRevisionId: string, operations: EditOperation[]): string {
  return `revision-${digest(canonicalJson({ baseRevisionId, operations })).slice(0, 16)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function formatZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "operation"}: ${issue.message}`).join("; ");
}

function auditRejected(
  options: ApplyOperationsOptions,
  baseRevisionId: string,
  actor: Actor,
  operations: unknown,
  failure: { code: string; detail: string },
  createdAt: string,
): void {
  const path = options.operationsPath ?? (options.root || options.artifactRoot ? join(options.root ?? options.artifactRoot!, "operations.jsonl") : undefined);
  if (!path) return;
  const entry = {
    id: randomUUID(),
    baseRevisionId,
    actor,
    operations,
    accepted: false,
    error: failure,
    evidenceRefs: [],
    createdAt,
  };
  appendJsonLine(path, entry);
}

function persistAccepted(
  options: ApplyOperationsOptions,
  project: Project,
  baseRevisionId: string,
  revisionId: string,
  operationIds: string[],
  operations: EditOperation[],
  actor: Actor,
  createdAt: string,
): void {
  const root = options.root ?? options.artifactRoot;
  if (root) {
    const serialized = `${JSON.stringify(project, null, 2)}\n`;
    const revisionPath = join(root, "revisions", `${revisionId}.json`);
    mkdirSync(dirname(revisionPath), { recursive: true });
    if (!existsSync(revisionPath)) atomicWrite(revisionPath, serialized);
    else if (readFileSync(revisionPath, "utf8") !== serialized) throw new Error(`revision already exists: ${revisionId}`);
    atomicWrite(join(root, "project.json"), serialized);
  }
  const path = options.operationsPath ?? (root ? join(root, "operations.jsonl") : undefined);
  if (path) {
    for (const [index, input] of operations.entries()) {
      const record: OperationRecord = {
        id: operationIds[index],
        baseRevisionId,
        resultRevisionId: revisionId,
        actor,
        input,
        accepted: true,
        evidenceRefs: [],
        createdAt,
      };
      OperationRecordSchema.parse(record);
      appendJsonLine(path, record);
    }
  }
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${parsePath(path).base}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, "utf8");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
