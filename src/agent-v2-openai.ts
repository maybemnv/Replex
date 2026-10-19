import { existsSync } from "node:fs";
import { resolve } from "node:path";
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { V2_AGENT_MAX_OUTPUT_TOKENS_PER_CALL, type V2AgentModelClient, type V2AgentModelRequest } from "./agent-v2.js";
import { AgentBudgetError, AgentBudgetLedger } from "./agent-v2-budget.js";

const MAX_IMAGE_BYTES_PER_RESULT = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES_PER_REQUEST = 4 * 1024 * 1024;

/** OpenAI Responses adapter; credentials and model selection remain host-owned. */
export function createOpenAIV2ModelClient(client: OpenAI, model: string, budget: AgentBudgetLedger): V2AgentModelClient {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(model)) throw new Error("invalid host model name");
  return {
    async respond(request) {
      if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
        || request.maxOutputTokens > V2_AGENT_MAX_OUTPUT_TOKENS_PER_CALL) {
        throw new Error("requested output-token ceiling is outside the Replex V2 limit");
      }
      request.signal.throwIfAborted();
      const params = {
        model,
        instructions: request.instructions,
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
          strict: true as const,
        })),
        input: modelInput(request),
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        parallel_tool_calls: false,
      };
      const options = { signal: request.signal, maxRetries: 0 };
      const key = budget.key(request.context.projectId, request.intentId);
      await budget.requestSlot(request.signal);
      // Count images, tool schemas, and linked history rather than estimating from local bytes.
      const counted = await client.responses.inputTokens.count(params, options);
      if (!Number.isSafeInteger(counted.input_tokens) || counted.input_tokens < 0) {
        throw new AgentBudgetError("provider could not establish the model input cost");
      }
      await budget.requestSlot(request.signal);
      await budget.reserve(key, counted.input_tokens, request.maxOutputTokens, request.signal);
      request.signal.throwIfAborted();
      const response = await client.responses.create({ ...params, max_output_tokens: request.maxOutputTokens }, options);
      const usage = response.usage;
      const validUsage = usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0
        && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0;
      const exceeded = !validUsage || usage.input_tokens > counted.input_tokens || usage.output_tokens > request.maxOutputTokens;
      await budget.usage(key, validUsage ? usage.input_tokens : 0, validUsage ? usage.output_tokens : 0, exceeded);

      if (response.usage && response.usage.output_tokens > request.maxOutputTokens) {
        throw new Error("provider exceeded the requested output-token ceiling");
      }
      if (exceeded) throw new AgentBudgetError("provider usage is missing or exceeds the reserved model budget");
      if (response.status === "incomplete") throw new Error("provider returned an incomplete response at the output-token ceiling");

      const calls = response.output.filter((item) => item.type === "function_call").map((item) => {
        let args: unknown = item.arguments;
        try { args = JSON.parse(item.arguments); } catch { /* Core rejects malformed typed arguments. */ }
        return { id: item.call_id, name: item.name, arguments: args };
      });
      return {
        responseId: response.id,
        calls,
        text: response.output_text.slice(0, 8_000),
      };
    },
  };
}

function modelInput(request: V2AgentModelRequest): ResponseInputItem[] {
  if (request.toolResults.length === 0) {
    return [{
      role: "user",
      content: [{ type: "input_text", text: JSON.stringify({ prompt: request.prompt, context: request.context }) }],
    }];
  }
  if (!request.previousResponseId) throw new Error("tool results require the preceding provider response ID");

  let totalImageBytes = 0;
  return request.toolResults.map((result) => {
    const output: NonNullable<Extract<ResponseInputItem, { type: "function_call_output" }>["output"]> = [
      { type: "input_text", text: JSON.stringify({ name: result.name, context: request.context, output: result.output }) },
    ];
    if ((result.images?.length ?? 0) > 8) throw new Error("evidence image count exceeds the provider request limit");
    for (const image of result.images ?? []) {
      if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") throw new Error("evidence image type is not supported by the provider adapter");
      if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0 || image.bytes.byteLength > MAX_IMAGE_BYTES_PER_RESULT) {
        throw new Error("evidence image exceeds the provider request limit");
      }
      totalImageBytes += image.bytes.byteLength;
      if (totalImageBytes > MAX_IMAGE_BYTES_PER_REQUEST) throw new Error("evidence image budget exceeds the provider request limit");
      output.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
        detail: "low",
      });
    }
    return { type: "function_call_output", call_id: result.callId, output };
  });
}

/** Host bootstrap for an explicitly named model; the key comes from OPENAI_API_KEY or a local .env file. */
export function createOpenAIV2ModelClientFromEnv(model: string, workspaceRoot: string): V2AgentModelClient {
  if (!process.env.OPENAI_API_KEY && existsSync(resolve(".env"))) process.loadEnvFile(resolve(".env"));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to enable the agent model");
  const positiveInteger = (name: string, fallback?: number): number => {
    const value = process.env[name];
    if (value === undefined && fallback !== undefined) return fallback;
    if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer`);
    return Number(value);
  };
  const budget = new AgentBudgetLedger(workspaceRoot, {
    maxJobMicroUsd: positiveInteger("REPLEX_AGENT_MAX_JOB_MICRO_USD", 100_000),
    inputMicroUsdPerMillion: positiveInteger("REPLEX_AGENT_INPUT_MICRO_USD_PER_MILLION"),
    outputMicroUsdPerMillion: positiveInteger("REPLEX_AGENT_OUTPUT_MICRO_USD_PER_MILLION"),
    requestsPerMinute: positiveInteger("REPLEX_AGENT_REQUESTS_PER_MINUTE", 12),
  });
  return createOpenAIV2ModelClient(new OpenAI({ apiKey, maxRetries: 0 }), model, budget);
}
