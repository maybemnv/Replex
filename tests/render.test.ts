import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { buildRenderJob, executeRenderJob, validateOverlayAsset, type RenderJob } from "../src/render.js";
import { createProject, semanticHash, type Project, writeRevision } from "../src/project.js";
import { verifyProject } from "../src/verify.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

function project(root: string): Project {
  const value = createProject({
    projectId: "render-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment("http://127.0.0.1:4173"),
    flow: normalFlow("http://127.0.0.1:4173"),
    captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({
      id: `capture-${index + 1}`,
      sceneKey,
      path: `captures/${index + 1}.mp4`,
      durationMs: 9000,
      sha256: createHash("sha256").update(`capture-${index + 1}`).digest("hex"),
      capturedAt: "2026-09-05T00:00:00.000Z",
    })),
  });
  return {
    ...value,
    overlays: {
      "title-1": { id: "title-1", sceneId: value.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 3000 },
      "callout-1": { id: "callout-1", sceneId: value.scenes[1].id, kind: "callout", text: "Results update", placement: "bottom", startMs: 1000, endMs: 4000 },
    },
  };
}

describe("RenderJob", () => {
  it("freezes the canonical revision into only fixed primitives", () => {
    const root = join(tmpdir(), "replex-render-contract");
    const job = buildRenderJob(project(root), root, { id: "verification-project", passed: true });

    expect(job).toMatchObject({
      revisionId: "revision-0",
      output: { path: "renders/revision-0.mp4", width: 1920, height: 1080, fps: 30, videoCodec: "libx264", audioCodec: "aac" },
    });
    expect(job.scenes.map((scene) => scene.sourcePath)).toEqual(["captures/1.mp4", "captures/2.mp4", "captures/3.mp4"]);
    expect(job.scenes[0].overlays).toMatchObject([{ kind: "title", text: "Filter releases", startMs: 0, endMs: 3000 }]);
    expect(job.scenes[0].overlays[0].text).toBe("Filter releases");
    expect(job.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unsafe output paths and unrenderable scene primitives", () => {
    const root = join(tmpdir(), "replex-render-contract");
    const source = project(root);
    expect(() => buildRenderJob(source, root, { id: "verification-project", passed: true }, "../outside.mp4")).toThrow("project-relative");
    expect(() => buildRenderJob({ ...source, scenes: [{ ...source.scenes[0], transition: { type: "crossfade", durationMs: 250 } }, ...source.scenes.slice(1)] }, root, { id: "verification-project", passed: true })).not.toThrow();
    expect(() => buildRenderJob(source, root, { id: "verification-project", passed: false })).toThrow("successful verification");
  });

  it("refuses to execute without the persisted verification for this revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-render-gate-"));
    try {
      const job = buildRenderJob(project(root), root, { id: "verification-project", passed: true });
      expect(() => executeRenderJob(job, root, { ffmpegPath: "missing-ffmpeg", ffprobePath: "missing-ffprobe" })).toThrow("persisted successful verification");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a job whose plan hash no longer matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-render-tamper-"));
    try {
      const base = project(root);
      const source = { ...base, revisions: [{ ...base.revisions[0], manifestSha256: semanticHash(base) }] };
      await writeRevision(root, source as Project);
      const { writeVerificationResult } = await import("../src/verify.js");
      writeVerificationResult(root, { id: "verification-revision-0", phase: "scene", passed: true, checks: [] });
      const job = buildRenderJob(source, root, { id: "verification-revision-0", passed: true });
      const tampered = { ...job, sha256: "0".repeat(64) };
      expect(() => executeRenderJob(tampered, root, { ffmpegPath: "missing-ffmpeg", ffprobePath: "missing-ffprobe", project: source })).toThrow("job hash");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a job that is stale for the current revision manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-render-stale-"));
    try {
      const base = project(root);
      const source = { ...base, revisions: [{ ...base.revisions[0], manifestSha256: semanticHash(base) }] };
      await writeRevision(root, source as Project);
      const { writeVerificationResult } = await import("../src/verify.js");
      writeVerificationResult(root, { id: "verification-revision-0", phase: "scene", passed: true, checks: [] });
      const job = buildRenderJob(source, root, { id: "verification-revision-0", passed: true });
      const drifted = { ...source, brief: { ...source.brief, message: "Drifted message" } };
      expect(() => executeRenderJob(job, root, { ffmpegPath: "missing-ffmpeg", ffprobePath: "missing-ffprobe", project: drifted })).toThrow("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, corrupt, and blank overlay assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-overlay-assets-"));
    try {
      expect(() => validateOverlayAsset(join(root, "missing.png"), ffmpegPath, "missing")).toThrow("blank asset");
      const blank = join(root, "blank.png");
      await writeFile(blank, Buffer.alloc(0));
      expect(() => validateOverlayAsset(blank, ffmpegPath, "blank")).toThrow("blank asset");
      const corrupt = join(root, "corrupt.png");
      await writeFile(corrupt, "not an image");
      expect(() => validateOverlayAsset(corrupt, ffmpegPath, "corrupt")).toThrow("corrupt asset");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!mediaAvailable)("FFmpeg baseline render", () => {
  it("renders a 27-second 1080p H.264/AAC MP4, probes it, decodes it, and writes an evidence report", async () => {
      const root = await mkdtemp(join(tmpdir(), "replex-render-"));
    try {
      const base = project(root);
      await mkdir(join(root, "captures"), { recursive: true });
      for (const index of [1, 2, 3]) makeSource(join(root, "captures", `${index}.mp4`), index);
      const sourceCore = {
        ...base,
        overlays: {
          ...base.overlays,
          "title:hero": { ...base.overlays["title-1"], id: "title:hero", startMs: 4000, endMs: 5000 },
          "title_hero": { ...base.overlays["title-1"], id: "title_hero", startMs: 5000, endMs: 6000 },
        },
        captures: Object.fromEntries(await Promise.all(Object.entries(base.captures).map(async ([id, capture]) => [id, { ...capture, sha256: createHash("sha256").update(await readFile(join(root, capture.path))).digest("hex") }]))) as Project["captures"],
        scenes: [{ ...base.scenes[0], focus: { preset: "box" as const, bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, startMs: 0, endMs: 3000 }, transition: { type: "crossfade" as const, durationMs: 250 as const } }, ...base.scenes.slice(1)],
      };
      const source = { ...sourceCore, revisions: [{ ...base.revisions[0], manifestSha256: semanticHash(sourceCore) }] };
      const verification = verifyProject(source, root);
      const job = buildRenderJob(source, root, verification);
      await writeRevision(root, source as Project);
      const result = executeRenderJob(job, root, { ffmpegPath: relative(process.cwd(), ffmpegPath), ffprobePath, project: source as Project });

      expect(result.outputPath).toBe(join(root, "renders", "revision-0.mp4"));
      expect(result.probe).toMatchObject({ width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" });
      expect(result.probe.durationMs).toBeGreaterThanOrEqual(25000);
      expect(result.probe.durationMs).toBeLessThanOrEqual(35000);
      expect(result.output).toMatchObject({ id: "render-output-revision-0", revisionId: "revision-0", path: "renders/revision-0.mp4", verificationId: verification.id });
      expect((JSON.parse(await readFile(join(root, "project.json"), "utf8")) as Project).outputs).toEqual([result.output]);
      expect(await readFile(join(root, "renders", "revision-0.render-job.json"), "utf8")).toContain(job.sha256);
      const argv = await readFile(join(root, "renders", "revision-0.argv.json"), "utf8");
      expect(argv).toContain("-filter_complex");
      expect(argv).toContain("between(t,0.000,3.000)");
      expect(argv).toContain("overlay-7469746c653a6865726f.png");
      expect(argv).toContain("overlay-7469746c655f6865726f.png");
      expect(argv).not.toContain("Filter releases");
      expect(argv).not.toContain("drawtext");
      expect(existsSync(join(root, "renders", "render-revision-0-overlays", "overlay-7469746c652d31.png"))).toBe(true);
      expect(existsSync(join(root, "renders", "render-revision-0-overlays", "overlay-63616c6c6f75742d31.png"))).toBe(true);
      expect(existsSync(join(root, "renders", "render-revision-0-overlays", "overlay-7469746c653a6865726f.png"))).toBe(true);
      expect(existsSync(join(root, "renders", "render-revision-0-overlays", "overlay-7469746c655f6865726f.png"))).toBe(true);
      const onBoundary = frameRgb(result.outputPath, 2.9);
      const offBoundary = frameRgb(result.outputPath, 3.1);
      expect(colorDistance(onBoundary, 200, 100, [17, 24, 39])).toBeLessThan(24);
      expect(colorDistance(offBoundary, 200, 100, [17, 24, 39])).toBeGreaterThan(24);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

function makeSource(path: string, index: number): void {
  void index;
  const run = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "testsrc=s=1920x1080:r=30:d=9", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr || "could not create render fixture");
}

function frameRgb(path: string, timestamp: number): Buffer {
  const run = spawnSync(ffmpegPath, ["-ss", timestamp.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (run.status !== 0 || !run.stdout) throw new Error(run.stderr?.toString() || "could not extract render frame");
  return run.stdout;
}

function colorDistance(frame: Buffer, x: number, y: number, expected: [number, number, number]): number {
  const offset = (y * 1920 + x) * 3;
  return Math.hypot(frame[offset] - expected[0], frame[offset + 1] - expected[1], frame[offset + 2] - expected[2]);
}
