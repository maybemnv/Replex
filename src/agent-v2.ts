import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OperationSchema, applyOperationBatch, semanticHashV2, type Operation, type OperationBatchInput, type OperationLogRecord } from "./operations-v2.js";
import { buildMediaExecutionJob, executeMediaExecutionJob, registerRenderArtifactV2, type MediaExecutionAuthorization, type MediaExecutionOptions, type RenderArtifactV2 } from "./render-v2.js";
import { AssetHandleSchema, ProjectV2Schema, type AssetHandle, type ProjectV2 } from "./schema-v2.js";
import { IdSchema } from "./schema.js";

const inspectionLimit = z.number().int().min(1).max(100).optional();
const offset = z.number().int().nonnegative().optional();

/** Local copy kept structurally aligned with inspect-v2 until both branches integrate. */
export const V2InspectRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project_summary") }).strict(),
  z.object({ kind: z.enum(["assets", "clips"]), offset, limit: inspectionLimit }).strict(),
  z.object({ kind: z.literal("media_evidence"), assetId: IdSchema, image: z.enum(["contact_sheet", "selected_frame"]).optional(), frameOffset: offset }).strict(),
  z.object({ kind: z.literal("verification") }).strict(),
  z.object({ kind: z.literal("operation_history"), limit: inspectionLimit }).strict(),
]);

export type V2InspectRequest = z.infer<typeof V2InspectRequestSchema>;
export type V2InspectionImage = { ref: string; mimeType: "image/png" | "image/jpeg"; bytes: Uint8Array };
export type V2InspectionResult =
  | { ok: true; data: unknown; evidenceRefs: string[]; images?: V2InspectionImage[] }
  | { ok: false; code: string };

export interface V2InspectionContext {
  evidenceRoot: string;
  operationLog: readonly OperationLogRecord[];
  signal: AbortSignal;
}

export type V2Inspector = (project: ProjectV2, request: V2InspectRequest, context?: V2InspectionContext) => Promise<V2InspectionResult>;

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
  project: ProjectV2;
  operationLog: OperationLogRecord[];
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

const inspectArguments = V2InspectRequestSchema;
const proposeArguments = z.object({
  baseRevisionId: IdSchema,
  evidenceRefs: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
  operations: z.array(OperationSchema).min(1).max(12),
}).strict();

const toolDefinitions: readonly V2AgentToolDefinition[] = Object.freeze([
  {
    name: "inspect_v2",
    description: "Request one bounded project, media evidence, verification, or operation-history view.",
    strict: true,
    parameters: {
      type: "object",
      oneOf: [
        { type: "object", properties: { kind: { const: "project_summary" } }, required: ["kind"], additionalProperties: false },
        { type: "object", properties: { kind: { enum: ["assets", "clips"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["kind"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "media_evidence" }, assetId: { type: "string" }, image: { enum: ["contact_sheet", "selected_frame"] }, frameOffset: { type: "integer", minimum: 0 } }, required: ["kind", "assetId"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "verification" } }, required: ["kind"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "operation_history" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["kind"], additionalProperties: false },
      ],
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
        operations: { type: "array", minItems: 1, maxItems: 12, items: { type: "object" } },
      },
      required: ["baseRevisionId", "evidenceRefs", "operations"],
      additionalProperties: false,
    },
  },
]);

const allowedAgentOperationTypes = new Set<Operation["type"]>([
  "trim_clip", "set_transform", "set_opacity", "set_speed", "set_volume", "mute_clip",
]);
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_INSPECTION_DATA_BYTES = 64 * 1024;
const MAX_IMAGES_PER_RESULT = 8;
const MAX_IMAGE_BYTES_PER_RESULT = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES_PER_INTENT = 4 * 1024 * 1024;
const MAX_MODEL_CALLS = 4;
const MAX_TOOL_CALLS = 12;
const MAX_EDIT_BATCHES = 2;
const MAX_PREVIEWS = 2;
const MAX_WALL_TIME_MS = 120_000;
const MAX_PER_CALL_MS = 20_000;

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
  return error instanceof Error ? error.message : "operation failed";
}

async function withBoundedCall<T>(
  label: string,
  parentSignal: AbortSignal | undefined,
  remainingMs: () => number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) throw new AgentCallError("CANCELLED", "conversation was cancelled");
  const timeoutMs = Math.min(MAX_PER_CALL_MS, remainingMs());
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

function validateInspection(result: V2InspectionResult): { refs: string[]; images: V2InspectionImage[]; data: unknown } {
  if (!result.ok) throw new Error(`bounded inspector returned ${result.code}`);
  if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length > 64
    || result.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0 || ref.length > 512)) {
    throw new Error("bounded inspector returned invalid evidence references");
  }
  if (boundedJsonBytes(result.data) > MAX_INSPECTION_DATA_BYTES) throw new Error("bounded inspector data exceeds the model-facing limit");
  const images = result.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_RESULT) throw new Error("bounded inspector returned too many images");
  const refs = new Set(result.evidenceRefs);
  let imageBytes = 0;
  for (const image of images) {
    if (!image || !refs.has(image.ref) || !["image/png", "image/jpeg"].includes(image.mimeType) || !(image.bytes instanceof Uint8Array)) {
      throw new Error("bounded inspector returned an invalid image evidence item");
    }
    imageBytes += image.bytes.byteLength;
  }
  if (imageBytes > MAX_IMAGE_BYTES_PER_RESULT) throw new Error("bounded inspector image bytes exceed the per-result limit");
  return { refs: [...new Set(result.evidenceRefs)], images, data: result.data };
}

function boundedInspectionOutput(data: unknown, evidenceRefs: readonly string[]): unknown {
  return { ok: true, data, evidenceRefs };
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

/** Runs a bounded typed edit loop; the host commits each reducer result before preview rendering. */
export async function runConversationalEditV2(request: V2ConversationRequest): Promise<V2ConversationResult> {
  const initialParsed = ProjectV2Schema.safeParse(request.project);
  if (!initialParsed.success) {
    return failure("rejected", "INVALID_PROJECT", "input is not a valid ProjectV2", request.project, request.threadId, request.intentId ?? "intent-invalid", request.project.currentRevisionId, "0".repeat(64), [], [], [], []);
  }

  let project = initialParsed.data;
  let baseRevisionHash: string;
  try { baseRevisionHash = canonicalHashForCurrentRevision(project); }
  catch (error) {
    return failure("rejected", "INVALID_PROJECT", errorDetail(error), project, request.threadId, request.intentId ?? "intent-invalid", project.currentRevisionId, "0".repeat(64), [], [], [], []);
  }
  const baseRevisionId = project.currentRevisionId;
  const intentId = request.intentId ?? `intent-${randomUUID()}`;

  if (!IdSchema.safeParse(request.threadId).success || !request.prompt.trim()
    || Buffer.byteLength(request.prompt, "utf8") > MAX_PROMPT_BYTES
    || !IdSchema.safeParse(intentId).success) {
    return failure("rejected", "INVALID_REQUEST", "thread, intent, or prompt is invalid or exceeds its limit", project, request.threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], []);
  }

  const savedThread = request.threadState;
  if (savedThread && (savedThread.threadId !== request.threadId
    || savedThread.projectId !== project.projectId
    || savedThread.currentRevisionId !== project.currentRevisionId
    || savedThread.currentRevisionHash !== baseRevisionHash)) {
    return failure("rejected", "STALE_THREAD", "conversation thread does not match the current project and semantic revision", project, request.threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], [], savedThread);
  }

  const handlesParsed = z.array(AssetHandleSchema).safeParse(request.assetHandles);
  if (!handlesParsed.success) return failure("rejected", "INVALID_REQUEST", "authorized asset handles are invalid", project, request.threadId, intentId, baseRevisionId, baseRevisionHash, [], [], [], [], savedThread);

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
    threadId: request.threadId,
    projectId: workingProject.projectId,
    currentRevisionId: workingProject.currentRevisionId,
    currentRevisionHash: semanticHashV2(workingProject),
    ...(previousResponseId ? { previousResponseId } : {}),
    operationIds: [...(savedThread?.operationIds ?? []), ...operationLog.map(({ id }) => id)],
  });
  const fail = (status: FailureStatus, code: string, detail: string) => failure(
    status, code, detail, workingProject, request.threadId, intentId, baseRevisionId, baseRevisionHash,
    responseIds, operationLog, acceptedBatches, previews, makeThreadState(),
  );

  try {
    let toolResults: V2AgentToolResult[] = [];
    let modelCalls = 0;
    let toolCalls = 0;
    let acceptedCount = 0;
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
        threadId: request.threadId,
        prompt: request.prompt,
        ...(previousResponseId ? { previousResponseId } : {}),
        context: { projectId: workingProject.projectId, currentRevisionId: workingProject.currentRevisionId, currentRevisionHash },
        instructions,
        tools: toolDefinitions,
        toolResults,
        signal,
      }));
      if (!response || typeof response.responseId !== "string" || response.responseId.length === 0 || !Array.isArray(response.calls)) {
        throw new Error("model returned an invalid response envelope");
      }
      previousResponseId = response.responseId;
      responseIds.push(response.responseId);
      if (typeof response.text === "string" && response.text.trim()) finalAssistantText = response.text.slice(0, 8_000);
      if (response.calls.length === 0) break;

      toolResults = [];
      for (const call of response.calls) {
        if (toolCalls >= MAX_TOOL_CALLS) throw new AgentCallError("BUDGET_EXCEEDED", "tool-call budget exceeded");
        toolCalls += 1;
        if (!call || typeof call.id !== "string" || call.id.length === 0 || typeof call.name !== "string") {
          toolResults.push({ callId: "invalid-call", name: "unknown", output: { ok: false, code: "INVALID_TOOL_CALL", detail: "tool call envelope is invalid" } });
          continue;
        }

        if (call.name === "inspect_v2") {
          const parsedRequest = inspectArguments.safeParse(call.arguments);
          if (!parsedRequest.success) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "INVALID_ARGUMENTS", detail: "inspection request does not match the bounded inspection schema" } });
            continue;
          }
          try {
            const inspected = await withBoundedCall("inspection", request.signal, remainingMs, (signal) => request.inspect(
              workingProject,
              parsedRequest.data,
              { evidenceRoot: request.evidenceRoot, operationLog: [...operationLog], signal },
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
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "INSPECTION_FAILED", detail: errorDetail(error).slice(0, 512) } });
          }
          continue;
        }

        if (call.name === "propose_edit_batch") {
          const parsedProposal = proposeArguments.safeParse(call.arguments);
          if (!parsedProposal.success) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "INVALID_ARGUMENTS", detail: "edit proposal does not match the typed batch schema" } });
            continue;
          }
          if (parsedProposal.data.baseRevisionId !== workingProject.currentRevisionId) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "STALE_REVISION", currentRevisionId: workingProject.currentRevisionId } });
            continue;
          }
          if (parsedProposal.data.evidenceRefs.some((ref) => !refsKnownToModel.has(ref))) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "UNGROUNDED_EVIDENCE", detail: "every edit reference must have been disclosed by an earlier inspection response" } });
            continue;
          }
          const unsupportedIndex = parsedProposal.data.operations.findIndex((operation) => !allowedAgentOperationTypes.has(operation.type));
          if (unsupportedIndex >= 0 || parsedProposal.data.operations.some((operation) => !OperationSchema.safeParse(operation).success)) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "UNSUPPORTED_OPERATION", detail: "one or more operations are outside the preview-supported semantic allowlist" } });
            continue;
          }
          if (acceptedCount >= MAX_EDIT_BATCHES || previews.length >= MAX_PREVIEWS) {
            throw new AgentCallError("BUDGET_EXCEEDED", "edit-batch or preview budget exceeded");
          }

          const batch: OperationBatchInput = {
            baseRevisionId: parsedProposal.data.baseRevisionId,
            actor: "agent",
            intentId,
            evidenceRefs: parsedProposal.data.evidenceRefs,
            operations: parsedProposal.data.operations,
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
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "PREVIEW_UNSUPPORTED", detail: errorDetail(error).slice(0, 512) } });
            continue;
          }

          const beforeCommitHash = semanticHashV2(workingProject);
          if (beforeCommitHash !== currentRevisionHash) throw new Error("project changed while preparing the semantic batch");
          const commit = await withBoundedCall("canonical revision commit", request.signal, remainingMs, (signal) => request.commitCanonicalRevision({
            baseRevisionId: workingProject.currentRevisionId,
            baseRevisionHash: beforeCommitHash,
            project: predicted.project,
            operationLog: predicted.operationLog,
            signal,
          }));
          if (!commit.ok) {
            toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "COMMIT_REJECTED", detail: (commit.detail ?? commit.code).slice(0, 512) } });
            continue;
          }
          const committed = ProjectV2Schema.safeParse(commit.project);
          const committedRevision = committed.success ? committed.data.revisions.find(({ id }) => id === predicted.revisionId) : undefined;
          if (!committed.success || committed.data.projectId !== workingProject.projectId
            || committed.data.currentRevisionId !== predicted.revisionId
            || semanticHashV2(committed.data) !== semanticHashV2(predicted.project)
            || committedRevision?.manifestSha256 !== semanticHashV2(predicted.project)) {
            throw new Error("host commit did not return the reducer's committed semantic revision");
          }
          workingProject = committed.data;
          operationLog.push(...predicted.operationLog);
          acceptedCount += 1;

          try {
            const currentJob = buildMediaExecutionJob(workingProject, handlesParsed.data);
            if (currentJob.jobHash !== plannedJob.jobHash) throw new Error("committed project does not match the frozen preview plan");
            const renderOptions = { ...request.renderOptions, timeoutMs: Math.min(request.renderOptions?.timeoutMs ?? 60_000, remainingMs()) };
            const rendered = await withBoundedCall("preview render", request.signal, remainingMs, (signal) => executeMediaExecutionJob(
              currentJob,
              request.renderAuthorization,
              { ...renderOptions, signal },
            ));
            const registered = registerRenderArtifactV2(workingProject, rendered.artifact);
            workingProject = registered;
            previews.push(rendered.artifact);
            const batchResult: V2AcceptedBatch = {
              baseRevisionId: batch.baseRevisionId,
              resultRevisionId: predicted.revisionId,
              operationIds: predicted.operationLog.map(({ id }) => id),
              evidenceRefs: [...batch.evidenceRefs],
              renderJobHash: currentJob.jobHash,
              verificationRefId: rendered.artifact.verificationRefId,
            };
            acceptedBatches.push(batchResult);
            toolResults.push({ callId: call.id, name: call.name, output: {
              ok: true,
              baseRevisionId: batch.baseRevisionId,
              revisionId: predicted.revisionId,
              operationIds: batchResult.operationIds,
              preview: {
                outputId: rendered.artifact.outputId,
                ref: rendered.artifact.ref,
                sha256: rendered.artifact.sha256,
                probe: rendered.artifact.probe,
                verificationRefId: rendered.artifact.verificationRefId,
                checks: rendered.artifact.verification.checks,
              },
            } });
          } catch (error) {
            if (error instanceof AgentCallError) throw error;
            return fail("failed", "PREVIEW_FAILED", errorDetail(error).slice(0, 1_000));
          }
          continue;
        }

        toolResults.push({ callId: call.id, name: call.name, output: { ok: false, code: "UNSUPPORTED_TOOL", detail: "tool name is not in the fixed Replex allowlist" } });
      }
    }

    const finalHash = canonicalHashForCurrentRevision(workingProject);
    const threadState: V2ConversationThread = {
      threadId: request.threadId,
      projectId: workingProject.projectId,
      currentRevisionId: workingProject.currentRevisionId,
      currentRevisionHash: finalHash,
      ...(previousResponseId ? { previousResponseId } : {}),
      operationIds: [...(savedThread?.operationIds ?? []), ...operationLog.map(({ id }) => id)],
    };
    return {
      ok: true,
      status: "completed",
      project: workingProject,
      threadState,
      assistantText: finalAssistantText || (acceptedBatches.length ? "The edit preview is ready." : "I inspected the project and made no changes."),
      attribution: {
        threadId: request.threadId,
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
  } catch (error) {
    const code = error instanceof AgentCallError ? error.code : error instanceof Error && error.message.includes("current project revision") ? "INVALID_PROJECT" : "MODEL_ERROR";
    const status: FailureStatus = code === "INVALID_PROJECT" ? "rejected" : "failed";
    return fail(status, code, errorDetail(error).slice(0, 1_000));
  }
}
