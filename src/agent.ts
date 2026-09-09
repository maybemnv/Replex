import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { inspectProject, type InspectionRequest } from "./inspect.js";
import { applyOperations } from "./operations.js";
import { buildRenderJob, executeRenderJob } from "./render.js";
import { EditOperationSchemas, IdSchema, type Project } from "./schema.js";
import { verifyProject } from "./verify.js";

export const AGENT_TOOL_NAMES = [
  "inspect_project", "inspect_flow", "inspect_scene", "inspect_capture", "inspect_browser_trace", "inspect_verification_results", "inspect_screenshot",
  "create_scene", "trim_scene", "reorder_scene", "replace_capture", "set_speed", "set_focus", "set_title", "set_callout", "set_transition",
  "verify_project", "render_draft", "inspect_render_result",
] as const;

type AgentTool = (typeof AGENT_TOOL_NAMES)[number];
type EditTool = Extract<AgentTool, "create_scene" | "trim_scene" | "reorder_scene" | "replace_capture" | "set_speed" | "set_focus" | "set_title" | "set_callout" | "set_transition">;

export interface RecordedToolCall { id?: string; tool: string; input: unknown }
export interface OpenAIRequest {
  model: string;
  instructions: string;
  tools: Array<{ type: "function"; name: AgentTool; parameters: Record<string, unknown>; strict: true }>;
  input: string | Array<{ type: "function_call_output"; call_id: string; output: string }>;
  previousResponseId?: string;
}
export interface OpenAIResponse {
  id: string;
  toolCalls: RecordedToolCall[];
  stopReason: "tool_use" | "end_turn";
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
export interface OpenAIClient { createResponse(request: OpenAIRequest, signal: AbortSignal): Promise<OpenAIResponse> }

export type AgentResult =
  | { ok: true; project: Project; toolCalls: number; events: string[] }
  | { ok: false; code: "UNKNOWN_TOOL" | "INVALID_CALL" | "BUDGET_EXHAUSTED" | "EDIT_BUDGET_EXHAUSTED" | "VERIFICATION_FAILED" | "RENDER_FAILED" | "TRANSPORT_FAILED"; detail: string; project: Project; toolCalls: number; events: string[] };

/** Replays real-shaped recorded calls through the same dispatcher used by the live client. */
export function runRecordedAgentDraft(project: Project, root: string, calls: RecordedToolCall[], options: { requireCompletion?: boolean } = {}): AgentResult {
  if (calls.length > 20) return failure(project, 0, [], "BUDGET_EXHAUSTED", "agent exceeded 20 tool calls", root);
  const result = dispatch({ project, toolCalls: 0, editPasses: 0, renderCount: 0, verified: false, events: [], outputs: [], disclosed: new Set() }, root, calls);
  if (result.ok && options.requireCompletion !== false) {
    const hasEdit = result.events.some((event) => ["create_scene", "trim_scene", "reorder_scene", "replace_capture", "set_speed", "set_focus", "set_title", "set_callout", "set_transition"].includes(event));
    const hasVerify = result.events.includes("verify_project");
    const hasRender = result.events.includes("render_draft");
    if (!hasEdit || !hasVerify || !hasRender) {
      return failure(result.project, result.toolCalls, result.events, "INVALID_CALL", "recorded draft ended before an edit, verification, and render completed", root);
    }
  }
  return result;
}

/** Runs the one configured provider seam; a missing key never falls back to recorded mode. */
export async function runOpenAIDraft(project: Project, root: string, client = createOpenAIClient()): Promise<AgentResult> {
  const state: DispatchState = { project, toolCalls: 0, editPasses: 0, renderCount: 0, verified: false, events: [], outputs: [], disclosed: new Set() };
  const deadline = Date.now() + 120_000;
  let request = initialOpenAIRequest(project);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return failure(state.project, state.toolCalls, state.events, "TRANSPORT_FAILED", "agent exceeded two-minute model wall-time budget", root);
    let response: OpenAIResponse;
    try {
      response = await client.createResponse(request, AbortSignal.timeout(Math.min(60_000, remaining)));
    } catch (error) {
      const retryRemaining = deadline - Date.now();
      if (retryRemaining <= 0) return failure(state.project, state.toolCalls, state.events, "TRANSPORT_FAILED", "agent exceeded two-minute model wall-time budget", root);
      try {
        response = await client.createResponse(request, AbortSignal.timeout(Math.min(60_000, retryRemaining)));
      } catch (retryError) {
        return failure(state.project, state.toolCalls, state.events, "TRANSPORT_FAILED", retryError instanceof Error ? retryError.message : String(error), root);
      }
    }
    audit(root, { provider: "openai", model: request.model, responseId: response.id, usage: response.usage });
    if (response.stopReason !== "tool_use") {
      return state.editPasses && state.verified && state.renderCount
        ? { ok: true, project: state.project, toolCalls: state.toolCalls, events: state.events }
        : failure(state.project, state.toolCalls, state.events, "INVALID_CALL", "agent ended before an edit, verification, and render completed", root);
    }
    if (!Array.isArray(response.toolCalls) || response.toolCalls.length === 0) {
      return failure(state.project, state.toolCalls, state.events, "INVALID_CALL", "OpenAI declared tool use without a parsed tool call", root);
    }
    const result = dispatch(state, root, response.toolCalls);
    if (!result.ok) return result;
    const outputs = state.outputs.splice(-response.toolCalls.length);
    request = { ...request, previousResponseId: response.id, input: response.toolCalls.map((call, index) => ({
      type: "function_call_output",
      call_id: call.id ?? "missing-tool-id",
      output: outputs[index] ?? JSON.stringify({ ok: false, detail: "tool produced no result" }),
    })) };
  }
}

export function createOpenAIClient(): OpenAIClient {
  if (!process.env.OPENAI_API_KEY && existsSync(resolve(".env"))) process.loadEnvFile(resolve(".env"));
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for real OpenAI runs");
  const openai = new OpenAI({ apiKey: key });
  return {
    async createResponse(request, signal) {
      const response = await openai.responses.create({
        model: request.model,
        instructions: request.instructions,
        tools: request.tools,
        input: request.input,
        previous_response_id: request.previousResponseId,
        parallel_tool_calls: false,
        max_output_tokens: 1200,
      }, { signal });
      const toolCalls = response.output.filter((item) => item.type === "function_call")
        .map((item) => {
          let input: unknown = item.arguments;
          try { input = JSON.parse(item.arguments); } catch { /* dispatcher rejects malformed arguments */ }
          return { id: item.call_id, tool: item.name, input };
        });
      return {
        id: response.id,
        stopReason: toolCalls.length ? "tool_use" : "end_turn",
        toolCalls,
        usage: response.usage ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        } : undefined,
      };
    },
  };
}

interface DispatchState { project: Project; toolCalls: number; editPasses: number; renderCount: number; verified: boolean; verification?: { id: string; passed: boolean }; events: string[]; outputs: string[]; disclosed: Set<string> }

function dispatch(state: DispatchState, root: string, calls: RecordedToolCall[]): AgentResult {
  if (state.toolCalls + calls.length > 20) return failure(state.project, state.toolCalls, state.events, "BUDGET_EXHAUSTED", "agent exceeded 20 tool calls", root);
  let project = state.project;
  let verified = state.verified;
  let latestVerification = state.verification;
  let editPasses = state.editPasses;
  let renderCount = state.renderCount;
  const events = state.events;
  const fail = (toolCalls: number, code: Extract<AgentResult, { ok: false }>["code"], detail: string) => { state.project = project; state.toolCalls = toolCalls; return failure(project, toolCalls, events, code, detail, root); };
  for (const [index, call] of calls.entries()) {
    if (!AGENT_TOOL_NAMES.includes(call.tool as AgentTool)) return fail(state.toolCalls + index, "UNKNOWN_TOOL", `tool is not allowed: ${call.tool}`);
    if (containsSecret(call.input)) return fail(state.toolCalls + index, "INVALID_CALL", "secret-shaped model input is not accepted");
    if (isInspectionTool(call.tool)) {
      const inspection = inspectProject(project, root, { kind: call.tool, ...(object(call.input) ?? {}) } as InspectionRequest);
      if (!inspection.ok) return fail(state.toolCalls + index + 1, "INVALID_CALL", inspection.detail);
      for (const artifact of inspection.artifacts) state.disclosed.add(artifact.id);
      events.push(call.tool);
      state.outputs.push(JSON.stringify(inspection));
      continue;
    }
    if (isEditTool(call.tool)) {
      if (editPasses >= 2) return fail(state.toolCalls + index, "EDIT_BUDGET_EXHAUSTED", "agent exceeded two edit passes");
      const input = object(call.input);
      if (!input || typeof input.baseRevisionId !== "string" || !validEvidence(input.evidenceRefs)) return fail(state.toolCalls + index, "INVALID_CALL", "edits require current baseRevisionId and non-empty stable evidence references");
      const evidenceRefs = input.evidenceRefs as string[];
      const undisclosed = evidenceRefs.find((ref) => !state.disclosed.has(ref));
      if (undisclosed) return fail(state.toolCalls + index, "INVALID_CALL", `evidence reference was never disclosed for this run: ${undisclosed}`);
      const { baseRevisionId, evidenceRefs: _evidenceRefs, ...operationInput } = input;
      const mutation = applyOperations(project, baseRevisionId, [{ ...operationInput, type: call.tool }], { actor: "model", root, evidenceRefs });
      if (!mutation.ok) return fail(state.toolCalls + index + 1, "INVALID_CALL", mutation.detail);
      project = mutation.project;
      editPasses += 1;
      events.push(call.tool);
      state.outputs.push(JSON.stringify({ ok: true, revisionId: project.currentRevisionId, operationIds: mutation.operationIds }));
      continue;
    }
    if (call.tool === "verify_project") {
      const verification = verifyProject(project, root);
      if (!verification.passed) return fail(state.toolCalls + index + 1, "VERIFICATION_FAILED", verification.firstCause ?? "project verification failed");
      verified = true;
      latestVerification = verification;
      events.push(call.tool);
      state.outputs.push(JSON.stringify({ ok: true, verification }));
      continue;
    }
    if (call.tool === "render_draft") {
      if (!verified) return fail(state.toolCalls + index, "VERIFICATION_FAILED", "render requires a successful verification");
      if (renderCount >= 2) return fail(state.toolCalls + index, "BUDGET_EXHAUSTED", "agent exceeded two renders");
      let rendered: ReturnType<typeof executeRenderJob>;
      try {
        rendered = executeRenderJob(buildRenderJob(project, root, latestVerification ?? { id: `verification-${project.currentRevisionId}`, passed: false }), root, { project });
      } catch (error) {
        return fail(state.toolCalls + index + 1, "RENDER_FAILED", error instanceof Error ? error.message : String(error));
      }
      renderCount += 1;
      events.push(call.tool);
      state.outputs.push(JSON.stringify({ ok: true, revisionId: project.currentRevisionId, rendered: true, output: rendered.output }));
      continue;
    }
    if (call.tool === "inspect_render_result") {
      if (!renderCount) return fail(state.toolCalls + index, "INVALID_CALL", "no render result is available");
      events.push(call.tool);
      state.outputs.push(JSON.stringify({ ok: true, revisionId: project.currentRevisionId, rendered: true }));
    }
  }
  state.project = project;
  state.toolCalls += calls.length;
  state.editPasses = editPasses;
  state.renderCount = renderCount;
  state.verified = verified;
  state.verification = latestVerification;
  audit(root, { toolCalls: state.toolCalls, events });
  return { ok: true, project, toolCalls: state.toolCalls, events };
}

function initialOpenAIRequest(project: Project): OpenAIRequest {
  return {
    model: "gpt-5.6-luna",
    instructions: "Use only the supplied typed tools. Never request browser access, shell, files, JavaScript, FFmpeg arguments, raw traces, secrets, or direct manifest writes. Inspect before editing. Cite stable evidence references for every edit. Copy currentRevisionId exactly from the latest inspect_project into each mutation; after an accepted mutation, use its returned revisionId for the next mutation. Make at most two mutation tool calls total; then immediately call verify_project, render_draft, and inspect_render_result. Do not request a third mutation. Finish only after a successful verification and render.",
    tools: AGENT_TOOL_NAMES.map((name) => ({ type: "function", name, parameters: strictToolSchema(toolInputSchema(name)), strict: true })),
    input: `Create a bounded first draft for project ${project.projectId}.`,
  };
}

function toolInputSchema(name: AgentTool): Record<string, unknown> {
  const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
  const evidenceRefs = { type: "array", minItems: 1, items: { type: "string", pattern: "^(capture|screenshot|verification):[A-Za-z0-9._:-]+$" } };
  const base = { baseRevisionId: id, evidenceRefs };
  if (name === "inspect_scene" || name === "inspect_screenshot") return { type: "object", properties: { sceneId: id }, required: ["sceneId"], additionalProperties: false };
  if (name === "inspect_capture" || name === "inspect_browser_trace") return { type: "object", properties: { captureId: id }, required: ["captureId"], additionalProperties: false };
  if (isEditTool(name)) {
    const schema = z.toJSONSchema(EditOperationSchemas[name]) as Record<string, any>;
    delete schema.properties.type;
    schema.required = ["baseRevisionId", "evidenceRefs", ...(schema.required as string[]).filter((field) => field !== "type")];
    schema.properties = { ...base, ...schema.properties };
    return schema;
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

/** Responses strict tools require every declared object property to be required. */
function strictToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const normalize = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const objectValue = value as Record<string, unknown>;
    if (Array.isArray(objectValue.allOf)) {
      const branches = objectValue.allOf as Record<string, unknown>[];
      delete objectValue.allOf;
      for (const branch of branches) {
        normalize(branch);
        for (const key of ["type", "enum", "const", "pattern", "minimum", "maximum", "minLength", "maxLength"]) {
          if (objectValue[key] === undefined && branch[key] !== undefined) objectValue[key] = branch[key];
        }
        if (branch.const !== undefined) objectValue.const = branch.const;
      }
    }
    if (objectValue.type === "object" || objectValue.properties) {
      const properties = objectValue.properties && typeof objectValue.properties === "object"
        ? Object.keys(objectValue.properties as Record<string, unknown>) : [];
      objectValue.additionalProperties = false;
      objectValue.required = properties;
    }
    for (const child of Object.values(objectValue)) normalize(child);
  };
  delete copy.$schema;
  normalize(copy);
  return copy;
}

function isInspectionTool(tool: string): tool is Extract<AgentTool, `inspect_${string}`> {
  return tool.startsWith("inspect_") && tool !== "inspect_render_result";
}

function isEditTool(tool: string): tool is EditTool {
  return ["create_scene", "trim_scene", "reorder_scene", "replace_capture", "set_speed", "set_focus", "set_title", "set_callout", "set_transition"].includes(tool);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validEvidence(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && /^(capture|screenshot|verification):[A-Za-z0-9._:-]+$/.test(item));
}

function containsSecret(value: unknown): boolean {
  return /(?:token|access_token|refresh_token|api[-_]?key|password|secret)\s*[=:]/i.test(JSON.stringify(value));
}

function failure(project: Project, toolCalls: number, events: string[], code: Extract<AgentResult, { ok: false }>["code"], detail: string, root = ""): Extract<AgentResult, { ok: false }> {
  audit(root, { toolCalls, events, code, detail });
  return { ok: false, code, detail, project, toolCalls, events };
}

function audit(root: string, value: Record<string, unknown>): void {
  if (!root) return;
  const path = join(root, "logs", "agent.jsonl");
  mkdirSync(join(root, "logs"), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, "utf8");
}
