import type { V2AgentModelClient } from "../agent-v2.js";

/** Deterministic demonstration of the real inspect/edit/preview loop; never contacts a provider. */
export function createDemoScriptedModel(): V2AgentModelClient {
  let counter = 0;
  return {
    async respond(request) {
      request.signal.throwIfAborted();
      const responseId = `demo-response-${++counter}`;
      const call = (name: string, args: unknown) => ({ responseId, calls: [{ id: `demo-call-${counter}`, name, arguments: args }] });
      const last = request.toolResults.at(-1);
      if (!last) return call("inspect_v2", { kind: "clips" });
      const output = last.output as { evidenceRefs?: string[]; data?: { items?: Array<{ assetId: string }> } };
      if (last.name === "inspect_v2" && !output.evidenceRefs?.length) {
        const assetId = output.data?.items?.[0]?.assetId;
        if (!assetId) throw new Error("Demo needs a composed browser clip before editing.");
        return call("inspect_v2", { kind: "media_evidence", assetId, image: "selected_frame", frameOffset: 0 });
      }
      if (last.name === "inspect_v2") return call("propose_edit_batch", {
        baseRevisionId: request.context.currentRevisionId, evidenceRefs: output.evidenceRefs,
        operations: [{ type: "update_text_layer", layerId: "demo-title", properties: { text: "Ship the change.", fontSize: 36, color: "#ffffff" } }],
      });
      if (!(last.output as { ok?: boolean }).ok) throw new Error("The demo edit was rejected.");
      return { responseId, calls: [], text: "The verified preview is ready." };
    },
  };
}
