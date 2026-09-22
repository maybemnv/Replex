import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  ClipSchema,
  CropSchema,
  KeyframeSchema,
  LayerSchema,
  MediaAssetSchema,
  ProjectV2Schema,
  TextPropertiesSchema,
  TransformSchema,
  TransitionV2Schema,
  type Clip,
  type Keyframe,
  type Layer,
  type MediaAsset,
  type ProjectV2,
} from "./schema-v2.js";
import { IdSchema } from "./schema.js";

const nonEmptyText = z.string().trim().min(1);
const finite = z.number().finite();
const milliseconds = z.number().int().finite().nonnegative();
const opacity = finite.min(0).max(1);
const actorSchema = z.enum(["user", "agent", "recapture", "migration"]);

const operationSchemas = {
  import_asset: z.object({ type: z.literal("import_asset"), asset: MediaAssetSchema }).strict(),
  remove_asset: z.object({ type: z.literal("remove_asset"), assetId: IdSchema }).strict(),
  create_clip: z.object({ type: z.literal("create_clip"), clip: ClipSchema }).strict(),
  split_clip: z.object({ type: z.literal("split_clip"), clipId: IdSchema, atTimelineMs: milliseconds, newClipId: IdSchema }).strict(),
  trim_clip: z.object({ type: z.literal("trim_clip"), clipId: IdSchema, sourceInMs: milliseconds, sourceOutMs: milliseconds }).strict(),
  move_clip: z.object({ type: z.literal("move_clip"), clipId: IdSchema, timelineStartMs: milliseconds, trackId: IdSchema.optional() }).strict(),
  remove_clip: z.object({ type: z.literal("remove_clip"), clipId: IdSchema }).strict(),
  replace_asset: z.object({ type: z.literal("replace_asset"), clipId: IdSchema, assetId: IdSchema }).strict(),
  set_transform: z.object({ type: z.literal("set_transform"), clipId: IdSchema, transform: TransformSchema, crop: CropSchema.optional() }).strict(),
  set_opacity: z.object({ type: z.literal("set_opacity"), clipId: IdSchema.optional(), layerId: IdSchema.optional(), opacity }).strict().superRefine((value, context) => {
    if ((value.clipId === undefined) === (value.layerId === undefined)) context.addIssue({ code: "custom", path: ["clipId"], message: "set_opacity requires exactly one clipId or layerId" });
  }),
  set_speed: z.object({ type: z.literal("set_speed"), clipId: IdSchema, speed: finite.min(0.25).max(4) }).strict(),
  set_transition: z.object({ type: z.literal("set_transition"), clipId: IdSchema, transition: TransitionV2Schema }).strict(),
  add_text_layer: z.object({ type: z.literal("add_text_layer"), layer: LayerSchema }).strict().superRefine((value, context) => {
    if (value.layer.kind !== "text") context.addIssue({ code: "custom", path: ["layer", "kind"], message: "text layer operation requires a text layer" });
  }),
  update_text_layer: z.object({ type: z.literal("update_text_layer"), layerId: IdSchema, properties: TextPropertiesSchema }).strict(),
  add_image_layer: z.object({ type: z.literal("add_image_layer"), layer: LayerSchema }).strict().superRefine((value, context) => {
    if (value.layer.kind !== "image") context.addIssue({ code: "custom", path: ["layer", "kind"], message: "image layer operation requires an image layer" });
  }),
  remove_layer: z.object({ type: z.literal("remove_layer"), layerId: IdSchema }).strict(),
  set_volume: z.object({ type: z.literal("set_volume"), clipId: IdSchema, audioGainDb: finite }).strict(),
  mute_clip: z.object({ type: z.literal("mute_clip"), clipId: IdSchema, muted: z.boolean() }).strict(),
  animate_property: z.object({ type: z.literal("animate_property"), layerId: IdSchema, keyframes: z.array(KeyframeSchema).min(1) }).strict(),
  apply_motion_preset: z.object({ type: z.literal("apply_motion_preset"), targetId: IdSchema, presetId: IdSchema, presetVersion: nonEmptyText, parameters: z.record(z.string(), finite).optional() }).strict(),
  recapture_browser_asset: z.object({ type: z.literal("recapture_browser_asset"), assetId: IdSchema, reason: nonEmptyText }).strict(),
  replace_browser_capture: z.object({
    type: z.literal("replace_browser_capture"),
    previousAssetId: IdSchema,
    replacementAsset: MediaAssetSchema,
    changedActionIds: z.array(IdSchema).min(1),
    reason: nonEmptyText,
  }).strict(),
} as const;

export const OperationSchemas = operationSchemas;
export const OperationSchema = z.discriminatedUnion("type", [
  operationSchemas.import_asset,
  operationSchemas.remove_asset,
  operationSchemas.create_clip,
  operationSchemas.split_clip,
  operationSchemas.trim_clip,
  operationSchemas.move_clip,
  operationSchemas.remove_clip,
  operationSchemas.replace_asset,
  operationSchemas.set_transform,
  operationSchemas.set_opacity,
  operationSchemas.set_speed,
  operationSchemas.set_transition,
  operationSchemas.add_text_layer,
  operationSchemas.update_text_layer,
  operationSchemas.add_image_layer,
  operationSchemas.remove_layer,
  operationSchemas.set_volume,
  operationSchemas.mute_clip,
  operationSchemas.animate_property,
  operationSchemas.apply_motion_preset,
  operationSchemas.recapture_browser_asset,
  operationSchemas.replace_browser_capture,
]);
export const OperationBatchSchema = z.array(OperationSchema).min(1);

export type Operation = z.infer<typeof OperationSchema>;
export type OperationType = Operation["type"];

export const SCHEMA_RECOGNIZED_OPERATION_TYPES = Object.keys(operationSchemas) as OperationType[];
export const REDUCER_SUPPORTED_OPERATION_TYPES = SCHEMA_RECOGNIZED_OPERATION_TYPES.filter((type) => !["apply_motion_preset", "recapture_browser_asset"].includes(type));
export const BACKEND_SUPPORTED_OPERATION_TYPES: OperationType[] = [];

const reducerSupported = new Set(REDUCER_SUPPORTED_OPERATION_TYPES);
const deferredOperations = new Set<OperationType>(["apply_motion_preset", "recapture_browser_asset"]);

export const OperationLogRecordSchema = z.object({
  id: IdSchema,
  baseRevisionId: IdSchema,
  resultRevisionId: IdSchema,
  actor: z.enum(["user", "agent", "recapture", "migration"]),
  intentId: IdSchema,
  input: OperationSchema,
  accepted: z.literal(true),
  evidenceRefs: z.array(nonEmptyText),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type OperationLogRecord = z.infer<typeof OperationLogRecordSchema>;

export interface OperationBatchInput {
  baseRevisionId: string;
  actor: "user" | "agent" | "recapture" | "migration";
  intentId: string;
  evidenceRefs: string[];
  operations: unknown;
  createdAt?: string;
}

export type OperationBatchFailureCode = "STALE_REVISION" | "INVALID_OPERATION" | "UNSUPPORTED_OPERATION";

export type OperationBatchResult =
  | { ok: true; project: ProjectV2; revisionId: string; operationLog: OperationLogRecord[] }
  | { ok: false; code: OperationBatchFailureCode; detail: string; operationIndex?: number; operationType?: string };

const DETERMINISTIC_CREATED_AT = "1970-01-01T00:00:00.000Z";

export function semanticHashV2(project: ProjectV2 | Record<string, unknown>): string {
  const { currentRevisionId: _currentRevisionId, revisions: _revisions, outputs: _outputs, operationLogRef: _operationLogRef, ...semanticProject } = project as Record<string, unknown>;
  return digest(canonicalJson(semanticProject));
}

export function applyOperationBatch(project: ProjectV2, batch: OperationBatchInput): OperationBatchResult {
  if (batch.baseRevisionId !== project.currentRevisionId) return { ok: false, code: "STALE_REVISION", detail: "base revision is not current" };

  const parsedProject = ProjectV2Schema.safeParse(project);
  if (!parsedProject.success) return { ok: false, code: "INVALID_OPERATION", detail: formatIssues(parsedProject.error) };
  const parsedOperations = OperationBatchSchema.safeParse(batch.operations);
  if (!parsedOperations.success) return { ok: false, code: "INVALID_OPERATION", detail: formatIssues(parsedOperations.error) };
  if (!actorSchema.safeParse(batch.actor).success) return { ok: false, code: "INVALID_OPERATION", detail: "actor is invalid" };
  if (!IdSchema.safeParse(batch.intentId).success) return { ok: false, code: "INVALID_OPERATION", detail: "intentId is invalid" };
  if (!z.array(nonEmptyText).safeParse(batch.evidenceRefs).success) return { ok: false, code: "INVALID_OPERATION", detail: "evidenceRefs must contain non-empty references" };

  const unsupportedIndex = parsedOperations.data.findIndex((operation) => deferredOperations.has(operation.type) || !reducerSupported.has(operation.type));
  if (unsupportedIndex >= 0) {
    const operation = parsedOperations.data[unsupportedIndex];
    return { ok: false, code: "UNSUPPORTED_OPERATION", detail: `${operation.type} is recognized but deferred`, operationIndex: unsupportedIndex, operationType: operation.type };
  }

  const next = structuredClone(parsedProject.data);
  for (const [index, operation] of parsedOperations.data.entries()) {
    const error = applyOperation(next, operation);
    if (error) return { ok: false, code: "INVALID_OPERATION", detail: `operation ${index + 1}: ${error}`, operationIndex: index, operationType: operation.type };
  }

  const revisionId = `revision-${digest(canonicalJson({ baseRevisionId: batch.baseRevisionId, actor: batch.actor, intentId: batch.intentId, operations: parsedOperations.data })).slice(0, 16)}`;
  if (next.revisions.some((revision) => revision.id === revisionId)) return { ok: false, code: "INVALID_OPERATION", detail: "result revision already exists" };
  const operationIds = parsedOperations.data.map((operation, index) => `operation-${digest(canonicalJson({ revisionId, index, operation })).slice(0, 16)}`);
  const createdAt = batch.createdAt ?? DETERMINISTIC_CREATED_AT;
  if (!z.string().datetime({ offset: true }).safeParse(createdAt).success) return { ok: false, code: "INVALID_OPERATION", detail: "createdAt must be an ISO datetime" };
  const records = parsedOperations.data.map((input, index) => ({
    id: operationIds[index],
    baseRevisionId: batch.baseRevisionId,
    resultRevisionId: revisionId,
    actor: batch.actor,
    intentId: batch.intentId,
    input,
    accepted: true as const,
    evidenceRefs: [...batch.evidenceRefs],
    createdAt,
  }));
  const revision = {
    id: revisionId,
    parentId: batch.baseRevisionId,
    actor: batch.actor,
    operationIds,
    manifestSha256: "0".repeat(64),
    createdAt,
  } as const;
  next.currentRevisionId = revisionId;
  next.revisions = [...next.revisions, revision];
  next.verification = { revisionId, status: "stale", refs: next.verification.refs };
  if (next.browser) {
    next.browser.recaptureLineage = next.browser.recaptureLineage.map((lineage) => lineage.revisionId === "pending" ? { ...lineage, revisionId } : lineage);
  }
  next.revisions.at(-1)!.manifestSha256 = semanticHashV2(next);

  const finalProject = ProjectV2Schema.safeParse(next);
  if (!finalProject.success) return { ok: false, code: "INVALID_OPERATION", detail: formatIssues(finalProject.error) };
  const operationLog = records.map((record) => OperationLogRecordSchema.parse(record));
  return { ok: true, project: finalProject.data, revisionId, operationLog };
}

function applyOperation(project: ProjectV2, operation: Operation): string | undefined {
  switch (operation.type) {
    case "import_asset":
      if (project.assets[operation.asset.id]) return "asset ID already exists";
      project.assets[operation.asset.id] = structuredClone(operation.asset);
      return;
    case "remove_asset": {
      if (!project.assets[operation.assetId]) return "asset does not exist";
      if (project.composition.clips.some((clip) => clip.assetId === operation.assetId)) return "asset is referenced by a clip";
      if (project.composition.layers.some((layer) => layerAssetId(layer) === operation.assetId)) return "asset is referenced by a layer";
      if (Object.values(project.assets).some((asset) => asset.provenance.kind === "generated" && asset.provenance.inputRefs.includes(operation.assetId))) return "asset is referenced by generated provenance";
      if (project.browser?.recaptureLineage.some((lineage) => lineage.previousAssetId === operation.assetId || lineage.replacementAssetId === operation.assetId)) return "browser lineage is immutable";
      delete project.assets[operation.assetId];
      return;
    }
    case "create_clip":
      return addClip(project, operation.clip);
    case "split_clip": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      if (hasId(project, operation.newClipId)) return "clip ID already exists";
      const duration = clipDuration(clip);
      if (operation.atTimelineMs <= clip.timelineStartMs || operation.atTimelineMs >= clip.timelineStartMs + duration) return "split point must be inside the clip";
      const sourceSplit = clip.sourceInMs + (operation.atTimelineMs - clip.timelineStartMs) * clip.speed;
      const first: Clip = { ...clip, sourceOutMs: sourceSplit, transitionOut: undefined };
      const second: Clip = { ...clip, id: operation.newClipId, timelineStartMs: operation.atTimelineMs, sourceInMs: sourceSplit };
      const index = project.composition.clips.indexOf(clip);
      project.composition.clips.splice(index, 1, first, second);
      return;
    }
    case "trim_clip": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      const error = validateSourceRange(project.assets[clip.assetId], operation.sourceInMs, operation.sourceOutMs);
      if (error) return error;
      const candidate = { ...clip, sourceInMs: operation.sourceInMs, sourceOutMs: operation.sourceOutMs };
      return replaceClip(project, clip, candidate);
    }
    case "move_clip": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      const track = project.composition.tracks.find((candidate) => candidate.id === (operation.trackId ?? clip.trackId));
      if (!track) return "track does not exist";
      const trackError = validateClipTrack(project.assets[clip.assetId], track);
      if (trackError) return trackError;
      if (track.locked) return "track is locked";
      return replaceClip(project, clip, { ...clip, timelineStartMs: operation.timelineStartMs, trackId: track.id });
    }
    case "remove_clip": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      project.composition.clips = project.composition.clips.filter((candidate) => candidate.id !== clip.id);
      return;
    }
    case "replace_asset": {
      const clip = findClip(project, operation.clipId);
      const asset = project.assets[operation.assetId];
      if (!clip) return "clip does not exist";
      if (!asset) return "asset does not exist";
      const track = project.composition.tracks.find((candidate) => candidate.id === clip.trackId);
      if (!track) return "clip track does not exist";
      const trackError = validateClipTrack(asset, track);
      if (trackError) return trackError;
      const rangeError = validateSourceRange(asset, clip.sourceInMs, clip.sourceOutMs);
      if (rangeError) return rangeError;
      clip.assetId = asset.id;
      return;
    }
    case "set_transform": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      clip.transform = structuredClone(operation.transform);
      clip.crop = operation.crop ? structuredClone(operation.crop) : undefined;
      return;
    }
    case "set_opacity":
      if (operation.clipId) {
        const clip = findClip(project, operation.clipId);
        if (!clip) return "clip does not exist";
        clip.opacity = operation.opacity;
      } else {
        const layer = findLayer(project, operation.layerId!);
        if (!layer) return "layer does not exist";
        upsertOpacityKeyframe(layer, operation.opacity);
      }
      return;
    case "set_speed": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      return replaceClip(project, clip, { ...clip, speed: operation.speed });
    }
    case "set_transition": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      clip.transitionOut = structuredClone(operation.transition);
      return;
    }
    case "add_text_layer":
      if (operation.layer.kind !== "text") return "text layer operation requires a text layer";
      return addLayer(project, operation.layer);
    case "update_text_layer": {
      const layer = findLayer(project, operation.layerId);
      if (!layer) return "layer does not exist";
      if (layer.kind !== "text") return "layer is not a text layer";
      layer.properties = structuredClone(operation.properties);
      return;
    }
    case "add_image_layer":
      if (operation.layer.kind !== "image") return "image layer operation requires an image layer";
      {
        const asset = project.assets[(operation.layer.properties as { assetId: string }).assetId];
        if (!asset) return "layer asset does not exist";
        if (asset.type !== "image" && asset.type !== "generated_graphic") return "image layer requires an image asset";
      }
      return addLayer(project, operation.layer);
    case "remove_layer":
      if (!findLayer(project, operation.layerId)) return "layer does not exist";
      project.composition.layers = project.composition.layers.filter((layer) => layer.id !== operation.layerId);
      return;
    case "set_volume": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      clip.audioGainDb = operation.audioGainDb;
      return;
    }
    case "mute_clip": {
      const clip = findClip(project, operation.clipId);
      if (!clip) return "clip does not exist";
      clip.muted = operation.muted;
      return;
    }
    case "animate_property": {
      const layer = findLayer(project, operation.layerId);
      if (!layer) return "layer does not exist";
      const existing = new Set(layer.keyframes.map((keyframe) => `${keyframe.property}:${keyframe.timeMs}`));
      for (const keyframe of operation.keyframes) {
        const key = `${keyframe.property}:${keyframe.timeMs}`;
        if (existing.has(key)) return "keyframe property and time already exists";
        if (keyframe.property === "opacity" && (typeof keyframe.value !== "number" || keyframe.value < 0 || keyframe.value > 1)) return "opacity keyframe must be between zero and one";
        if (keyframe.property === "scale" && (typeof keyframe.value !== "number" || keyframe.value <= 0)) return "scale keyframe must be positive";
        existing.add(key);
      }
      layer.keyframes.push(...structuredClone(operation.keyframes));
      return;
    }
    case "apply_motion_preset":
    case "recapture_browser_asset":
      return "operation is deferred";
    case "replace_browser_capture":
      return replaceBrowserCapture(project, operation.previousAssetId, operation.replacementAsset, operation.changedActionIds, operation.reason);
  }
}

function addClip(project: ProjectV2, clip: Clip): string | undefined {
  if (hasId(project, clip.id)) return "clip ID already exists";
  const asset = project.assets[clip.assetId];
  if (!asset) return "asset does not exist";
  const track = project.composition.tracks.find((candidate) => candidate.id === clip.trackId);
  if (!track) return "track does not exist";
  const trackError = validateClipTrack(asset, track);
  if (trackError) return trackError;
  if (track.locked) return "track is locked";
  const rangeError = validateSourceRange(asset, clip.sourceInMs, clip.sourceOutMs);
  if (rangeError) return rangeError;
  const timingError = validateClipTiming(project, clip);
  if (timingError) return timingError;
  project.composition.clips.push(structuredClone(clip));
  return;
}

function addLayer(project: ProjectV2, layer: Layer): string | undefined {
  if (hasId(project, layer.id)) return "layer ID already exists";
  const track = project.composition.tracks.find((candidate) => candidate.id === layer.trackId);
  if (!track) return "track does not exist";
  if (track.kind !== "overlay") return "layers require an overlay track";
  if (track.locked) return "track is locked";
  if (layer.timelineStartMs + layer.durationMs > project.composition.durationMs) return "layer timing exceeds composition duration";
  project.composition.layers.push(structuredClone(layer));
  return;
}

function replaceClip(project: ProjectV2, current: Clip, candidate: Clip): string | undefined {
  const asset = project.assets[candidate.assetId];
  if (!asset) return "asset does not exist";
  const rangeError = validateSourceRange(asset, candidate.sourceInMs, candidate.sourceOutMs);
  if (rangeError) return rangeError;
  const timingError = validateClipTiming(project, candidate, current.id);
  if (timingError) return timingError;
  project.composition.clips[project.composition.clips.indexOf(current)] = candidate;
  return;
}

function replaceBrowserCapture(project: ProjectV2, previousAssetId: string, replacementAsset: MediaAsset, changedActionIds: string[], reason: string): string | undefined {
  const previous = project.assets[previousAssetId];
  if (!previous || previous.provenance.kind !== "browser") return "previous asset is not a browser asset";
  if (replacementAsset.type !== "browser_capture" || replacementAsset.provenance.kind !== "browser") return "replacement asset must be a browser capture";
  if (project.assets[replacementAsset.id]) return "replacement asset ID already exists";
  if (previous.provenance.flowId !== replacementAsset.provenance.flowId || previous.provenance.sceneKey !== replacementAsset.provenance.sceneKey) return "replacement browser provenance is incompatible";
  if (replacementAsset.provenance.predecessorAssetId && replacementAsset.provenance.predecessorAssetId !== previousAssetId) return "replacement lineage predecessor is invalid";
  if (previous.probe.width !== replacementAsset.probe.width || previous.probe.height !== replacementAsset.probe.height || previous.probe.fps !== replacementAsset.probe.fps) return "replacement dimensions or frame rate are incompatible";
  const clips = project.composition.clips.filter((clip) => clip.assetId === previousAssetId);
  for (const clip of clips) {
    const rangeError = validateSourceRange(replacementAsset, clip.sourceInMs, clip.sourceOutMs);
    if (rangeError) return "replacement asset is shorter than a retained clip range";
  }
  project.assets[replacementAsset.id] = {
    ...structuredClone(replacementAsset),
    provenance: { ...replacementAsset.provenance, predecessorAssetId: previousAssetId },
  };
  for (const clip of clips) clip.assetId = replacementAsset.id;
  if (!project.browser) return "browser context is required for recapture lineage";
  project.browser.recaptureLineage = [...project.browser.recaptureLineage, {
    id: `lineage-${digest(canonicalJson({ previousAssetId, replacementAssetId: replacementAsset.id, changedActionIds, reason })).slice(0, 16)}`,
    previousAssetId,
    replacementAssetId: replacementAsset.id,
    changedActionIds: [...changedActionIds],
    reason,
    revisionId: "pending",
  }];
  return;
}

function validateClipTrack(asset: MediaAsset, track: ProjectV2["composition"]["tracks"][number]): string | undefined {
  if (track.kind === "overlay") return "clips cannot use overlay tracks";
  if ((asset.type === "audio") !== (track.kind === "audio")) return "asset and track kinds are incompatible";
  return;
}

function validateSourceRange(asset: MediaAsset | undefined, sourceInMs: number, sourceOutMs: number): string | undefined {
  if (!asset) return "asset does not exist";
  if (sourceOutMs <= sourceInMs) return "clip source range must be positive";
  if (asset.probe.durationMs !== undefined && sourceOutMs > asset.probe.durationMs) return "clip source range exceeds asset duration";
  return;
}

function validateClipTiming(project: ProjectV2, clip: Clip, replacingClipId?: string): string | undefined {
  const duration = clipDuration(clip);
  if (clip.timelineStartMs + duration > project.composition.durationMs) return "clip timing exceeds composition duration";
  for (const other of project.composition.clips) {
    if (other.id === replacingClipId || other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (clip.timelineStartMs < other.timelineStartMs + clipDuration(other) && other.timelineStartMs < clip.timelineStartMs + duration) return "clip overlaps another clip on the track";
  }
  return;
}

function findClip(project: ProjectV2, id: string): Clip | undefined {
  return project.composition.clips.find((clip) => clip.id === id);
}

function findLayer(project: ProjectV2, id: string): Layer | undefined {
  return project.composition.layers.find((layer) => layer.id === id);
}

function hasId(project: ProjectV2, id: string): boolean {
  return project.composition.clips.some((clip) => clip.id === id) || project.composition.layers.some((layer) => layer.id === id);
}

function layerAssetId(layer: Layer): string | undefined {
  const properties = layer.properties as { assetId?: string };
  return properties.assetId;
}

function clipDuration(clip: Clip): number {
  return (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
}

function upsertOpacityKeyframe(layer: Layer, value: number): void {
  const keyframe: Keyframe = { property: "opacity", timeMs: 0, value, interpolation: "linear" };
  const index = layer.keyframes.findIndex((candidate) => candidate.property === "opacity" && candidate.timeMs === 0);
  if (index >= 0) layer.keyframes[index] = keyframe;
  else layer.keyframes.push(keyframe);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "operation"}: ${issue.message}`).join("; ");
}
