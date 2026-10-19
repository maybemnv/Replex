import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBudgetLedger } from "../src/agent-v2-budget.js";
import { createOpenAIV2ModelClient, createOpenAIV2ModelClientFromEnv } from "../src/agent-v2-openai.js";
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
  let root: string;
  let budget: AgentBudgetLedger;
  const count = vi.fn(async () => ({ input_tokens: 100 }));
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "replex-model-budget-"));
    budget = new AgentBudgetLedger(root, { maxJobMicroUsd: 2600, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000, requestsPerMinute: 12 });
    count.mockClear();
    count.mockResolvedValue({ input_tokens: 100 });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  const fakeClient = (create: unknown) => ({ responses: { create, inputTokens: { count } } }) as unknown as OpenAI;
  it("passes the per-call output-token ceiling to the provider and maps typed function calls", async () => {
    const response = {
      id: "response-1",
      output: [{ type: "function_call", call_id: "call-1", name: "inspect_v2", arguments: JSON.stringify({ kind: "project_summary" }) }],
      output_text: "",
      usage: { input_tokens: 21, output_tokens: 37, total_tokens: 58 },
      status: "completed",
    };
    const create = vi.fn(async () => response);
    const client = fakeClient(create);
    const model = createOpenAIV2ModelClient(client, "poc-test-model", budget);

    const result = await model.respond(request);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "poc-test-model",
      max_output_tokens: 1200,
      parallel_tool_calls: false,
    }), { signal: request.signal, maxRetries: 0 });
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ model: "poc-test-model", tools: expect.any(Array) }), { signal: request.signal, maxRetries: 0 });
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
    const client = fakeClient(create);
    const model = createOpenAIV2ModelClient(client, "poc-test-model", budget);

    await expect(model.respond(request)).rejects.toThrow("provider exceeded the requested output-token ceiling");
  });

  it("sends bounded evidence images only with their matching function result", async () => {
    const create = vi.fn(async (_params: { input: unknown }) => ({ id: "response-3", output: [], output_text: "Done.", status: "completed", usage: { input_tokens: 100, output_tokens: 10 } }));
    const client = fakeClient(create);
    const model = createOpenAIV2ModelClient(client, "poc-test-model", budget);
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
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ input, previous_response_id: "response-2" }), expect.any(Object));
  });

  it("retains reservations for failed attempts and refuses a retry after restart when the job cap is spent", async () => {
    const create = vi.fn(async () => { throw new Error("provider timeout containing sensitive details"); });
    const model = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget);
    await expect(model.respond(request)).rejects.toThrow("provider timeout");
    await expect(model.respond(request)).rejects.toThrow("provider timeout");
    const restarted = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", new AgentBudgetLedger(root, budget.policy));
    await expect(restarted.respond(request)).rejects.toThrow("job cost cap");
    expect(create).toHaveBeenCalledTimes(2);
    const ledger = await readFile(join(root, ".replex-agent-budget.json"), "utf8");
    expect(ledger).not.toContain("sensitive");
    expect(ledger).not.toContain(request.prompt);
    expect(JSON.parse(ledger).jobs[budget.key("project-1", "intent-1")]).toMatchObject({ calls: 2, reservedMicroUsd: 2600 });
  });

  it("does not generate when full linked input exceeds the remaining job allowance", async () => {
    count.mockResolvedValue({ input_tokens: 2601 });
    const create = vi.fn();
    const model = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget);
    await expect(model.respond({ ...request, previousResponseId: "response-old" })).rejects.toThrow("job cost cap");
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ previous_response_id: "response-old" }), expect.any(Object));
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed when input counting is unavailable or invalid", async () => {
    const create = vi.fn();
    const model = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget);
    count.mockRejectedValueOnce(new Error("count unavailable"));
    await expect(model.respond(request)).rejects.toThrow("count unavailable");
    count.mockResolvedValueOnce({ input_tokens: NaN });
    await expect(model.respond(request)).rejects.toThrow("input cost");
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks further generation for an intent with missing usage", async () => {
    const create = vi.fn(async () => ({ id: "response-1", output: [], output_text: "", status: "completed" }));
    const model = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget);
    await expect(model.respond(request)).rejects.toThrow("usage is missing");
    await expect(model.respond(request)).rejects.toThrow("job cost cap");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("limits count and generation requests across different jobs and adapter restarts", async () => {
    budget = new AgentBudgetLedger(root, { ...budget.policy, requestsPerMinute: 2 });
    const create = vi.fn(async () => ({ id: "response-1", output: [], output_text: "", status: "completed", usage: { input_tokens: 100, output_tokens: 10 } }));
    await createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget).respond(request);
    const restarted = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", new AgentBudgetLedger(root, budget.policy));
    await expect(restarted.respond({ ...request, intentId: "intent-2" })).rejects.toThrow("rate limit");
    expect(count).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("never calls the provider for an already cancelled request", async () => {
    const create = vi.fn();
    const model = createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget);
    await expect(model.respond({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(count).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("fails live bootstrap closed without valid host pricing, without making requests", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-placeholder");
    vi.stubEnv("REPLEX_AGENT_INPUT_MICRO_USD_PER_MILLION", "");
    vi.stubEnv("REPLEX_AGENT_OUTPUT_MICRO_USD_PER_MILLION", "1000000");
    expect(() => createOpenAIV2ModelClientFromEnv("poc-test-model", root)).toThrow("INPUT_MICRO_USD");
    vi.stubEnv("REPLEX_AGENT_INPUT_MICRO_USD_PER_MILLION", "1000000");
    vi.stubEnv("REPLEX_AGENT_REQUESTS_PER_MINUTE", "0");
    expect(() => createOpenAIV2ModelClientFromEnv("poc-test-model", root)).toThrow();
    vi.stubEnv("REPLEX_AGENT_REQUESTS_PER_MINUTE", "12");
    expect(() => createOpenAIV2ModelClientFromEnv("poc-test-model", root)).not.toThrow();
  });

  it("honors cancellation while input counting is in flight", async () => {
    const controller = new AbortController();
    count.mockImplementationOnce(async () => { controller.abort(); return { input_tokens: 100 }; });
    const create = vi.fn();
    await expect(createOpenAIV2ModelClient(fakeClient(create), "poc-test-model", budget)
      .respond({ ...request, signal: controller.signal })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
