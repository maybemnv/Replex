import { afterEach, describe, expect, it } from "vitest";
import { startDemoFixture } from "../src/demo/fixture.js";
import { createDemoScriptedModel } from "../src/demo/scripted-model.js";
import { checkDemoPrerequisites } from "../src/demo/preflight.js";
import { CaptureDestinationPolicy } from "../src/capture-network-policy.js";
import type { V2AgentModelRequest } from "../src/agent-v2.js";

describe("local demo components", () => {
  let fixture: Awaited<ReturnType<typeof startDemoFixture>> | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });
  it("owns the exact fixture origin and changes only fake product content", async () => {
    fixture = await startDemoFixture();
    expect(fixture.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const policy = new CaptureDestinationPolicy([fixture.origin], fixture.fixtureGrants);
    expect((await policy.destination(fixture.origin, new AbortController().signal)).address).toBe("127.0.0.1");
    const before = await (await fetch(fixture.origin)).text();
    fixture.change();
    expect((await fetch(fixture.origin + "/__reset", { method: "POST" })).status).toBe(204);
    const after = await (await fetch(fixture.origin)).text();
    expect(before).toContain("Release filters, ready for your team.");
    expect(after).toContain("New: saved release filters are ready.");
    expect((await fetch(fixture.origin + "/not-a-fixture-route")).status).toBe(404);
  });
  it("makes evidence-grounded typed demo edits without any provider client", async () => {
    const model = createDemoScriptedModel();
    const request: V2AgentModelRequest = {
      intentId: "demo-intent", threadId: "demo-thread", prompt: "Update the title", instructions: "", tools: [], maxOutputTokens: 1200,
      context: { projectId: "demo-project", currentRevisionId: "revision-1", currentRevisionHash: "a".repeat(64) },
      toolResults: [], signal: new AbortController().signal,
    };
    expect((await model.respond(request)).calls[0]).toMatchObject({ name: "inspect_v2", arguments: { kind: "clips" } });
    expect((await model.respond({ ...request, toolResults: [{ callId: "clips", name: "inspect_v2", output: { data: { items: [{ assetId: "asset-browser" }] } } }] })).calls[0])
      .toMatchObject({ name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-browser" } });
    const proposed = await model.respond({ ...request, toolResults: [{ callId: "evidence", name: "inspect_v2", output: { evidenceRefs: ["evidence/frame.png"] } }] });
    expect(proposed.calls[0]).toMatchObject({ name: "propose_edit_batch", arguments: { baseRevisionId: "revision-1", evidenceRefs: ["evidence/frame.png"] } });
    await expect(model.respond({ ...request, toolResults: [{ callId: "rejected", name: "propose_edit_batch", output: { ok: false } }] })).rejects.toThrow("rejected");
  });
  it("reports unsupported Node and missing media tools before starting any services", () => {
    expect(() => checkDemoPrerequisites({ nodeVersion: "18.19.1" })).toThrow("Node.js 22");
    expect(() => checkDemoPrerequisites({ ffmpegPath: "/nonexistent/replex-demo-ffmpeg" })).toThrow("REPLEX_FFMPEG_PATH");
  });
});
