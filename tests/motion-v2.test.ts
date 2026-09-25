import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyOperationBatch, createProjectV2, semanticHashV2, type OperationLogRecord } from "../src/operations-v2.js";
import { canonicalJson } from "../src/canonical-json.js";
import { runConversationalEditV2, type V2AgentModelRequest, type V2CanonicalRevisionCommit, type V2AgentModelResponse } from "../src/agent-v2.js";
import { inspectProjectV2 } from "../src/inspect-v2.js";
import { buildMotionExecutionJobV1, cleanupMotionArtifact, executeMotionExecutionJob } from "../src/motion-v2.js";
import { buildCompositionExecutionJobV3, executeCompositionExecutionJobV3, type MediaExecutionAuthorization } from "../src/render-v2.js";
import { ProjectV2Schema, type AssetHandle, type ProjectV2 } from "../src/schema-v2.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
const mediaToolsAvailable = spawnSync(ffmpegPath, ["-version"], { windowsHide: true, shell: false }).status === 0
  && spawnSync(ffprobePath, ["-version"], { windowsHide: true, shell: false }).status === 0;

function apply(project: ProjectV2, operation: unknown): ProjectV2 {
  const result = applyOperationBatch(project, {
    baseRevisionId: project.currentRevisionId,
    actor: "user",
    intentId: "camera-push-test",
    evidenceRefs: [],
    operations: [operation],
  });
  if (!result.ok) throw new Error(result.detail);
  return result.project;
}

function motionProject(assetHash: string, assetPath = "assets/source.mp4", withMotion = true, compositionDurationMs = 2000): ProjectV2 {
  let project = createProjectV2({ projectId: "camera-push-test", brief: { message: "A focused product push" }, width: 320, height: 180, fps: 24, durationMs: compositionDurationMs });
  const probe = { durationMs: 4000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 1, sampleRateHz: 48000 };
  project = apply(project, {
    type: "import_asset",
    asset: {
      id: "source-video", type: "uploaded_video", path: assetPath, sha256: assetHash, probe,
      provenance: { kind: "upload", originalFilename: "source.mp4", importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: assetHash, importMethod: "path", originalProbe: probe },
    },
  });
  project = apply(project, {
    type: "create_clip",
    clip: {
      id: "clip-product", assetId: "source-video", trackId: "track-video", timelineStartMs: 0, sourceInMs: 500, sourceOutMs: 3500, speed: 1.5,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, opacity: 0.75, audioGainDb: -4, muted: false,
    },
  });
  if (withMotion) project = apply(project, { type: "apply_motion_preset", targetId: "clip-product", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.06 } });
  return ProjectV2Schema.parse(project);
}

function authorized(project: ProjectV2, root: string, inputPath: string): { handles: AssetHandle[]; authorization: MediaExecutionAuthorization } {
  const asset = project.assets["source-video"]!;
  const handle = { assetId: asset.id, sha256: asset.sha256, ref: asset.path! };
  return {
    handles: [handle],
    authorization: {
      projectRoot: root,
      resolvedHandles: [{ ...handle, path: inputPath }],
      isRevisionCurrent: async (revisionId, hash) => revisionId === project.currentRevisionId && hash === semanticHashV2(project),
    },
  };
}

async function makeSource(root: string): Promise<{ path: string; hash: string }> {
  const assets = join(root, "assets");
  await mkdir(assets, { recursive: true });
  const path = join(assets, "source.mp4");
  const result = spawnSync(ffmpegPath, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x18324a:s=320x180:r=24:d=4",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=4",
    "-vf", "drawbox=x=8:y=8:w=304:h=22:color=0x27445f:t=fill,drawbox=x=18:y=46:w=72:h=112:color=0x1d3348:t=fill,drawbox=x=112:y=54:w=176:h=56:color=0x36597b:t=fill,drawbox=x=128:y=122:w=84:h=34:color=0x2cbb83:t=fill,setsar=4/3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", path,
  ], { windowsHide: true, shell: false, timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() ?? "fixture generation failed");
  const bytes = await readFile(path);
  return { path, hash: sha(bytes) };
}

describe("V2 camera-push execution", () => {
  it("freezes post-trim/post-speed motion inputs with a deterministic job hash", () => {
    const project = motionProject(sha("source"));
    const handle = { assetId: "source-video", sha256: sha("source"), ref: "assets/source.mp4" };
    const job = buildMotionExecutionJobV1(project, "clip-product", handle);
    const replay = buildMotionExecutionJobV1(project, "clip-product", handle);

    expect(job).toMatchObject({
      jobVersion: 1,
      sourceRevisionId: project.currentRevisionId,
      sourceRevisionHash: semanticHashV2(project),
      target: { clipId: "clip-product", sourceInMs: 500, sourceOutMs: 3500, speed: 1.5 },
      preset: { presetId: "camera-push", presetVersion: "1", strength: 0.06 },
      output: { width: 320, height: 180, fps: 24, frameCount: 48, durationMs: 2000 },
    });
    expect(job.jobHash).toBe(replay.jobHash);
    expect(job).not.toHaveProperty("project");
    expect(JSON.stringify(job)).not.toContain("-filter_complex");
  });

  it("requires absolute host-configured FFmpeg paths before authorization or file access", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-motion-path-policy-"));
    try {
      const sourceBytes = Buffer.from("authorized source fixture bytes");
      const sourcePath = join(root, "assets", "source.mp4");
      await mkdir(join(root, "assets"));
      await writeFile(sourcePath, sourceBytes);
      const project = motionProject(sha(sourceBytes));
      const handle = { assetId: "source-video", sha256: sha(sourceBytes), ref: "assets/source.mp4" };
      const job = buildMotionExecutionJobV1(project, "clip-product", handle);
      let revisionChecks = 0;
      const authorization: MediaExecutionAuthorization = {
        projectRoot: root,
        resolvedHandles: [{ ...handle, path: sourcePath }],
        isRevisionCurrent: async () => { revisionChecks += 1; return true; },
      };
      const previousFfmpegPath = process.env.REPLEX_FFMPEG_PATH;
      const previousFfprobePath = process.env.REPLEX_FFPROBE_PATH;
      delete process.env.REPLEX_FFMPEG_PATH;
      delete process.env.REPLEX_FFPROBE_PATH;
      try {
        await expect(executeMotionExecutionJob(job, authorization)).rejects.toThrow("absolute FFmpeg and FFprobe executable paths");
        await expect(executeMotionExecutionJob(job, authorization, { ffmpegPath: "relative/ffmpeg", ffprobePath: "relative/ffprobe" })).rejects.toThrow("absolute FFmpeg and FFprobe executable paths");
        expect(revisionChecks).toBe(0);
        expect(await readdir(join(root, ".replex-staging", "motion", "jobs")).catch(() => [])).toEqual([]);
      } finally {
        if (previousFfmpegPath === undefined) delete process.env.REPLEX_FFMPEG_PATH;
        else process.env.REPLEX_FFMPEG_PATH = previousFfmpegPath;
        if (previousFfprobePath === undefined) delete process.env.REPLEX_FFPROBE_PATH;
        else process.env.REPLEX_FFPROBE_PATH = previousFfprobePath;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["source width", (job: any) => { job.output.width += 2; }],
    ["source height", (job: any) => { job.output.height += 2; }],
    ["execution dimensions", (job: any) => { job.target.source.width = 5000; job.output.width = 5000; }],
    ["composition fps", (job: any) => { job.output.fps += 1; }],
    ["trim bounds", (job: any) => { job.target.sourceOutMs = job.target.source.durationMs + 1; }],
    ["derived frame count", (job: any) => { job.output.frameCount += 1; }],
    ["derived duration", (job: any) => { job.output.durationMs += 1; }],
  ])("rejects rehashed non-canonical motion jobs with altered %s", async (_label, alter) => {
    const project = motionProject(sha("source"));
    const handle = { assetId: "source-video", sha256: sha("source"), ref: "assets/source.mp4" };
    const job = buildMotionExecutionJobV1(project, "clip-product", handle);
    const tampered = structuredClone(job) as any;
    delete tampered.jobHash;
    alter(tampered);
    tampered.jobHash = sha(canonicalJson(tampered));

    await expect(executeMotionExecutionJob(tampered, {
      projectRoot: ".", resolvedHandles: [], isRevisionCurrent: async () => true,
    })).rejects.toThrow();
  });

  it("renders a verified silent push intermediate into a verified final composition without double speed", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-motion-e2e-"));
    try {
      const source = await makeSource(root);
      const project = motionProject(source.hash);
      const { handles, authorization } = authorized(project, root, source.path);
      const motionJob = buildMotionExecutionJobV1(project, "clip-product", handles[0]!);
      const motion = await executeMotionExecutionJob(motionJob, authorization, { ffmpegPath, ffprobePath, timeoutMs: 120_000 });
      expect(motion.result).toMatchObject({
        artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        width: 320, height: 180, fps: 24, frameCount: 48, sampleAspectRatio: "4:3", audioPresent: false,
        sourceRevisionId: project.currentRevisionId, sourceRevisionHash: semanticHashV2(project), motionJobHash: motionJob.jobHash,
        presetId: "camera-push", presetVersion: "1", verification: { status: "passed", checks: { probe: true, decode: true, hash: true } },
      });
      expect(motion.handle).toMatchObject({ sourceRevisionId: project.currentRevisionId, targetClipId: "clip-product", sourceAssetId: "source-video", motionJobHash: motionJob.jobHash, sha256: motion.result.artifactSha256 });
      const intermediatePath = join(root, ...motion.handle.ref.split("/"));
      const firstFrame = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", intermediatePath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
      const lastFrame = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-sseof", "-0.05", "-i", intermediatePath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
      expect(firstFrame.status, firstFrame.stderr?.toString()).toBe(0);
      expect(lastFrame.status, lastFrame.stderr?.toString()).toBe(0);
      expect(Buffer.compare(firstFrame.stdout as Buffer, lastFrame.stdout as Buffer)).not.toBe(0);

      const compositionJob = buildCompositionExecutionJobV3(project, handles, [motion.handle]);
      const repeatedJob = buildCompositionExecutionJobV3(project, handles, [motion.handle]);
      expect(compositionJob.jobVersion).toBe(3);
      expect(compositionJob.jobHash).toBe(repeatedJob.jobHash);
      expect(compositionJob.videoClips[0]).toMatchObject({ id: "clip-product", sourceInMs: 500, sourceOutMs: 3500, speed: 1.5, motionArtifact: { sha256: motion.result.artifactSha256 } });

      const final = await executeCompositionExecutionJobV3(compositionJob, [motion.handle], authorization, { ffmpegPath, ffprobePath, timeoutMs: 120_000 });
      expect(final.artifact).toMatchObject({
        backendVersion: "3",
        sourceRevisionId: project.currentRevisionId,
        sourceRevisionHash: semanticHashV2(project),
        probe: { width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac" },
        verification: { status: "passed", checks: { probe: true, decode: true, hash: true } },
      });
      expect(Math.abs(final.artifact.probe.durationMs! - 2000)).toBeLessThanOrEqual(1500 / 24);
      expect(await readFile(join(root, ...final.artifact.ref.split("/")))).toBeDefined();
      expect(ProjectV2Schema.parse(project).composition.motionPresets).toHaveLength(1);
      expect(project.outputs).toHaveLength(0);

      const repeatedMotion = await executeMotionExecutionJob(motionJob, authorization, { ffmpegPath, ffprobePath, timeoutMs: 120_000 });
      expect(repeatedMotion.result.artifactSha256).toBe(motion.result.artifactSha256);
      await cleanupMotionArtifact(motion.handle);
      await cleanupMotionArtifact(repeatedMotion.handle);
      await expect(readFile(join(root, ...motion.handle.ref.split("/")))).rejects.toThrow();
      const receiptBytes = await readFile(join(root, ...motion.result.verification.evidenceRef.split("/")));
      expect(sha(receiptBytes)).toBe(motion.result.verification.evidenceSha256);
      expect(JSON.parse(receiptBytes.toString("utf8"))).toMatchObject({
        status: "passed", motionJobHash: motionJob.jobHash, artifactSha256: motion.result.artifactSha256,
        sourceAssetId: "source-video", sourceAssetSha256: source.hash, targetClipId: "clip-product",
        preset: { presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.06 } },
        backend: { id: "native-ffmpeg-motion", version: "1", ffmpegVersion: expect.stringContaining("ffmpeg version") },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!mediaToolsAvailable)("accepts a camera-push edit and a same-thread strength follow-up with verified V3 previews", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-camera-push-agent-"));
    const keepSample = process.env.REPLEX_KEEP_CAMERA_PUSH_SAMPLE === "1";
    try {
      const source = await makeSource(root);
      let canonical = motionProject(source.hash, "assets/source.mp4", false);
      const initialRevisionId = canonical.currentRevisionId;
      const asset = canonical.assets["source-video"]!;
      const assetHandle: AssetHandle = { assetId: asset.id, sha256: asset.sha256, ref: asset.path! };
      const authorization: MediaExecutionAuthorization = {
        projectRoot: root,
        resolvedHandles: [{ ...assetHandle, path: source.path }],
        isRevisionCurrent: async (revisionId, revisionHash) => revisionId === canonical.currentRevisionId && revisionHash === semanticHashV2(canonical),
      };
      const inspect = async (project: ProjectV2, request: Parameters<typeof inspectProjectV2>[0]) => {
        const result = await inspectProjectV2(request, { project });
        return result.ok ? { ...result, evidenceRefs: ["fixture:camera-push-conversation"] } : result;
      };
      const commitCanonicalRevision = async (input: V2CanonicalRevisionCommit) => {
        if (input.baseRevisionId !== canonical.currentRevisionId || input.baseRevisionHash !== semanticHashV2(canonical)) return { ok: false as const, code: "STALE_REVISION" };
        canonical = ProjectV2Schema.parse(input.project);
        return { ok: true as const, project: canonical };
      };
      const makeModel = (label: string, strength: number, expectStrength?: number) => {
        let call = 0;
        const model = {
          async respond(input: V2AgentModelRequest): Promise<V2AgentModelResponse> {
            call += 1;
            if (call === 1) return { responseId: `${label}-inspect`, calls: [{ id: `${label}-call-inspect`, name: "inspect_v2", arguments: { kind: "clips", offset: 0, limit: 5 } }] };
            if (call === 2) {
              const inspected = input.toolResults[0]?.output as { ok?: boolean; data?: { items?: Array<{ clipId?: string; motionPreset?: { parameters?: { strength?: number } } }> }; evidenceRefs?: string[] };
              expect(inspected.ok).toBe(true);
              const target = inspected.data?.items?.find(({ clipId }) => clipId === "clip-product");
              if (expectStrength === undefined) expect(target?.motionPreset).toBeUndefined();
              else expect(target?.motionPreset?.parameters?.strength).toBe(expectStrength);
              return { responseId: `${label}-propose`, calls: [{
                id: `${label}-call-propose`, name: "propose_edit_batch", arguments: {
                  baseRevisionId: input.context.currentRevisionId,
                  evidenceRefs: inspected.evidenceRefs,
                  operations: [{ type: "apply_motion_preset", targetId: "clip-product", presetId: "camera-push", presetVersion: "1", parameters: { strength } }],
                },
              }] };
            }
            const preview = input.toolResults[0]?.output as { ok?: boolean; preview?: { renderJobHash?: string; verificationRefId?: string; checks?: { probe?: boolean; decode?: boolean; hash?: boolean } } };
            expect(preview).toMatchObject({ ok: true, preview: { renderJobHash: expect.stringMatching(/^[a-f0-9]{64}$/), verificationRefId: expect.any(String), checks: { probe: true, decode: true, hash: true } } });
            return { responseId: `${label}-done`, calls: [], text: "Camera push preview is ready." };
          },
        };
        return model;
      };
      const requestBase = {
        threadId: "camera-push-thread",
        inspect,
        operationLog: [] as OperationLogRecord[],
        assetHandles: [assetHandle],
        renderAuthorization: authorization,
        renderOptions: { ffmpegPath, ffprobePath, timeoutMs: 120_000 },
        commitCanonicalRevision,
        evidenceRoot: join(root, "evidence"),
      };
      const first = await runConversationalEditV2({ ...requestBase, project: canonical, prompt: "Add a gentle camera push to the product intro.", model: makeModel("first", 0.04) });
      expect(first).toMatchObject({ ok: true, acceptedBatches: [{ baseRevisionId: initialRevisionId }] });
      if (!first.ok) throw new Error(first.detail);
      expect(first.operationLog.map(({ input }) => input.type)).toEqual(["apply_motion_preset"]);
      expect(first.project.composition.motionPresets).toMatchObject([{ targetId: "clip-product", parameters: { strength: 0.04 } }]);
      expect(first.motionExecutions).toHaveLength(1);
      expect(first.previews[0]).toMatchObject({ backendVersion: "3", verification: { status: "passed", checks: { probe: true, decode: true, hash: true } } });
      const replay = applyOperationBatch(motionProject(source.hash, "assets/source.mp4", false), {
        baseRevisionId: initialRevisionId, actor: "agent", intentId: first.attribution.intentId,
        evidenceRefs: first.operationLog[0]!.evidenceRefs, operations: first.operationLog.map(({ input }) => input),
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(semanticHashV2(replay.project)).toBe(semanticHashV2(first.project));

      const firstReceiptPath = join(root, ...first.motionExecutions[0]!.verification.evidenceRef.split("/"));
      const firstReceiptBytes = await readFile(firstReceiptPath);
      expect(sha(firstReceiptBytes)).toBe(first.motionExecutions[0]!.verification.evidenceSha256);
      expect(JSON.parse(firstReceiptBytes.toString("utf8"))).toMatchObject({ motionJobHash: first.motionExecutions[0]!.motionJobHash, status: "passed" });

      const second = await runConversationalEditV2({
        ...requestBase,
        project: first.project,
        prompt: "Keep that camera push and make it slightly stronger.",
        threadState: first.threadState,
        operationLog: first.operationLog,
        model: makeModel("followup", 0.06, 0.04),
      });
      expect(second).toMatchObject({ ok: true, acceptedBatches: [{ baseRevisionId: first.project.currentRevisionId }] });
      if (!second.ok) throw new Error(second.detail);
      expect(second.threadState.threadId).toBe(first.threadState.threadId);
      expect(second.attribution.baseRevisionId).toBe(first.project.currentRevisionId);
      expect(second.operationLog.map(({ input }) => input.type)).toEqual(["apply_motion_preset"]);
      expect(second.project.revisions.at(-1)?.parentId).toBe(first.project.currentRevisionId);
      expect(second.project.composition.motionPresets).toMatchObject([{ targetId: "clip-product", parameters: { strength: 0.06 } }]);
      expect(second.previews[0]).toMatchObject({ backendVersion: "3", verification: { status: "passed", checks: { probe: true, decode: true, hash: true } } });
      expect(second.motionExecutions).toHaveLength(1);
      expect(second.motionExecutions[0]!.motionJobHash).not.toBe(first.motionExecutions[0]!.motionJobHash);
      const finalOutput = second.project.outputs.at(-1)!;
      expect(finalOutput.sha256).toBe(second.previews[0]!.sha256);
      const finalPath = join(root, ...finalOutput.ref.split("/"));
      expect(sha(await readFile(finalPath))).toBe(finalOutput.sha256);
      if (keepSample) console.info(`CAMERA_PUSH_SAMPLE_OUTPUT=${finalPath}`);
    } finally {
      if (!keepSample) await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it.skipIf(!mediaToolsAvailable)("cleans a verified motion handle when cancellation wins before the bounded call returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-camera-push-verified-cancel-"));
    const abort = new AbortController();
    let enterVerification!: () => void;
    const verificationReached = new Promise<void>((resolvePromise) => { enterVerification = resolvePromise; });
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolvePromise) => { releaseVerification = resolvePromise; });
    let resultPromise: ReturnType<typeof runConversationalEditV2> | undefined;
    try {
      const source = await makeSource(root);
      const project = motionProject(source.hash, "assets/source.mp4", false);
      const asset = project.assets["source-video"]!;
      const handle: AssetHandle = { assetId: asset.id, sha256: asset.sha256, ref: asset.path! };
      let revisionChecks = 0;
      let commitCalls = 0;
      const result = {
        async respond(input: V2AgentModelRequest): Promise<V2AgentModelResponse> {
          return input.toolResults.length === 0
            ? { responseId: "verified-cancel-inspect", calls: [{ id: "verified-cancel-call-inspect", name: "inspect_v2", arguments: { kind: "clips", offset: 0, limit: 5 } }] }
            : { responseId: "verified-cancel-propose", calls: [{ id: "verified-cancel-call-propose", name: "propose_edit_batch", arguments: {
              baseRevisionId: input.context.currentRevisionId,
              evidenceRefs: ["fixture:verified-cancel-motion"],
              operations: [{ type: "apply_motion_preset", targetId: "clip-product", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.04 } }],
            } }] };
        },
      };
      const jobsRoot = join(root, ".replex-staging", "motion", "jobs");
      resultPromise = runConversationalEditV2({
        project,
        prompt: "Add a camera push.",
        threadId: "verified-cancel-motion-thread",
        inspect: async (current, request) => {
          const inspected = await inspectProjectV2(request, { project: current });
          return inspected.ok ? { ...inspected, evidenceRefs: ["fixture:verified-cancel-motion"] } : inspected;
        },
        model: result,
        operationLog: [],
        assetHandles: [handle],
        renderAuthorization: {
          projectRoot: root,
          resolvedHandles: [{ ...handle, path: source.path }],
          isRevisionCurrent: async (revisionId, hash) => {
            revisionChecks += 1;
            if (revisionChecks === 2) {
              enterVerification();
              await verificationGate;
            }
            return revisionId === project.currentRevisionId && hash === semanticHashV2(project);
          },
        },
        renderOptions: { ffmpegPath, ffprobePath, timeoutMs: 120_000 },
        commitCanonicalRevision: async (_input: V2CanonicalRevisionCommit) => {
          commitCalls += 1;
          return { ok: true as const, project };
        },
        evidenceRoot: join(root, "evidence"),
        signal: abort.signal,
      });

      await Promise.race([
        verificationReached,
        new Promise<never>((_resolvePromise, reject) => setTimeout(() => reject(new Error("motion verification did not reach its host revision gate")), 15_000)),
      ]);
      const jobIds = await readdir(jobsRoot);
      expect(jobIds).toHaveLength(1);
      await expect(readFile(join(jobsRoot, jobIds[0]!, "motion.mp4"))).resolves.toBeTruthy();

      abort.abort();
      releaseVerification();
      const cancelled = await resultPromise;
      expect(cancelled).toMatchObject({ ok: false, code: "CANCELLED", project: { currentRevisionId: project.currentRevisionId } });
      expect(commitCalls).toBe(0);
      expect(await readdir(jobsRoot).catch(() => [])).toEqual([]);
    } finally {
      abort.abort();
      releaseVerification();
      await resultPromise?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!mediaToolsAvailable)("drains an in-flight canceled motion preview before removing staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-camera-push-cancel-"));
    try {
      const source = await makeSource(root);
      const project = motionProject(source.hash, "assets/source.mp4", false);
      const asset = project.assets["source-video"]!;
      const handle: AssetHandle = { assetId: asset.id, sha256: asset.sha256, ref: asset.path! };
      const abort = new AbortController();
      const model = {
        respond: async (input: V2AgentModelRequest): Promise<V2AgentModelResponse> => input.toolResults.length === 0
          ? { responseId: "cancel-inspect", calls: [{ id: "cancel-call-inspect", name: "inspect_v2", arguments: { kind: "clips", offset: 0, limit: 5 } }] }
          : { responseId: "cancel-propose", calls: [{ id: "cancel-call-propose", name: "propose_edit_batch", arguments: {
            baseRevisionId: input.context.currentRevisionId,
            evidenceRefs: ["fixture:cancel-motion"],
            operations: [{ type: "apply_motion_preset", targetId: "clip-product", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.04 } }],
          } }] },
      };
      let commitCalls = 0;
      const commit = async (_input: V2CanonicalRevisionCommit) => { commitCalls += 1; return { ok: true as const, project }; };
      const resultPromise = runConversationalEditV2({
        project,
        prompt: "Add a camera push.",
        threadId: "cancel-motion-thread",
        inspect: async (current, request) => {
          const inspected = await inspectProjectV2(request, { project: current });
          return inspected.ok ? { ...inspected, evidenceRefs: ["fixture:cancel-motion"] } : inspected;
        },
        model,
        operationLog: [],
        assetHandles: [handle],
        renderAuthorization: {
          projectRoot: root,
          resolvedHandles: [{ ...handle, path: source.path }],
          isRevisionCurrent: async (revisionId, hash) => revisionId === project.currentRevisionId && hash === semanticHashV2(project),
        },
        renderOptions: { ffmpegPath, ffprobePath, timeoutMs: 120_000 },
        commitCanonicalRevision: commit,
        evidenceRoot: join(root, "evidence"),
        signal: abort.signal,
      });
      const jobsRoot = join(root, ".replex-staging", "motion", "jobs");
      const deadline = Date.now() + 15_000;
      let motionOutputAppeared = false;
      while (!motionOutputAppeared && Date.now() < deadline) {
        const jobIds = await readdir(jobsRoot).catch(() => []);
        for (const jobId of jobIds) {
          motionOutputAppeared = await readFile(join(jobsRoot, jobId, "motion.mp4")).then(() => true, () => false);
          if (motionOutputAppeared) break;
        }
        if (!motionOutputAppeared) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      abort.abort();
      const result = await resultPromise;

      expect(motionOutputAppeared).toBe(true);
      expect(result).toMatchObject({ ok: false, code: "CANCELLED", project: { currentRevisionId: project.currentRevisionId } });
      expect(commitCalls).toBe(0);
      expect(await readdir(jobsRoot).catch(() => [])).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!mediaToolsAvailable)("rejects stale jobs and cleans private staging after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-motion-failure-"));
    try {
      const inputPath = join(root, "assets", "source.mp4");
      await mkdir(join(root, "assets"));
      const bytes = Buffer.from("verified synthetic placeholder");
      await writeFile(inputPath, bytes);
      const project = motionProject(sha(bytes));
      const { handles, authorization } = authorized(project, root, inputPath);
      const job = buildMotionExecutionJobV1(project, "clip-product", handles[0]!);
      await expect(executeMotionExecutionJob(job, { ...authorization, isRevisionCurrent: async () => false }, { ffmpegPath, ffprobePath })).rejects.toThrow("no longer current");

      const controller = new AbortController();
      controller.abort();
      await expect(executeMotionExecutionJob(job, authorization, { ffmpegPath, ffprobePath, signal: controller.signal })).rejects.toThrow("cancelled");
      const stagingRoot = join(root, ".replex-staging", "motion");
      const jobs = await readdir(join(stagingRoot, "jobs")).catch(() => []);
      expect(jobs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
