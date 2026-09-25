import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConversationalEditV2, V2_AGENT_TOOLS, type V2AgentModelRequest, type V2AgentModelResponse, type V2CanonicalRevisionCommit, type V2ConversationRequest } from "../src/agent-v2.js";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const evidenceRef = "media-evidence:asset-1";

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

function projectWithClip(): ProjectV2 {
  const sourceSha256 = sha("uploaded-video-fixture");
  const probe = { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 2, sampleRateHz: 48000 };
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "agent-v2-media-project",
    brief: { message: "A small uploaded video edit" },
    assets: {
      "asset-1": {
        id: "asset-1",
        type: "uploaded_video",
        path: "assets/demo.mp4",
        sha256: sourceSha256,
        probe,
        provenance: {
          kind: "upload",
          originalFilename: "demo.mp4",
          importedAt: "2026-09-25T00:00:00.000Z",
          sourceSha256,
          importMethod: "path",
          originalProbe: probe,
        },
      },
    },
    composition: {
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 1000,
      tracks: [{ id: "video-1", kind: "video", order: 0, muted: false, locked: false }],
      clips: [{
        id: "clip-1",
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartMs: 0,
        sourceInMs: 0,
        sourceOutMs: 1000,
        speed: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        opacity: 1,
        audioGainDb: 0,
        muted: false,
      }],
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

function requestFor(project: ProjectV2, model: V2ConversationRequest["model"], overrides: Partial<V2ConversationRequest> = {}): V2ConversationRequest {
  return {
    project,
    prompt: "Make the opening faster",
    threadId: "thread-1",
    inspect: async () => ({ ok: false, code: "unexpected inspection" }),
    model,
    assetHandles: project.assets["asset-1"] ? [{ assetId: "asset-1", sha256: project.assets["asset-1"].sha256, ref: project.assets["asset-1"].path! }] : [],
    renderAuthorization: { projectRoot: ".", resolvedHandles: [], isRevisionCurrent: vi.fn() },
    renderOptions: { ffmpegPath: "missing-ffmpeg", ffprobePath: "missing-ffprobe", timeoutMs: 1000 },
    commitCanonicalRevision: async () => ({ ok: false, code: "unexpected commit" }),
    evidenceRoot: ".",
    ...overrides,
  };
}

function scriptedModel(responses: Array<(input: V2AgentModelRequest) => V2AgentModelResponse>) {
  let index = 0;
  return {
    respond: vi.fn(async (input: V2AgentModelRequest) => responses[index++](input)),
  };
}

const finalResponse = (id = "response-final"): V2AgentModelResponse => ({ responseId: id, calls: [], text: "Done." });

describe("V2 conversational edit thread", () => {
  it("offers only strict-schema tools with closed typed operation objects", () => {
    const visit = (schema: Record<string, unknown>): void => {
      expect(schema).not.toHaveProperty("oneOf");
      if (schema.type === "object" || schema.properties) {
        expect(schema.additionalProperties).toBe(false);
        const properties = schema.properties as Record<string, unknown> | undefined;
        expect([...(schema.required as string[] ?? [])].sort()).toEqual(Object.keys(properties ?? {}).sort());
        for (const child of Object.values(properties ?? {})) visit(child as Record<string, unknown>);
      }
      if (Array.isArray(schema.anyOf)) for (const child of schema.anyOf) visit(child as Record<string, unknown>);
      if (schema.items && typeof schema.items === "object") visit(schema.items as Record<string, unknown>);
    };

    expect(V2_AGENT_TOOLS.map(({ name }) => name)).toEqual(["inspect_v2", "propose_edit_batch"]);
    for (const tool of V2_AGENT_TOOLS) {
      expect(tool.strict).toBe(true);
      visit(tool.parameters as Record<string, unknown>);
    }
    const proposal = V2_AGENT_TOOLS.find(({ name }) => name === "propose_edit_batch")!.parameters;
    const operationBranches = ((proposal.properties as Record<string, unknown>).operations as { items: { anyOf: Array<{ properties: { type: { const: string } } }> } }).items.anyOf;
    expect(operationBranches.map(({ properties }) => properties.type.const).sort()).toEqual([
      "mute_clip", "set_opacity", "set_speed", "set_transform", "set_volume", "trim_clip",
    ]);
  });

  it("rejects a follow-up whose saved revision pin is stale before calling model or host", async () => {
    const project = emptyProject();
    const respond = vi.fn(async (_input: V2AgentModelRequest) => finalResponse());
    const model = { respond };
    const commit = vi.fn(async (_input: V2CanonicalRevisionCommit) => ({ ok: false as const, code: "unexpected" }));
    const result = await runConversationalEditV2(requestFor(project, model, {
      prompt: "Continue the edit",
      threadState: {
        threadId: "thread-1",
        projectId: project.projectId,
        currentRevisionId: "revision-old",
        currentRevisionHash: "f".repeat(64),
        operationIds: [],
      },
      commitCanonicalRevision: commit,
    }));

    expect(result).toMatchObject({ ok: false, code: "STALE_THREAD" });
    expect(result.project).toEqual(project);
    expect(respond).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("returns unsupported tool calls as bounded errors without exposing a shell path", async () => {
    const model = scriptedModel([
      () => ({ responseId: "response-1", calls: [{ id: "call-1", name: "run_shell", arguments: { command: "ffmpeg secret" } }] }),
      (input) => {
        expect(input.toolResults).toEqual([{ callId: "call-1", name: "run_shell", output: { ok: false, code: "UNSUPPORTED_TOOL", detail: "tool name is not in the fixed Replex allowlist" } }]);
        return finalResponse("response-2");
      },
    ]);
    const commit = vi.fn();
    const result = await runConversationalEditV2(requestFor(emptyProject(), model, { commitCanonicalRevision: commit }));

    expect(result).toMatchObject({ ok: true, project: { currentRevisionId: "revision-0" }, acceptedBatches: [], previews: [] });
    expect(model.respond).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects invalid inspection arguments before calling the bounded inspector", async () => {
    const model = scriptedModel([
      () => ({ responseId: "response-1", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "assets", offset: -1 } }] }),
      (input) => {
        expect(input.toolResults[0]?.output).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
        return finalResponse("response-2");
      },
    ]);
    const inspect = vi.fn();
    const result = await runConversationalEditV2(requestFor(emptyProject(), model, { inspect }));

    expect(result).toMatchObject({ ok: true, project: { currentRevisionId: "revision-0" } });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects proposals grounded in refs not disclosed by an earlier inspection", async () => {
    const project = projectWithClip();
    const model = scriptedModel([
      (input) => ({ responseId: "response-1", calls: [{
        id: "call-edit",
        name: "propose_edit_batch",
        arguments: { baseRevisionId: input.context.currentRevisionId, evidenceRefs: ["media-evidence:not-inspected"], operations: [{ type: "set_speed", clipId: "clip-1", speed: 1.25 }] },
      }] }),
      (input) => {
        expect(input.toolResults[0]?.output).toMatchObject({ ok: false, code: "UNGROUNDED_EVIDENCE" });
        return finalResponse("response-2");
      },
    ]);
    const commit = vi.fn();
    const result = await runConversationalEditV2(requestFor(project, model, { commitCanonicalRevision: commit }));

    expect(result).toMatchObject({ ok: true, project: { currentRevisionId: "revision-0" }, operationLog: [], previews: [] });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects an invalid multi-operation batch atomically before host commit", async () => {
    const project = projectWithClip();
    const model = scriptedModel([
      () => ({ responseId: "response-1", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-1" } }] }),
      (input) => ({ responseId: "response-2", calls: [{
        id: "call-edit",
        name: "propose_edit_batch",
        arguments: {
          baseRevisionId: input.context.currentRevisionId,
          evidenceRefs: [evidenceRef],
          operations: [
            { type: "set_speed", clipId: "clip-1", speed: 1.25 },
            { type: "set_volume", clipId: "missing-clip", audioGainDb: -6 },
          ],
        },
      }] }),
      (input) => {
        expect(input.toolResults[0]?.output).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
        return finalResponse("response-3");
      },
    ]);
    const commit = vi.fn();
    const originalHash = semanticHashV2(project);
    const result = await runConversationalEditV2(requestFor(project, model, {
      inspect: async (_project, request) => request.kind === "media_evidence" ? { ok: true, data: { selectedFrames: 2 }, evidenceRefs: [evidenceRef] } : { ok: false, code: "not found" },
      commitCanonicalRevision: commit,
    }));

    expect(result).toMatchObject({ ok: true, project: { currentRevisionId: "revision-0" }, operationLog: [], previews: [] });
    expect(semanticHashV2(project)).toBe(originalHash);
    expect(commit).not.toHaveBeenCalled();
  });

  it("requires the host CAS commit to succeed before it starts any render", async () => {
    const project = projectWithClip();
    const model = scriptedModel([
      () => ({ responseId: "response-1", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-1" } }] }),
      (input) => ({ responseId: "response-2", calls: [{
        id: "call-edit",
        name: "propose_edit_batch",
        arguments: { baseRevisionId: input.context.currentRevisionId, evidenceRefs: [evidenceRef], operations: [{ type: "set_volume", clipId: "clip-1", audioGainDb: -6 }] },
      }] }),
      (input) => {
        expect(input.toolResults[0]?.output).toMatchObject({ ok: false, code: "COMMIT_REJECTED" });
        return finalResponse("response-3");
      },
    ]);
    const isRevisionCurrent = vi.fn();
    const commit = vi.fn(async (_input: V2CanonicalRevisionCommit) => ({ ok: false as const, code: "STALE_REVISION", detail: "host CAS lost" }));
    const result = await runConversationalEditV2(requestFor(project, model, {
      inspect: async () => ({ ok: true, data: { summary: "clip 1" }, evidenceRefs: [evidenceRef] }),
      renderAuthorization: { projectRoot: ".", resolvedHandles: [], isRevisionCurrent },
      commitCanonicalRevision: commit,
    }));

    expect(result).toMatchObject({ ok: true, project: { currentRevisionId: "revision-0" }, operationLog: [], previews: [] });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0]).toMatchObject({ baseRevisionId: "revision-0", baseRevisionHash: semanticHashV2(project) });
    expect(isRevisionCurrent).not.toHaveBeenCalled();
  });

  it("honors cancellation while waiting for the model", async () => {
    const abort = new AbortController();
    const model = { respond: vi.fn(({ signal }: V2AgentModelRequest) => new Promise<V2AgentModelResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("model received abort")), { once: true });
    })) };
    const resultPromise = runConversationalEditV2(requestFor(emptyProject(), model, { signal: abort.signal }));
    setTimeout(() => abort.abort(), 10);
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, code: "CANCELLED", project: { currentRevisionId: "revision-0" } });
    expect(model.respond).toHaveBeenCalledOnce();
  });

  it("enforces the four-model-call limit", async () => {
    const model = scriptedModel(Array.from({ length: 4 }, (_, index) => () => ({
      responseId: `response-${index}`,
      calls: [{ id: `call-${index}`, name: "unknown_tool", arguments: {} }],
    })));
    const result = await runConversationalEditV2(requestFor(emptyProject(), model));

    expect(result).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
    expect(model.respond).toHaveBeenCalledTimes(4);
  });
});
