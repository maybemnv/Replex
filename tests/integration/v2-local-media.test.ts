import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { authorizeLocalImport, importLocalAssetV2 } from "../../src/import-v2.js";
import { generateMediaEvidence } from "../../src/media-evidence.js";
import { applyOperationBatch, semanticHashV2, type OperationLogRecord } from "../../src/operations-v2.js";
import { buildMediaExecutionJob, executeMediaExecutionJob, registerRenderArtifactV2, verifyMediaExecutionPreflight } from "../../src/render-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../../src/schema-v2.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function emptyProject(): ProjectV2 {
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "local-media-e2e",
    brief: { message: "Deterministic uploaded footage proof" },
    assets: {},
    composition: {
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 1400,
      tracks: [
        { id: "video-track", kind: "video", order: 0, muted: false, locked: false },
        { id: "audio-track", kind: "audio", order: 1, muted: false, locked: false },
        { id: "overlay-track", kind: "overlay", order: 2, muted: false, locked: false },
      ],
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
    if (!result.ok) throw new Error(`replay failed: ${result.detail}`);
    expect(result.revisionId).toBe(revisionId);
    project = result.project;
  }
  return project;
}

describe("Phase 2 local media Gate B", () => {
  it.skipIf(!mediaAvailable)("imports, analyzes, edits, replays, renders, verifies, and registers arbitrary uploaded footage", async () => {
    const inputRoot = await mkdtemp(join(tmpdir(), "replex-v2-e2e-input-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "replex-v2-e2e-project-"));
    const sourcePath = join(inputRoot, "customer-walkthrough.mp4");
    const base = emptyProject();
    let currentProject = base;

    try {
      const fixture = spawnSync(ffmpegPath, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        "-metadata", "creation_time=2026-09-25T00:00:00Z", sourcePath,
      ], { windowsHide: true, shell: false, timeout: 30_000 });
      expect(fixture.status, fixture.stderr?.toString()).toBe(0);
      const originalBytes = await readFile(sourcePath);
      const originalHash = sha256(originalBytes);

      const authorized = await authorizeLocalImport(sourcePath, [inputRoot], "file_picker");
      const imported = await importLocalAssetV2(base, projectRoot, authorized, { ffmpegPath, ffprobePath });
      currentProject = imported.project;
      expect(imported.asset).toMatchObject({
        type: "uploaded_video",
        sha256: originalHash,
        path: `media/assets/${originalHash}`,
        provenance: { kind: "upload", originalFilename: "customer-walkthrough.mp4", importMethod: "file_picker", sourceSha256: originalHash },
      });
      expect(await readFile(sourcePath)).toEqual(originalBytes);
      expect(sha256(await readFile(join(projectRoot, ...imported.asset.path!.split("/"))))).toBe(originalHash);

      const handle = { assetId: imported.asset.id, sha256: imported.asset.sha256, ref: imported.asset.path! };
      const evidence = await generateMediaEvidence({
        asset: handle,
        resolveSource: async (asset) => {
          expect(asset).toEqual(handle);
          return join(projectRoot, ...imported.asset.path!.split("/"));
        },
        evidenceRoot: join(projectRoot, "evidence"),
        ffmpegPath,
        ffprobePath,
      });
      expect(evidence.sourceSha256).toBe(originalHash);
      expect(evidence.artifacts.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["probe", "selected_frame", "contact_sheet", "scene_boundaries", "audio_summary"]));
      expect(evidence.artifacts.filter(({ kind }) => kind === "selected_frame")).toHaveLength(4);
      expect(evidence.artifacts.reduce((total, item) => total + item.sizeBytes, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);

      const createClip = applyOperationBatch(currentProject, {
        baseRevisionId: currentProject.currentRevisionId,
        actor: "user",
        intentId: "e2e-create-upload-clip",
        evidenceRefs: [evidence.indexRef],
        operations: [{
          type: "create_clip",
          clip: {
            id: "uploaded-clip",
            assetId: imported.asset.id,
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
      expect(createClip.ok).toBe(true);
      if (!createClip.ok) throw new Error(createClip.detail);
      currentProject = createClip.project;

      const edit = applyOperationBatch(currentProject, {
        baseRevisionId: currentProject.currentRevisionId,
        actor: "user",
        intentId: "e2e-edit-upload-clip",
        evidenceRefs: [evidence.indexRef],
        operations: [
          { type: "set_speed", clipId: "uploaded-clip", speed: 1.25 },
          { type: "trim_clip", clipId: "uploaded-clip", sourceInMs: 0, sourceOutMs: 1750 },
          { type: "set_transform", clipId: "uploaded-clip", transform: { x: 5, y: -3, scale: 1.1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
          { type: "set_volume", clipId: "uploaded-clip", audioGainDb: -3 },
        ],
        createdAt: "2026-09-25T00:00:02.000Z",
      });
      expect(edit.ok).toBe(true);
      if (!edit.ok) throw new Error(edit.detail);
      currentProject = edit.project;

      const records = [...imported.operationLog, ...createClip.operationLog, ...edit.operationLog];
      const replayed = replay(records, base);
      expect(replayed.currentRevisionId).toBe(currentProject.currentRevisionId);
      expect(replayed.revisions.at(-1)?.manifestSha256).toBe(currentProject.revisions.at(-1)?.manifestSha256);
      expect(semanticHashV2(replayed)).toBe(semanticHashV2(currentProject));
      expect(currentProject.composition.clips[0]).toMatchObject({ speed: 1.25, sourceOutMs: 1750, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, audioGainDb: -3 });

      const job = buildMediaExecutionJob(currentProject, [handle]);
      const authorization = {
        projectRoot,
        resolvedHandles: [{ ...handle, path: join(projectRoot, ...imported.asset.path!.split("/")) }],
        isRevisionCurrent: async (revisionId: string, revisionHash: string) => revisionId === currentProject.currentRevisionId && revisionHash === semanticHashV2(currentProject),
      };
      await expect(verifyMediaExecutionPreflight(job, authorization)).resolves.toMatchObject({ status: "passed", assetSha256: originalHash });
      const { artifact } = await executeMediaExecutionJob(job, authorization, { ffmpegPath, ffprobePath, timeoutMs: 120_000 });
      const outputPath = join(projectRoot, ...artifact.ref.split("/"));
      expect((await stat(outputPath)).size).toBeGreaterThan(0);
      expect(sha256(await readFile(outputPath))).toBe(artifact.sha256);
      expect(artifact).toMatchObject({
        sourceRevisionId: currentProject.currentRevisionId,
        sourceRevisionHash: semanticHashV2(currentProject),
        backendId: "native-ffmpeg",
        probe: { width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac" },
        verification: { status: "passed", checks: { probe: true, decode: true, hash: true } },
      });

      const beforeRegistrationHash = semanticHashV2(currentProject);
      currentProject = registerRenderArtifactV2(currentProject, artifact);
      expect(currentProject.outputs).toHaveLength(1);
      expect(currentProject.outputs[0]).toMatchObject({
        outputId: artifact.outputId,
        ref: artifact.ref,
        sha256: artifact.sha256,
        renderJobHash: artifact.renderJobHash,
        sourceRevisionId: currentProject.currentRevisionId,
        verificationRefId: artifact.verificationRefId,
      });
      expect(currentProject.verification).toMatchObject({ revisionId: currentProject.currentRevisionId, status: "passed" });
      expect(semanticHashV2(currentProject)).toBe(beforeRegistrationHash);
      expect(registerRenderArtifactV2(currentProject, artifact).outputs).toEqual(currentProject.outputs);
      expect(JSON.parse(await readFile(join(projectRoot, ...artifact.verification.evidenceRefs[0].split("/")), "utf8"))).toMatchObject({
        status: "passed",
        sourceRevisionHash: beforeRegistrationHash,
        artifactSha256: artifact.sha256,
      });

      const stale = applyOperationBatch(currentProject, {
        baseRevisionId: currentProject.currentRevisionId,
        actor: "user",
        intentId: "e2e-follow-up-after-render",
        evidenceRefs: [],
        operations: [{ type: "set_volume", clipId: "uploaded-clip", audioGainDb: -6 }],
        createdAt: "2026-09-25T00:00:03.000Z",
      });
      expect(stale.ok).toBe(true);
      if (!stale.ok) throw new Error(stale.detail);
      currentProject = stale.project;
      await expect(verifyMediaExecutionPreflight(job, authorization)).rejects.toThrow("no longer current");
      expect(currentProject.verification.status).toBe("stale");
    } finally {
      await rm(inputRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
