import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { ProjectSchema, type Focus, type Overlay, type Project, type RenderOutput, type Scene, type Transition } from "./schema.js";
import { loadVerificationResult } from "./verify.js";

export interface RenderJobOverlay {
  id: string;
  kind: Overlay["kind"];
  text: string;
  placement: Overlay["placement"];
  startMs: number;
  endMs: number;
  assetPath: string;
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
  output: RenderOutput;
}

export interface RenderOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  project?: Project;
}

/** Builds the only renderable representation; callers never provide FFmpeg arguments. */
export function buildRenderJob(project: Project, root: string, verification: { id: string; passed: boolean }, outputPath = `renders/${project.currentRevisionId}.mp4`): RenderJob {
  if (!verification.passed) throw new Error("render requires a successful verification");
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
    verificationId: verification.id,
    revisionSha256: project.revisions.at(-1)?.manifestSha256 ?? "",
    scenes,
    output: { path: output, width: 1920 as const, height: 1080 as const, fps: 30 as const, videoCodec: "libx264" as const, audioCodec: "aac" as const },
  };
  return { ...withoutHash, sha256: sha256(canonicalJson(withoutHash)) };
}

/** Executes a closed, argv-only FFmpeg plan and retains the plan before promotion. */
export function executeRenderJob(job: RenderJob, root: string, options: RenderOptions = {}): RenderExecution {
  const verification = loadVerificationResult(root, job.revisionId);
  if (!verification || !verification.passed || verification.id !== job.verificationId) throw new Error("render requires persisted successful verification for the current revision");
  const ffmpegPath = options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
  const outputPath = resolveProjectPath(root, job.output.path);
  const renderRoot = dirname(outputPath);
  mkdirSync(renderRoot, { recursive: true });
  const temporary = `${outputPath}.${job.sha256.slice(0, 12)}.tmp.mp4`;
  writeOverlayAssets(job, root);
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
  const output: RenderOutput = {
    id: `render-output-${job.revisionId}`,
    revisionId: job.revisionId,
    renderJobSha256: job.sha256,
    path: relative(resolve(root), outputPath).replace(/\\/g, "/"),
    ffprobe: probe,
    verificationId: job.verificationId,
  };
  persistRenderOutput(root, options.project, output);
  return { outputPath, probe, argv, output };
}

/** Records the only successful render for a revision in the canonical project. */
function persistRenderOutput(root: string, suppliedProject: Project | undefined, output: RenderOutput): void {
  const projectPath = join(root, "project.json");
  let project = suppliedProject;
  if (!project) {
    if (!existsSync(projectPath)) return;
    project = ProjectSchema.parse(JSON.parse(readFileSync(projectPath, "utf8")));
  }
  const next = ProjectSchema.parse({
    ...project,
    outputs: [...project.outputs.filter((candidate) => candidate.revisionId !== output.revisionId), output],
  });
  if (suppliedProject) suppliedProject.outputs = next.outputs;
  if (existsSync(projectPath)) {
    const temporary = `${projectPath}.${output.renderJobSha256.slice(0, 12)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, projectPath);
  }
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
    overlays: Object.values(project.overlays).filter((overlay) => overlay.sceneId === scene.id).map((overlay) => ({
      id: overlay.id,
      kind: overlay.kind,
      text: overlay.text,
      placement: overlay.placement,
      startMs: overlay.startMs,
      endMs: overlay.endMs,
      assetPath: overlayAssetPath(overlay),
    })),
    transition: scene.transition,
  };
}

function buildFfmpegArgv(job: RenderJob, root: string, temporary: string): string[] {
  const sourceInputs = job.scenes.flatMap((scene) => ["-ss", seconds(scene.inMs), "-t", seconds(scene.outMs - scene.inMs), "-i", resolveProjectPath(root, scene.sourcePath)]);
  const overlays = job.scenes.flatMap((scene) => scene.overlays);
  const overlayInputs = overlays.flatMap((overlay) => ["-loop", "1", "-framerate", "30", "-t", seconds(overlay.endMs), "-i", resolveProjectPath(root, overlay.assetPath)]);
  const totalSeconds = renderedDurationSeconds(job.scenes);
  const audioInput = job.scenes.length + overlays.length;
  let overlayInput = job.scenes.length;
  const filters = job.scenes.flatMap((scene, index) => {
    const indexes = scene.overlays.map(() => overlayInput++);
    return sceneFilters(scene, index, indexes);
  });
  filters.push(...timelineFilters(job.scenes));
  return [
    "-y", ...sourceInputs, ...overlayInputs,
    "-f", "lavfi", "-t", seconds(totalSeconds * 1000), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", filters.join(";"),
    "-map", "[video]", "-map", `${audioInput}:a`, "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", temporary,
  ];
}

function timelineFilters(scenes: RenderJobScene[]): string[] {
  if (scenes.length === 1) return ["[scene0]null[video]"];
  const filters: string[] = [];
  let previous = "scene0";
  let duration = sceneDurationSeconds(scenes[0]);
  for (let index = 1; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const next = `timeline${index}`;
    if (scenes[index - 1].transition.type === "crossfade") {
      const transitionSeconds = scenes[index - 1].transition.durationMs / 1000;
      filters.push(`[${previous}][scene${index}]xfade=transition=fade:duration=${transitionSeconds.toFixed(3)}:offset=${(duration - transitionSeconds).toFixed(3)}[${next}]`);
      duration += sceneDurationSeconds(scene) - transitionSeconds;
    } else {
      filters.push(`[${previous}][scene${index}]concat=n=2:v=1:a=0[${next}]`);
      duration += sceneDurationSeconds(scene);
    }
    previous = next;
  }
  filters.push(`[${previous}]null[video]`);
  return filters;
}

function sceneFilters(scene: RenderJobScene, index: number, overlayInputIndexes: number[]): string[] {
  const focus = focusFilters(scene.focus);
  const filters = [`[${index}:v]setpts=(PTS-STARTPTS)/${scene.speed},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2${focus}[base${index}]`];
  let previous = `base${index}`;
  for (const [overlayIndex, overlay] of scene.overlays.entries()) {
    const next = `overlay${index}_${overlayIndex}`;
    filters.push(`[${previous}][${overlayInputIndexes[overlayIndex]}:v]overlay=x=0:y=0:eof_action=repeat:enable='between(t,${seconds(overlay.startMs)},${seconds(overlay.endMs)})'[${next}]`);
    previous = next;
  }
  filters.push(`[${previous}]null[scene${index}]`);
  return filters;
}

function focusFilters(focus: Focus | undefined): string {
  if (!focus || focus.preset === "none") return "";
  const bounds = focus.bounds!;
  const x = (bounds.x * 1920).toFixed(3);
  const y = (bounds.y * 1080).toFixed(3);
  const width = (bounds.width * 1920).toFixed(3);
  const height = (bounds.height * 1080).toFixed(3);
  if (focus.preset === "box") return `,drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=0xF5C56B@0.9:thickness=6`;
  return `,crop=${width}:${height}:${x}:${y},scale=1920:1080`;
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

function sceneDurationSeconds(scene: RenderJobScene): number {
  return (scene.outMs - scene.inMs) / scene.speed / 1000;
}

function renderedDurationSeconds(scenes: RenderJobScene[]): number {
  return scenes.reduce((total, scene, index) => total + sceneDurationSeconds(scene) - (index && scenes[index - 1].transition.type === "crossfade" ? scenes[index - 1].transition.durationMs / 1000 : 0), 0);
}

function writeOverlayAssets(job: RenderJob, root: string): void {
  for (const overlay of job.scenes.flatMap((scene) => scene.overlays)) {
    const path = resolveProjectPath(root, overlay.assetPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, overlayPng(overlay));
  }
}

function overlayAssetPath(overlay: Pick<RenderJobOverlay, "id" | "kind" | "text" | "placement">): string {
  const id = overlay.id.replace(/[^A-Za-z0-9._-]/g, "_") || "overlay";
  const fingerprint = sha256(canonicalJson(overlay)).slice(0, 16);
  return `render-assets/${id}-${fingerprint}.png`;
}

function overlayPng(overlay: RenderJobOverlay): Buffer {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.alloc(width * height * 4);
  const y = overlay.placement === "bottom" ? 892 : overlay.placement === "target" ? 476 : 72;
  const background: [number, number, number] = overlay.kind === "title" ? [17, 24, 39] : [245, 197, 107];
  const foreground: [number, number, number] = overlay.kind === "title" ? [255, 255, 255] : [17, 24, 39];
  drawRect(pixels, width, 160, y, 1600, 128, background);
  drawText(pixels, width, overlay.text, y + 36, foreground);
  return png(width, height, pixels);
}

function drawRect(pixels: Buffer, width: number, x: number, y: number, rectangleWidth: number, rectangleHeight: number, color: [number, number, number]): void {
  for (let row = y; row < y + rectangleHeight; row += 1) for (let column = x; column < x + rectangleWidth; column += 1) setPixel(pixels, width, column, row, color);
}

function drawText(pixels: Buffer, width: number, value: string, y: number, color: [number, number, number]): void {
  const glyphs = value.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").slice(0, 35).split("");
  const scale = 8;
  const characterWidth = 6 * scale;
  let x = Math.max(192, Math.floor((1920 - glyphs.length * characterWidth) / 2));
  for (const character of glyphs) {
    for (const [row, line] of (FONT[character] ?? FONT[" "]).entries()) for (const [column, bit] of [...line].entries()) if (bit === "1") drawRect(pixels, width, x + column * scale, y + row * scale, scale, scale, color);
    x += characterWidth;
  }
}

function setPixel(pixels: Buffer, width: number, x: number, y: number, color: [number, number, number]): void {
  const index = (y * width + x) * 4;
  pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = 255;
}

function png(width: number, height: number, pixels: Buffer): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) pixels.copy(rows, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", Buffer.from([0, 0, 7, 128, 0, 0, 4, 56, 8, 6, 0, 0, 0])), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0); body.copy(chunk, 4); chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"], C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"], D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"], E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"], G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"], I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"], J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"], K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"], L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"], M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"], O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"], Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"], R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"], S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"], U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"], W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"], X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"], Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"], "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"], "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"], "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"], "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"], "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"], " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
