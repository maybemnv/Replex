import { z } from "zod";

export const CONTRACT_VERSION = "v1" as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export type ContractVersion = z.infer<typeof ContractVersionSchema>;

const text = z.string().trim().min(1);
const datetime = z.string().datetime({ offset: true });
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "invalid stable ID");
const milliseconds = z.number().int().finite().nonnegative();
const finite = z.number().finite();
const positiveNumber = finite.positive();
const positiveInteger = z.number().int().finite().positive();
const unitInterval = finite.min(0).max(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const boundedIdempotencyKey = z.string().trim().min(1).max(128);
const unsafePublicPath = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?:home|root|tmp|Users?|private|var|etc|mnt|Volumes|proc|sys|dev|opt|usr|bin|sbin|run|srv|workspace|workspaces)(?:[\\/]|(?=$|[\s"'<>),;])))|\bfile:\/\/|\bhttps?:\/\/[^\s/]*@/i;
const secretAssignment = /["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|api[-_]?key|password|secret|authorization|cookie|aws_access_key_id|aws_secret_access_key|aws_session_token)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;}"']+)/i;
const absolutePosixPath = /(?:^|[\s"'(=])\/(?:[^\s"'<>/]+(?:\/[^\s"'<>]*)?|(?=\s*$))/;
function hasUnsafePublicDetail(value: string): boolean {
  return value.trim() === "/" || /\b(?:open|path|file|directory|folder)\s+\/\s*$/i.test(value)
    || unsafePublicPath.test(value) || secretAssignment.test(value) || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value);
}
const safePublicText = (maxLength: number) => text.max(maxLength).refine((value) => !hasUnsafePublicDetail(value) && !absolutePosixPath.test(value), "public text must not contain host paths or secret-shaped details");
const safeClarificationText = (maxLength: number) => text.max(maxLength).refine((value) => !hasUnsafePublicDetail(value), "clarification must not contain secret-shaped details");
const publicErrorText = safePublicText(4000);

// Frozen wire v1 projections. External changes require a deliberate contract version bump.
function isScopedReference(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized);
  const safeObjectRef = /^object:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(normalized);
  return normalized !== "."
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split("/").includes("..")
    && !/%(?:2e|2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(normalized)
    && (!hasScheme || safeObjectRef)
    && !normalized.includes("\0");
}

const scopedReference = text.refine(isScopedReference, "reference must stay within an authorized project or object namespace");
const projectBriefV1Schema = z.object({
  audience: text.optional(),
  message: text.optional(),
  targetDurationMs: milliseconds.optional(),
}).strict();
const mediaProbeV1Schema = z.object({
  durationMs: milliseconds.optional(),
  width: positiveInteger.optional(),
  height: positiveInteger.optional(),
  fps: positiveNumber.optional(),
  videoCodec: text.optional(),
  audioCodec: text.optional(),
  channels: positiveInteger.optional(),
  sampleRateHz: positiveInteger.optional(),
}).strict();
const assetTypeV1Schema = z.enum(["browser_capture", "uploaded_video", "image", "audio", "generated_graphic"]);
const browserProvenanceV1Schema = z.object({
  kind: z.literal("browser"),
  flowId: IdSchema,
  sceneKey: IdSchema,
  actionIds: z.array(IdSchema).min(1).max(1000),
  checkpointActionId: IdSchema,
  runId: IdSchema,
  capturedAt: datetime,
  predecessorAssetId: IdSchema.optional(),
}).strict();
const uploadProvenanceV1Schema = z.object({
  kind: z.literal("upload"),
  originalFilename: text.max(255).refine((value) => !/[\\/:\0-\x1f]/.test(value), "filename must not contain a path or control characters"),
  importedAt: datetime,
  sourceSha256: sha256,
  importMethod: z.enum(["file_picker", "path", "upload"]),
  originalProbe: mediaProbeV1Schema,
}).strict();
const generatedProvenanceV1Schema = z.object({
  kind: z.literal("generated"),
  generator: text,
  generatedAt: datetime,
  inputRefs: z.array(IdSchema).max(1000),
}).strict();
const cropV1Schema = z.object({
  x: unitInterval,
  y: unitInterval,
  width: finite.positive().max(1),
  height: finite.positive().max(1),
}).strict().superRefine((value, context) => {
  if (value.x + value.width > 1) context.addIssue({ code: "custom", path: ["width"], message: "crop must remain inside normalized bounds" });
  if (value.y + value.height > 1) context.addIssue({ code: "custom", path: ["height"], message: "crop must remain inside normalized bounds" });
});
const transformV1Schema = z.object({
  x: finite,
  y: finite,
  scale: positiveNumber,
  rotation: finite,
  anchorX: unitInterval,
  anchorY: unitInterval,
}).strict();
const transitionV1Schema = z.object({
  type: z.enum(["cut", "crossfade"]),
  durationMs: milliseconds,
}).strict().superRefine((value, context) => {
  if (value.type === "cut" && value.durationMs !== 0) context.addIssue({ code: "custom", path: ["durationMs"], message: "cut duration must be zero" });
  if (value.type === "crossfade" && value.durationMs === 0) context.addIssue({ code: "custom", path: ["durationMs"], message: "crossfade duration must be positive" });
});
const clipViewV1Schema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  trackId: IdSchema,
  timelineStartMs: milliseconds,
  sourceInMs: milliseconds,
  sourceOutMs: milliseconds,
  speed: finite.positive().min(0.25).max(4),
  transform: transformV1Schema,
  crop: cropV1Schema.optional(),
  opacity: unitInterval,
  audioGainDb: finite,
  muted: z.boolean().default(false),
  transitionOut: transitionV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceOutMs <= value.sourceInMs) context.addIssue({ code: "custom", path: ["sourceOutMs"], message: "clip source range must be positive" });
  if (value.transitionOut && value.transitionOut.durationMs >= (value.sourceOutMs - value.sourceInMs) / value.speed) {
    context.addIssue({ code: "custom", path: ["transitionOut", "durationMs"], message: "transition must be shorter than the clip" });
  }
});
const textLayerPropertiesV1Schema = z.object({
  text,
  fontFamily: text.optional(),
  fontSize: positiveNumber.optional(),
  color: text.optional(),
}).strict();
const imageLayerPropertiesV1Schema = z.object({ assetId: IdSchema }).strict();
const graphicLayerPropertiesV1Schema = z.object({ assetId: IdSchema }).strict();
const keyframeV1Schema = z.object({
  id: IdSchema.optional(),
  property: z.enum(["position", "scale", "rotation", "opacity", "crop", "blur", "camera"]),
  timeMs: milliseconds,
  value: z.union([finite, cropV1Schema]),
  interpolation: z.enum(["linear", "ease_in", "ease_out", "ease_in_out"]),
}).strict().superRefine((value, context) => {
  if (value.property === "crop" && typeof value.value === "number") context.addIssue({ code: "custom", path: ["value"], message: "crop keyframes require crop bounds" });
  if (value.property !== "crop" && typeof value.value !== "number") context.addIssue({ code: "custom", path: ["value"], message: "numeric keyframes require a numeric value" });
});
const layerViewV1Schema = z.object({
  id: IdSchema,
  trackId: IdSchema,
  kind: z.enum(["text", "image", "graphic"]),
  timelineStartMs: milliseconds,
  durationMs: positiveInteger,
  properties: z.union([textLayerPropertiesV1Schema, imageLayerPropertiesV1Schema, graphicLayerPropertiesV1Schema]),
  keyframes: z.array(keyframeV1Schema).max(100_000),
}).strict().superRefine((value, context) => {
  const expectedKind = value.kind === "text" ? textLayerPropertiesV1Schema : value.kind === "image" ? imageLayerPropertiesV1Schema : graphicLayerPropertiesV1Schema;
  if (!expectedKind.safeParse(value.properties).success) context.addIssue({ code: "custom", path: ["properties"], message: `layer kind ${value.kind} requires matching properties` });
  const seen = new Set<string>();
  for (const [index, keyframe] of value.keyframes.entries()) {
    if (keyframe.timeMs > value.durationMs) context.addIssue({ code: "custom", path: ["keyframes", index, "timeMs"], message: "keyframe must fit within layer timing" });
    const key = `${keyframe.property}:${keyframe.timeMs}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["keyframes", index], message: "keyframe property and time must be unique" });
    seen.add(key);
  }
});
const trackViewV1Schema = z.object({
  id: IdSchema,
  kind: z.enum(["video", "audio", "overlay"]),
  order: z.number().int().finite().nonnegative(),
  muted: z.boolean(),
  locked: z.boolean(),
}).strict();
const revisionViewV1Schema = z.object({
  id: IdSchema,
  parentId: IdSchema.optional(),
  actor: z.enum(["user", "agent", "recapture", "migration"]),
  operationIds: z.array(IdSchema).max(100_000),
  manifestSha256: sha256,
  createdAt: datetime,
  isCurrent: z.boolean(),
}).strict();
const verificationRefV1Schema = z.object({
  id: IdSchema,
  revisionId: IdSchema,
  status: z.enum(["passed", "failed"]),
  evidenceRefs: z.array(scopedReference).max(1000),
}).strict();
const verificationViewV1Schema = z.object({
  revisionId: IdSchema,
  status: z.enum(["unknown", "stale", "passed", "failed"]),
  refs: z.array(verificationRefV1Schema).max(100_000),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, ref] of value.refs.entries()) {
    if (ids.has(ref.id)) context.addIssue({ code: "custom", path: ["refs", index, "id"], message: "verification reference IDs must be unique" });
    ids.add(ref.id);
  }
});
const renderArtifactViewV1Schema = z.object({
  outputId: IdSchema,
  ref: scopedReference,
  sha256,
  renderJobHash: sha256,
  probe: mediaProbeV1Schema,
  sourceRevisionId: IdSchema,
  revisionId: IdSchema.optional(),
  backendId: text,
  backendVersion: text,
  verificationRefId: IdSchema,
}).strict();

export const CommandMetaSchema = z.object({
  contractVersion: ContractVersionSchema,
  idempotencyKey: boundedIdempotencyKey,
}).strict();

export const ProjectCommandMetaSchema = CommandMetaSchema.extend({
  projectId: IdSchema,
}).strict();

export const RevisionCommandMetaSchema = ProjectCommandMetaSchema.extend({
  baseRevisionId: IdSchema,
}).strict();

export const RevisionReadMetaSchema = ProjectCommandMetaSchema.extend({
  revisionId: IdSchema,
}).strict();

export type CommandMeta = z.infer<typeof CommandMetaSchema>;
export type ProjectCommandMeta = z.infer<typeof ProjectCommandMetaSchema>;
export type RevisionCommandMeta = z.infer<typeof RevisionCommandMetaSchema>;
export type RevisionReadMeta = z.infer<typeof RevisionReadMetaSchema>;

export const ProjectSummarySchema = z.object({
  projectId: IdSchema,
  projectSchemaVersion: z.literal(2),
  brief: projectBriefV1Schema,
  currentRevisionId: IdSchema,
  assetCount: z.number().int().nonnegative().max(100_000),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  verificationStatus: z.enum(["unknown", "stale", "passed", "failed"]),
  updatedAt: datetime,
}).strict();

export const AssetViewSchema = z.object({
  id: IdSchema,
  type: assetTypeV1Schema,
  sha256,
  probe: mediaProbeV1Schema,
  provenance: z.discriminatedUnion("kind", [
    browserProvenanceV1Schema,
    uploadProvenanceV1Schema,
    generatedProvenanceV1Schema,
  ]),
}).strict().superRefine((asset, context) => {
  const expectedKind = asset.type === "browser_capture" ? "browser" : asset.type === "generated_graphic" ? "generated" : "upload";
  if (asset.provenance.kind !== expectedKind) {
    context.addIssue({ code: "custom", path: ["provenance", "kind"], message: `${asset.type} assets require ${expectedKind} provenance` });
  }
});

export const ClipViewSchema = clipViewV1Schema;
export const LayerViewSchema = layerViewV1Schema;
export const TrackViewSchema = trackViewV1Schema;
export const RevisionViewSchema = revisionViewV1Schema;
export const VerificationViewSchema = verificationViewV1Schema;
export const RenderArtifactViewSchema = renderArtifactViewV1Schema;

export const ProjectSnapshotSchema = z.object({
  summary: ProjectSummarySchema,
  revisionId: IdSchema,
  isCurrentRevision: z.boolean(),
  assets: z.array(AssetViewSchema).max(100_000),
  composition: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().finite().positive(),
    durationMs: z.number().int().positive().max(86_400_000),
    tracks: z.array(TrackViewSchema).max(1000),
    clips: z.array(ClipViewSchema).max(100_000),
    layers: z.array(LayerViewSchema).max(100_000),
  }).strict(),
  revisions: z.array(RevisionViewSchema).min(1).max(100_000),
  verification: VerificationViewSchema,
  renderArtifacts: z.array(RenderArtifactViewSchema).max(100_000),
  capabilities: z.lazy(() => CapabilitySetSchema),
}).strict().superRefine((snapshot, context) => {
  const current = snapshot.revisions.filter((revision) => revision.isCurrent);
  if (current.length !== 1 || current[0]?.id !== snapshot.summary.currentRevisionId) {
    context.addIssue({ code: "custom", path: ["revisions"], message: "exactly the summary current revision must be marked current" });
  }
  if (!snapshot.revisions.some((revision) => revision.id === snapshot.revisionId)) {
    context.addIssue({ code: "custom", path: ["revisionId"], message: "snapshot revision must exist" });
  }
  if (snapshot.isCurrentRevision !== (snapshot.revisionId === snapshot.summary.currentRevisionId)) {
    context.addIssue({ code: "custom", path: ["isCurrentRevision"], message: "current revision flag must match the summary" });
  }
  if (snapshot.isCurrentRevision && snapshot.summary.assetCount !== snapshot.assets.length) {
    context.addIssue({ code: "custom", path: ["assets"], message: "asset count must match the summary" });
  }
  if (snapshot.isCurrentRevision && snapshot.composition.durationMs !== snapshot.summary.durationMs) {
    context.addIssue({ code: "custom", path: ["composition", "durationMs"], message: "composition duration must match the summary" });
  }
  if (snapshot.verification.revisionId !== snapshot.revisionId) {
    context.addIssue({ code: "custom", path: ["verification", "revisionId"], message: "verification must match the snapshot revision" });
  }
  if (snapshot.renderArtifacts.some((artifact) => artifact.sourceRevisionId !== snapshot.revisionId)) {
    context.addIssue({ code: "custom", path: ["renderArtifacts"], message: "render artifacts must match the snapshot revision" });
  }
  const assetIds = new Set(snapshot.assets.map((asset) => asset.id));
  const trackIds = new Set(snapshot.composition.tracks.map((track) => track.id));
  const revisionIds = new Set(snapshot.revisions.map((revision) => revision.id));
  const verificationRefs = new Map(snapshot.verification.refs.map((ref) => [ref.id, ref]));
  if (assetIds.size !== snapshot.assets.length) context.addIssue({ code: "custom", path: ["assets"], message: "asset IDs must be unique" });
  if (trackIds.size !== snapshot.composition.tracks.length) context.addIssue({ code: "custom", path: ["composition", "tracks"], message: "track IDs must be unique" });
  if (revisionIds.size !== snapshot.revisions.length) context.addIssue({ code: "custom", path: ["revisions"], message: "revision IDs must be unique" });
  if (snapshot.verification.refs.some((ref) => !revisionIds.has(ref.revisionId))) context.addIssue({ code: "custom", path: ["verification", "refs"], message: "verification references must target listed revisions" });
  const outputIds = new Set<string>();
  for (const [index, artifact] of snapshot.renderArtifacts.entries()) {
    if (outputIds.has(artifact.outputId)) context.addIssue({ code: "custom", path: ["renderArtifacts", index, "outputId"], message: "render artifact IDs must be unique" });
    outputIds.add(artifact.outputId);
    const verification = verificationRefs.get(artifact.verificationRefId);
    if (!verification || verification.status !== "passed" || verification.revisionId !== snapshot.revisionId) {
      context.addIssue({ code: "custom", path: ["renderArtifacts", index, "verificationRefId"], message: "render artifacts require passed verification for the snapshot revision" });
    }
  }
  for (const [index, clip] of snapshot.composition.clips.entries()) {
    if (!assetIds.has(clip.assetId)) context.addIssue({ code: "custom", path: ["composition", "clips", index, "assetId"], message: "clip asset must exist in the snapshot" });
    if (!trackIds.has(clip.trackId)) context.addIssue({ code: "custom", path: ["composition", "clips", index, "trackId"], message: "clip track must exist in the snapshot" });
  }
  for (const [index, layer] of snapshot.composition.layers.entries()) {
    if (!trackIds.has(layer.trackId)) context.addIssue({ code: "custom", path: ["composition", "layers", index, "trackId"], message: "layer track must exist in the snapshot" });
    const assetId = "assetId" in layer.properties ? layer.properties.assetId : undefined;
    if (assetId && !assetIds.has(assetId)) context.addIssue({ code: "custom", path: ["composition", "layers", index, "properties", "assetId"], message: "layer asset must exist in the snapshot" });
  }
});

export const ProjectCreatedResponseSchema = z.object({
  contractVersion: ContractVersionSchema,
  projectId: IdSchema,
  revisionId: IdSchema,
  summary: ProjectSummarySchema,
}).strict().superRefine((created, context) => {
  if (created.summary.projectId !== created.projectId || created.summary.currentRevisionId !== created.revisionId) {
    context.addIssue({ code: "custom", path: ["summary"], message: "created project summary must match its new project and initial revision IDs" });
  }
});

export const ServiceCommandSchema = z.enum([
  "create_project",
  "open_project",
  "import_asset",
  "start_browser_capture",
  "recapture_browser_scene",
  "request_agent_edit",
  "apply_operations",
  "verify_revision",
  "render_preview",
  "render_final",
  "cancel_job",
  "submit_job_input",
]);

export const JobKindSchema = z.enum([
  "asset_import",
  "browser_capture",
  "browser_recapture",
  "agent_edit",
  "apply_operations",
  "verify_revision",
  "render_preview",
  "render_final",
]);

const serviceOperationTypesV1 = [
  "remove_asset", "create_clip", "split_clip", "trim_clip", "move_clip", "remove_clip", "replace_asset",
  "set_transform", "set_opacity", "set_speed", "set_transition", "add_text_layer", "update_text_layer",
  "add_image_layer", "remove_layer", "set_volume", "mute_clip", "animate_property", "apply_motion_preset",
] as const;
const operationTypeSchema = z.enum(serviceOperationTypesV1);

// Import and recapture use their service commands; edit batches carry only user-facing semantic operations.
export const SemanticOperationV1Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remove_asset"), assetId: IdSchema }).strict(),
  z.object({ type: z.literal("create_clip"), clip: ClipViewSchema }).strict(),
  z.object({ type: z.literal("split_clip"), clipId: IdSchema, atTimelineMs: milliseconds, newClipId: IdSchema }).strict(),
  z.object({ type: z.literal("trim_clip"), clipId: IdSchema, sourceInMs: milliseconds, sourceOutMs: milliseconds }).strict(),
  z.object({ type: z.literal("move_clip"), clipId: IdSchema, timelineStartMs: milliseconds, trackId: IdSchema.optional() }).strict(),
  z.object({ type: z.literal("remove_clip"), clipId: IdSchema }).strict(),
  z.object({ type: z.literal("replace_asset"), clipId: IdSchema, assetId: IdSchema }).strict(),
  z.object({ type: z.literal("set_transform"), clipId: IdSchema, transform: transformV1Schema, crop: cropV1Schema.optional() }).strict(),
  z.object({ type: z.literal("set_opacity"), clipId: IdSchema.optional(), layerId: IdSchema.optional(), opacity: unitInterval }).strict().superRefine((value, context) => {
    if ((value.clipId === undefined) === (value.layerId === undefined)) context.addIssue({ code: "custom", path: ["clipId"], message: "set_opacity requires exactly one clipId or layerId" });
  }),
  z.object({ type: z.literal("set_speed"), clipId: IdSchema, speed: finite.min(0.25).max(4) }).strict(),
  z.object({ type: z.literal("set_transition"), clipId: IdSchema, transition: transitionV1Schema }).strict(),
  z.object({ type: z.literal("add_text_layer"), layer: LayerViewSchema }).strict().superRefine((value, context) => {
    if (value.layer.kind !== "text") context.addIssue({ code: "custom", path: ["layer", "kind"], message: "text layer operation requires a text layer" });
  }),
  z.object({ type: z.literal("update_text_layer"), layerId: IdSchema, properties: textLayerPropertiesV1Schema }).strict(),
  z.object({ type: z.literal("add_image_layer"), layer: LayerViewSchema }).strict().superRefine((value, context) => {
    if (value.layer.kind !== "image") context.addIssue({ code: "custom", path: ["layer", "kind"], message: "image layer operation requires an image layer" });
  }),
  z.object({ type: z.literal("remove_layer"), layerId: IdSchema }).strict(),
  z.object({ type: z.literal("set_volume"), clipId: IdSchema, audioGainDb: finite }).strict(),
  z.object({ type: z.literal("mute_clip"), clipId: IdSchema, muted: z.boolean() }).strict(),
  z.object({ type: z.literal("animate_property"), layerId: IdSchema, keyframes: z.array(keyframeV1Schema).min(1).max(1000) }).strict(),
  z.object({ type: z.literal("apply_motion_preset"), targetId: IdSchema, presetId: IdSchema, presetVersion: text, parameters: z.record(z.string(), finite).optional() }).strict(),
]);
export const SemanticOperationBatchV1Schema = z.array(SemanticOperationV1Schema).min(1);

const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const CapabilitySetSchema = z.object({
  contractVersion: ContractVersionSchema,
  target: z.enum(["local", "cloud"]),
  availableCommands: z.array(ServiceCommandSchema).max(12),
  availableOperations: z.array(operationTypeSchema).max(serviceOperationTypesV1.length),
  assetTypes: z.array(assetTypeV1Schema).max(5),
  jobKinds: z.array(JobKindSchema).max(8),
  cancellationSupported: z.boolean(),
  credentialActions: z.array(z.literal("secure_browser_flow")).max(1),
}).strict().superRefine((capabilities, context) => {
  for (const field of ["availableCommands", "availableOperations", "assetTypes", "jobKinds", "credentialActions"] as const) {
    if (!unique(capabilities[field])) context.addIssue({ code: "custom", path: [field], message: "capability entries must be unique" });
  }
  const commands = new Set(capabilities.availableCommands);
  const jobs = new Set(capabilities.jobKinds);
  const commandForJob: Record<z.infer<typeof JobKindSchema>, z.infer<typeof ServiceCommandSchema>> = {
    asset_import: "import_asset",
    browser_capture: "start_browser_capture",
    browser_recapture: "recapture_browser_scene",
    agent_edit: "request_agent_edit",
    apply_operations: "apply_operations",
    verify_revision: "verify_revision",
    render_preview: "render_preview",
    render_final: "render_final",
  };
  for (const job of jobs) {
    if (!commands.has(commandForJob[job])) context.addIssue({ code: "custom", path: ["jobKinds"], message: `${job} requires its command to be available` });
  }
  if (capabilities.availableOperations.length > 0 && !commands.has("apply_operations")) {
    context.addIssue({ code: "custom", path: ["availableOperations"], message: "semantic operations require apply_operations" });
  }
  if (capabilities.cancellationSupported !== commands.has("cancel_job")) {
    context.addIssue({ code: "custom", path: ["cancellationSupported"], message: "cancellation capability must match cancel_job availability" });
  }
  const browserCommands = commands.has("start_browser_capture") || commands.has("recapture_browser_scene");
  if (capabilities.target === "cloud" && (browserCommands || capabilities.credentialActions.length > 0)) {
    context.addIssue({ code: "custom", path: ["target"], message: "browser capture and secure browser credential actions are local-only" });
  }
});

export const CreateProjectRequestSchema = CommandMetaSchema.extend({
  name: text.max(120),
  brief: projectBriefV1Schema.optional(),
}).strict();

// Opening a project is pinned to a concrete revision; callers use a summary to choose it.
export const OpenProjectRequestSchema = RevisionReadMetaSchema;

export const ImportAssetRequestSchema = RevisionCommandMetaSchema.extend({
  source: z.object({
    kind: z.enum(["local_token", "upload_session"]),
    ref: IdSchema,
  }).strict(),
  declaredFilename: text.max(255),
}).strict();

export const StartBrowserCaptureRequestSchema = RevisionCommandMetaSchema.extend({
  flowId: IdSchema,
  approved: z.literal(true),
  executionTarget: z.literal("local"),
}).strict();

export const RecaptureRequestSchema = RevisionCommandMetaSchema.extend({
  assetId: IdSchema,
  changedActionIds: z.array(IdSchema).min(1).max(1000),
  reason: text.max(1000),
  executionTarget: z.literal("local"),
}).strict();

export const RequestAgentEditRequestSchema = RevisionCommandMetaSchema.extend({
  prompt: text.max(20_000),
  selectedAssetIds: z.array(IdSchema).max(1000).optional(),
  selectedClipIds: z.array(IdSchema).max(10_000).optional(),
  threadId: IdSchema.optional(),
  preview: z.boolean(),
}).strict();
export const RequestAgentEditSchema = RequestAgentEditRequestSchema;

export const ApplyOperationsRequestSchema = RevisionCommandMetaSchema.extend({
  actor: z.enum(["user", "agent"]),
  operations: SemanticOperationBatchV1Schema,
}).strict();

export const VerifyRevisionRequestSchema = RevisionReadMetaSchema;
export const RenderPreviewRequestSchema = RevisionReadMetaSchema;
export const RenderFinalRequestSchema = RevisionReadMetaSchema.extend({
  verificationRefId: IdSchema,
}).strict();

export const CancelJobRequestSchema = ProjectCommandMetaSchema.extend({
  jobId: IdSchema,
}).strict();

export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "REVISION_CONFLICT",
  "PROJECT_NOT_FOUND",
  "ASSET_NOT_FOUND",
  "REVISION_NOT_FOUND",
  "INVALID_OPERATION",
  "INVALID_JOB_STATE",
  "MEDIA_UNAVAILABLE",
  "EXECUTION_FAILED",
  "CANCELLATION",
  "PATH_FAILURE",
  "STALE_JOB_INPUT",
  "CONTRACT_VERSION_UNSUPPORTED",
  "IDEMPOTENCY_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "ASSET_UNSUPPORTED",
  "ASSET_CHANGED",
  "UPLOAD_INTERRUPTED",
  "STORAGE_FAILED",
  "BROWSER_APPROVAL_REQUIRED",
  "BROWSER_CAPTURE_FAILED",
  "INSUFFICIENT_EVIDENCE",
  "AGENT_BUDGET_EXCEEDED",
  "OPERATION_REJECTED",
  "VERIFICATION_FAILED",
  "RENDER_FAILED",
  "JOB_NOT_CANCELLABLE",
  "JOB_NOT_FOUND",
  "EXECUTOR_OFFLINE",
  "UNAUTHORIZED",
]);

export const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: publicErrorText,
  retryable: z.boolean(),
  fieldIssues: z.array(z.object({ path: text.max(512).regex(/^[A-Za-z0-9_$.[\]-]+$/), message: publicErrorText }).strict()).max(50).optional(),
  evidenceRefs: z.array(text.max(512).refine((value) => isScopedReference(value) && !hasUnsafePublicDetail(value), "evidence reference must stay within an authorized project or object namespace")).max(100).optional(),
  requiredCapability: text.max(128).regex(/^[a-z][a-z0-9_]*$/).optional(),
}).strict();

export const ServiceErrorResponseSchema = z.object({
  contractVersion: ContractVersionSchema,
  error: ErrorSchema,
}).strict();

export const JobInputOptionSchema = z.object({
  id: IdSchema,
  label: safePublicText(120),
  description: safePublicText(500).optional(),
}).strict();

const jobInputBase = {
  id: IdSchema,
  jobId: IdSchema,
  expectedRevisionId: IdSchema,
  title: safePublicText(120),
  message: safePublicText(2000),
  expiresAt: datetime.optional(),
};

export const CredentialActionSchema = z.object({
  type: z.literal("credential_action"),
  secureFlowId: IdSchema,
  action: z.enum(["open_secure_flow", "cancel_secure_flow"]),
}).strict();

export const JobInputRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...jobInputBase, kind: z.literal("browser_approval"), flowId: IdSchema, targetOrigin: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      && url.origin === value && url.pathname === "/" && !url.search && !url.hash;
  }, "targetOrigin must be a credential-free HTTP origin") }).strict(),
  z.object({ ...jobInputBase, kind: z.literal("missing_media"), assetIds: z.array(IdSchema).min(1).max(1000) }).strict(),
  z.object({ ...jobInputBase, kind: z.literal("user_choice"), options: z.array(JobInputOptionSchema).min(1).max(8) }).strict(),
  z.object({ ...jobInputBase, kind: z.literal("clarification"), options: z.array(JobInputOptionSchema).max(8).optional() }).strict(),
  z.object({ ...jobInputBase, kind: z.literal("credential_action"), secureFlowId: IdSchema, action: z.literal("open_secure_flow") }).strict(),
  z.object({ ...jobInputBase, kind: z.literal("conflict_resolution"), currentRevisionId: IdSchema }).strict(),
]);

export const JobInputResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser_approval"), approved: z.boolean() }).strict(),
  z.object({ type: z.literal("missing_media"), source: z.object({ kind: z.enum(["local_token", "upload_session"]), ref: IdSchema }).strict() }).strict(),
  z.object({ type: z.literal("user_choice"), optionId: IdSchema }).strict(),
  z.object({ type: z.literal("clarification"), text: safeClarificationText(2000) }).strict(),
  CredentialActionSchema,
  z.object({ type: z.literal("conflict_resolution"), action: z.enum(["refresh", "cancel"]) }).strict(),
]);

export const SubmitJobInputRequestSchema = RevisionCommandMetaSchema.extend({
  jobId: IdSchema,
  inputRequestId: IdSchema,
  response: JobInputResponseSchema,
}).strict();

export const JobProgressSchema = z.object({
  completed: z.number().int().nonnegative().max(1_000_000),
  total: z.number().int().positive().max(1_000_000).optional(),
  percent: z.number().finite().min(0).max(100).optional(),
  unit: text.max(32).optional(),
}).strict().superRefine((progress, context) => {
  if (progress.total !== undefined && progress.completed > progress.total) {
    context.addIssue({ code: "custom", path: ["completed"], message: "completed must not exceed total" });
  }
});

export const JobStageSchema = z.enum([
  "queued",
  "importing",
  "hashing",
  "probing",
  "analyzing",
  "capturing",
  "planning",
  "validating_operations",
  "applying_revision",
  "awaiting_user_input",
  "verifying",
  "rendering_preview",
  "rendering_final",
  "finalizing",
]);

const jobCommon = {
  id: IdSchema,
  projectId: IdSchema,
  kind: JobKindSchema,
  baseRevisionId: IdSchema.optional(),
  revisionId: IdSchema.optional(),
  stage: JobStageSchema,
  progress: JobProgressSchema.optional(),
  createdAt: datetime,
  updatedAt: datetime,
};

const QueuedJobSchema = z.object({
  ...jobCommon,
  state: z.literal("queued"),
  cancellable: z.boolean(),
  cancellationRequested: z.boolean(),
}).strict();

const RunningJobSchema = z.object({
  ...jobCommon,
  state: z.literal("running"),
  cancellable: z.boolean(),
  cancellationRequested: z.boolean(),
}).strict();

const WaitingForInputJobSchema = z.object({
  ...jobCommon,
  state: z.literal("waiting_for_input"),
  cancellable: z.boolean(),
  cancellationRequested: z.boolean(),
  inputRequest: JobInputRequestSchema,
}).strict();

const CancellingJobSchema = z.object({
  ...jobCommon,
  state: z.literal("cancelling"),
  cancellable: z.literal(false),
  cancellationRequested: z.literal(true),
}).strict();

const SucceededJobSchema = z.object({
  ...jobCommon,
  state: z.literal("succeeded"),
  cancellable: z.literal(false),
  cancellationRequested: z.literal(false),
  result: z.object({
    revisionId: IdSchema.optional(),
    assetId: IdSchema.optional(),
    outputId: IdSchema.optional(),
  }).strict(),
}).strict();

const FailedJobSchema = z.object({
  ...jobCommon,
  state: z.literal("failed"),
  cancellable: z.literal(false),
  cancellationRequested: z.literal(false),
  error: ErrorSchema,
}).strict();

const CancelledJobSchema = z.object({
  ...jobCommon,
  state: z.literal("cancelled"),
  cancellable: z.literal(false),
  cancellationRequested: z.literal(false),
}).strict();

export const JobViewSchema = z.discriminatedUnion("state", [
  QueuedJobSchema,
  RunningJobSchema,
  WaitingForInputJobSchema,
  CancellingJobSchema,
  SucceededJobSchema,
  FailedJobSchema,
  CancelledJobSchema,
]).superRefine((job, context) => {
  const baseRevisionKinds = ["asset_import", "browser_capture", "browser_recapture", "agent_edit", "apply_operations"];
  const revisionKinds = ["verify_revision", "render_preview", "render_final"];
  if (baseRevisionKinds.includes(job.kind)) {
    if (!job.baseRevisionId) context.addIssue({ code: "custom", path: ["baseRevisionId"], message: "job requires a base revision pin" });
    if (job.revisionId !== undefined) context.addIssue({ code: "custom", path: ["revisionId"], message: "job cannot include both revision pins" });
  } else if (revisionKinds.includes(job.kind)) {
    if (!job.revisionId) context.addIssue({ code: "custom", path: ["revisionId"], message: "job requires a revision pin" });
    if (job.baseRevisionId !== undefined) context.addIssue({ code: "custom", path: ["baseRevisionId"], message: "job cannot include both revision pins" });
  }
  if (Date.parse(job.updatedAt) < Date.parse(job.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must be at or after createdAt" });
  }
  if ((job.state === "queued") !== (job.stage === "queued")) {
    context.addIssue({ code: "custom", path: ["stage"], message: "queued state and queued stage must agree" });
  }
  if (job.stage === "awaiting_user_input" && job.state !== "waiting_for_input") {
    context.addIssue({ code: "custom", path: ["stage"], message: "awaiting_user_input stage requires waiting_for_input state" });
  }
  if ((job.state === "queued" || job.state === "running" || job.state === "waiting_for_input") && job.cancellationRequested) {
    context.addIssue({ code: "custom", path: ["cancellationRequested"], message: "requested cancellation must use the cancelling state" });
  }
  if (job.state === "waiting_for_input") {
    const expected = job.baseRevisionId ?? job.revisionId;
    if (job.inputRequest.jobId !== job.id || (expected !== undefined && job.inputRequest.expectedRevisionId !== expected)) {
      context.addIssue({ code: "custom", path: ["inputRequest"], message: "input request must belong to the job and its pinned revision" });
    }
    if (job.stage !== "awaiting_user_input") {
      context.addIssue({ code: "custom", path: ["stage"], message: "waiting jobs must use awaiting_user_input stage" });
    }
  }
  if (job.state === "succeeded") {
    const result = job.result;
    const requiresRevision = ["asset_import", "browser_capture", "browser_recapture", "agent_edit", "apply_operations", ...revisionKinds].includes(job.kind);
    const requiresAsset = job.kind === "asset_import" || job.kind === "browser_capture" || job.kind === "browser_recapture";
    const requiresOutput = job.kind === "render_preview" || job.kind === "render_final";
    if (requiresRevision && !result.revisionId) context.addIssue({ code: "custom", path: ["result", "revisionId"], message: "successful job requires its resulting or verified revision ID" });
    if (requiresAsset && !result.assetId) context.addIssue({ code: "custom", path: ["result", "assetId"], message: "successful asset job requires an asset ID" });
    if (requiresOutput && !result.outputId) context.addIssue({ code: "custom", path: ["result", "outputId"], message: "successful render job requires an output ID" });
    if (revisionKinds.includes(job.kind) && result.revisionId !== job.revisionId) {
      context.addIssue({ code: "custom", path: ["result", "revisionId"], message: "derived job result must match its pinned revision" });
    }
  }
});

export const JobSchema = JobViewSchema;
export const JobStateSchema = z.enum(["queued", "running", "waiting_for_input", "cancelling", "succeeded", "failed", "cancelled"]);

const nonTerminalJobState = JobViewSchema.pipe(z.union([QueuedJobSchema, RunningJobSchema, WaitingForInputJobSchema, CancellingJobSchema]));

const StaleInputTerminalJobSchema = FailedJobSchema.extend({
  error: ErrorSchema.extend({ code: z.literal("STALE_JOB_INPUT") }).strict(),
}).strict();
const staleInputTerminalJobState = JobViewSchema.pipe(StaleInputTerminalJobSchema);

export const JobInputSubmissionResultSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("accepted"), job: nonTerminalJobState }).strict(),
  z.object({ disposition: z.literal("stale"), job: staleInputTerminalJobState }).strict(),
]);

const eventEnvelope = {
  projectId: IdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: datetime,
};

export const JobEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventEnvelope, type: z.literal("job.updated"), job: JobViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("revision.created"), revision: RevisionViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("verification.updated"), revisionId: IdSchema, verification: VerificationViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("asset.updated"), asset: AssetViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("render_artifact.created"), artifact: RenderArtifactViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("capabilities.updated"), capabilities: CapabilitySetSchema }).strict(),
]).superRefine((event, context) => {
  if (event.type === "job.updated" && event.projectId !== event.job.projectId) {
    context.addIssue({ code: "custom", path: ["job", "projectId"], message: "job projectId must match event projectId" });
  }
  if (event.type === "verification.updated" && event.revisionId !== event.verification.revisionId) {
    context.addIssue({ code: "custom", path: ["verification", "revisionId"], message: "verification revisionId must match event revisionId" });
  }
});
export const ProjectEventSchema = JobEventSchema;

const cancellingJobState = JobViewSchema.pipe(CancellingJobSchema);
const terminalJobState = JobViewSchema.pipe(z.union([SucceededJobSchema, FailedJobSchema, CancelledJobSchema]));

export const CancelJobResponseSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("requested"), job: cancellingJobState }).strict(),
  z.object({ disposition: z.literal("already_terminal"), job: terminalJobState }).strict(),
]);

export const JobEventPageSchema = z.object({
  contractVersion: ContractVersionSchema,
  projectId: IdSchema,
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  latestSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cursorExpired: z.boolean(),
  hasMore: z.boolean(),
  events: z.array(JobEventSchema).max(1000),
}).strict().superRefine((page, context) => {
  if (page.afterSequence > page.latestSequence) {
    context.addIssue({ code: "custom", path: ["afterSequence"], message: "event cursor cannot be ahead of the latest sequence" });
  }
  let previous = page.afterSequence;
  for (const [index, event] of page.events.entries()) {
    if (event.projectId !== page.projectId || event.sequence <= previous || event.sequence > page.latestSequence) {
      context.addIssue({ code: "custom", path: ["events", index], message: "event page must contain ordered events for its project and cursor" });
    }
    previous = event.sequence;
  }
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type AssetView = z.infer<typeof AssetViewSchema>;
export type ClipView = z.infer<typeof ClipViewSchema>;
export type LayerView = z.infer<typeof LayerViewSchema>;
export type TrackView = z.infer<typeof TrackViewSchema>;
export type RevisionView = z.infer<typeof RevisionViewSchema>;
export type VerificationView = z.infer<typeof VerificationViewSchema>;
export type RenderArtifactView = z.infer<typeof RenderArtifactViewSchema>;
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
export type ProjectCreatedResponse = z.infer<typeof ProjectCreatedResponseSchema>;
export type ServiceCommand = z.infer<typeof ServiceCommandSchema>;
export type JobKind = z.infer<typeof JobKindSchema>;
export type CapabilitySet = z.infer<typeof CapabilitySetSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type OpenProjectRequest = z.infer<typeof OpenProjectRequestSchema>;
export type ImportAssetRequest = z.infer<typeof ImportAssetRequestSchema>;
export type StartBrowserCaptureRequest = z.infer<typeof StartBrowserCaptureRequestSchema>;
export type RecaptureRequest = z.infer<typeof RecaptureRequestSchema>;
export type RequestAgentEdit = z.infer<typeof RequestAgentEditSchema>;
export type RequestAgentEditRequest = z.infer<typeof RequestAgentEditRequestSchema>;
export type ApplyOperationsRequest = z.infer<typeof ApplyOperationsRequestSchema>;
export type VerifyRevisionRequest = z.infer<typeof VerifyRevisionRequestSchema>;
export type RenderPreviewRequest = z.infer<typeof RenderPreviewRequestSchema>;
export type RenderFinalRequest = z.infer<typeof RenderFinalRequestSchema>;
export type CancelJobRequest = z.infer<typeof CancelJobRequestSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ContractError = z.infer<typeof ErrorSchema>;
export type ServiceErrorResponse = z.infer<typeof ServiceErrorResponseSchema>;
export type JobInputOption = z.infer<typeof JobInputOptionSchema>;
export type CredentialAction = z.infer<typeof CredentialActionSchema>;
export type JobInputRequest = z.infer<typeof JobInputRequestSchema>;
export type JobInputResponse = z.infer<typeof JobInputResponseSchema>;
export type SubmitJobInputRequest = z.infer<typeof SubmitJobInputRequestSchema>;
export type JobProgress = z.infer<typeof JobProgressSchema>;
export type JobStage = z.infer<typeof JobStageSchema>;
export type JobView = z.infer<typeof JobViewSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type JobInputSubmissionResult = z.infer<typeof JobInputSubmissionResultSchema>;
export type JobEvent = z.infer<typeof JobEventSchema>;
export type JobEventPage = z.infer<typeof JobEventPageSchema>;
export type ProjectEvent = JobEvent;
export type CancelJobResponse = z.infer<typeof CancelJobResponseSchema>;
export type SemanticOperation = z.infer<typeof SemanticOperationV1Schema>;
export type SemanticOperationType = z.infer<typeof operationTypeSchema>;
