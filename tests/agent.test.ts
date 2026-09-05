import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { runClaudeDraft, runRecordedAgentDraft } from "../src/agent.js";
import { createProject } from "../src/project.js";

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
        { stopReason: "tool_use" as const, toolCalls: [{ id: "tool-1", tool: "inspect_project", input: {} }] },
        { stopReason: "tool_use" as const, toolCalls: [{ id: "tool-2", tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: { id: "title-live", sceneId: project.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 1000 } } }] },
        { stopReason: "tool_use" as const, toolCalls: [{ id: "tool-3", tool: "verify_project", input: {} }] },
        { stopReason: "end_turn" as const, toolCalls: [] },
      ];
      const result = await runClaudeDraft(project, root, { createMessage: async () => responses.shift()! });
      expect(result).toMatchObject({ ok: false, code: "VERIFICATION_FAILED", toolCalls: 3 });
      expect(result.project.overlays["title-live"].text).toBe("Filter releases");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
