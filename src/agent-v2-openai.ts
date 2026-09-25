import type OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { V2_AGENT_MAX_OUTPUT_TOKENS_PER_CALL, type V2AgentModelClient, type V2AgentModelRequest } from "./agent-v2.js";

const MAX_IMAGE_BYTES_PER_RESULT = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES_PER_REQUEST = 4 * 1024 * 1024;

/** OpenAI Responses adapter; credentials and model selection remain host-owned. */
export function createOpenAIV2ModelClient(client: OpenAI, model: string): V2AgentModelClient {
  return {
    async respond(request) {
      if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
        || request.maxOutputTokens > V2_AGENT_MAX_OUTPUT_TOKENS_PER_CALL) {
        throw new Error("requested output-token ceiling is outside the Replex V2 limit");
      }
      const response = await client.responses.create({
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
        max_output_tokens: request.maxOutputTokens,
      }, { signal: request.signal });

      if (response.usage && response.usage.output_tokens > request.maxOutputTokens) {
        throw new Error("provider exceeded the requested output-token ceiling");
      }
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
