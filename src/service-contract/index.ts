import { z } from "zod";
import { IdSchema } from "../schema.js";
import {
  AssetTypeSchema,
  ClipSchema,
  LayerSchema,
  MediaProbeV2Schema,
  MediaProvenanceSchema,
  ProjectBriefV2Schema,
  RenderOutputSchemaV2,
  RevisionV2Schema,
  TrackSchema,
  VerificationStateSchema,
} from "../schema-v2.js";
import {
  OperationBatchSchema,
  SCHEMA_RECOGNIZED_OPERATION_TYPES,
  type Operation,
  type OperationType,
} from "../operations-v2.js";

export const CONTRACT_VERSION = "v1" as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export type ContractVersion = z.infer<typeof ContractVersionSchema>;

const text = z.string().trim().min(1);
const boundedText = text.max(2000);
const datetime = z.string().datetime({ offset: true });
const boundedIdempotencyKey = z.string().trim().min(1).max(128);

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
  brief: ProjectBriefV2Schema,
  currentRevisionId: IdSchema,
  assetCount: z.number().int().nonnegative().max(100_000),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  verificationStatus: z.enum(["unknown", "stale", "passed", "failed"]),
  updatedAt: datetime,
}).strict();

export const AssetViewSchema = z.object({
  id: IdSchema,
  type: AssetTypeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  probe: MediaProbeV2Schema,
  provenance: MediaProvenanceSchema,
}).strict();

export const ClipViewSchema = ClipSchema;
export const LayerViewSchema = LayerSchema;
export const TrackViewSchema = TrackSchema;
export const RevisionViewSchema = RevisionV2Schema.extend({
  isCurrent: z.boolean(),
}).strict();
export const VerificationViewSchema = VerificationStateSchema;
export const RenderArtifactViewSchema = RenderOutputSchemaV2;

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

const operationTypeSchema = z.custom<OperationType>(
  (value) => typeof value === "string" && SCHEMA_RECOGNIZED_OPERATION_TYPES.includes(value as OperationType),
  "unknown semantic operation type",
);

const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const CapabilitySetSchema = z.object({
  contractVersion: ContractVersionSchema,
  target: z.enum(["local", "cloud"]),
  availableCommands: z.array(ServiceCommandSchema).max(12),
  availableOperations: z.array(operationTypeSchema).max(22),
  assetTypes: z.array(AssetTypeSchema).max(5),
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
  brief: ProjectBriefV2Schema.optional(),
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
  operations: OperationBatchSchema,
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
  message: boundedText.max(4000),
  retryable: z.boolean(),
  fieldIssues: z.array(z.object({ path: text.max(512), message: boundedText }).strict()).max(50).optional(),
  evidenceRefs: z.array(text.max(512)).max(100).optional(),
  requiredCapability: text.max(128).optional(),
}).strict();

export const JobInputOptionSchema = z.object({
  id: IdSchema,
  label: text.max(120),
  description: text.max(500).optional(),
}).strict();

const jobInputBase = {
  id: IdSchema,
  jobId: IdSchema,
  expectedRevisionId: IdSchema,
  title: text.max(120),
  message: boundedText,
  expiresAt: datetime.optional(),
};

export const CredentialActionSchema = z.object({
  type: z.literal("credential_action"),
  secureFlowId: IdSchema,
  action: z.enum(["open_secure_flow", "cancel_secure_flow"]),
}).strict();

export const JobInputRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...jobInputBase, kind: z.literal("browser_approval"), flowId: IdSchema, targetOrigin: z.string().url().max(2048) }).strict(),
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
  z.object({ type: z.literal("clarification"), text: boundedText }).strict(),
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
  SucceededJobSchema,
  FailedJobSchema,
  CancelledJobSchema,
]).superRefine((job, context) => {
  if (Date.parse(job.updatedAt) < Date.parse(job.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must be at or after createdAt" });
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
    const requiresRevision = ["asset_import", "browser_capture", "browser_recapture", "agent_edit", "apply_operations", "verify_revision"].includes(job.kind);
    const requiresAsset = job.kind === "asset_import" || job.kind === "browser_capture" || job.kind === "browser_recapture";
    const requiresOutput = job.kind === "render_preview" || job.kind === "render_final";
    if (requiresRevision && !result.revisionId) context.addIssue({ code: "custom", path: ["result", "revisionId"], message: "successful job requires its resulting or verified revision ID" });
    if (requiresAsset && !result.assetId) context.addIssue({ code: "custom", path: ["result", "assetId"], message: "successful asset job requires an asset ID" });
    if (requiresOutput && !result.outputId) context.addIssue({ code: "custom", path: ["result", "outputId"], message: "successful render job requires an output ID" });
  }
});

export const JobStateSchema = z.enum(["queued", "running", "waiting_for_input", "succeeded", "failed", "cancelled"]);

const StaleInputTerminalJobSchema = FailedJobSchema.extend({
  error: ErrorSchema.extend({ code: z.literal("STALE_JOB_INPUT") }).strict(),
}).strict();

export const JobInputSubmissionResultSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("accepted"), job: JobViewSchema }).strict().superRefine((result, context) => {
    if (result.job.state === "failed" && result.job.error.code === "STALE_JOB_INPUT") {
      context.addIssue({ code: "custom", path: ["job"], message: "stale input must use the stale terminal disposition" });
    }
  }),
  z.object({ disposition: z.literal("stale"), job: StaleInputTerminalJobSchema }).strict(),
]);

const eventEnvelope = {
  projectId: IdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: datetime,
};

export const ProjectEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventEnvelope, type: z.literal("job.updated"), job: JobViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("revision.created"), revision: RevisionViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("verification.updated"), revisionId: IdSchema, verification: VerificationViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("asset.updated"), asset: AssetViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("render_artifact.created"), artifact: RenderArtifactViewSchema }).strict(),
  z.object({ ...eventEnvelope, type: z.literal("capabilities.updated"), capabilities: CapabilitySetSchema }).strict(),
]);

const activeJobState = z.union([QueuedJobSchema, RunningJobSchema, WaitingForInputJobSchema]);
const terminalJobState = z.union([SucceededJobSchema, FailedJobSchema, CancelledJobSchema]);

export const CancelJobResponseSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("requested"), job: activeJobState }).strict().superRefine((result, context) => {
    if (!result.job.cancellationRequested) context.addIssue({ code: "custom", path: ["job", "cancellationRequested"], message: "requested cancellation must be visible on the job" });
  }),
  z.object({ disposition: z.literal("already_terminal"), job: terminalJobState }).strict(),
]);

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
export type JobInputOption = z.infer<typeof JobInputOptionSchema>;
export type CredentialAction = z.infer<typeof CredentialActionSchema>;
export type JobInputRequest = z.infer<typeof JobInputRequestSchema>;
export type JobInputResponse = z.infer<typeof JobInputResponseSchema>;
export type SubmitJobInputRequest = z.infer<typeof SubmitJobInputRequestSchema>;
export type JobProgress = z.infer<typeof JobProgressSchema>;
export type JobStage = z.infer<typeof JobStageSchema>;
export type JobView = z.infer<typeof JobViewSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type JobInputSubmissionResult = z.infer<typeof JobInputSubmissionResultSchema>;
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;
export type CancelJobResponse = z.infer<typeof CancelJobResponseSchema>;
export type SemanticOperation = Operation;
export type SemanticOperationType = OperationType;
