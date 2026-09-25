import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runConversationalEditV2, type V2AgentModelClient, type V2AgentModelRequest } from "../../src/agent-v2.js";
import { inspectProjectV2, type V2InspectRequest } from "../../src/inspect-v2.js";
import { authorizeLocalImport, importLocalAssetV2 } from "../../src/import-v2.js";
import { generateMediaEvidence } from "../../src/media-evidence.js";
import { applyOperationBatch, semanticHashV2, type Operation, type OperationLogRecord } from "../../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../../src/schema-v2.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";

const promptOne = "Tighten the beginning, crop toward the product, and make it faster.";
const promptTwo = "Keep that edit but make the intro slightly slower and lower the audio.";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function emptyProject(): ProjectV2 {
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "conversation-v2-e2e",
    brief: { message: "A deterministic uploaded product walkthrough" },
    assets: {},
    composition: {
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 1400,
      tracks: [{ id: "video-track", kind: "video", order: 0, muted: false, locked: false }],
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

function replay(records: OperationLogRecord[], base: ProjectV2): ProjectV2 {
  const batches = new Map<string, OperationLogRecord[]>();
  for (const record of records) batches.set(record.resultRevisionId, [...(batches.get(record.resultRevisionId) ?? []), record]);
  let project = base;
  for (const [revisionId, batchRecords] of batches) {
    const first = batchRecords[0];
    const result = applyOperationBatch(project, {
      baseRevisionId: first.baseRevisionId,
      actor: first.actor,
      intentId: first.intentId,
      evidenceRefs: first.evidenceRefs,
      operations: batchRecords.map(({ input }) => input),
      createdAt: first.createdAt,
    });
    if (!result.ok) throw new Error("operation replay failed: " + result.detail);
    expect(result.revisionId).toBe(revisionId);
    project = result.project;
  }
  return project;
}

describe("V2 conversational edit E2E", () => {
  // This real-media proof skips only when the configured FFmpeg and FFprobe binaries cannot both launch.
  it.skipIf(!mediaAvailable)("grounds two follow-up prompts in persisted evidence and renders replayable revisions", async () => {
    const inputRoot = await mkdtemp(join(tmpdir(), "replex-v2-agent-input-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "replex-v2-agent-project-"));
    const sourcePath = join(inputRoot, "product-walkthrough.mp4");
    const base = emptyProject();
    let canonicalProject = base;
    const canonicalLog: OperationLogRecord[] = [];
    const commits: string[] = [];

    try {
      const fixture = spawnSync(ffmpegPath, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        sourcePath,
      ], { windowsHide: true, shell: false, timeout: 30_000 });
      expect(fixture.status, fixture.stderr?.toString()).toBe(0);

      const authorized = await authorizeLocalImport(sourcePath, [inputRoot], "file_picker");
      const imported = await importLocalAssetV2(base, projectRoot, authorized, { ffmpegPath, ffprobePath });
      canonicalProject = imported.project;
      canonicalLog.push(...imported.operationLog);

      const asset = imported.asset;
      const assetHandle = { assetId: asset.id, sha256: asset.sha256, ref: asset.path! };
      const sourceAssetPath = join(projectRoot, ...asset.path!.split("/"));
      const evidenceRoot = join(projectRoot, "evidence");
      const evidence = await generateMediaEvidence({
        asset: assetHandle,
        resolveSource: async (handle) => {
          expect(handle).toEqual(assetHandle);
          return sourceAssetPath;
        },
        evidenceRoot,
        ffmpegPath,
        ffprobePath,
      });
      expect(evidence.sourceSha256).toBe(asset.sha256);
      expect(evidence.artifacts.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["probe", "selected_frame", "contact_sheet", "scene_boundaries", "audio_summary"]));

      const created = applyOperationBatch(canonicalProject, {
        baseRevisionId: canonicalProject.currentRevisionId,
        actor: "user",
        intentId: "conversation-e2e-create-clip",
        evidenceRefs: [evidence.indexRef],
        operations: [{
          type: "create_clip",
          clip: {
            id: "uploaded-clip",
            assetId: asset.id,
            trackId: "video-track",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 1400,
            speed: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            opacity: 1,
            audioGainDb: 0,
            muted: false,
          },
        }],
        createdAt: "2026-09-25T00:00:01.000Z",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.detail);
      canonicalProject = created.project;
      canonicalLog.push(...created.operationLog);

      const initialThreadState = {
        threadId: "conversation-thread-1",
        projectId: canonicalProject.projectId,
        currentRevisionId: canonicalProject.currentRevisionId,
        currentRevisionHash: canonicalProject.revisions.at(-1)!.manifestSha256,
        operationIds: [...canonicalProject.revisions.at(-1)!.operationIds],
      };

      const inspections: Array<{ request: V2InspectRequest; result: Awaited<ReturnType<typeof inspectProjectV2>> }> = [];
      let inspectedEvidenceRefs: string[] = [];
      const inspect = async (project: ProjectV2, request: V2InspectRequest) => {
        const result = await inspectProjectV2(request, {
          project,
          evidenceIndexes: [evidence],
          evidenceRoot,
          operationLog: canonicalLog,
        });
        inspections.push({ request, result });
        if (result.ok) inspectedEvidenceRefs.splice(0, inspectedEvidenceRefs.length, ...result.evidenceRefs);
        return result;
      };

      const proposedOne: Operation[] = [
        { type: "set_speed", clipId: "uploaded-clip", speed: 1.25 },
        { type: "trim_clip", clipId: "uploaded-clip", sourceInMs: 150, sourceOutMs: 1900 },
        {
          type: "set_transform",
          clipId: "uploaded-clip",
          transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
          crop: { x: 0.15, y: 0.1, width: 0.7, height: 0.8 },
        },
      ];
      const proposedTwo: Operation[] = [
        { type: "trim_clip", clipId: "uploaded-clip", sourceInMs: 150, sourceOutMs: 1760 },
        { type: "set_speed", clipId: "uploaded-clip", speed: 1.15 },
        { type: "set_volume", clipId: "uploaded-clip", audioGainDb: -6 },
      ];
      const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });
      const responseQueues = new Map<string, Array<{ responseId: string; calls: Array<{ id: string; name: string; arguments: unknown }>; text?: string }>>([
        [promptOne, [
          { responseId: "thread-one-inspect", calls: [call("inspect-one", "inspect_v2", { kind: "media_evidence", assetId: asset.id, image: "selected_frame", frameOffset: 0 })] },
          { responseId: "thread-one-propose", calls: [call("propose-one", "propose_edit_batch", { baseRevisionId: initialThreadState.currentRevisionId, evidenceRefs: inspectedEvidenceRefs, operations: proposedOne })] },
          { responseId: "thread-one-final", calls: [], text: "Applied the requested edit." },
        ]],
        [promptTwo, [
          { responseId: "thread-two-inspect", calls: [call("inspect-two", "inspect_v2", { kind: "media_evidence", assetId: asset.id, image: "selected_frame", frameOffset: 0 })] },
          { responseId: "thread-two-propose", calls: [call("propose-two", "propose_edit_batch", { baseRevisionId: canonicalProject.currentRevisionId, evidenceRefs: inspectedEvidenceRefs, operations: proposedTwo })] },
          { responseId: "thread-two-final", calls: [], text: "Kept the crop and adjusted speed and audio." },
        ]],
      ]);
      const modelInputs: Array<Pick<V2AgentModelRequest, "prompt" | "previousResponseId" | "toolResults"> & V2AgentModelRequest["context"]> = [];
      const model: V2AgentModelClient = {
        async respond(input) {
          modelInputs.push({ prompt: input.prompt, previousResponseId: input.previousResponseId, projectId: input.context.projectId, currentRevisionId: input.context.currentRevisionId, currentRevisionHash: input.context.currentRevisionHash, toolResults: input.toolResults });
          const queue = responseQueues.get(input.prompt);
          const response = queue?.shift();
          if (!response) return { responseId: "unexpected-empty-" + modelInputs.length, calls: [] };
          if (!response.calls.some(({ name }) => name === "propose_edit_batch")) return response;
          const proposal = response.calls.find(({ name }) => name === "propose_edit_batch")!;
          const args = proposal.arguments as { operations: Operation[] };
          return {
            ...response,
            calls: response.calls.map((toolCall) => toolCall === proposal
              ? { ...toolCall, arguments: { baseRevisionId: input.context.currentRevisionId, evidenceRefs: [...inspectedEvidenceRefs], operations: args.operations } }
              : toolCall),
          };
        },
      };

      const resolvedHandles = [{ ...assetHandle, path: sourceAssetPath }];
      const renderAuthorization = {
        projectRoot,
        resolvedHandles,
        isRevisionCurrent: async (revisionId: string, revisionHash: string) =>
          revisionId === canonicalProject.currentRevisionId && revisionHash === semanticHashV2(canonicalProject),
      };
      const commitCanonicalRevision = async (request: {
        baseRevisionId: string;
        baseRevisionHash: string;
        project: ProjectV2;
        operationLog: OperationLogRecord[];
      }): Promise<{ ok: true; project: ProjectV2 } | { ok: false; code: string; detail?: string }> => {
        if (request.baseRevisionId !== canonicalProject.currentRevisionId
          || request.baseRevisionHash !== semanticHashV2(canonicalProject)) {
          return { ok: false, code: "STALE_REVISION", detail: "canonical project revision changed" };
        }
        if (!request.operationLog.length || request.operationLog.some((record) =>
          record.actor !== "agent" || record.baseRevisionId !== request.baseRevisionId
          || record.resultRevisionId !== request.project.currentRevisionId)) {
          return { ok: false, code: "INVALID_BATCH", detail: "agent operation batch is incomplete" };
        }
        const first = request.operationLog[0];
        const applied = applyOperationBatch(canonicalProject, {
          baseRevisionId: request.baseRevisionId,
          actor: "agent",
          intentId: first.intentId,
          evidenceRefs: first.evidenceRefs,
          operations: request.operationLog.map(({ input }) => input),
          createdAt: first.createdAt,
        });
        if (!applied.ok || applied.revisionId !== request.project.currentRevisionId
          || semanticHashV2(applied.project) !== semanticHashV2(request.project)) {
          return { ok: false, code: "INVALID_BATCH", detail: applied.ok ? "reducer result differs from candidate" : applied.detail };
        }
        canonicalProject = applied.project;
        canonicalLog.push(...applied.operationLog);
        commits.push(applied.revisionId);
        return { ok: true, project: canonicalProject };
      };

      const run = (prompt: string, threadState: typeof initialThreadState, project: ProjectV2) => runConversationalEditV2({
        project,
        prompt,
        threadId: initialThreadState.threadId,
        threadState,
        inspect,
        model,
        assetHandles: [assetHandle],
        renderAuthorization,
        commitCanonicalRevision,
        evidenceRoot,
        renderOptions: { ffmpegPath, ffprobePath, timeoutMs: 60_000 },
      });

      const baseSemanticHash = semanticHashV2(base);
      const first = await run(promptOne, initialThreadState, canonicalProject);
      expect(first.ok, first.ok ? "" : `${first.code}: ${first.detail}\n${JSON.stringify(modelInputs.map(({ toolResults }) => toolResults))}`).toBe(true);
      if (!first.ok) throw new Error("first conversational edit failed: " + first.code);
      const firstPromptInputs = modelInputs.filter(({ prompt }) => prompt === promptOne);
      const selectedFrameRef = evidence.artifacts.find(({ kind }) => kind === "selected_frame")!.ref;
      expect(firstPromptInputs).toHaveLength(3);
      expect(JSON.stringify(firstPromptInputs[1]?.toolResults)).toContain(inspectedEvidenceRefs[0]);
      expect(JSON.stringify(firstPromptInputs[1]?.toolResults)).toContain(selectedFrameRef);
      expect(firstPromptInputs[1]?.toolResults.some((result) => result.images?.some((image) => image.ref === selectedFrameRef && image.bytes.byteLength > 0))).toBe(true);
      const previewToolResult = firstPromptInputs[2]?.toolResults.find(({ name }) => name === "propose_edit_batch");
      const previewOutput = previewToolResult?.output as {
        ok: boolean;
        preview?: { verificationRefId: string; checks: { probe: boolean; decode: boolean; hash: boolean } };
        previewEvidence?: { imageRef: string };
      } | undefined;
      expect(previewOutput?.ok).toBe(true);
      expect(previewOutput?.preview?.checks).toMatchObject({ probe: true, decode: true, hash: true });
      expect(previewOutput?.preview?.verificationRefId).toBeTruthy();
      expect(previewToolResult?.images?.some((image) => image.ref === previewOutput?.previewEvidence?.imageRef && image.bytes.byteLength > 0)).toBe(true);
      expect(first.threadState).toMatchObject({
        threadId: initialThreadState.threadId,
        projectId: canonicalProject.projectId,
        currentRevisionId: first.project.currentRevisionId,
        currentRevisionHash: semanticHashV2(first.project),
      });
      expect(first.project.currentRevisionId).not.toBe(initialThreadState.currentRevisionId);
      expect(first.project.composition.clips[0]).toMatchObject({
        sourceInMs: 150,
        sourceOutMs: 1900,
        speed: 1.25,
        crop: { x: 0.15, y: 0.1, width: 0.7, height: 0.8 },
      });
      expect(canonicalProject.currentRevisionId).toBe(first.project.currentRevisionId);
      expect(semanticHashV2(first.project)).toBe(semanticHashV2(canonicalProject));
      expect(first.operationLog.filter(({ resultRevisionId }) => resultRevisionId === first.project.currentRevisionId)).toHaveLength(3);
      expect(first.operationLog.filter(({ resultRevisionId }) => resultRevisionId === first.project.currentRevisionId).every(({ actor, accepted }) => actor === "agent" && accepted)).toBe(true);
      expect(first.previews.length).toBeGreaterThan(0);

      const firstRevision = first.project.currentRevisionId;
      const firstThreadState = first.threadState;
      const firstResponseId = first.threadState.previousResponseId;
      expect(firstResponseId).toBeTruthy();
      canonicalProject = first.project;
      const second = await run(promptTwo, firstThreadState, first.project);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("follow-up conversational edit failed: " + second.code);
      canonicalProject = second.project;
      expect(second.project.currentRevisionId).not.toBe(firstRevision);
      expect(second.threadState).toMatchObject({
        currentRevisionId: second.project.currentRevisionId,
        currentRevisionHash: semanticHashV2(second.project),
      });
      expect(second.project.composition.clips[0]).toMatchObject({
        sourceInMs: 150,
        sourceOutMs: 1760,
        speed: 1.15,
        audioGainDb: -6,
        crop: { x: 0.15, y: 0.1, width: 0.7, height: 0.8 },
      });
      const secondTurnFirstInput = modelInputs.find(({ prompt }) => prompt === promptTwo);
      expect(secondTurnFirstInput?.previousResponseId).toBe(firstResponseId);
      expect(secondTurnFirstInput?.currentRevisionId).toBe(firstRevision);
      expect(secondTurnFirstInput?.currentRevisionHash).toBe(semanticHashV2(first.project));
      expect(modelInputs.some(({ prompt, toolResults }) =>
        prompt === promptOne && JSON.stringify(toolResults).includes(evidence.artifacts.find(({ kind }) => kind === "selected_frame")!.ref))).toBe(true);
      expect(inspections.filter(({ request, result }) => request.kind === "media_evidence" && result.ok)).toHaveLength(2);

      const finalRevision = second.project.currentRevisionId;
      const agentBatches = canonicalLog.filter(({ actor, resultRevisionId }) =>
        actor === "agent" && [firstRevision, finalRevision].includes(resultRevisionId));
      expect(new Set(agentBatches.map(({ resultRevisionId }) => resultRevisionId)).size).toBe(2);
      expect(commits).toEqual([firstRevision, finalRevision]);
      expect(first.previews.length).toBeGreaterThan(0);
      expect(second.previews.length).toBeGreaterThan(0);

      for (const artifact of first.previews) expect(artifact.sourceRevisionId).toBe(firstRevision);
      for (const artifact of second.previews) expect(artifact.sourceRevisionId).toBe(finalRevision);
      for (const artifact of [...first.previews, ...second.previews]) {
        expect(artifact.verification).toMatchObject({ status: "passed", checks: { probe: true, decode: true, hash: true } });
        const artifactPath = join(projectRoot, ...artifact.ref.split("/"));
        const bytes = await readFile(artifactPath);
        expect(bytes.length).toBeGreaterThan(0);
        expect(sha256(bytes)).toBe(artifact.sha256);
        const receiptPath = join(projectRoot, ...artifact.verification.evidenceRefs[0].split("/"));
        expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ status: "passed", artifactSha256: artifact.sha256 });
        expect(await stat(artifactPath)).toMatchObject({ size: bytes.length });
      }

      const replayed = replay(canonicalLog, base);
      expect(replayed.currentRevisionId).toBe(canonicalProject.currentRevisionId);
      expect(replayed.revisions.at(-1)?.manifestSha256).toBe(canonicalProject.revisions.at(-1)?.manifestSha256);
      expect(semanticHashV2(replayed)).toBe(semanticHashV2(canonicalProject));
      expect(semanticHashV2(second.project)).toBe(semanticHashV2(canonicalProject));
      expect(second.project.revisions.map(({ id }) => id)).toEqual(canonicalProject.revisions.map(({ id }) => id));
      expect(second.project.verification.status).toBe("passed");
      expect(second.project.outputs.length).toBeGreaterThanOrEqual(first.previews.length + second.previews.length);
      expect(semanticHashV2(second.project)).toBe(second.project.revisions.at(-1)?.manifestSha256);

      const modelCallCount = modelInputs.length;
      const commitCount = commits.length;
      const stale = await run(promptTwo, firstThreadState, second.project);
      expect(stale).toMatchObject({ ok: false, code: "STALE_THREAD" });
      expect(modelInputs).toHaveLength(modelCallCount);
      expect(commits).toHaveLength(commitCount);
      expect(canonicalProject.currentRevisionId).toBe(finalRevision);

      expect(second.operationLog.filter(({ resultRevisionId }) => resultRevisionId === finalRevision)).toHaveLength(3);
      expect(second.operationLog.filter(({ resultRevisionId }) => resultRevisionId === finalRevision).every(({ actor, accepted }) => actor === "agent" && accepted)).toBe(true);
      expect(canonicalProject.revisions.filter(({ actor }) => actor === "agent")).toHaveLength(2);
      expect(semanticHashV2(base)).toBe(baseSemanticHash);
    } finally {
      await rm(inputRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
