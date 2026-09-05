import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspectProject, type InspectionRequest } from "./inspect.js";
import { applyOperations } from "./operations.js";
import { buildRenderJob, executeRenderJob } from "./render.js";
import type { Project } from "./schema.js";
import { verifyProject } from "./verify.js";

export const AGENT_TOOL_NAMES = [
  "inspect_project", "inspect_flow", "inspect_scene", "inspect_capture", "inspect_browser_trace", "inspect_verification_results", "inspect_screenshot",
  "create_scene", "trim_scene", "reorder_scene", "replace_capture", "set_speed", "set_focus", "set_title", "set_callout", "set_transition",
  "verify_project", "render_draft", "inspect_render_result",
] as const;

type AgentTool = (typeof AGENT_TOOL_NAMES)[number];
type EditTool = Extract<AgentTool, "create_scene" | "trim_scene" | "reorder_scene" | "replace_capture" | "set_speed" | "set_focus" | "set_title" | "set_callout" | "set_transition">;

export interface RecordedToolCall { id?: string; tool: string; input: unknown }
export interface ClaudeRequest { model: string; system: string; tools: Array<{ name: AgentTool; input_schema: Record<string, unknown> }>; messages: Array<{ role: "user" | "assistant"; content: unknown }> }
export interface ClaudeResponse { toolCalls: RecordedToolCall[]; stopReason: "tool_use" | "end_turn"; assistantContent?: unknown }
export interface ClaudeClient { createMessage(request: ClaudeRequest, signal: AbortSignal): Promise<ClaudeResponse> }

export type AgentResult =
  | { ok: true; project: Project; toolCalls: number; events: string[] }
  | { ok: false; code: "UNKNOWN_TOOL" | "INVALID_CALL" | "BUDGET_EXHAUSTED" | "EDIT_BUDGET_EXHAUSTED" | "VERIFICATION_FAILED" | "RENDER_FAILED" | "TRANSPORT_FAILED"; detail: string; project: Project; toolCalls: number; events: string[] };

/** Replays real-shaped recorded calls through the same dispatcher used by the live client. */
export function runRecordedAgentDraft(project: Project, root: string, calls: RecordedToolCall[]): AgentResult {
  if (calls.length > 20) return failure(project, 0, [], "BUDGET_EXHAUSTED", "agent exceeded 20 tool calls", root);
  return dispatch({ project, toolCalls: 0, editPasses: 0, renderCount: 0, verified: false, events: [], outputs: [] }, root, calls);
}

/** Runs the one configured provider seam; a missing key never falls back to recorded mode. */
export async function runClaudeDraft(project: Project, root: string, client = createClaudeClient()): Promise<AgentResult> {
  const state: DispatchState = { project, toolCalls: 0, editPasses: 0, renderCount: 0, verified: false, events: [], outputs: [] };
  let request = initialClaudeRequest(project);
  for (;;) {
    let response: ClaudeResponse;
    try {
      response = await client.createMessage(request, AbortSignal.timeout(60_000));
    } catch (error) {
      try {
        response = await client.createMessage(request, AbortSignal.timeout(60_000));
      } catch (retryError) {
        return failure(state.project, state.toolCalls, state.events, "TRANSPORT_FAILED", retryError instanceof Error ? retryError.message : String(error), root);
      }
    }
    if (response.stopReason !== "tool_use") {
      return state.editPasses && state.verified && state.renderCount
        ? { ok: true, project: state.project, toolCalls: state.toolCalls, events: state.events }
        : failure(state.project, state.toolCalls, state.events, "INVALID_CALL", "agent ended before an edit, verification, and render completed", root);
    }
    const result = dispatch(state, root, response.toolCalls);
    if (!result.ok) return result;
    const outputs = state.outputs.splice(-response.toolCalls.length);
    request = {
      ...request,
      messages: [...request.messages, { role: "assistant", content: response.assistantContent ?? [] }, { role: "user", content: response.toolCalls.map((call, index) => ({ type: "tool_result", tool_use_id: call.id ?? "missing-tool-id", content: outputs[index] ?? JSON.stringify({ ok: false, detail: "tool produced no result" }) })) }],
    };
  }
}

export function createClaudeClient(): ClaudeClient {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is required for real Claude runs");
  return {
    async createMessage(request, signal) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: request.model, max_tokens: 1200, system: request.system, tools: request.tools, messages: request.messages }),
      });
      if (!response.ok) throw new Error(`Claude request failed: ${response.status}`);
      const body = await response.json() as { stop_reason?: string; content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> };
      return { stopReason: body.stop_reason === "tool_use" ? "tool_use" : "end_turn", assistantContent: body.content ?? [], toolCalls: (body.content ?? []).filter((item) => item.type === "tool_use").map((item) => ({ id: item.id, tool: item.name ?? "", input: item.input })) };
    },
  };
}

interface DispatchState { project: Project; toolCalls: number; editPasses: number; renderCount: number; verified: boolean; verification?: { id: string; passed: boolean }; events: string[]; outputs: string[] }

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
      events.push(call.tool);
      state.outputs.push(JSON.stringify(inspection));
      continue;
    }
    if (isEditTool(call.tool)) {
      if (editPasses >= 2) return fail(state.toolCalls + index, "EDIT_BUDGET_EXHAUSTED", "agent exceeded two edit passes");
      const input = object(call.input);
      if (!input || typeof input.baseRevisionId !== "string" || !validEvidence(input.evidenceRefs)) return fail(state.toolCalls + index, "INVALID_CALL", "edits require current baseRevisionId and non-empty stable evidence references");
      const { baseRevisionId, evidenceRefs, ...operationInput } = input;
      const mutation = applyOperations(project, baseRevisionId, [{ ...operationInput, type: call.tool }], { actor: "model", root, evidenceRefs: evidenceRefs as string[] });
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
      try {
        executeRenderJob(buildRenderJob(project, root, latestVerification ?? { id: `verification-${project.currentRevisionId}`, passed: false }), root);
      } catch (error) {
        return fail(state.toolCalls + index + 1, "RENDER_FAILED", error instanceof Error ? error.message : String(error));
      }
      renderCount += 1;
      events.push(call.tool);
      state.outputs.push(JSON.stringify({ ok: true, revisionId: project.currentRevisionId, rendered: true }));
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

function initialClaudeRequest(project: Project): ClaudeRequest {
  return {
    model: process.env.REPLEX_CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
    system: "Use only the supplied typed tools. Never request browser access, shell, files, JavaScript, FFmpeg arguments, raw traces, secrets, or direct manifest writes. Cite stable evidence references for every edit.",
    tools: AGENT_TOOL_NAMES.map((name) => ({ name, input_schema: toolInputSchema(name) })),
    messages: [{ role: "user", content: `Create a bounded first draft for project ${project.projectId}. Inspect before editing.` }],
  };
}

function toolInputSchema(name: AgentTool): Record<string, unknown> {
  const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
  if (name === "inspect_scene" || name === "inspect_screenshot") return { type: "object", properties: { sceneId: id }, required: ["sceneId"], additionalProperties: false };
  if (name === "inspect_capture") return { type: "object", properties: { captureId: id }, required: ["captureId"], additionalProperties: false };
  if (isEditTool(name)) return { type: "object", properties: { baseRevisionId: id, evidenceRefs: { type: "array", minItems: 1, items: { type: "string", pattern: "^(capture|screenshot|verification):[A-Za-z0-9._:-]+$" } } }, required: ["baseRevisionId", "evidenceRefs"], additionalProperties: true };
  return { type: "object", properties: {}, additionalProperties: false };
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
