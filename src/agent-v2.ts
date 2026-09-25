import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { checkedEvidenceRoot, readEvidenceFile, V2InspectRequestSchema, type V2InspectImage, type V2InspectRequest } from "./inspect-v2.js";
import { generateMediaEvidence, type MediaEvidenceIndex } from "./media-evidence.js";
import { OperationLogRecordSchema, OperationSchema, applyOperationBatch, semanticHashV2, type Operation, type OperationBatchInput, type OperationLogRecord } from "./operations-v2.js";
import { buildMediaExecutionJob, executeMediaExecutionJob, registerRenderArtifactV2, type MediaExecutionAuthorization, type MediaExecutionOptions, type RenderArtifactV2 } from "./render-v2.js";
import { AssetHandleSchema, ProjectV2Schema, type AssetHandle, type ProjectV2 } from "./schema-v2.js";
import { IdSchema } from "./schema.js";

export { V2InspectRequestSchema };
export type { V2InspectRequest };
export type V2InspectionImage = V2InspectImage;
export type V2InspectionResult =
  | { ok: true; kind?: V2InspectRequest["kind"]; data: unknown; evidenceRefs: string[]; images?: V2InspectionImage[] }
  | { ok: false; code: string };

export interface V2InspectorCallContext {
  evidenceRoot: string;
  operationLog: readonly OperationLogRecord[];
  signal: AbortSignal;
}

export type V2Inspector = (project: ProjectV2, request: V2InspectRequest, context?: V2InspectorCallContext) => Promise<V2InspectionResult>;

export interface V2AgentToolDefinition {
  name: "inspect_v2" | "propose_edit_batch";
  description: string;
  parameters: Readonly<Record<string, unknown>>;
  strict: true;
}

export interface V2AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface V2AgentToolResult {
  callId: string;
  name: string;
  output: unknown;
  images?: readonly V2InspectionImage[];
}

export interface V2AgentModelRequest {
  intentId: string;
  threadId: string;
  prompt: string;
  previousResponseId?: string;
  context: {
    projectId: string;
    currentRevisionId: string;
    currentRevisionHash: string;
  };
  instructions: string;
  tools: readonly V2AgentToolDefinition[];
  toolResults: readonly V2AgentToolResult[];
  /** The provider must enforce this per-call output ceiling. */
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface V2AgentModelResponse {
  responseId: string;
  calls: readonly V2AgentToolCall[];
  text?: string;
}

export interface V2AgentModelClient {
  respond(input: V2AgentModelRequest): Promise<V2AgentModelResponse>;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

export interface V2ConversationThread {
  threadId: string;
  projectId: string;
  currentRevisionId: string;
  currentRevisionHash: string;
  previousResponseId?: string;
  operationIds: string[];
}

export interface V2CanonicalRevisionCommit {
  baseRevisionId: string;
  baseRevisionHash: string;
  /** Candidate includes the semantic revision and its verified preview registration for atomic persistence. */
  project: ProjectV2;
  operationLog: OperationLogRecord[];
  /** Host CAS resolves with the publication outcome even if this signal arrives during its atomic write. */
  signal: AbortSignal;
}

export type V2CanonicalRevisionCommitResult =
  | { ok: true; project: ProjectV2 }
  | { ok: false; code: string; detail?: string };

export interface V2ConversationRequest {
  project: ProjectV2;
  prompt: string;
  threadId: string;
  threadState?: V2ConversationThread;
  inspect: V2Inspector;
  model: V2AgentModelClient;
  /** Host-loaded operation history; inspection keeps only bounded safe summaries. */
  operationLog: readonly OperationLogRecord[];
  assetHandles: readonly AssetHandle[];
  renderAuthorization: MediaExecutionAuthorization;
  renderOptions?: MediaExecutionOptions;
  commitCanonicalRevision: (input: V2CanonicalRevisionCommit) => Promise<V2CanonicalRevisionCommitResult>;
  evidenceRoot: string;
  signal?: AbortSignal;
  intentId?: string;
}

export interface V2ConversationAttribution {
  threadId: string;
  intentId: string;
  actor: "agent";
  baseRevisionId: string;
  baseRevisionHash: string;
  resultRevisionId: string;
  resultRevisionHash: string;
  responseIds: string[];
  operationIds: string[];
}

export interface V2AcceptedBatch {
  baseRevisionId: string;
  resultRevisionId: string;
  operationIds: string[];
  evidenceRefs: string[];
  renderJobHash: string;
  verificationRefId: string;
}

export type V2ConversationFailureCode =
  | "INVALID_PROJECT" | "INVALID_REQUEST" | "STALE_THREAD" | "CANCELLED" | "TIMEOUT"
  | "MODEL_ERROR" | "INSPECTION_FAILED" | "COMMIT_REJECTED" | "COMMIT_PROTOCOL_ERROR"
  | "PREVIEW_FAILED" | "BUDGET_EXCEEDED";

export type V2ConversationResult =
  | {
    ok: true;
    status: "completed";
    project: ProjectV2;
    threadState: V2ConversationThread;
    assistantText: string;
    attribution: V2ConversationAttribution;
    acceptedBatches: V2AcceptedBatch[];
    operationLog: OperationLogRecord[];
    previews: RenderArtifactV2[];
  }
  | {
    ok: false;
    status: "failed" | "rejected";
    code: V2ConversationFailureCode | string;
    detail: string;
    project: ProjectV2;
    threadState?: V2ConversationThread;
    attribution: V2ConversationAttribution;
    acceptedBatches: V2AcceptedBatch[];
    operationLog: OperationLogRecord[];
    previews: RenderArtifactV2[];
  };

const nullableInspectionWireSchema = z.object({
  kind: z.enum(["project_summary", "assets", "clips", "media_evidence", "verification", "operation_history"]),
  assetId: IdSchema.max(128).nullable(),
  offset: z.number().int().nonnegative().max(1_000_000).nullable(),
  limit: z.number().int().min(1).max(25).nullable(),
  image: z.enum(["contact_sheet", "selected_frame"]).nullable(),
  frameOffset: z.number().int().min(0).max(3).nullable(),
}).strict();

const strictTransformWireSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scale: z.number().positive().finite(),
  rotation: z.number().finite(),
  anchorX: z.number().min(0).max(1),
  anchorY: z.number().min(0).max(1),
}).strict();
const strictCropWireSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict();
const operationWireSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trim_clip"), clipId: IdSchema, sourceInMs: z.number().int().nonnegative(), sourceOutMs: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("set_transform"), clipId: IdSchema, transform: strictTransformWireSchema, crop: strictCropWireSchema.nullable() }).strict(),
  z.object({ type: z.literal("set_opacity"), clipId: IdSchema.nullable(), layerId: IdSchema.nullable(), opacity: z.number().finite().min(0).max(1) }).strict(),
  z.object({ type: z.literal("set_speed"), clipId: IdSchema, speed: z.number().finite().min(0.25).max(4) }).strict(),
  z.object({ type: z.literal("set_volume"), clipId: IdSchema, audioGainDb: z.number().finite() }).strict(),
  z.object({ type: z.literal("mute_clip"), clipId: IdSchema, muted: z.boolean() }).strict(),
]);
const proposalWireSchema = z.object({
  baseRevisionId: IdSchema,
  evidenceRefs: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
  operations: z.array(operationWireSchema).min(1).max(12),
}).strict();
const proposalLogicalSchema = z.object({
  baseRevisionId: IdSchema,
  evidenceRefs: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
  operations: z.array(OperationSchema).min(1).max(12),
}).strict();
const conversationThreadSchema = z.object({
  threadId: IdSchema,
  projectId: IdSchema,
  currentRevisionId: IdSchema,
  currentRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  previousResponseId: IdSchema.max(128).optional(),
  operationIds: z.array(IdSchema).max(10_000),
}).strict();

export const V2_AGENT_TOOLS: readonly V2AgentToolDefinition[] = freezeDeep([
  {
    name: "inspect_v2",
    description: "Request one bounded project, media evidence, verification, or operation-history view.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["project_summary", "assets", "clips", "media_evidence", "verification", "operation_history"] },
        assetId: { type: ["string", "null"] },
        offset: { type: ["integer", "null"], minimum: 0, maximum: 1_000_000 },
        limit: { type: ["integer", "null"], minimum: 1, maximum: 25 },
        image: { type: ["string", "null"], enum: ["contact_sheet", "selected_frame", null] },
        frameOffset: { type: ["integer", "null"], minimum: 0, maximum: 3 },
      },
      required: ["kind", "assetId", "offset", "limit", "image", "frameOffset"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_edit_batch",
    description: "Propose one atomic set of typed Replex semantic edits against the current revision. Cite refs returned by inspect_v2.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        baseRevisionId: { type: "string" },
        evidenceRefs: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
        operations: { type: "array", minItems: 1, maxItems: 12, items: { anyOf: [
          { type: "object", properties: { type: { enum: ["trim_clip"] }, clipId: { type: "string" }, sourceInMs: { type: "integer", minimum: 0 }, sourceOutMs: { type: "integer", minimum: 0 } }, required: ["type", "clipId", "sourceInMs", "sourceOutMs"], additionalProperties: false },
          { type: "object", properties: {
            type: { enum: ["set_transform"] }, clipId: { type: "string" },
            transform: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, scale: { type: "number", minimum: 0 }, rotation: { type: "number" }, anchorX: { type: "number", minimum: 0, maximum: 1 }, anchorY: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y", "scale", "rotation", "anchorX", "anchorY"], additionalProperties: false },
            crop: { anyOf: [
              { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, width: { type: "number", minimum: 0, maximum: 1 }, height: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y", "width", "height"], additionalProperties: false },
              { type: "null" },
            ] },
          }, required: ["type", "clipId", "transform", "crop"], additionalProperties: false },
          { type: "object", properties: { type: { enum: ["set_opacity"] }, clipId: { type: ["string", "null"] }, layerId: { type: ["string", "null"] }, opacity: { type: "number", minimum: 0, maximum: 1 } }, required: ["type", "clipId", "layerId", "opacity"], additionalProperties: false },
          { type: "object", properties: { type: { enum: ["set_speed"] }, clipId: { type: "string" }, speed: { type: "number", minimum: 0.25, maximum: 4 } }, required: ["type", "clipId", "speed"], additionalProperties: false },
          { type: "object", properties: { type: { enum: ["set_volume"] }, clipId: { type: "string" }, audioGainDb: { type: "number" } }, required: ["type", "clipId", "audioGainDb"], additionalProperties: false },
          { type: "object", properties: { type: { enum: ["mute_clip"] }, clipId: { type: "string" }, muted: { type: "boolean" } }, required: ["type", "clipId", "muted"], additionalProperties: false },
        ] } },
      },
      required: ["baseRevisionId", "evidenceRefs", "operations"],
      additionalProperties: false,
    },
  },
]);

function parseInspectRequest(input: unknown): V2InspectRequest | undefined {
  const direct = V2InspectRequestSchema.safeParse(input);
  if (direct.success) return direct.data;
  const wire = nullableInspectionWireSchema.safeParse(input);
  if (!wire.success) return undefined;
  const normalize = (candidate: unknown): V2InspectRequest | undefined => {
    const parsed = V2InspectRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  };
  const value = wire.data;
  if (value.kind === "project_summary" || value.kind === "verification") {
    if (value.assetId !== null || value.offset !== null || value.limit !== null || value.image !== null || value.frameOffset !== null) return undefined;
    return normalize({ kind: value.kind });
  }
  if (value.kind === "assets" || value.kind === "clips") {
    if (value.assetId !== null || value.image !== null || value.frameOffset !== null) return undefined;
    return normalize({ kind: value.kind, ...(value.offset !== null ? { offset: value.offset } : {}), ...(value.limit !== null ? { limit: value.limit } : {}) });
  }
  if (value.kind === "media_evidence") {
    if (!value.assetId || value.offset !== null || value.limit !== null) return undefined;
    return normalize({ kind: value.kind, assetId: value.assetId, ...(value.image !== null ? { image: value.image } : {}), ...(value.frameOffset !== null ? { frameOffset: value.frameOffset } : {}) });
  }
  if (value.offset !== null || value.assetId !== null || value.image !== null || value.frameOffset !== null) return undefined;
  return normalize({ kind: "operation_history", ...(value.limit !== null ? { limit: value.limit } : {}) });
}

function parseProposal(input: unknown): { baseRevisionId: string; evidenceRefs: string[]; operations: Operation[] } | undefined {
  const logical = proposalLogicalSchema.safeParse(input);
  if (logical.success) return logical.data;
  const wire = proposalWireSchema.safeParse(input);
  if (!wire.success) return undefined;
  const operations: Operation[] = [];
  for (const operation of wire.data.operations) {
    const normalized = operation.type === "set_transform"
      ? { ...operation, ...(operation.crop === null ? { crop: undefined } : {}) }
      : operation.type === "set_opacity"
        ? {
          ...operation,
          ...(operation.clipId === null ? { clipId: undefined } : {}),
          ...(operation.layerId === null ? { layerId: undefined } : {}),
        }
        : operation;
    const parsedOperation = OperationSchema.safeParse(normalized);
    if (!parsedOperation.success) return undefined;
    operations.push(parsedOperation.data);
  }
  return { ...wire.data, operations };
}

const allowedAgentOperationTypes = new Set<Operation["type"]>([
  "trim_clip", "set_transform", "set_opacity", "set_speed", "set_volume", "mute_clip",
]);
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_INSPECTION_DATA_BYTES = 64 * 1024;
const MAX_IMAGES_PER_RESULT = 8;
const MAX_IMAGE_BYTES_PER_RESULT = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES_PER_INTENT = 4 * 1024 * 1024;
export const V2_AGENT_MAX_OUTPUT_TOKENS_PER_CALL = 1200;
const MAX_MODEL_CALLS = 4;
const MAX_TOOL_CALLS = 12;
const MAX_WALL_TIME_MS = 120_000;
const MAX_PER_CALL_MS = 20_000;
const MAX_PREVIEW_CALL_MS = 60_000;
const MAX_PREVIEW_EVIDENCE_CALL_MS = 30_000;

type FailureStatus = "failed" | "rejected";
class AgentCallError extends Error {
  constructor(readonly code: "CANCELLED" | "TIMEOUT" | "BUDGET_EXCEEDED", message: string) {
    super(message);
  }
}

const canonicalHashForCurrentRevision = (project: ProjectV2): string => {
  const revision = project.revisions.find(({ id }) => id === project.currentRevisionId);
  if (!revision) throw new Error("current project revision is missing");
  const hash = semanticHashV2(project);
  if (revision.manifestSha256 !== hash) throw new Error("current project revision hash does not match semantic state");
  return hash;
};

function errorDetail(error: unknown): string {
  if (error instanceof AgentCallError) return error.message;
  return "operation failed";
}

async function withBoundedCall<T>(
  label: string,
  parentSignal: AbortSignal | undefined,
  remainingMs: () => number,
  operation: (signal: AbortSignal) => Promise<T>,
  callLimitMs = MAX_PER_CALL_MS,
): Promise<T> {
  if (parentSignal?.aborted) throw new AgentCallError("CANCELLED", "conversation was cancelled");
  const timeoutMs = Math.min(callLimitMs, remainingMs());
  if (timeoutMs <= 0) throw new AgentCallError("TIMEOUT", "conversation exceeded its wall-time limit");

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => reject(new AgentCallError(timedOut ? "TIMEOUT" : "CANCELLED", timedOut ? `${label} exceeded its call deadline` : "conversation was cancelled"));
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function boundedJsonBytes(value: unknown): number {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { return Number.POSITIVE_INFINITY; }
  return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, "utf8");
}

function hasUnsafeDisclosure(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return /(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUnsafeDisclosure(item, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    /(?:cookie|token|secret|storage.?state|api.?key|authorization|raw.?argv|filter.?graph|shell.?command)/i.test(key)
      || hasUnsafeDisclosure(child, seen));
}

function safeEvidenceReference(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.length <= 512
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split("/").includes("..")
    && !normalized.includes("://")
    && !normalized.includes("\0");
}

function validateInspection(result: V2InspectionResult): { refs: string[]; images: V2InspectionImage[]; data: unknown } {
  if (!result.ok) throw new Error(`bounded inspector returned ${result.code}`);
  if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length > 64
    || result.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0 || !safeEvidenceReference(ref))) {
    throw new Error("bounded inspector returned invalid evidence references");
  }
  if (boundedJsonBytes(result.data) > MAX_INSPECTION_DATA_BYTES || hasUnsafeDisclosure(result.data)) throw new Error("bounded inspector data exceeds the safe model-facing limit");
  const images = result.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_RESULT) throw new Error("bounded inspector returned too many images");
  const refs = new Set(result.evidenceRefs);
  let imageBytes = 0;
  for (const image of images) {
    if (!image || !safeEvidenceReference(image.ref) || !refs.has(image.ref) || !["image/png", "image/jpeg"].includes(image.mimeType) || !(image.bytes instanceof Uint8Array)) {
      throw new Error("bounded inspector returned an invalid image evidence item");
    }
    imageBytes += image.bytes.byteLength;
  }
  if (imageBytes > MAX_IMAGE_BYTES_PER_RESULT) throw new Error("bounded inspector image bytes exceed the per-result limit");
  return {
    refs: [...new Set(result.evidenceRefs)],
    images: images.map((image) => ({ ...image, bytes: new Uint8Array(image.bytes) })),
    data: structuredClone(result.data),
  };
}

function boundedInspectionOutput(data: unknown, evidenceRefs: readonly string[]): unknown {
  return { ok: true, data, evidenceRefs };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function createPreviewEvidence(
  request: V2ConversationRequest,
  artifact: RenderArtifactV2,
  remainingMs: () => number,
): Promise<{ index: MediaEvidenceIndex; image: V2InspectionImage }> {
  if (!isAbsolute(request.evidenceRoot)) throw new Error("preview evidence root must be an authorized absolute project path");
  const root = await realpath(request.renderAuthorization.projectRoot);
  const evidenceRoot = resolve(request.evidenceRoot);
  if (!inside(root, evidenceRoot)) throw new Error("preview evidence root escaped the project media store");
  const refParts = artifact.ref.replace(/\\/g, "/").split("/");
  if (refParts.some((part) => !part || part === "." || part === "..")) throw new Error("render artifact reference is invalid");
  const sourcePath = resolve(root, ...refParts);
  if (!inside(root, sourcePath)) throw new Error("render artifact reference escaped the project media store");
  const [sourceReal, sourceLink, sourceInfo] = await Promise.all([realpath(sourcePath), lstat(sourcePath), stat(sourcePath)]);
  if (!inside(root, sourceReal) || sourceLink.isSymbolicLink() || !sourceInfo.isFile()) throw new Error("render artifact is not a regular project-owned file");
  const deadlineMs = Math.min(MAX_PREVIEW_EVIDENCE_CALL_MS, remainingMs());
  if (deadlineMs < 1_000) throw new Error("preview evidence deadline is too short");
  const index = await generateMediaEvidence({
    asset: { assetId: artifact.outputId, sha256: artifact.sha256, ref: artifact.ref },
    resolveSource: async () => sourcePath,
    evidenceRoot,
    ffmpegPath: request.renderOptions?.ffmpegPath,
    ffprobePath: request.renderOptions?.ffprobePath,
    deadlineMs,
  });
  if (index.sourceSha256 !== artifact.sha256 || index.sourceAssetId !== artifact.outputId) throw new Error("preview evidence index is not bound to the rendered artifact");
  const imageArtifact = index.artifacts.find(({ kind }) => kind === "contact_sheet")
    ?? index.artifacts.find(({ kind }) => kind === "selected_frame");
  if (!imageArtifact || imageArtifact.sizeBytes > MAX_IMAGE_BYTES_PER_RESULT
    || !["image/png", "image/jpeg"].includes(imageArtifact.contentType)) throw new Error("preview evidence has no bounded image");
  const evidenceRealRoot = await checkedEvidenceRoot(evidenceRoot);
  if (!inside(root, evidenceRealRoot)) throw new Error("preview evidence root escaped the authorized project root");
  const imageBytes = await readEvidenceFile(evidenceRealRoot, imageArtifact.ref, MAX_IMAGE_BYTES_PER_RESULT);
  const imageHash = createHash("sha256").update(imageBytes).digest("hex");
  if (imageBytes.byteLength !== imageArtifact.sizeBytes || imageHash !== imageArtifact.sha256) {
    throw new Error("preview image evidence hash does not match the media evidence index");
  }
  return {
    index,
    image: {
      ref: imageArtifact.ref,
      mimeType: imageArtifact.contentType as "image/png" | "image/jpeg",
      bytes: new Uint8Array(imageBytes),
    },
  };
}

function failure(
  status: FailureStatus,
  code: string,
  detail: string,
  project: ProjectV2,
  threadId: string,
  intentId: string,
  baseRevisionId: string,
  baseRevisionHash: string,
  responseIds: string[],
  operationLog: OperationLogRecord[],
  acceptedBatches: V2AcceptedBatch[],
  previews: RenderArtifactV2[],
  threadState?: V2ConversationThread,
): V2ConversationResult {
  const current = project.revisions.find(({ id }) => id === project.currentRevisionId);
  return {
    ok: false,
    status,
    code,
    detail,
    project,
    ...(threadState ? { threadState } : {}),
    attribution: {
      threadId,
      intentId,
      actor: "agent",
      baseRevisionId,
      baseRevisionHash,
      resultRevisionId: project.currentRevisionId,
      resultRevisionHash: current?.manifestSha256 ?? baseRevisionHash,
      responseIds: [...responseIds],
      operationIds: operationLog.map(({ id }) => id),
    },
    acceptedBatches: [...acceptedBatches],
    operationLog: [...operationLog],
    previews: [...previews],
  };
}

const instructions = [
  "You edit a Replex ProjectV2 only by proposing typed semantic operations through propose_edit_batch.",
  "Inspect bounded project evidence before editing. Every proposed edit must cite evidence references already returned by inspect_v2.",
  "Use the exact currentRevisionId supplied in context as baseRevisionId. After acceptance, use the new currentRevisionId for a follow-up batch.",
  "The currently supported edit operations are trim_clip, set_transform, set_opacity, set_speed, set_volume, and mute_clip.",
  "Never request paths, shell, JavaScript, FFmpeg commands, arbitrary files, raw project JSON, or backend implementation details.",
  "After a successful preview, inspect the result if useful, then finish with a concise response. A preview is technically verified, not a claim of creative approval.",
].join(" ");

/** Runs a bounded typed edit loop; the host commits only after its preview and evidence verify. */
export async function runConversationalEditV2(request: V2ConversationRequest): Promise<V2ConversationResult> {
  const parsedThreadId = IdSchema.safeParse(request.threadId);
  const threadId = parsedThreadId.success ? parsedThreadId.data : "thread-invalid";
  const intentWasValid = request.intentId === undefined || IdSchema.safeParse(request.intentId).success;
  const intentId = request.intentId && intentWasValid ? request.intentId : `intent-${randomUUID()}`;
  const initialParsed = ProjectV2Schema.safeParse(request.project);
  if (!initialParsed.success) {
    return failure("rejected", "INVALID_PROJECT", "input is not a valid ProjectV2", request.project, threadId, intentId, request.project.currentRevisionId, "0".repeat(64), [], [], [], []);
  }

  let project = initialParsed.data;
  let baseRevisionHash: string;
  try { baseRevisionHash = canonicalHashForCurrentRevision(project); }
  catch (error) {
    return failure("rejected", "INVALID_PROJECT", errorDetail(error), project, threadId, intentId, project.currentRevisionId, "0".repeat(64), [], [], [], []);
  }
  const baseRevisionId = project.currentRevisionId;

  if (!parsedThreadId.success || !intentWasValid || typeof request.prompt !== "string" || !request.prompt.trim()
    || Buffer.byteLength(request.prompt, "utf8") > MAX_PROMPT_BYTES
    || !IdSchema.safeParse(intentId).success || typeof request.evidenceRoot !== "string") {
    return failure("rejected", "INVALID_REQUEST", "thread, intent, or prompt is invalid or exceeds its limit", project, threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], []);
  }

  const parsedThread = request.threadState === undefined ? undefined : conversationThreadSchema.safeParse(request.threadState);
  if (request.threadState !== undefined && (!parsedThread || !parsedThread.success)) {
    return failure("rejected", "STALE_THREAD", "saved conversation state is invalid", project, threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], []);
  }
  const savedThread = parsedThread?.success ? parsedThread.data : undefined;
  if (savedThread && (savedThread.threadId !== threadId
    || savedThread.projectId !== project.projectId
    || savedThread.currentRevisionId !== project.currentRevisionId
    || savedThread.currentRevisionHash !== baseRevisionHash)) {
    return failure("rejected", "STALE_THREAD", "conversation thread does not match the current project and semantic revision", project, threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], [], savedThread);
  }

  const handlesParsed = z.array(AssetHandleSchema).safeParse(request.assetHandles);
  if (!handlesParsed.success) return failure("rejected", "INVALID_REQUEST", "authorized asset handles are invalid", project, threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], [], savedThread);
  const priorOperationLog = z.array(OperationLogRecordSchema).max(1_000).safeParse(request.operationLog);
  if (!priorOperationLog.success) return failure("rejected", "INVALID_REQUEST", "host operation history is invalid or exceeds its limit", project, threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], [], savedThread);

  let previousResponseId = savedThread?.previousResponseId;
  const responseIds: string[] = [];
  const operationLog: OperationLogRecord[] = [];
  const acceptedBatches: V2AcceptedBatch[] = [];
  const previews: RenderArtifactV2[] = [];
  const disclosedEvidenceRefs = new Set<string>();
  let finalAssistantText = "";
  const startedAt = Date.now();
  const remainingMs = () => MAX_WALL_TIME_MS - (Date.now() - startedAt);
  let workingProject = project;

  const makeThreadState = (): V2ConversationThread => ({
    threadId,
    projectId: workingProject.projectId,
    currentRevisionId: workingProject.currentRevisionId,
    currentRevisionHash: semanticHashV2(workingProject),
    ...(previousResponseId ? { previousResponseId } : {}),
    operationIds: [...(savedThread?.operationIds ?? []), ...operationLog.map(({ id }) => id)],
  });
  const fail = (status: FailureStatus, code: string, detail: string) => failure(
    status, code, detail, workingProject, threadId, intentId, baseRevisionId, baseRevisionHash,
    responseIds, operationLog, acceptedBatches, previews, makeThreadState(),
  );
  const complete = (assistantText: string): V2ConversationResult => {
    const finalHash = canonicalHashForCurrentRevision(workingProject);
    return {
      ok: true,
      status: "completed",
      project: workingProject,
      threadState: makeThreadState(),
      assistantText,
      attribution: {
        threadId,
        intentId,
        actor: "agent",
        baseRevisionId,
        baseRevisionHash,
        resultRevisionId: workingProject.currentRevisionId,
        resultRevisionHash: finalHash,
        responseIds,
        operationIds: operationLog.map(({ id }) => id),
      },
      acceptedBatches,
      operationLog,
      previews,
    };
  };

  try {
    let toolResults: V2AgentToolResult[] = [];
    let modelCalls = 0;
    let toolCalls = 0;
    let imageBytesForIntent = 0;

    while (true) {
      if (request.signal?.aborted) throw new AgentCallError("CANCELLED", "conversation was cancelled");
      if (remainingMs() <= 0) throw new AgentCallError("TIMEOUT", "conversation exceeded its wall-time limit");
      if (modelCalls >= MAX_MODEL_CALLS) throw new AgentCallError("BUDGET_EXCEEDED", "model-call budget exceeded");

      const currentRevisionHash = canonicalHashForCurrentRevision(workingProject);
      const refsKnownToModel = new Set(disclosedEvidenceRefs);
      modelCalls += 1;
      const response = await withBoundedCall("model call", request.signal, remainingMs, (signal) => request.model.respond({
        intentId,
        threadId,
        prompt: request.prompt,
        ...(previousResponseId ? { previousResponseId } : {}),
        context: { projectId: workingProject.projectId, currentRevisionId: workingProject.currentRevisionId, currentRevisionHash },
        instructions,
        tools: V2_AGENT_TOOLS,
        toolResults,
        maxOutputTokens: V2_AGENT_MAX_OUTPUT_TOKENS_PER_CALL,
        signal,
      }));
      if (!response || typeof response.responseId !== "string" || response.responseId.length > 128
        || !IdSchema.safeParse(response.responseId).success || !Array.isArray(response.calls)) {
        throw new Error("model returned an invalid response envelope");
      }
      previousResponseId = response.responseId;
      responseIds.push(response.responseId);
      if (typeof response.text === "string" && response.text.trim()) finalAssistantText = response.text.slice(0, 8_000);
      if (response.calls.length === 0) break;

      toolResults = [];
      let proposalsThisResponse = 0;
      for (const call of response.calls) {
        if (toolCalls >= MAX_TOOL_CALLS) throw new AgentCallError("BUDGET_EXCEEDED", "tool-call budget exceeded");
        toolCalls += 1;
        if (!call || typeof call.id !== "string" || call.id.length > 128 || !IdSchema.safeParse(call.id).success || typeof call.name !== "string") {
          toolResults.push({ callId: "invalid-call", name: "unknown", output: { ok: false, code: "INVALID_TOOL_CALL", detail: "tool call envelope is invalid" } });
          continue;
        }
        if (boundedJsonBytes(call.arguments) > MAX_INSPECTION_DATA_BYTES) {
          toolResults.push({ callId: call.id, name: call.name === "inspect_v2" || call.name === "propose_edit_batch" ? call.name : "unsupported_tool", output: { ok: false, code: "INVALID_ARGUMENTS", detail: "tool arguments exceed the bounded input limit" } });
          continue;
        }

        if (call.name === "inspect_v2") {
          const parsedRequest = parseInspectRequest(call.arguments);
          if (!parsedRequest) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "INVALID_ARGUMENTS", detail: "inspection request does not match the bounded inspection schema" } });
            continue;
          }
          try {
            const inspected = await withBoundedCall("inspection", request.signal, remainingMs, (signal) => request.inspect(
              structuredClone(workingProject),
              parsedRequest,
              { evidenceRoot: request.evidenceRoot, operationLog: [...priorOperationLog.data, ...operationLog], signal },
            ));
            const bounded = validateInspection(inspected);
            const imageBytes = bounded.images.reduce((total, image) => total + image.bytes.byteLength, 0);
            if (imageBytesForIntent + imageBytes > MAX_IMAGE_BYTES_PER_INTENT) {
              toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "IMAGE_BUDGET_EXCEEDED", detail: "image evidence budget exceeded" } });
              continue;
            }
            imageBytesForIntent += imageBytes;
            for (const ref of bounded.refs) disclosedEvidenceRefs.add(ref);
            toolResults.push({ callId: call.id, name: call.name, output: boundedInspectionOutput(bounded.data, bounded.refs), ...(bounded.images.length ? { images: bounded.images } : {}) });
          } catch (error) {
            if (error instanceof AgentCallError) throw error;
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "INSPECTION_FAILED", detail: "bounded inspection failed; try a smaller or different request" } });
          }
          continue;
        }

        if (call.name === "propose_edit_batch") {
          proposalsThisResponse += 1;
          if (proposalsThisResponse > 1) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "ONE_PROPOSAL_PER_TURN", detail: "wait for the previous preview before proposing another edit batch" } });
            continue;
          }
          const parsedProposal = parseProposal(call.arguments);
          if (!parsedProposal) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "INVALID_ARGUMENTS", detail: "edit proposal does not match the typed batch schema" } });
            continue;
          }
          if (parsedProposal.baseRevisionId !== workingProject.currentRevisionId) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "STALE_REVISION", currentRevisionId: workingProject.currentRevisionId } });
            continue;
          }
          if (parsedProposal.evidenceRefs.some((ref) => !refsKnownToModel.has(ref))) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "UNGROUNDED_EVIDENCE", detail: "every edit reference must have been disclosed by an earlier inspection response" } });
            continue;
          }
          const unsupportedIndex = parsedProposal.operations.findIndex((operation) => !allowedAgentOperationTypes.has(operation.type));
          if (unsupportedIndex >= 0 || parsedProposal.operations.some((operation) => !OperationSchema.safeParse(operation).success)) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "UNSUPPORTED_OPERATION", detail: "one or more operations are outside the preview-supported semantic allowlist" } });
            continue;
          }
          if (acceptedBatches.length > 0) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "EDIT_BATCH_LIMIT", detail: "one accepted edit batch per prompt; use a follow-up prompt for another revision" } });
            continue;
          }

          const batch: OperationBatchInput = {
            baseRevisionId: parsedProposal.baseRevisionId,
            actor: "agent",
            intentId,
            evidenceRefs: parsedProposal.evidenceRefs,
            operations: parsedProposal.operations,
          };
          const predicted = applyOperationBatch(workingProject, batch);
          if (!predicted.ok) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: predicted.code, detail: predicted.detail.slice(0, 512) } });
            continue;
          }

          let plannedJob;
          try {
            plannedJob = buildMediaExecutionJob(predicted.project, handlesParsed.data);
          } catch (error) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "PREVIEW_UNSUPPORTED", detail: "the proposed state is outside the bounded preview renderer's supported project shape" } });
            continue;
          }

          const beforeCommitHash = semanticHashV2(workingProject);
          if (beforeCommitHash !== currentRevisionHash) throw new Error("project changed while preparing the semantic batch");
          let rendered: Awaited<ReturnType<typeof executeMediaExecutionJob>>;
          let registered: ProjectV2;
          let previewEvidence: Awaited<ReturnType<typeof createPreviewEvidence>>;
          try {
            const renderTimeoutMs = Math.min(request.renderOptions?.timeoutMs ?? MAX_PREVIEW_CALL_MS, MAX_PREVIEW_CALL_MS, remainingMs());
            if (renderTimeoutMs < 1) throw new Error("preview render deadline is exhausted");
            const renderOptions = { ...request.renderOptions, timeoutMs: renderTimeoutMs };
            const previewAuthorization: MediaExecutionAuthorization = {
              ...request.renderAuthorization,
              isRevisionCurrent: async (revisionId, revisionHash) => revisionId === plannedJob.sourceRevisionId
                && revisionHash === plannedJob.sourceRevisionHash
                && await request.renderAuthorization.isRevisionCurrent(workingProject.currentRevisionId, beforeCommitHash),
            };
            rendered = await withBoundedCall("preview render", request.signal, remainingMs, (signal) => executeMediaExecutionJob(
              plannedJob,
              previewAuthorization,
              { ...renderOptions, signal },
            ), MAX_PREVIEW_CALL_MS);
            registered = registerRenderArtifactV2(predicted.project, rendered.artifact);
            previewEvidence = await withBoundedCall("preview evidence", request.signal, remainingMs, async () => createPreviewEvidence(request, rendered.artifact, remainingMs), MAX_PREVIEW_EVIDENCE_CALL_MS);
            const previewImageBytes = previewEvidence.image.bytes.byteLength;
            if (imageBytesForIntent + previewImageBytes > MAX_IMAGE_BYTES_PER_INTENT) throw new Error("preview image evidence budget exceeded");
            imageBytesForIntent += previewImageBytes;
          } catch (error) {
            if (error instanceof AgentCallError) throw error;
            return fail("failed", "PREVIEW_FAILED", "preview render or its bounded image evidence failed; no canonical revision was committed");
          }

          let commit: V2CanonicalRevisionCommitResult;
          const commitTimeoutMs = remainingMs();
          if (commitTimeoutMs < 1) throw new AgentCallError("TIMEOUT", "conversation budget expired before canonical commit");
          const commitController = new AbortController();
          const abortCommit = () => commitController.abort();
          const commitTimer = setTimeout(abortCommit, commitTimeoutMs);
          request.signal?.addEventListener("abort", abortCommit, { once: true });
          try {
            if (request.signal?.aborted) abortCommit();
            if (commitController.signal.aborted) throw new AgentCallError("CANCELLED", "conversation was cancelled before canonical commit");
            // ponytail: CAS latency is host-bounded; don't race a write and report failure while it may still publish.
            commit = await request.commitCanonicalRevision({
              baseRevisionId: workingProject.currentRevisionId,
              baseRevisionHash: beforeCommitHash,
              project: structuredClone(registered),
              operationLog: structuredClone(predicted.operationLog),
              signal: commitController.signal,
            });
          } catch (error) {
            if (error instanceof AgentCallError) throw error;
            if (commitController.signal.aborted) throw new AgentCallError(request.signal?.aborted ? "CANCELLED" : "TIMEOUT", "canonical commit ended after cancellation or timeout");
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "COMMIT_REJECTED", detail: "canonical revision compare-and-swap could not be completed" } });
            continue;
          } finally {
            clearTimeout(commitTimer);
            request.signal?.removeEventListener("abort", abortCommit);
          }
          if (!commit || typeof commit !== "object" || typeof commit.ok !== "boolean") {
            return fail("failed", "COMMIT_PROTOCOL_ERROR", "host commit returned an invalid result envelope");
          }
          if (!commit.ok) {
            if (commit.code === "STALE_REVISION") return fail("rejected", "STALE_REVISION", "canonical project changed before this batch could be committed");
            if (commitController.signal.aborted) return fail("failed", request.signal?.aborted ? "CANCELLED" : "TIMEOUT", "canonical commit stopped without publishing the candidate revision");
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "COMMIT_REJECTED", detail: "canonical revision compare-and-swap rejected this batch" } });
            continue;
          }
          const committed = ProjectV2Schema.safeParse(commit.project);
          const committedRevision = committed.success ? committed.data.revisions.find(({ id }) => id === predicted.revisionId) : undefined;
          const committedOutput = committed.success ? committed.data.outputs.find(({ outputId }) => outputId === rendered.artifact.outputId) : undefined;
          const committedVerification = committed.success ? committed.data.verification : undefined;
          const committedVerificationRef = committed.success ? committed.data.verification.refs.find(({ id }) => id === rendered.artifact.verificationRefId) : undefined;
          if (!committed.success || committed.data.projectId !== workingProject.projectId
            || committed.data.currentRevisionId !== predicted.revisionId
            || semanticHashV2(committed.data) !== semanticHashV2(predicted.project)
            || committedRevision?.manifestSha256 !== semanticHashV2(predicted.project)
            || committedOutput?.ref !== rendered.artifact.ref
            || committedOutput?.sha256 !== rendered.artifact.sha256
            || committedOutput?.sourceRevisionId !== predicted.revisionId
            || committedOutput?.revisionId !== predicted.revisionId
            || committedOutput?.renderJobHash !== plannedJob.jobHash
            || committedOutput?.backendId !== rendered.artifact.backendId
            || committedOutput?.backendVersion !== rendered.artifact.backendVersion
            || JSON.stringify(committedOutput?.probe) !== JSON.stringify(rendered.artifact.probe)
            || committedOutput?.verificationRefId !== rendered.artifact.verificationRefId
            || committedVerification?.revisionId !== predicted.revisionId
            || committedVerification.status !== "passed"
            || committedVerificationRef?.status !== "passed"
            || JSON.stringify(committedVerificationRef?.evidenceRefs) !== JSON.stringify(rendered.artifact.verification.evidenceRefs)) {
            return fail("failed", "COMMIT_PROTOCOL_ERROR", "host commit result did not persist the proposed revision and verified preview artifact");
          }
          workingProject = committed.data;
          operationLog.push(...predicted.operationLog);
          previews.push(rendered.artifact);
          const batchResult: V2AcceptedBatch = {
            baseRevisionId: batch.baseRevisionId,
            resultRevisionId: predicted.revisionId,
            operationIds: predicted.operationLog.map(({ id }) => id),
            evidenceRefs: [...batch.evidenceRefs],
            renderJobHash: plannedJob.jobHash,
            verificationRefId: rendered.artifact.verificationRefId,
          };
          acceptedBatches.push(batchResult);
          const previewEvidenceRefs = [previewEvidence.index.indexRef, previewEvidence.image.ref];
          for (const ref of previewEvidenceRefs) disclosedEvidenceRefs.add(ref);
          toolResults.push({ callId: call.id, name: call.name, output: {
            ok: true,
            baseRevisionId: batch.baseRevisionId,
            revisionId: predicted.revisionId,
            operationIds: batchResult.operationIds,
            preview: {
              renderJobHash: rendered.artifact.renderJobHash,
              outputId: rendered.artifact.outputId,
              ref: rendered.artifact.ref,
              sha256: rendered.artifact.sha256,
              probe: rendered.artifact.probe,
              verificationRefId: rendered.artifact.verificationRefId,
              checks: rendered.artifact.verification.checks,
              creativeApproval: "not_assessed",
            },
            previewEvidence: {
              indexRef: previewEvidence.index.indexRef,
              sourceAssetSha256: previewEvidence.index.sourceSha256,
              imageRef: previewEvidence.image.ref,
              imageSha256: previewEvidence.index.artifacts.find(({ ref }) => ref === previewEvidence.image.ref)?.sha256,
            },
            evidenceRefs: previewEvidenceRefs,
          }, images: [previewEvidence.image] });
          continue;
        }

        toolResults.push({ callId: call.id, name: "unsupported_tool", output: { ok: false, code: "UNSUPPORTED_TOOL", detail: "tool name is not in the fixed Replex allowlist" } });
      }
    }

    return complete(finalAssistantText || (acceptedBatches.length ? "The edit preview is ready." : "I inspected the project and made no changes."));
  } catch (error) {
    if (acceptedBatches.length > 0) return complete("The edit preview is ready; an optional follow-up response could not be completed.");
    const code = error instanceof AgentCallError ? error.code : error instanceof Error && error.message.includes("current project revision") ? "INVALID_PROJECT" : "MODEL_ERROR";
    const status: FailureStatus = code === "INVALID_PROJECT" ? "rejected" : "failed";
    return fail(status, code, error instanceof AgentCallError ? errorDetail(error) : "model or agent operation failed");
  }
}
