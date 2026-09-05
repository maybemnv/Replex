import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Focus, Overlay, Project, Scene, Transition } from "./schema.js";

export interface RenderJobOverlay {
  id: string;
  kind: Overlay["kind"];
  text: string;
  placement: Overlay["placement"];
  startMs: number;
  endMs: number;
}

export interface RenderJobScene {
  sceneId: string;
  sourcePath: string;
  sourceSha256: string;
  inMs: number;
  outMs: number;
  speed: number;
  focus?: Focus;
  overlays: RenderJobOverlay[];
  transition: Transition;
}

export interface RenderJob {
  id: string;
  revisionId: string;
  verificationId: string;
  revisionSha256: string;
  scenes: RenderJobScene[];
  output: { path: string; width: 1920; height: 1080; fps: 30; videoCodec: "libx264"; audioCodec: "aac" };
  sha256: string;
}

export interface MediaProbe {
  durationMs: number;
  width: number;
  height: number;
  fps: 30;
  videoCodec: string;
  audioCodec: string;
}

export interface RenderExecution {
  outputPath: string;
  probe: MediaProbe;
  argv: string[];
}

export interface RenderOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
}

/** Builds the only renderable representation; callers never provide FFmpeg arguments. */
export function buildRenderJob(project: Project, root: string, verificationId: string, outputPath = `renders/${project.currentRevisionId}.mp4`): RenderJob {
  const output = projectRelative(root, outputPath);
  if (!output.endsWith(".mp4")) throw new Error("render output must be an MP4");
  const scenes = [...project.scenes].sort((left, right) => left.order - right.order).map((scene) => sceneJob(project, scene));
  if (!scenes.length) throw new Error("render job needs at least one scene");
  for (const scene of scenes) {
    if (scene.outMs <= scene.inMs || ![0.75, 1, 1.25, 1.5, 2].includes(scene.speed)) throw new Error(`unrenderable scene: ${scene.sceneId}`);
    if (scene.transition.type === "crossfade" && scene.transition.durationMs === 0) throw new Error(`unrenderable transition: ${scene.sceneId}`);
  }
  const withoutHash = {
    id: `render-${project.currentRevisionId}`,
    revisionId: project.currentRevisionId,
    verificationId,
    revisionSha256: project.revisions.at(-1)?.manifestSha256 ?? "",
    scenes,
    output: { path: output, width: 1920 as const, height: 1080 as const, fps: 30 as const, videoCodec: "libx264" as const, audioCodec: "aac" as const },
  };
  return { ...withoutHash, sha256: sha256(canonicalJson(withoutHash)) };
}

/** Executes a closed, argv-only FFmpeg plan and retains the plan before promotion. */
export function executeRenderJob(job: RenderJob, root: string, options: RenderOptions = {}): RenderExecution {
  const ffmpegPath = options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
  const outputPath = resolveProjectPath(root, job.output.path);
  const renderRoot = dirname(outputPath);
  mkdirSync(renderRoot, { recursive: true });
  const temporary = `${outputPath}.${job.sha256.slice(0, 12)}.tmp.mp4`;
  const argv = buildFfmpegArgv(job, root, temporary);
  const stem = outputPath.slice(0, -4);
  writeFileSync(`${stem}.render-job.json`, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  writeFileSync(`${stem}.argv.json`, `${JSON.stringify(argv, null, 2)}\n`, "utf8");
  const run = spawnSync(ffmpegPath, argv, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(`${stem}.stderr.txt`, run.stderr || "", "utf8");
  if (run.status !== 0 || !existsSync(temporary)) throw new Error(`FFmpeg render failed: ${(run.stderr || run.error?.message || "unknown error").trim()}`);
  const probe = probeMedia(temporary, ffprobePath);
  assertRenderedMedia(probe);
  const decode = spawnSync(ffmpegPath, ["-v", "error", "-i", temporary, "-f", "null", "-"], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (decode.status !== 0) throw new Error(`FFmpeg decode failed: ${(decode.stderr || "unknown error").trim()}`);
  renameSync(temporary, outputPath);
  return { outputPath, probe, argv };
}

export function probeMedia(path: string, ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe"): MediaProbe {
  const run = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", path], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(`FFprobe failed: ${(run.stderr || run.error?.message || "unknown error").trim()}`);
  const output = JSON.parse(run.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }> };
  const video = output.streams?.find((stream) => stream.codec_type === "video");
  const audio = output.streams?.find((stream) => stream.codec_type === "audio");
  const fps = parseRate(video?.avg_frame_rate);
  if (!video || !audio || !output.format?.duration || fps !== 30) throw new Error("media probe is missing required H.264/AAC 30 fps streams");
  return { durationMs: Math.round(Number(output.format.duration) * 1000), width: video.width ?? 0, height: video.height ?? 0, fps: 30, videoCodec: video.codec_name ?? "", audioCodec: audio.codec_name ?? "" };
}

function sceneJob(project: Project, scene: Scene): RenderJobScene {
  const capture = project.captures[scene.captureId];
  if (!capture) throw new Error(`scene capture does not exist: ${scene.id}`);
  return {
    sceneId: scene.id,
    sourcePath: capture.path,
    sourceSha256: capture.sha256,
    inMs: scene.sourceInMs,
    outMs: scene.sourceOutMs,
    speed: scene.speed,
    ...(scene.focus ? { focus: scene.focus } : {}),
    overlays: Object.values(project.overlays).filter((overlay) => overlay.sceneId === scene.id).map(({ id, kind, text, placement, startMs, endMs }) => ({ id, kind, text, placement, startMs, endMs })),
    transition: scene.transition,
  };
}

function buildFfmpegArgv(job: RenderJob, root: string, temporary: string): string[] {
  const inputs = job.scenes.flatMap((scene) => ["-ss", seconds(scene.inMs), "-t", seconds(scene.outMs - scene.inMs), "-i", resolveProjectPath(root, scene.sourcePath)]);
  const totalSeconds = job.scenes.reduce((total, scene) => total + (scene.outMs - scene.inMs) / scene.speed / 1000, 0);
  const audioInput = job.scenes.length;
  const filters = job.scenes.flatMap((scene, index) => sceneFilters(scene, index));
  const videoLabels = job.scenes.map((_, index) => `[scene${index}]`).join("");
  filters.push(`${videoLabels}concat=n=${job.scenes.length}:v=1:a=0[video]`);
  return [
    "-y", ...inputs,
    "-f", "lavfi", "-t", seconds(totalSeconds * 1000), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", filters.join(";"),
    "-map", "[video]", "-map", `${audioInput}:a`, "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", temporary,
  ];
}

function sceneFilters(scene: RenderJobScene, index: number): string[] {
  const filters = [`[${index}:v]setpts=(PTS-STARTPTS)/${scene.speed},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[base${index}]`];
  let previous = `base${index}`;
  for (const [overlayIndex, overlay] of scene.overlays.entries()) {
    const next = `overlay${index}_${overlayIndex}`;
    const y = overlay.placement === "bottom" ? "h-text_h-72" : overlay.placement === "target" ? "(h-text_h)/2" : "72";
    const color = overlay.kind === "title" ? "white" : "0xF5C56B";
    filters.push(`[${previous}]drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${escapeDrawText(overlay.text)}':x=(w-text_w)/2:y=${y}:fontcolor=${color}:fontsize=46:box=1:boxcolor=black@0.55:boxborderw=18:enable='between(t,${seconds(overlay.startMs)},${seconds(overlay.endMs)})'[${next}]`);
    previous = next;
  }
  filters.push(`[${previous}]null[scene${index}]`);
  return filters;
}

function assertRenderedMedia(probe: MediaProbe): void {
  if (probe.width !== 1920 || probe.height !== 1080 || probe.fps !== 30 || probe.videoCodec !== "h264" || probe.audioCodec !== "aac") throw new Error("render output is not 1920x1080 30fps H.264/AAC");
  if (probe.durationMs < 25000 || probe.durationMs > 35000) throw new Error("render output duration must be between 25 and 35 seconds");
}

function projectRelative(root: string, candidate: string): string {
  if (isAbsolute(candidate) || candidate.includes("..") || candidate.replace(/\\/g, "/").startsWith("/")) throw new Error("render output must be project-relative");
  const resolved = resolve(root, candidate);
  if (relative(resolve(root), resolved).startsWith("..")) throw new Error("render output must remain inside the project");
  return candidate.replace(/\\/g, "/");
}

function resolveProjectPath(root: string, relativePath: string): string {
  projectRelative(root, relativePath);
  return resolve(root, relativePath);
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}

function seconds(value: number): string {
  return (value / 1000).toFixed(3).replace(/\.000$/, "");
}

function escapeDrawText(value: string): string {
  return value.replace(/[\\':,\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
