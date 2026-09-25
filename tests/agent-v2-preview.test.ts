import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/render-v2.js", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  return {
    buildMediaExecutionJob: vi.fn((project: { currentRevisionId: string }) => ({ jobHash: "a".repeat(64), sourceRevisionId: project.currentRevisionId })),
    executeMediaExecutionJob: vi.fn(async (job: { jobHash: string; sourceRevisionId: string }, authorization: { projectRoot: string }) => {
      const ref = "renders/preview.mp4";
      const bytes = Buffer.from("deterministic mock render");
      const sourceRevisionHash = "b".repeat(64);
      const filePath = join(authorization.projectRoot, ref);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const verificationRefId = "verification-preview";
      return {
        preflight: { status: "passed", sourceRevisionId: job.sourceRevisionId, sourceRevisionHash, assetId: "asset-1", assetSha256: "c".repeat(64) },
        artifact: {
          outputId: "render-preview",
          ref,
          sha256,
          probe: { durationMs: 1000, width: 320, height: 180, fps: 24, videoCodec: "h264" },
          sourceRevisionId: job.sourceRevisionId,
          sourceRevisionHash,
          renderJobHash: job.jobHash,
          backendId: "native-ffmpeg",
          backendVersion: "1",
          ffmpegVersion: "fixture",
          verificationRefId,
          verification: {
            id: verificationRefId,
            status: "passed",
            revisionId: job.sourceRevisionId,
            evidenceRefs: ["evidence/renders/preview.json"],
            evidenceSha256: "d".repeat(64),
            sourceRevisionHash,
            renderJobHash: job.jobHash,
            artifactSha256: sha256,
            checks: { probe: true, decode: true, hash: true },
          },
        },
      };
    }),
    registerRenderArtifactV2: vi.fn((project: { outputs: unknown[]; verification: unknown }, artifact: { outputId: string; ref: string; sha256: string; probe: unknown; sourceRevisionId: string; renderJobHash: string; backendId: string; backendVersion: string; verificationRefId: string; verification: { evidenceRefs: string[] } }) => ({
      ...project,
      outputs: [...project.outputs, {
        outputId: artifact.outputId,
        ref: artifact.ref,
        sha256: artifact.sha256,
        probe: artifact.probe,
        sourceRevisionId: artifact.sourceRevisionId,
        revisionId: artifact.sourceRevisionId,
        renderJobHash: artifact.renderJobHash,
        backendId: artifact.backendId,
        backendVersion: artifact.backendVersion,
        verificationRefId: artifact.verificationRefId,
      }],
      verification: {
        revisionId: artifact.sourceRevisionId,
        status: "passed",
        refs: [{ id: artifact.verificationRefId, revisionId: artifact.sourceRevisionId, status: "passed", evidenceRefs: artifact.verification.evidenceRefs }],
      },
    })),
  };
});

vi.mock("../src/media-evidence.js", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  return {
    generateMediaEvidence: vi.fn(async (request: { asset: { assetId: string; sha256: string }; evidenceRoot: string }) => {
      const bytes = Buffer.from("bounded preview image");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const ref = "media-evidence/" + "1".repeat(24) + "/" + "2".repeat(24) + "/contact-sheet-" + sha256 + ".png";
      const imagePath = join(request.evidenceRoot, ...ref.split("/"));
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, bytes);
      return {
        version: 1,
        sourceAssetId: request.asset.assetId,
        sourceSha256: request.asset.sha256,
        generator: "replex-native-media-evidence",
        generatorVersion: "1",
        configHash: "e".repeat(64),
        runHash: "f".repeat(64),
        indexRef: "media-evidence/" + "1".repeat(24) + "/" + "2".repeat(24) + "/index.json",
        artifacts: [{ kind: "contact_sheet", ref, sha256, sizeBytes: bytes.byteLength, contentType: "image/png" }],
      };
    }),
  };
});

import { applyOperationBatch, semanticHashV2 } from "../src/operations-v2.js";
import { generateMediaEvidence } from "../src/media-evidence.js";
import { runConversationalEditV2, type V2AgentModelRequest, type V2AgentModelResponse } from "../src/agent-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots = [];
});

function makeProject() {
  const sourceSha = sha("uploaded fixture");
  const probe = { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 2, sampleRateHz: 48000 };
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "preview-test-project",
    brief: { message: "Preview evidence test" },
    assets: {
      "asset-1": {
        id: "asset-1", type: "uploaded_video", path: "assets/video.mp4", sha256: sourceSha, probe,
        provenance: { kind: "upload", originalFilename: "video.mp4", importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sourceSha, importMethod: "path", originalProbe: probe },
      },
    },
    composition: {
      width: 320, height: 180, fps: 24, durationMs: 1000,
      tracks: [{ id: "track-1", kind: "video", order: 0, muted: false, locked: false }],
      clips: [{ id: "clip-1", assetId: "asset-1", trackId: "track-1", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 1000, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false }],
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

function scriptedModel(responses: Array<(input: V2AgentModelRequest) => V2AgentModelResponse>) {
  let index = 0;
  return { respond: vi.fn(async (input: V2AgentModelRequest) => responses[index++](input)) };
}

describe("V2 conversation preview evidence", () => {
  it("delivers a hash-bound rendered preview image to the following model turn", async () => {
    const project = makeProject();
    const root = await mkdtemp(join(tmpdir(), "replex-agent-preview-"));
    tempRoots.push(root);
    const evidenceRef = "media-evidence:asset-1";
    const predicted = applyOperationBatch(project, {
      baseRevisionId: project.currentRevisionId,
      actor: "agent",
      intentId: "intent-preview",
      evidenceRefs: [evidenceRef],
      operations: [{ type: "set_speed", clipId: "clip-1", speed: 1.25 }],
    });
    expect(predicted.ok).toBe(true);
    if (!predicted.ok) return;

    const model = scriptedModel([
      () => ({ responseId: "response-inspect", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-1" } }] }),
      (input) => ({ responseId: "response-edit", calls: [{ id: "call-edit", name: "propose_edit_batch", arguments: {
        baseRevisionId: input.context.currentRevisionId,
        evidenceRefs: [evidenceRef],
        operations: [{ type: "set_speed", clipId: "clip-1", speed: 1.25 }],
      } }] }),
      (input) => {
        const result = input.toolResults[0];
        expect(result?.output).toMatchObject({
          ok: true,
          preview: { renderJobHash: "a".repeat(64), sha256: sha("deterministic mock render"), creativeApproval: "not_assessed" },
          previewEvidence: { sourceAssetSha256: sha("deterministic mock render") },
        });
        expect(result?.images).toHaveLength(1);
        expect(Buffer.from(result!.images![0]!.bytes).toString()).toBe("bounded preview image");
        return { responseId: "response-final", calls: [], text: "Preview reviewed." };
      },
    ]);

    const commit = vi.fn(async ({ project: candidate }: { project: ProjectV2 }) => ({ ok: true as const, project: candidate }));
    const result = await runConversationalEditV2({
      project,
      prompt: "Make the opening faster",
      threadId: "thread-preview",
      inspect: async () => ({ ok: true, data: { selectedFrames: 1 }, evidenceRefs: [evidenceRef] }),
      model,
      operationLog: [],
      assetHandles: [{ assetId: "asset-1", sha256: project.assets["asset-1"]!.sha256, ref: project.assets["asset-1"]!.path! }],
      renderAuthorization: { projectRoot: root, resolvedHandles: [], isRevisionCurrent: async () => true },
      commitCanonicalRevision: commit,
      evidenceRoot: join(root, "evidence"),
    });

    expect(result).toMatchObject({ ok: true, previews: [{ renderJobHash: "a".repeat(64) }] });
    expect(commit.mock.calls[0]?.[0].project.outputs).toHaveLength(1);
    expect(result.ok && result.project.outputs).toHaveLength(1);
    expect(model.respond).toHaveBeenCalledTimes(3);
  });

  it("does not commit an edit when preview evidence generation fails", async () => {
    const project = makeProject();
    const root = await mkdtemp(join(tmpdir(), "replex-agent-preview-failure-"));
    tempRoots.push(root);
    const evidence = "media-evidence:asset-1";
    const model = scriptedModel([
      () => ({ responseId: "response-inspect", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-1" } }] }),
      (input) => ({ responseId: "response-edit", calls: [{ id: "call-edit", name: "propose_edit_batch", arguments: {
        baseRevisionId: input.context.currentRevisionId,
        evidenceRefs: [evidence],
        operations: [{ type: "set_speed", clipId: "clip-1", speed: 1.25 }],
      } }] }),
    ]);
    const commit = vi.fn(async ({ project: candidate }: { project: ProjectV2 }) => ({ ok: true as const, project: candidate }));
    vi.mocked(generateMediaEvidence).mockRejectedValueOnce(new Error("evidence provider failed"));

    const result = await runConversationalEditV2({
      project,
      prompt: "Make the opening faster",
      threadId: "thread-preview-failure",
      inspect: async () => ({ ok: true, data: { selectedFrames: 1 }, evidenceRefs: [evidence] }),
      model,
      operationLog: [],
      assetHandles: [{ assetId: "asset-1", sha256: project.assets["asset-1"]!.sha256, ref: project.assets["asset-1"]!.path! }],
      renderAuthorization: { projectRoot: root, resolvedHandles: [], isRevisionCurrent: async () => true },
      commitCanonicalRevision: commit,
      evidenceRoot: join(root, "evidence"),
    });

    expect(result).toMatchObject({ ok: false, code: "PREVIEW_FAILED", project: { currentRevisionId: "revision-0" }, operationLog: [], acceptedBatches: [], previews: [] });
    expect(commit).not.toHaveBeenCalled();
    expect(semanticHashV2(project)).toBe(project.revisions[0].manifestSha256);
  });

  it("keeps a verified accepted edit successful if the optional final model response fails", async () => {
    const project = makeProject();
    const root = await mkdtemp(join(tmpdir(), "replex-agent-final-response-failure-"));
    tempRoots.push(root);
    const evidence = "media-evidence:asset-1";
    const model = scriptedModel([
      () => ({ responseId: "response-inspect", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-1" } }] }),
      (input) => ({ responseId: "response-edit", calls: [{ id: "call-edit", name: "propose_edit_batch", arguments: {
        baseRevisionId: input.context.currentRevisionId,
        evidenceRefs: [evidence],
        operations: [{ type: "set_speed", clipId: "clip-1", speed: 1.25 }],
      } }] }),
      () => { throw new Error("final model response unavailable"); },
    ]);
    const commit = vi.fn(async ({ project: candidate }: { project: ProjectV2 }) => ({ ok: true as const, project: candidate }));

    const result = await runConversationalEditV2({
      project,
      prompt: "Make the opening faster",
      threadId: "thread-final-response-failure",
      inspect: async () => ({ ok: true, data: { selectedFrames: 1 }, evidenceRefs: [evidence] }),
      model,
      operationLog: [],
      assetHandles: [{ assetId: "asset-1", sha256: project.assets["asset-1"]!.sha256, ref: project.assets["asset-1"]!.path! }],
      renderAuthorization: { projectRoot: root, resolvedHandles: [], isRevisionCurrent: async () => true },
      commitCanonicalRevision: commit,
      evidenceRoot: join(root, "evidence"),
    });

    expect(result).toMatchObject({ ok: true, status: "completed", project: { outputs: [{ outputId: "render-preview" }] } });
    expect(result.ok && result.project.currentRevisionId).not.toBe("revision-0");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("reports the host CAS outcome when cancellation arrives after publication starts", async () => {
    const project = makeProject();
    const root = await mkdtemp(join(tmpdir(), "replex-agent-cas-cancel-"));
    tempRoots.push(root);
    const evidence = "media-evidence:asset-1";
    const model = scriptedModel([
      () => ({ responseId: "response-inspect", calls: [{ id: "call-inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "asset-1" } }] }),
      (input) => ({ responseId: "response-edit", calls: [{ id: "call-edit", name: "propose_edit_batch", arguments: {
        baseRevisionId: input.context.currentRevisionId,
        evidenceRefs: [evidence],
        operations: [{ type: "set_speed", clipId: "clip-1", speed: 1.25 }],
      } }] }),
      () => ({ responseId: "response-final", calls: [], text: "Preview ready." }),
    ]);
    let canonicalProject = project;
    let resolveCommitStarted!: () => void;
    let resolveCommitFinished!: () => void;
    const commitStarted = new Promise<void>((resolve) => { resolveCommitStarted = resolve; });
    const commitFinished = new Promise<void>((resolve) => { resolveCommitFinished = resolve; });
    const commit = vi.fn(async ({ project: candidate }: { project: ProjectV2 }) => {
      canonicalProject = candidate;
      resolveCommitStarted();
      await new Promise((resolve) => setTimeout(resolve, 30));
      resolveCommitFinished();
      return { ok: true as const, project: canonicalProject };
    });
    const controller = new AbortController();
    const resultPromise = runConversationalEditV2({
      project,
      prompt: "Make the opening faster",
      threadId: "thread-cas-cancel",
      inspect: async () => ({ ok: true, data: { selectedFrames: 1 }, evidenceRefs: [evidence] }),
      model,
      operationLog: [],
      assetHandles: [{ assetId: "asset-1", sha256: project.assets["asset-1"]!.sha256, ref: project.assets["asset-1"]!.path! }],
      renderAuthorization: { projectRoot: root, resolvedHandles: [], isRevisionCurrent: async () => true },
      commitCanonicalRevision: commit,
      evidenceRoot: join(root, "evidence"),
      signal: controller.signal,
    });
    await commitStarted;
    controller.abort();
    const result = await resultPromise;
    await commitFinished;

    expect(result).toMatchObject({ ok: true, project: { currentRevisionId: canonicalProject.currentRevisionId } });
    expect(canonicalProject.currentRevisionId).not.toBe("revision-0");
  });
});
