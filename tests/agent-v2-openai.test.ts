import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIV2ModelClient } from "../src/agent-v2-openai.js";
import type { V2AgentModelRequest } from "../src/agent-v2.js";

const request: V2AgentModelRequest = {
  intentId: "intent-1",
  threadId: "thread-1",
  prompt: "Edit the opening",
  context: { projectId: "project-1", currentRevisionId: "revision-1", currentRevisionHash: "a".repeat(64) },
  instructions: "Use bounded typed tools.",
  tools: [{ name: "inspect_v2", description: "Inspect project evidence.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }],
  toolResults: [],
  maxOutputTokens: 1200,
  signal: new AbortController().signal,
};

describe("OpenAI V2 model adapter", () => {
  it("passes the per-call output-token ceiling to the provider and maps typed function calls", async () => {
    const response = {
      id: "response-1",
      output: [{ type: "function_call", call_id: "call-1", name: "inspect_v2", arguments: JSON.stringify({ kind: "project_summary" }) }],
      output_text: "",
      usage: { input_tokens: 21, output_tokens: 37, total_tokens: 58 },
      status: "completed",
    };
    const create = vi.fn(async () => response);
    const client = { responses: { create } } as unknown as OpenAI;
    const model = createOpenAIV2ModelClient(client, "poc-test-model");

    const result = await model.respond(request);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "poc-test-model",
      max_output_tokens: 1200,
      parallel_tool_calls: false,
    }), { signal: request.signal });
    expect(result).toMatchObject({
      responseId: "response-1",
      calls: [{ id: "call-1", name: "inspect_v2", arguments: { kind: "project_summary" } }],
    });
  });

  it("rejects a provider response that reports output above the requested ceiling", async () => {
    const create = vi.fn(async () => ({
      id: "response-2",
      output: [],
      output_text: "",
      usage: { input_tokens: 10, output_tokens: 1201, total_tokens: 1211 },
      status: "completed",
    }));
    const client = { responses: { create } } as unknown as OpenAI;
    const model = createOpenAIV2ModelClient(client, "poc-test-model");

    await expect(model.respond(request)).rejects.toThrow("provider exceeded the requested output-token ceiling");
  });

  it("sends bounded evidence images only with their matching function result", async () => {
    const create = vi.fn(async (_params: { input: unknown }) => ({ id: "response-3", output: [], output_text: "Done.", status: "completed" }));
    const client = { responses: { create } } as unknown as OpenAI;
    const model = createOpenAIV2ModelClient(client, "poc-test-model");
    const evidenceRequest: V2AgentModelRequest = {
      ...request,
      previousResponseId: "response-2",
      toolResults: [{ callId: "call-2", name: "inspect_v2", output: { ok: true, evidenceRef: "evidence:frame-1" }, images: [{ ref: "evidence:frame-1", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }] }],
    };

    await model.respond(evidenceRequest);

    const input = create.mock.calls[0]?.[0].input;
    expect(input).toEqual([{
      type: "function_call_output",
      call_id: "call-2",
      output: [
        { type: "input_text", text: expect.stringContaining("evidence:frame-1") },
        { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "low" },
      ],
    }]);
  });
});
