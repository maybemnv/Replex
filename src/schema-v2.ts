import { z } from "zod";
import {
  FlowSchema,
  IdSchema,
  MillisecondsSchema,
  Sha256Schema,
  type Flow,
} from "./schema.js";

const nonEmptyText = z.string().trim().min(1);
const finite = z.number().finite();
const positiveNumber = finite.positive();
const positiveInteger = z.number().int().finite().positive();
const unitInterval = finite.min(0).max(1);
const datetime = z.string().datetime({ offset: true });

function isScopedReference(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized !== "."
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split("/").includes("..")
    && !normalized.includes("\0");
}

const scopedReference = nonEmptyText.refine(isScopedReference, "reference must stay within an authorized project or object namespace");
const projectPath = scopedReference.refine((value) => !value.includes("://"), "project paths must be relative paths");

export const ProjectBriefV2Schema = z.object({
  audience: nonEmptyText.optional(),
  message: nonEmptyText.optional(),
  targetDurationMs: MillisecondsSchema.optional(),
}).strict();

export const MediaProbeV2Schema = z.object({
  durationMs: MillisecondsSchema.optional(),
  width: positiveInteger.optional(),
  height: positiveInteger.optional(),
  fps: positiveNumber.optional(),
  videoCodec: nonEmptyText.optional(),
  audioCodec: nonEmptyText.optional(),
  channels: positiveInteger.optional(),
  sampleRateHz: positiveInteger.optional(),
}).strict();

export const BrowserProvenanceSchema = z.object({
  kind: z.literal("browser"),
  flowId: IdSchema,
  sceneKey: IdSchema,
  actionIds: z.array(IdSchema).min(1),
  checkpointActionId: IdSchema,
  runId: IdSchema,
  capturedAt: datetime,
  predecessorAssetId: IdSchema.optional(),
}).strict();

export const UploadProvenanceSchema = z.object({
  kind: z.literal("upload"),
  originalFilename: nonEmptyText,
  importedAt: datetime,
  sourceSha256: Sha256Schema,
  importMethod: z.enum(["file_picker", "path", "upload"]),
  originalProbe: MediaProbeV2Schema,
}).strict();

export const GeneratedProvenanceSchema = z.object({
  kind: z.literal("generated"),
  generator: nonEmptyText,
  generatedAt: datetime,
  inputRefs: z.array(IdSchema),
}).strict();

export const MediaProvenanceSchema = z.discriminatedUnion("kind", [
  BrowserProvenanceSchema,
  UploadProvenanceSchema,
  GeneratedProvenanceSchema,
]);

export const AssetTypeSchema = z.enum([
  "browser_capture",
  "uploaded_video",
  "image",
  "audio",
  "generated_graphic",
]);

export const MediaAssetSchema = z.object({
  id: IdSchema,
  type: AssetTypeSchema,
  path: projectPath.optional(),
  objectRef: scopedReference.optional(),
  sha256: Sha256Schema,
  probe: MediaProbeV2Schema,
  provenance: MediaProvenanceSchema,
}).strict().superRefine((value, context) => {
  if ((value.path === undefined) === (value.objectRef === undefined)) {
    context.addIssue({ code: "custom", path: ["path"], message: "asset must provide exactly one project path or object reference" });
  }
  const expectedKind = value.type === "browser_capture" ? "browser" : value.type === "generated_graphic" ? "generated" : "upload";
  if (value.provenance.kind !== expectedKind) {
    context.addIssue({ code: "custom", path: ["provenance", "kind"], message: `${value.type} assets require ${expectedKind} provenance` });
  }
});

export const MediaAssetsSchema = z.record(IdSchema, MediaAssetSchema).superRefine((value, context) => {
  for (const [key, asset] of Object.entries(value)) {
    if (key !== asset.id) context.addIssue({ code: "custom", path: [key, "id"], message: "asset key must equal asset id" });
  }
});

export const AssetHandleSchema = z.object({
  assetId: IdSchema,
  sha256: Sha256Schema,
  ref: scopedReference,
}).strict();

export const CropSchema = z.object({
  x: unitInterval,
  y: unitInterval,
  width: finite.positive().max(1),
  height: finite.positive().max(1),
}).strict().superRefine((value, context) => {
  if (value.x + value.width > 1) context.addIssue({ code: "custom", path: ["width"], message: "crop must remain inside normalized bounds" });
  if (value.y + value.height > 1) context.addIssue({ code: "custom", path: ["height"], message: "crop must remain inside normalized bounds" });
});

export const TransformSchema = z.object({
  x: finite,
  y: finite,
  scale: positiveNumber,
  rotation: finite,
  anchorX: unitInterval,
  anchorY: unitInterval,
}).strict();

export const TransitionV2Schema = z.object({
  type: z.enum(["cut", "crossfade"]),
  durationMs: MillisecondsSchema,
}).strict().superRefine((value, context) => {
  if (value.type === "cut" && value.durationMs !== 0) context.addIssue({ code: "custom", path: ["durationMs"], message: "cut duration must be zero" });
  if (value.type === "crossfade" && value.durationMs === 0) context.addIssue({ code: "custom", path: ["durationMs"], message: "crossfade duration must be positive" });
});

export const ClipSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  trackId: IdSchema,
  timelineStartMs: MillisecondsSchema,
  sourceInMs: MillisecondsSchema,
  sourceOutMs: MillisecondsSchema,
  speed: finite.positive().min(0.25).max(4),
  transform: TransformSchema,
  crop: CropSchema.optional(),
  opacity: unitInterval,
  audioGainDb: finite,
  muted: z.boolean().default(false),
  transitionOut: TransitionV2Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceOutMs <= value.sourceInMs) context.addIssue({ code: "custom", path: ["sourceOutMs"], message: "clip source range must be positive" });
  if (value.transitionOut && value.transitionOut.durationMs >= (value.sourceOutMs - value.sourceInMs) / value.speed) {
    context.addIssue({ code: "custom", path: ["transitionOut", "durationMs"], message: "transition must be shorter than the clip" });
  }
});

export const TextPropertiesSchema = z.object({
  text: nonEmptyText,
  fontFamily: nonEmptyText.optional(),
  fontSize: positiveNumber.optional(),
  color: nonEmptyText.optional(),
}).strict();

export const ImagePropertiesSchema = z.object({ assetId: IdSchema }).strict();
export const GraphicPropertiesSchema = z.object({ assetId: IdSchema }).strict();
export const LayerPropertiesSchema = z.union([TextPropertiesSchema, ImagePropertiesSchema, GraphicPropertiesSchema]);

export const KeyframeSchema = z.object({
  id: IdSchema.optional(),
  property: z.enum(["position", "scale", "rotation", "opacity", "crop", "blur", "camera"]),
  timeMs: MillisecondsSchema,
  value: z.union([finite, CropSchema]),
  interpolation: z.enum(["linear", "ease_in", "ease_out", "ease_in_out"]),
}).strict().superRefine((value, context) => {
  if (value.property === "crop" && typeof value.value === "number") context.addIssue({ code: "custom", path: ["value"], message: "crop keyframes require crop bounds" });
  if (value.property !== "crop" && typeof value.value !== "number") context.addIssue({ code: "custom", path: ["value"], message: "numeric keyframes require a numeric value" });
});

export const LayerSchema = z.object({
  id: IdSchema,
  trackId: IdSchema,
  kind: z.enum(["text", "image", "graphic"]),
  timelineStartMs: MillisecondsSchema,
  durationMs: positiveInteger,
  properties: LayerPropertiesSchema,
  keyframes: z.array(KeyframeSchema),
}).strict().superRefine((value, context) => {
  const expectedKind = value.kind === "text" ? TextPropertiesSchema : value.kind === "image" ? ImagePropertiesSchema : GraphicPropertiesSchema;
  if (!expectedKind.safeParse(value.properties).success) context.addIssue({ code: "custom", path: ["properties"], message: `layer kind ${value.kind} requires matching properties` });
  const seen = new Set<string>();
  for (const [index, keyframe] of value.keyframes.entries()) {
    if (keyframe.timeMs > value.durationMs) context.addIssue({ code: "custom", path: ["keyframes", index, "timeMs"], message: "keyframe must fit within layer timing" });
    const key = `${keyframe.property}:${keyframe.timeMs}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["keyframes", index], message: "keyframe property and time must be unique" });
    seen.add(key);
  }
});

export const TrackSchema = z.object({
  id: IdSchema,
  kind: z.enum(["video", "audio", "overlay"]),
  order: z.number().int().finite().nonnegative(),
  muted: z.boolean(),
  locked: z.boolean(),
}).strict();

export const CompositionSchema = z.object({
  width: positiveInteger,
  height: positiveInteger,
  fps: positiveNumber,
  durationMs: positiveInteger,
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  layers: z.array(LayerSchema),
}).strict().superRefine((value, context) => {
  const trackIds = new Set<string>();
  const orders = new Set<number>();
  for (const [index, track] of value.tracks.entries()) {
    if (trackIds.has(track.id)) context.addIssue({ code: "custom", path: ["tracks", index, "id"], message: "track IDs must be unique" });
    if (orders.has(track.order)) context.addIssue({ code: "custom", path: ["tracks", index, "order"], message: "track orders must be unique" });
    trackIds.add(track.id);
    orders.add(track.order);
  }
  const ids = new Set<string>();
  const clipsByTrack = new Map<string, Array<{ clip: z.infer<typeof ClipSchema>; index: number }>>();
  for (const [index, clip] of value.clips.entries()) {
    if (ids.has(clip.id)) context.addIssue({ code: "custom", path: ["clips", index, "id"], message: "clip and layer IDs must be globally unique" });
    ids.add(clip.id);
    const track = value.tracks.find((candidate) => candidate.id === clip.trackId);
    if (!track) context.addIssue({ code: "custom", path: ["clips", index, "trackId"], message: "clip track does not exist" });
    else if (track.kind === "overlay") context.addIssue({ code: "custom", path: ["clips", index, "trackId"], message: "clips cannot use overlay tracks" });
    const duration = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
    if (clip.timelineStartMs + duration > value.durationMs) context.addIssue({ code: "custom", path: ["clips", index, "timelineStartMs"], message: "clip timing exceeds composition duration" });
    const trackClips = clipsByTrack.get(clip.trackId) ?? [];
    trackClips.push({ clip, index });
    clipsByTrack.set(clip.trackId, trackClips);
  }
  for (const clips of clipsByTrack.values()) {
    clips.sort((left, right) => left.clip.timelineStartMs - right.clip.timelineStartMs);
    for (let index = 0; index < clips.length; index += 1) {
      const current = clips[index];
      const currentEnd = current.clip.timelineStartMs + (current.clip.sourceOutMs - current.clip.sourceInMs) / current.clip.speed;
      const next = clips[index + 1];
      if (next) {
        if (currentEnd > next.clip.timelineStartMs) context.addIssue({ code: "custom", path: ["clips", next.index, "timelineStartMs"], message: "clips on a track must not overlap; transitionOut owns transition timing" });
      }
      if (current.clip.transitionOut?.type === "crossfade") {
        const successor = clips.slice(index + 1).find(({ clip }) => clip.timelineStartMs >= currentEnd);
        if (!successor) context.addIssue({ code: "custom", path: ["clips", current.index, "transitionOut"], message: "crossfade requires a following clip on the same track" });
        else if (current.clip.transitionOut.durationMs >= (successor.clip.sourceOutMs - successor.clip.sourceInMs) / successor.clip.speed) {
          context.addIssue({ code: "custom", path: ["clips", current.index, "transitionOut", "durationMs"], message: "crossfade must be shorter than both clips" });
        }
      }
    }
  }
  for (const [index, layer] of value.layers.entries()) {
    if (ids.has(layer.id)) context.addIssue({ code: "custom", path: ["layers", index, "id"], message: "clip and layer IDs must be globally unique" });
    ids.add(layer.id);
    const track = value.tracks.find((candidate) => candidate.id === layer.trackId);
    if (!track) context.addIssue({ code: "custom", path: ["layers", index, "trackId"], message: "layer track does not exist" });
    else if (track.kind !== "overlay") context.addIssue({ code: "custom", path: ["layers", index, "trackId"], message: "layers require an overlay track" });
    if (layer.timelineStartMs + layer.durationMs > value.durationMs) context.addIssue({ code: "custom", path: ["layers", index, "timelineStartMs"], message: "layer timing exceeds composition duration" });
  }
});

export const VerificationRefSchema = z.object({
  id: IdSchema,
  revisionId: IdSchema,
  status: z.enum(["passed", "failed"]),
  evidenceRefs: z.array(scopedReference),
}).strict();

export const VerificationStateSchema = z.object({
  revisionId: IdSchema,
  status: z.enum(["unknown", "stale", "passed", "failed"]),
  refs: z.array(VerificationRefSchema),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, ref] of value.refs.entries()) {
    if (ids.has(ref.id)) context.addIssue({ code: "custom", path: ["refs", index, "id"], message: "verification reference IDs must be unique" });
    ids.add(ref.id);
  }
});

export const RenderArtifactSchema = z.object({
  outputId: IdSchema,
  ref: scopedReference,
  sha256: Sha256Schema,
  probe: MediaProbeV2Schema,
  sourceRevisionId: IdSchema,
  renderJobHash: Sha256Schema,
}).strict();

export const RenderOutputSchemaV2 = RenderArtifactSchema.extend({
  revisionId: IdSchema.optional(),
  backendId: nonEmptyText,
  backendVersion: nonEmptyText,
  verificationRefId: IdSchema,
}).strict();

export const RevisionV2Schema = z.object({
  id: IdSchema,
  parentId: IdSchema.optional(),
  actor: z.enum(["user", "agent", "recapture", "migration"]),
  operationIds: z.array(IdSchema),
  manifestSha256: Sha256Schema,
  createdAt: datetime,
}).strict();

export const RecaptureLineageSchemaV2 = z.object({
  id: IdSchema,
  previousAssetId: IdSchema,
  replacementAssetId: IdSchema,
  changedActionIds: z.array(IdSchema).min(1),
  reason: nonEmptyText,
  revisionId: IdSchema,
}).strict();

export const BrowserFlowSchema = FlowSchema;

export const ProjectV2Schema = z.object({
  schemaVersion: z.literal(2),
  projectId: IdSchema,
  brief: ProjectBriefV2Schema,
  assets: MediaAssetsSchema,
  composition: CompositionSchema,
  revisions: z.array(RevisionV2Schema).min(1),
  operationLogRef: projectPath,
  outputs: z.array(RenderOutputSchemaV2),
  verification: VerificationStateSchema,
  browser: z.object({
    flows: z.record(IdSchema, BrowserFlowSchema),
    recaptureLineage: z.array(RecaptureLineageSchemaV2),
  }).strict().optional(),
  currentRevisionId: IdSchema,
}).strict().superRefine((value, context) => {
  const revisionIds = new Set(value.revisions.map((revision) => revision.id));
  if (new Set(revisionIds).size !== value.revisions.length) context.addIssue({ code: "custom", path: ["revisions"], message: "revision IDs must be unique" });
  if (!revisionIds.has(value.currentRevisionId)) context.addIssue({ code: "custom", path: ["currentRevisionId"], message: "current revision does not exist" });
  for (const [index, revision] of value.revisions.entries()) {
    if (revision.parentId && (!revisionIds.has(revision.parentId) || revision.parentId === revision.id)) context.addIssue({ code: "custom", path: ["revisions", index, "parentId"], message: "revision parent must be another existing revision" });
  }
  const revisionParents = new Map(value.revisions.map((revision) => [revision.id, revision.parentId]));
  const complete = new Set<string>();
  const visiting = new Set<string>();
  const visitRevision = (id: string): void => {
    if (complete.has(id)) return;
    if (visiting.has(id)) {
      context.addIssue({ code: "custom", path: ["revisions"], message: "revision ancestry must be acyclic" });
      return;
    }
    visiting.add(id);
    const parentId = revisionParents.get(id);
    if (parentId && revisionParents.has(parentId)) visitRevision(parentId);
    visiting.delete(id);
    complete.add(id);
  };
  for (const revision of value.revisions) visitRevision(revision.id);
  if (!revisionIds.has(value.verification.revisionId)) context.addIssue({ code: "custom", path: ["verification", "revisionId"], message: "verification revision does not exist" });
  for (const [index, ref] of value.verification.refs.entries()) if (!revisionIds.has(ref.revisionId)) context.addIssue({ code: "custom", path: ["verification", "refs", index, "revisionId"], message: "verification reference revision does not exist" });
  if (value.verification.status === "passed" && !value.verification.refs.some((ref) => ref.status === "passed" && ref.revisionId === value.verification.revisionId)) context.addIssue({ code: "custom", path: ["verification", "refs"], message: "passed verification state requires a passed verification reference for its revision" });
  const assetIds = new Set(Object.keys(value.assets));
  const flowIds = new Set(Object.keys(value.browser?.flows ?? {}));
  for (const [key, asset] of Object.entries(value.assets)) {
    const provenance = asset.provenance;
    if (provenance.kind === "browser") {
      if (!value.browser || !flowIds.has(provenance.flowId)) context.addIssue({ code: "custom", path: ["assets", key, "provenance", "flowId"], message: "browser provenance flow does not exist" });
      else {
        const flow = value.browser.flows[provenance.flowId];
        const steps = flow.steps.filter((step) => step.sceneKey === provenance.sceneKey);
        if (steps.length !== provenance.actionIds.length || steps.some((step, index) => step.id !== provenance.actionIds[index])) context.addIssue({ code: "custom", path: ["assets", key, "provenance", "actionIds"], message: "browser provenance actions must match the approved flow" });
        if (provenance.checkpointActionId !== steps.at(-1)?.id) context.addIssue({ code: "custom", path: ["assets", key, "provenance", "checkpointActionId"], message: "browser provenance checkpoint must match the approved flow" });
      }
      if (provenance.predecessorAssetId) {
        const predecessor = value.assets[provenance.predecessorAssetId];
        if (!predecessor || predecessor.provenance.kind !== "browser" || provenance.predecessorAssetId === asset.id) context.addIssue({ code: "custom", path: ["assets", key, "provenance", "predecessorAssetId"], message: "browser predecessor asset is invalid" });
        else if (predecessor.provenance.flowId !== provenance.flowId || predecessor.provenance.sceneKey !== provenance.sceneKey) context.addIssue({ code: "custom", path: ["assets", key, "provenance", "predecessorAssetId"], message: "browser predecessor must belong to the same flow scene" });
      }
    }
    if (provenance.kind === "generated") {
      for (const [index, inputRef] of provenance.inputRefs.entries()) if (!assetIds.has(inputRef) || inputRef === asset.id) context.addIssue({ code: "custom", path: ["assets", key, "provenance", "inputRefs", index], message: "generated input asset does not exist or cannot self-reference" });
    }
  }
  for (const [index, clip] of value.composition.clips.entries()) if (!assetIds.has(clip.assetId)) context.addIssue({ code: "custom", path: ["composition", "clips", index, "assetId"], message: "clip asset does not exist" });
  for (const [index, clip] of value.composition.clips.entries()) {
    const asset = value.assets[clip.assetId];
    const track = value.composition.tracks.find((candidate) => candidate.id === clip.trackId);
    if (asset && track && ((asset.type === "audio") !== (track.kind === "audio"))) context.addIssue({ code: "custom", path: ["composition", "clips", index], message: "audio assets require audio tracks and visual assets require video tracks" });
    if (asset?.probe.durationMs !== undefined && clip.sourceOutMs > asset.probe.durationMs) context.addIssue({ code: "custom", path: ["composition", "clips", index, "sourceOutMs"], message: "clip source range exceeds asset duration" });
  }
  for (const [index, layer] of value.composition.layers.entries()) {
    const properties = layer.properties as { assetId?: string };
    if (properties.assetId) {
      const asset = value.assets[properties.assetId];
      if (!asset) context.addIssue({ code: "custom", path: ["composition", "layers", index, "properties", "assetId"], message: "layer asset does not exist" });
      else if (layer.kind === "image" && !["image", "generated_graphic"].includes(asset.type)) context.addIssue({ code: "custom", path: ["composition", "layers", index, "properties", "assetId"], message: "image layers require image assets" });
      else if (layer.kind === "graphic" && asset.type !== "generated_graphic") context.addIssue({ code: "custom", path: ["composition", "layers", index, "properties", "assetId"], message: "graphic layers require generated graphic assets" });
    }
  }
  const verificationRefs = new Map(value.verification.refs.map((ref) => [ref.id, ref]));
  const outputIds = new Set<string>();
  for (const [index, output] of value.outputs.entries()) {
    if (outputIds.has(output.outputId)) context.addIssue({ code: "custom", path: ["outputs", index, "outputId"], message: "output IDs must be unique" });
    outputIds.add(output.outputId);
    if (!revisionIds.has(output.sourceRevisionId)) context.addIssue({ code: "custom", path: ["outputs", index, "sourceRevisionId"], message: "output source revision does not exist" });
    if (output.revisionId && output.sourceRevisionId !== output.revisionId) context.addIssue({ code: "custom", path: ["outputs", index, "sourceRevisionId"], message: "output source revision must match its revision" });
    const verification = verificationRefs.get(output.verificationRefId);
    if (!verification || verification.status !== "passed") context.addIssue({ code: "custom", path: ["outputs", index, "verificationRefId"], message: "output verification reference must be a passed reference" });
    else if (verification.revisionId !== output.sourceRevisionId) context.addIssue({ code: "custom", path: ["outputs", index, "verificationRefId"], message: "output verification must match its source revision" });
  }
  if (value.browser) {
    for (const [key, flow] of Object.entries(value.browser.flows)) if (key !== flow.id) context.addIssue({ code: "custom", path: ["browser", "flows", key, "id"], message: "browser flow key must equal flow id" });
    for (const [index, lineage] of value.browser.recaptureLineage.entries()) {
      const previous = value.assets[lineage.previousAssetId];
      const replacement = value.assets[lineage.replacementAssetId];
      if (!previous || previous.provenance.kind !== "browser") context.addIssue({ code: "custom", path: ["browser", "recaptureLineage", index, "previousAssetId"], message: "recapture predecessor must be a browser asset" });
      if (!replacement || replacement.provenance.kind !== "browser") context.addIssue({ code: "custom", path: ["browser", "recaptureLineage", index, "replacementAssetId"], message: "recapture replacement must be a browser asset" });
      if (previous?.provenance.kind === "browser" && replacement?.provenance.kind === "browser" && (previous.provenance.flowId !== replacement.provenance.flowId || previous.provenance.sceneKey !== replacement.provenance.sceneKey)) context.addIssue({ code: "custom", path: ["browser", "recaptureLineage", index], message: "recapture assets must belong to the same browser flow scene" });
      if (replacement?.provenance.kind === "browser" && replacement.provenance.predecessorAssetId !== lineage.previousAssetId) context.addIssue({ code: "custom", path: ["browser", "recaptureLineage", index, "replacementAssetId"], message: "recapture replacement predecessor does not match lineage" });
      if (!revisionIds.has(lineage.revisionId)) context.addIssue({ code: "custom", path: ["browser", "recaptureLineage", index, "revisionId"], message: "recapture revision does not exist" });
    }
  }
});

export type ProjectBriefV2 = z.infer<typeof ProjectBriefV2Schema>;
export type MediaProbeV2 = z.infer<typeof MediaProbeV2Schema>;
export type BrowserProvenance = z.infer<typeof BrowserProvenanceSchema>;
export type UploadProvenance = z.infer<typeof UploadProvenanceSchema>;
export type GeneratedProvenance = z.infer<typeof GeneratedProvenanceSchema>;
export type MediaProvenance = z.infer<typeof MediaProvenanceSchema>;
export type AssetType = z.infer<typeof AssetTypeSchema>;
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type AssetHandle = z.infer<typeof AssetHandleSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type TextProperties = z.infer<typeof TextPropertiesSchema>;
export type ImageProperties = z.infer<typeof ImagePropertiesSchema>;
export type GraphicProperties = z.infer<typeof GraphicPropertiesSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Composition = z.infer<typeof CompositionSchema>;
export type VerificationRef = z.infer<typeof VerificationRefSchema>;
export type VerificationState = z.infer<typeof VerificationStateSchema>;
export type RenderArtifact = z.infer<typeof RenderArtifactSchema>;
export type RenderOutputV2 = z.infer<typeof RenderOutputSchemaV2>;
export type RevisionV2 = z.infer<typeof RevisionV2Schema>;
export type RecaptureLineageV2 = z.infer<typeof RecaptureLineageSchemaV2>;
export type BrowserFlow = Flow;
export type ProjectV2 = z.infer<typeof ProjectV2Schema>;

export const ProjectBriefSchema = ProjectBriefV2Schema;
export const MediaProbeSchema = MediaProbeV2Schema;
export const TransitionSchema = TransitionV2Schema;
export const RenderOutputSchema = RenderOutputSchemaV2;
export const RevisionSchema = RevisionV2Schema;
export const RecaptureLineageSchema = RecaptureLineageSchemaV2;
export const ProjectSchema = ProjectV2Schema;
export type ProjectBrief = ProjectBriefV2;
export type MediaProbe = MediaProbeV2;
export type RenderOutput = RenderOutputV2;
export type Revision = RevisionV2;
export type RecaptureLineage = RecaptureLineageV2;

export function parseProjectV2(input: unknown): ProjectV2 {
  return ProjectV2Schema.parse(input);
}
