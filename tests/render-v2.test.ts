import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { buildMediaExecutionJob, executeMediaExecutionJob, verifyMediaExecutionPreflight, type MediaExecutionAuthorization } from "../src/render-v2.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
const mediaToolsAvailable = spawnSync(ffmpegPath, ["-version"], { windowsHide: true, shell: false }).status === 0
  && spawnSync(ffprobePath, ["-version"], { windowsHide: true, shell: false }).status === 0;

const handle = { assetId: "upload-1", sha256: sha("uploaded-media"), ref: "assets/product.mp4" };

function uploadedProject(sourceSha256 = handle.sha256): ProjectV2 {
  const base: Omit<ProjectV2, "revisions"> & { revisions: ProjectV2["revisions"] } = {
    schemaVersion: 2,
    projectId: "project-render-v2",
    brief: { message: "Product walkthrough" },
    assets: {
      "upload-1": {
        id: "upload-1",
        type: "uploaded_video",
        path: handle.ref,
        sha256: sourceSha256,
        probe: { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 2, sampleRateHz: 48000 },
        provenance: {
          kind: "upload",
          originalFilename: "product.mp4",
          importedAt: "2026-09-25T00:00:00.000Z",
          sourceSha256,
          importMethod: "path",
          originalProbe: { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 2, sampleRateHz: 48000 },
        },
      },
    },
    composition: {
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 1280,
      tracks: [{ id: "video-1", kind: "video", order: 0, muted: false, locked: false }],
      clips: [{
        id: "clip-1",
        assetId: "upload-1",
        trackId: "video-1",
        timelineStartMs: 0,
        sourceInMs: 200,
        sourceOutMs: 1800,
        speed: 1.25,
        transform: { x: 12, y: -6, scale: 1.1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        opacity: 0.75,
        audioGainDb: -6,
        muted: false,
      }],
      layers: [],
    },
    revisions: [{ id: "revision-1", actor: "user", operationIds: [], manifestSha256: sha("manifest"), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-1", status: "unknown", refs: [] },
    currentRevisionId: "revision-1",
  };
  base.revisions[0].manifestSha256 = semanticHashV2(base);
  return ProjectV2Schema.parse(base);
}

describe("V2 media render planning", () => {
  it("freezes a deterministic single uploaded-video job to the source revision", () => {
    const project = uploadedProject();
    const first = buildMediaExecutionJob(project, [handle]);
    const second = buildMediaExecutionJob(project, [handle]);

    expect(first.jobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.jobHash).toBe(first.jobHash);
    expect(first.sourceRevisionId).toBe(project.currentRevisionId);
    expect(first.sourceRevisionHash).toBe(project.revisions[0].manifestSha256);
    expect(first.clip).toMatchObject({ sourceInMs: 200, sourceOutMs: 1800, speed: 1.25, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, opacity: 0.75, audioGainDb: -6 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.clip.transform)).toBe(true);
    expect(first).not.toHaveProperty("project");

    project.composition.clips[0].speed = 2;
    expect(first.clip.speed).toBe(1.25);
  });

  it("rejects unsupported or invalid canonical state before planning", () => {
    const project = uploadedProject();
    project.assets["upload-1"].type = "image";
    project.revisions[0].manifestSha256 = semanticHashV2(project);
    expect(() => buildMediaExecutionJob(project, [handle])).toThrow("supports one uploaded video asset");

    const corrupted = uploadedProject();
    corrupted.revisions[0].manifestSha256 = sha("wrong manifest");
    expect(() => buildMediaExecutionJob(corrupted, [handle])).toThrow("manifest hash");
  });

  it("combines canonical clip and track mute state in the frozen job", () => {
    const project = uploadedProject();
    project.composition.tracks[0].muted = true;
    project.revisions[0].manifestSha256 = semanticHashV2(project);
    expect(buildMediaExecutionJob(project, [handle]).clip.muted).toBe(true);
  });

  it("preflights the pinned revision and the exact project-contained upload handle", async () => {
    const project = uploadedProject();
    const job = buildMediaExecutionJob(project, [handle]);
    const root = await mkdtemp(join(tmpdir(), "replex-v2-render-preflight-"));
    const source = join(root, "assets", "product.mp4");
    await mkdir(join(root, "assets"));
    await writeFile(source, "uploaded-media");
    const authorization: MediaExecutionAuthorization = {
      projectRoot: root,
      resolvedHandles: [{ ...handle, path: source }],
      isRevisionCurrent: async (revisionId, revisionHash) => revisionId === "revision-1" && revisionHash === project.revisions[0].manifestSha256,
    };

    try {
      await expect(verifyMediaExecutionPreflight(job, authorization)).resolves.toMatchObject({ status: "passed", assetId: "upload-1", assetSha256: handle.sha256 });
      await expect(verifyMediaExecutionPreflight(job, { ...authorization, isRevisionCurrent: async () => false })).rejects.toThrow("no longer current");
      await expect(executeMediaExecutionJob(job, { ...authorization, isRevisionCurrent: async () => false }, { ffmpegPath: join(root, "missing-ffmpeg.exe") })).rejects.toThrow("no longer current");
      await writeFile(source, "changed media bytes");
      await expect(verifyMediaExecutionPreflight(job, authorization)).rejects.toThrow("bytes changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an authorized path that escapes the project root", async () => {
    const job = buildMediaExecutionJob(uploadedProject(), [handle]);
    const root = await mkdtemp(join(tmpdir(), "replex-v2-render-containment-"));
    try {
      await expect(verifyMediaExecutionPreflight(job, {
        projectRoot: root,
        resolvedHandles: [{ ...handle, path: join(root, "..", "outside.mp4") }],
        isRevisionCurrent: async () => true,
      })).rejects.toThrow("escapes the project root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans staging and leaves project state untouched when the backend cannot start", async () => {
    const project = uploadedProject();
    const before = JSON.stringify(project);
    const job = buildMediaExecutionJob(project, [handle]);
    const root = await mkdtemp(join(tmpdir(), "replex-v2-render-failure-"));
    const source = join(root, "assets", "product.mp4");
    await mkdir(join(root, "assets"));
    await writeFile(source, "uploaded-media");
    try {
      await expect(executeMediaExecutionJob(job, {
        projectRoot: root,
        resolvedHandles: [{ ...handle, path: source }],
        isRevisionCurrent: async () => true,
      }, { ffmpegPath: join(root, "missing-ffmpeg.exe") })).rejects.toThrow("could not start");
      expect(JSON.stringify(project)).toBe(before);
      expect(await readdir(join(root, ".replex-staging"))).toEqual([]);
      await expect(readdir(join(root, "renders"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans staging when a render is cancelled before launch", async () => {
    const project = uploadedProject();
    const job = buildMediaExecutionJob(project, [handle]);
    const root = await mkdtemp(join(tmpdir(), "replex-v2-render-cancel-"));
    const source = join(root, "assets", "product.mp4");
    await mkdir(join(root, "assets"));
    await writeFile(source, "uploaded-media");
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(executeMediaExecutionJob(job, {
        projectRoot: root,
        resolvedHandles: [{ ...handle, path: source }],
        isRevisionCurrent: async () => true,
      }, { ffmpegPath: join(root, "missing-ffmpeg.exe"), signal: abort.signal })).rejects.toThrow("cancelled");
      expect(await readdir(join(root, ".replex-staging"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // This output-media gate is skipped only when neither configured binary can be launched.
  it.skipIf(!mediaToolsAvailable)("renders deterministically when FFmpeg and FFprobe are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-v2-render-e2e-"));
    const source = join(root, "assets", "product.mp4");
    await mkdir(join(root, "assets"));
    const fixture = spawnSync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ], { windowsHide: true, shell: false });
    if (fixture.status !== 0) {
      await rm(root, { recursive: true, force: true });
      throw new Error("FFmpeg could not generate the synthetic uploaded-video fixture");
    }
    const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex");
    const localHandle = { ...handle, sha256: sourceSha256 };
    const project = uploadedProject(sourceSha256);
    const before = JSON.stringify(project);
    const job = buildMediaExecutionJob(project, [localHandle]);
    const authorization: MediaExecutionAuthorization = {
      projectRoot: root,
      resolvedHandles: [{ ...localHandle, path: source }],
      isRevisionCurrent: async (revisionId, revisionHash) => revisionId === "revision-1" && revisionHash === project.revisions[0].manifestSha256,
    };
    try {
      const outputDir = join(root, "renders");
      await mkdir(outputDir);
      const outputPath = join(outputDir, `${job.jobHash}.mp4`);
      await writeFile(outputPath, "pre-existing artifact must not be overwritten");
      await expect(executeMediaExecutionJob(job, authorization, { ffmpegPath, ffprobePath })).rejects.toThrow("already contains different");
      expect(await readFile(outputPath, "utf8")).toBe("pre-existing artifact must not be overwritten");
      await rm(outputPath);

      const first = await executeMediaExecutionJob(job, authorization, { ffmpegPath, ffprobePath });
      const second = await executeMediaExecutionJob(job, authorization, { ffmpegPath, ffprobePath });
      expect(first.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(second.artifact.sha256).toBe(first.artifact.sha256);
      expect(first.artifact).toMatchObject({
        sourceRevisionId: "revision-1",
        sourceRevisionHash: project.revisions[0].manifestSha256,
        renderJobHash: job.jobHash,
        backendId: "native-ffmpeg",
        probe: { width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac" },
        verification: { status: "passed", evidenceRefs: [`evidence/renders/${job.jobHash}.json`], checks: { probe: true, decode: true, hash: true } },
      });
      expect(JSON.stringify(project)).toBe(before);
      expect(first.artifact.ref).toBe(`renders/${job.jobHash}.mp4`);
      expect(await readdir(join(root, ".replex-staging"))).toEqual([]);
      const actualOutputPath = join(root, ...first.artifact.ref.split("/"));
      const independentProbe = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", actualOutputPath], { encoding: "utf8", windowsHide: true, shell: false });
      expect(independentProbe.status).toBe(0);
      const probed = JSON.parse(independentProbe.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
      expect(probed.streams.find(({ codec_type }) => codec_type === "video")).toMatchObject({ codec_name: "h264", width: 320, height: 180 });
      expect(probed.streams.find(({ codec_type }) => codec_type === "audio")).toMatchObject({ codec_name: "aac" });
      const independentDecode = spawnSync(ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-i", actualOutputPath, "-f", "null", "-"], { windowsHide: true, shell: false });
      expect(independentDecode.status).toBe(0);

      const evidence = await readFile(join(root, ...first.artifact.verification.evidenceRefs[0].split("/")), "utf8");
      expect(sha(evidence)).toBe(first.artifact.verification.evidenceSha256);
      expect(JSON.parse(evidence)).toMatchObject({ status: "passed", revisionId: "revision-1", renderJobHash: job.jobHash, checks: { probe: true, decode: true, hash: true } });

      const staleProject = structuredClone(project);
      staleProject.composition.clips[0].audioGainDb = -5;
      staleProject.revisions[0].manifestSha256 = semanticHashV2(staleProject);
      const staleJob = buildMediaExecutionJob(staleProject, [localHandle]);
      let revisionChecks = 0;
      const staleAfterPromotion = {
        ...authorization,
        isRevisionCurrent: async () => ++revisionChecks < 3,
      };
      await expect(executeMediaExecutionJob(staleJob, staleAfterPromotion, { ffmpegPath, ffprobePath })).rejects.toThrow("changed after output promotion");
      await expect(readFile(join(root, "renders", `${staleJob.jobHash}.mp4`))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, "evidence", "renders", `${staleJob.jobHash}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      expect(revisionChecks).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
