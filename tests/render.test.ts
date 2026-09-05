import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { buildRenderJob, executeRenderJob, type RenderJob } from "../src/render.js";
import { createProject, type Project } from "../src/project.js";
import { verifyProject } from "../src/verify.js";

const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
const mediaAvailable = existsSync(ffmpegPath) && existsSync(ffprobePath);

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
    expect(job.scenes[0].overlays[0].assetPath).toMatch(/^render-assets\/[A-Za-z0-9._-]+\.png$/);
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
});

describe.skipIf(!mediaAvailable)("FFmpeg baseline render", () => {
  it("renders a 27-second 1080p H.264/AAC MP4, probes it, decodes it, and writes an evidence report", async () => {
      const root = await mkdtemp(join(tmpdir(), "replex-render-"));
    try {
      const base = project(root);
      await mkdir(join(root, "captures"), { recursive: true });
      for (const index of [1, 2, 3]) makeSource(join(root, "captures", `${index}.mp4`), index);
      const source = {
        ...base,
        captures: Object.fromEntries(await Promise.all(Object.entries(base.captures).map(async ([id, capture]) => [id, { ...capture, sha256: createHash("sha256").update(await readFile(join(root, capture.path))).digest("hex") }]))) as Project["captures"],
        scenes: [{ ...base.scenes[0], focus: { preset: "box" as const, bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, startMs: 0, endMs: 3000 }, transition: { type: "crossfade" as const, durationMs: 250 as const } }, ...base.scenes.slice(1)],
      };
      const verification = verifyProject(source, root);
      const job = buildRenderJob(source, root, verification);
      const result = executeRenderJob(job, root, { ffmpegPath, ffprobePath });

      expect(result.outputPath).toBe(join(root, "renders", "revision-0.mp4"));
      expect(result.probe).toMatchObject({ width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" });
      expect(result.probe.durationMs).toBeGreaterThanOrEqual(25000);
      expect(result.probe.durationMs).toBeLessThanOrEqual(35000);
      expect(await readFile(join(root, "renders", "revision-0.render-job.json"), "utf8")).toContain(job.sha256);
      expect(await readFile(join(root, "renders", "revision-0.argv.json"), "utf8")).toContain("-filter_complex");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

function makeSource(path: string, index: number): void {
  const colors = ["0x243447", "0x355c7d", "0x5c3d2e"];
  const run = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", `color=c=${colors[index - 1]}:s=1920x1080:r=30:d=9`, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr || "could not create render fixture");
}
