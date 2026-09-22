import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { createOpenAIClient, runOpenAIDraft, runRecordedAgentDraft } from "../src/agent.js";
import { applyOperations } from "../src/operations.js";
import { createProject } from "../src/project.js";
import { ffmpegPath, mediaAvailable } from "./media.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "replex-agent-"));
  await mkdir(join(root, "captures"), { recursive: true });
  const values = ["one", "two", "three"];
  for (const [index, value] of values.entries()) await writeFile(join(root, "captures", `${index}.mp4`), value);
  const project = createProject({
    projectId: "agent-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment("http://127.0.0.1:4173"),
    flow: normalFlow("http://127.0.0.1:4173"),
    captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 10000, sha256: createHash("sha256").update(values[index]).digest("hex") })),
  });
  return { root, project };
}

describe("recorded bounded model loop", () => {
  it("loads OPENAI_API_KEY from an ignored root env file without writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-env-"));
    const originalCwd = process.cwd();
    const originalKey = process.env.OPENAI_API_KEY;
    try {
      await writeFile(join(root, ".env"), "OPENAI_API_KEY=test-canary-key\n");
      process.chdir(root);
      delete process.env.OPENAI_API_KEY;
      createOpenAIClient();
      expect(process.env.OPENAI_API_KEY).toBe("test-canary-key");
      expect(await (await import("node:fs/promises")).readdir(root)).toEqual([".env"]);
    } finally {
      process.chdir(originalCwd);
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes an evidence-grounded edit through the sole operation reducer", async () => {
    const { root, project } = await fixture();
    try {
      const result = runRecordedAgentDraft(project, root, [
        { tool: "inspect_project", input: {} },
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: { id: "title-1", sceneId: project.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 2000 } } },
        { tool: "verify_project", input: {} },
      ]);
      expect(result).toMatchObject({ ok: false, code: "VERIFICATION_FAILED", toolCalls: 3 });
      expect(result.project.currentRevisionId).not.toBe("revision-0");
      expect(result.project.overlays["title-1"].text).toBe("Filter releases");
      expect(await (await import("node:fs/promises")).readFile(join(root, "operations.jsonl"), "utf8")).toContain('"evidenceRefs":["capture:capture-0"]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("stops unknown, stale, secret-bearing, and ungrounded calls without mutating the project", async () => {
    const { root, project } = await fixture();
    try {
      for (const call of [
        { tool: "shell", input: { command: "ffmpeg" } },
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: { id: "title-secret", sceneId: project.scenes[0].id, kind: "title", text: 'payload "password":"leaked-secret"', placement: "top", startMs: 0, endMs: 1000 } } },
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: [], overlay: { id: "title-1", sceneId: project.scenes[0].id, kind: "title", text: "x", placement: "top", startMs: 0, endMs: 1000 } } },
        { tool: "set_title", input: { baseRevisionId: "revision-stale", evidenceRefs: ["capture:capture-0"], overlay: { id: "title-1", sceneId: project.scenes[0].id, kind: "title", text: "stale request", placement: "top", startMs: 0, endMs: 1000 } } },
      ]) {
        const result = runRecordedAgentDraft(project, root, [call]);
        expect(result).toMatchObject({ ok: false });
        expect(project.currentRevisionId).toBe("revision-0");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete recorded draft that never renders", async () => {
    const { root, project } = await fixture();
    try {
      const result = runRecordedAgentDraft(project, root, [
        { tool: "inspect_project", input: {} },
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: { id: "title-1", sceneId: project.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 2000 } } },
      ]);
      expect(result).toMatchObject({ ok: false, code: "INVALID_CALL" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects evidence references that were never disclosed", async () => {
    const { root, project } = await fixture();
    try {
      const result = runRecordedAgentDraft(project, root, [
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:does-not-exist"], overlay: { id: "title-1", sceneId: project.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 2000 } } },
      ]);
      expect(result).toMatchObject({ ok: false, code: "INVALID_CALL" });
      if (!result.ok) expect(result.detail).toContain("never disclosed");
      expect(project.currentRevisionId).toBe("revision-0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the fixed tool-call budget", async () => {
    const { root, project } = await fixture();
    try {
      const result = runRecordedAgentDraft(project, root, Array.from({ length: 21 }, () => ({ tool: "inspect_project", input: {} })));
      expect(result).toMatchObject({ ok: false, code: "BUDGET_EXHAUSTED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps revision and verification state across real-client turns", async () => {
    const { root, project } = await fixture();
    try {
      const responses = [
        { id: "response-1", stopReason: "tool_use" as const, toolCalls: [{ id: "tool-1", tool: "inspect_project", input: {} }], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
        { id: "response-2", stopReason: "tool_use" as const, toolCalls: [{ id: "tool-2", tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: { id: "title-live", sceneId: project.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 1000 } } }] },
        { id: "response-3", stopReason: "tool_use" as const, toolCalls: [{ id: "tool-3", tool: "verify_project", input: {} }] },
        { id: "response-4", stopReason: "end_turn" as const, toolCalls: [] },
      ];
      const requests: unknown[] = [];
      const result = await runOpenAIDraft(project, root, { createResponse: async (request) => {
        requests.push(request);
        return responses.shift()!;
      } });
      expect(result).toMatchObject({ ok: false, code: "VERIFICATION_FAILED", toolCalls: 3 });
      expect(result.project.overlays["title-live"].text).toBe("Filter releases");
      expect(requests[0]).toMatchObject({ model: "gpt-5.6-luna", tools: expect.arrayContaining([expect.objectContaining({ type: "function", name: "inspect_project", strict: true })]) });
      expect(requests[0]).toMatchObject({ instructions: expect.stringContaining("use its returned revisionId") });
      expect(requests[1]).toMatchObject({ previousResponseId: "response-1", input: [{ type: "function_call_output", call_id: "tool-1" }] });
      expect(await readFile(join(root, "logs", "agent.jsonl"), "utf8")).toContain('"usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!mediaAvailable)("invalidates verification after a later accepted edit", async () => {
    const { root, project: base } = await fixture();
    try {
      const captures = { ...base.captures };
      for (const [id, capture] of Object.entries(captures)) {
        const path = join(root, capture.path);
        const generated = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "testsrc=s=1920x1080:r=30:d=10", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path], { encoding: "utf8", windowsHide: true });
        if (generated.status !== 0) throw new Error(generated.stderr || "could not create agent verification fixture");
        captures[id] = { ...capture, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
      }
      const project = { ...base, captures };
      const firstOverlay = { id: "title-after-verify", sceneId: project.scenes[0].id, kind: "title" as const, text: "First edit", placement: "top" as const, startMs: 0, endMs: 2000 };
      const first = applyOperations(project, project.currentRevisionId, [{ type: "set_title" as const, overlay: firstOverlay }]);
      if (!first.ok) throw new Error(first.detail);
      const result = runRecordedAgentDraft(project, root, [
        { tool: "inspect_project", input: {} },
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: firstOverlay } },
        { tool: "verify_project", input: {} },
        { tool: "set_callout", input: { baseRevisionId: first.project.currentRevisionId, evidenceRefs: ["capture:capture-1"], overlay: { id: "callout-after-verify", sceneId: project.scenes[1].id, kind: "callout", text: "Second edit", placement: "target", startMs: 0, endMs: 2000 } } },
        { tool: "render_draft", input: {} },
      ]);
      expect(result).toMatchObject({ ok: false, code: "VERIFICATION_FAILED" });
      expect(result.events).toEqual(["inspect_project", "set_title", "verify_project", "set_callout"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("fails closed when OpenAI reports tool use without a parsed call", async () => {
    const { root, project } = await fixture();
    try {
      let calls = 0;
      const result = await runOpenAIDraft(project, root, {
        createResponse: async () => {
          calls += 1;
          return { id: "response-empty", stopReason: "tool_use" as const, toolCalls: [] };
        },
      });
      expect(result).toMatchObject({ ok: false, code: "INVALID_CALL", toolCalls: 0 });
      if (!result.ok) expect(result.detail).toContain("without a parsed tool call");
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("audits the first transport failure before retrying", async () => {
    const { root, project } = await fixture();
    try {
      let calls = 0;
      const result = await runOpenAIDraft(project, root, {
        createResponse: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transport unavailable");
          return { id: "response-after-retry", stopReason: "tool_use" as const, toolCalls: [] };
        },
      });
      expect(result).toMatchObject({ ok: false, code: "INVALID_CALL" });
      expect(calls).toBe(2);
      expect(await readFile(join(root, "logs", "agent.jsonl"), "utf8")).toContain('"event":"transport_retry"');
      expect(await readFile(join(root, "logs", "agent.jsonl"), "utf8")).not.toContain("transport unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces one cumulative two-minute model deadline", async () => {
    const { root, project } = await fixture();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const result = await runOpenAIDraft(project, root, { createResponse: async () => {
        now += 120_001;
        return { id: "response-late", stopReason: "tool_use", toolCalls: [{ id: "tool-late", tool: "inspect_project", input: {} }] };
      } });
      expect(result).toMatchObject({ ok: false, code: "TRANSPORT_FAILED", detail: "agent exceeded two-minute model wall-time budget", toolCalls: 1 });
    } finally {
      clock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
