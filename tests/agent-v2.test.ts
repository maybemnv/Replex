import { describe, expect, it, vi } from "vitest";
import { runConversationalEditV2 } from "../src/agent-v2.js";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema } from "../src/schema-v2.js";

function emptyProject() {
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "agent-v2-test-project",
    brief: { message: "A bounded conversation test" },
    assets: {},
    composition: {
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 1000,
      tracks: [],
      clips: [],
      layers: [],
    },
    revisions: [{ id: "revision-0", actor: "user", operationIds: [], manifestSha256: "0".repeat(64), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-0", status: "unknown", refs: [] },
    currentRevisionId: "revision-0",
  });
  project.revisions[0].manifestSha256 = semanticHashV2(project);
  return ProjectV2Schema.parse(project);
}

describe("V2 conversational edit thread", () => {
  it("rejects a follow-up whose saved revision pin is stale before calling model or host", async () => {
    const project = emptyProject();
    const respond = vi.fn();
    const commit = vi.fn();
    const result = await runConversationalEditV2({
      project,
      prompt: "Continue the edit",
      threadId: "thread-1",
      threadState: {
        threadId: "thread-1",
        projectId: project.projectId,
        currentRevisionId: "revision-old",
        currentRevisionHash: "f".repeat(64),
        operationIds: [],
      },
      inspect: vi.fn(),
      model: { respond },
      assetHandles: [],
      renderAuthorization: { projectRoot: ".", resolvedHandles: [], isRevisionCurrent: vi.fn() },
      commitCanonicalRevision: commit,
      evidenceRoot: ".",
    } as never);

    expect(result).toMatchObject({ ok: false, code: "STALE_THREAD" });
    expect(result.project).toEqual(project);
    expect(respond).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});
