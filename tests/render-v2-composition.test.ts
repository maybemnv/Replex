import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runConversationalEditV2, type V2AgentModelClient } from "../src/agent-v2.js";
import { applyOperationBatch, semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { buildCompositionExecutionJob, executeMediaExecutionJob, MAX_RENDER_ARTIFACT_BYTES, registerRenderArtifactV2, verifyCompositionExecutionPreflight, type MediaExecutionAuthorization } from "../src/render-v2.js";
import { spawnSync } from "node:child_process";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
const mediaToolsAvailable = spawnSync(ffmpegPath, ["-version"], { windowsHide: true, shell: false }).status === 0
  && spawnSync(ffprobePath, ["-version"], { windowsHide: true, shell: false }).status === 0;

function mixedProject(): ProjectV2 {
  const videoProbe = { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264" };
  const audioProbe = { durationMs: 4000, audioCodec: "aac", channels: 2, sampleRateHz: 48000 };
  const imageProbe = { width: 640, height: 360 };
  const videoAsset = (id: string, filename: string) => ({
    id, type: "uploaded_video" as const, path: `assets/${filename}`, sha256: sha(id), probe: videoProbe,
    provenance: { kind: "upload" as const, originalFilename: filename, importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sha(id), importMethod: "path" as const, originalProbe: videoProbe },
  });
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "composition-render-test",
    brief: { message: "Mixed media composition" },
    assets: {
      "video-a": videoAsset("video-a", "a.mp4"),
      "video-b": videoAsset("video-b", "b.mp4"),
      "audio-a": {
        id: "audio-a", type: "audio", path: "assets/music.m4a", sha256: sha("audio-a"), probe: audioProbe,
        provenance: { kind: "upload", originalFilename: "music.m4a", importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sha("audio-a"), importMethod: "path", originalProbe: audioProbe },
      },
      "image-a": {
        id: "image-a", type: "image", path: "assets/product.png", sha256: sha("image-a"), probe: imageProbe,
        provenance: { kind: "upload", originalFilename: "product.png", importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sha("image-a"), importMethod: "path", originalProbe: imageProbe },
      },
    },
    composition: {
      width: 320, height: 180, fps: 24, durationMs: 2280,
      tracks: [
        { id: "video", kind: "video", order: 0, muted: false, locked: false },
        { id: "audio", kind: "audio", order: 1, muted: false, locked: false },
        { id: "overlay", kind: "overlay", order: 2, muted: false, locked: false },
      ],
      clips: [
        { id: "clip-a", assetId: "video-a", trackId: "video", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 1280, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: -3, muted: false, transitionOut: { type: "crossfade", durationMs: 250 } },
        { id: "clip-b", assetId: "video-b", trackId: "video", timelineStartMs: 1280, sourceInMs: 200, sourceOutMs: 1200, speed: 1, transform: { x: 0, y: 0, scale: 1.1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false },
        { id: "music", assetId: "audio-a", trackId: "audio", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 2200, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: -12, muted: false },
      ],
      layers: [
        { id: "title", trackId: "overlay", kind: "text", timelineStartMs: 100, durationMs: 1500, properties: { text: "Ship faster: 100% [ready]", fontSize: 36, color: "#ffffff" }, keyframes: [] },
        { id: "product-image", trackId: "overlay", kind: "image", timelineStartMs: 1500, durationMs: 500, properties: { assetId: "image-a" }, keyframes: [] },
      ],
    },
    revisions: [{ id: "revision-1", actor: "user", operationIds: [], manifestSha256: sha("initial"), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-1", status: "unknown", refs: [] },
    currentRevisionId: "revision-1",
  });
  project.revisions[0]!.manifestSha256 = semanticHashV2(project);
  return ProjectV2Schema.parse(project);
}

describe("V2 composition render planning", () => {
  it("freezes mixed media handles, timeline semantics, and the derived crossfade duration", () => {
    const project = mixedProject();
    const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));

    const first = buildCompositionExecutionJob(project, handles);
    const second = buildCompositionExecutionJob(project, handles);

    expect(first.jobVersion).toBe(2);
    expect(first.jobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.jobHash).toBe(first.jobHash);
    expect(first.sourceRevisionId).toBe(project.currentRevisionId);
    expect(first.composition).toMatchObject({ durationMs: 2280, outputDurationMs: 2030 });
    expect(first.videoClips).toHaveLength(2);
    expect(first.audioClip).toMatchObject({ id: "music", audioGainDb: -12 });
    expect(first.layers.map(({ kind }) => kind)).toEqual(["text", "image"]);
    expect(Object.isFrozen(first.videoClips[0]!.transform)).toBe(true);
    expect(first).not.toHaveProperty("project");
    expect(JSON.stringify(project.composition)).toContain('"durationMs":2280');
  });

  it("rejects a gap instead of inventing timeline timing for the renderer", () => {
    const project = mixedProject();
    project.composition.clips[1]!.timelineStartMs += 100;
    project.composition.durationMs += 100;
    project.revisions[0]!.manifestSha256 = semanticHashV2(project);
    const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));

    expect(() => buildCompositionExecutionJob(project, handles)).toThrow("contiguous");
  });

  it("rejects visual source dimensions beyond the bounded import profile", () => {
    const project = mixedProject();
    const asset = project.assets["video-a"]!;
    asset.probe.width = 4097;
    if (asset.provenance.kind === "upload") asset.provenance.originalProbe.width = 4097;
    project.revisions[0]!.manifestSha256 = semanticHashV2(project);
    const handles = Object.values(project.assets).map((candidate) => ({ assetId: candidate.id, sha256: candidate.sha256, ref: candidate.path! }));

    expect(() => buildCompositionExecutionJob(project, handles)).toThrow("dimensions exceed native V2 render limits");
  });

  it("authorizes every source and rejects a hard-linked immutable asset", async () => {
    const project = mixedProject();
    const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));
    const job = buildCompositionExecutionJob(project, handles);
    const root = await mkdtemp(join(tmpdir(), "replex-composition-preflight-"));
    await mkdir(join(root, "assets"));
    const resolvedHandles = [] as Array<{ assetId: string; sha256: string; ref: string; path: string }>;
    try {
      for (const handle of handles) {
        const path = join(root, ...handle.ref.split("/"));
        await writeFile(path, handle.assetId);
        resolvedHandles.push({ ...handle, path });
      }
      const authorization = { projectRoot: root, resolvedHandles, isRevisionCurrent: async () => true };
      await expect(verifyCompositionExecutionPreflight(job, authorization)).resolves.toMatchObject({
        status: "passed", sourceRevisionId: project.currentRevisionId, assets: handles.map(({ assetId, sha256 }) => ({ assetId, sha256 })),
      });
      await expect(verifyCompositionExecutionPreflight(job, { ...authorization, resolvedHandles: resolvedHandles.slice(0, -1) })).rejects.toThrow("not resolved");
      await link(resolvedHandles[0]!.path, join(root, "assets", "second-link"));
      await expect(verifyCompositionExecutionPreflight(job, authorization)).rejects.toThrow("regular project media file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!mediaToolsAvailable)("renders, verifies, and replays a real mixed-media composition", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-composition-e2e-"));
    const assetsRoot = join(root, "assets");
    await mkdir(assetsRoot);
    const files = ["a.mp4", "b.mp4", "music.m4a", "product.png"];
    const sources = files.map((filename) => join(assetsRoot, filename));
    // Rectangular app chrome keeps the synthetic demo footage deterministic and readable as software UI.
    const fixtures = [
      ["-f", "lavfi", "-i", "color=c=0x18324a:s=320x180:r=24:d=2", "-vf", "drawbox=x=8:y=8:w=304:h=22:color=0x27445f:t=fill,drawbox=x=14:y=40:w=82:h=128:color=0x1d3348:t=fill,drawbox=x=104:y=40:w=198:h=57:color=0x36597b:t=fill,drawbox=x=104:y=106:w=198:h=62:color=0x233d59:t=fill,drawbox=x=114:y=118:w=48:h=20:color=0x2cbb83:t=fill", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", sources[0]!],
      ["-f", "lavfi", "-i", "color=c=0x101b2d:s=320x180:r=24:d=2", "-vf", "drawbox=x=8:y=8:w=304:h=22:color=0x31435c:t=fill,drawbox=x=14:y=40:w=72:h=128:color=0x1e2f45:t=fill,drawbox=x=94:y=40:w=208:h=40:color=0x273f5b:t=fill,drawbox=x=94:y=88:w=208:h=80:color=0x1c3148:t=fill,drawbox=x=108:y=102:w=68:h=50:color=0x4f6d8a:t=fill", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", sources[1]!],
      ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=4", "-c:a", "aac", "-b:a", "128k", sources[2]!],
      ["-f", "lavfi", "-i", "color=c=0x23a575:s=160x90:d=0.1", "-vf", "drawbox=x=4:y=4:w=152:h=10:color=0x286546:t=fill,drawbox=x=10:y=20:w=62:h=60:color=0x2d8f6a:t=fill,drawbox=x=82:y=20:w=66:h=26:color=0x17734f:t=fill", "-frames:v", "1", sources[3]!],
    ];
    try {
      for (const args of fixtures) {
        const result = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, shell: false, timeout: 30_000 });
        expect(result.status, result.stderr?.toString()).toBe(0);
      }
      const project = mixedProject();
      for (const [index, asset] of Object.values(project.assets).entries()) {
        const bytes = await readFile(sources[index]!);
        const hash = createHash("sha256").update(bytes).digest("hex");
        asset.sha256 = hash;
        if (asset.provenance.kind === "upload") asset.provenance.sourceSha256 = hash;
      }
      project.revisions[0]!.manifestSha256 = semanticHashV2(project);
      const before = JSON.stringify(project);
      const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));
      const job = buildCompositionExecutionJob(project, handles);
      const authorization: MediaExecutionAuthorization = {
        projectRoot: root,
        resolvedHandles: handles.map((handle, index) => ({ ...handle, path: sources[index]! })),
        isRevisionCurrent: async () => true,
      };
      const first = await executeMediaExecutionJob(job, authorization, { ffmpegPath, ffprobePath, timeoutMs: 120_000 });
      const second = await executeMediaExecutionJob(job, authorization, { ffmpegPath, ffprobePath, timeoutMs: 120_000 });

      expect(first.artifact).toMatchObject({
        renderJobHash: job.jobHash,
        probe: { width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac" },
        verification: { status: "passed", checks: { probe: true, decode: true, hash: true } },
      });
      expect(Math.abs(first.artifact.probe.durationMs! - job.composition.outputDurationMs)).toBeLessThanOrEqual(1500 / job.composition.fps);
      expect(first.artifact.sha256).toBe(second.artifact.sha256);
      expect((await readFile(join(root, ...first.artifact.ref.split("/")))).byteLength).toBeLessThanOrEqual(MAX_RENDER_ARTIFACT_BYTES);
      const outputPath = join(root, ...first.artifact.ref.split("/"));
      const titleFrame = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
      expect(titleFrame.status, titleFrame.stderr?.toString()).toBe(0);
      const titlePixels = titleFrame.stdout as Buffer;
      let brightTitlePixels = 0;
      for (let y = 120; y < 180; y += 1) for (let x = 0; x < 320; x += 1) {
        const offset = (y * 320 + x) * 3;
        if (titlePixels[offset]! > 190 && titlePixels[offset + 1]! > 190 && titlePixels[offset + 2]! > 190) brightTitlePixels += 1;
      }
      expect(brightTitlePixels).toBeGreaterThan(10);
      const imageFrame = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", "1.75", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
      expect(imageFrame.status, imageFrame.stderr?.toString()).toBe(0);
      const overlayPoint = (45 * 320 + 255) * 3;
      expect(imageFrame.stdout[overlayPoint + 1]).toBeGreaterThan(100);
      const backgroundPoint = (90 * 320 + 160) * 3;
      expect(imageFrame.stdout[backgroundPoint + 2]).toBeGreaterThan(50);
      const registered = registerRenderArtifactV2(project, first.artifact);
      expect(registered.outputs).toHaveLength(1);
      expect(registered.outputs[0]).toMatchObject({ renderJobHash: job.jobHash, sourceRevisionId: project.currentRevisionId });
      expect(semanticHashV2(registered)).toBe(project.revisions[0]!.manifestSha256);
      expect(JSON.stringify(project)).toBe(before);
      expect(await readFile(join(root, ...first.artifact.verification.evidenceRefs[0]!.split("/")), "utf8")).toContain(job.jobHash);

      let canonicalProject = project;
      const evidenceRef = "evidence:launch-demo";
      let responseIndex = 0;
      const model: V2AgentModelClient = {
        async respond(request) {
          responseIndex += 1;
          if (responseIndex === 1) return { responseId: "composition-inspect", calls: [{ id: "inspect", name: "inspect_v2", arguments: { kind: "media_evidence", assetId: "video-a" } }] };
          if (responseIndex === 2) return { responseId: "composition-edit", calls: [{ id: "edit", name: "propose_edit_batch", arguments: {
            baseRevisionId: request.context.currentRevisionId,
            evidenceRefs: [evidenceRef],
            operations: [{ type: "set_volume", clipId: "music", audioGainDb: -15 }],
          } }] };
          expect(request.toolResults[0]?.output).toMatchObject({ ok: true, preview: { creativeApproval: "not_assessed" } });
          expect(request.toolResults[0]?.images).toHaveLength(1);
          return { responseId: "composition-final", calls: [], text: "Lowered the music and rendered a preview." };
        },
      };
      const conversation = await runConversationalEditV2({
        project: canonicalProject,
        prompt: "Lower the music while keeping this composition.",
        threadId: "thread-composition-e2e",
        inspect: async () => ({ ok: true, data: { evidence: "audio and frame measurements" }, evidenceRefs: [evidenceRef] }),
        model,
        operationLog: [],
        assetHandles: handles,
        renderAuthorization: authorization,
        renderOptions: { ffmpegPath, ffprobePath, timeoutMs: 120_000 },
        commitCanonicalRevision: async ({ baseRevisionId, baseRevisionHash, project: candidate, operationLog }) => {
          if (baseRevisionId !== canonicalProject.currentRevisionId || baseRevisionHash !== semanticHashV2(canonicalProject)) return { ok: false as const, code: "STALE_REVISION" };
          const firstRecord = operationLog[0];
          const applied = applyOperationBatch(canonicalProject, {
            baseRevisionId, actor: "agent", intentId: firstRecord!.intentId, evidenceRefs: firstRecord!.evidenceRefs,
            operations: operationLog.map(({ input }) => input), createdAt: firstRecord!.createdAt,
          });
          if (!applied.ok || semanticHashV2(applied.project) !== semanticHashV2(candidate)) return { ok: false as const, code: "INVALID_BATCH" };
          canonicalProject = candidate;
          return { ok: true as const, project: canonicalProject };
        },
        evidenceRoot: join(root, "evidence"),
      });
      expect(conversation).toMatchObject({ ok: true, project: { outputs: [{ backendVersion: "2" }] }, acceptedBatches: [{ baseRevisionId: project.currentRevisionId }] });
      expect(conversation.ok && conversation.project.currentRevisionId).not.toBe(project.currentRevisionId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
