import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectSchema, transitionAdjustedDurationMs, type Focus, type Overlay, type Project, type RenderOutput, type Scene, type Transition } from "./schema.js";
import { semanticHash } from "./project.js";
import { canonicalJson } from "./canonical-json.js";
import { loadVerificationResult } from "./verify.js";

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
  const { sha256: _jobSha256, ...unsignedJob } = job;
  if (sha256(canonicalJson(unsignedJob)) !== job.sha256) throw new Error("render job hash does not match its declared plan");
  const project = options.project ?? readProjectForRender(root);
  if (project.currentRevisionId !== job.revisionId) throw new Error("render job revision is not the current project revision");
  if (job.revisionSha256 !== semanticHash(project)) throw new Error("render job is stale for the current revision manifest");
  for (const scene of job.scenes) {
    const sourcePath = resolveProjectPath(root, scene.sourcePath);
    if (sha256File(sourcePath) !== scene.sourceSha256) throw new Error(`render source changed since verification: ${scene.sceneId}`);
  }
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
    })),
    transition: scene.transition,
  };
}

function buildFfmpegArgv(job: RenderJob, root: string, temporary: string): string[] {
  const sourceInputs = job.scenes.flatMap((scene) => ["-ss", seconds(scene.inMs), "-t", seconds(scene.outMs - scene.inMs), "-i", resolveProjectPath(root, scene.sourcePath)]);
  const totalSeconds = renderedDurationSeconds(job.scenes);
  const audioInput = job.scenes.length;
  const filters = job.scenes.flatMap((scene, index) => sceneFilters(scene, index));
  filters.push(...timelineFilters(job.scenes));
  return [
    "-y", ...sourceInputs,
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

function sceneFilters(scene: RenderJobScene, index: number): string[] {
  const input = `[${index}:v]setpts=(PTS-STARTPTS)/${scene.speed},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`;
  const filters: string[] = [];
  if (scene.focus?.preset === "zoom") {
    const { x, y, width, height } = scene.focus.bounds!;
    const start = seconds(scene.focus.startMs);
    const end = seconds(scene.focus.endMs);
    filters.push(`${input},split=2[plain${index}][zoomSource${index}]`);
    filters.push(`[zoomSource${index}]crop=${(width * 1920).toFixed(3)}:${(height * 1080).toFixed(3)}:${(x * 1920).toFixed(3)}:${(y * 1080).toFixed(3)},scale=1920:1080[zoom${index}]`);
    filters.push(`[plain${index}][zoom${index}]overlay=0:0:enable='between(t,${start},${end})'[base${index}]`);
  } else {
    filters.push(`${input}${focusFilters(scene.focus)}[base${index}]`);
  }
  let previous = `base${index}`;
  for (const [overlayIndex, overlay] of scene.overlays.entries()) {
    const next = `overlay${index}_${overlayIndex}`;
    const y = overlay.placement === "bottom" ? 892 : overlay.placement === "target" ? 476 : 72;
    const background = overlay.kind === "title" ? "0x111827@0.94" : "0xF5C56B@0.94";
    const foreground = overlay.kind === "title" ? "white" : "0x111827";
    const enable = `between(t,${seconds(overlay.startMs)},${seconds(overlay.endMs)})`;
    filters.push(`[${previous}]drawbox=x=160:y=${y}:w=1600:h=128:color=${background}:thickness=fill:enable='${enable}',drawtext=text='${escapeDrawtext(overlay.text)}':fontcolor=${foreground}:fontsize=48:x=(w-text_w)/2:y=${y + 34}:enable='${enable}'[${next}]`);
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
  const start = (focus.startMs / 1000).toFixed(3);
  const end = (focus.endMs / 1000).toFixed(3);
  if (focus.preset === "box") return `,drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=0xF5C56B@0.9:thickness=6:enable='between(t,${start},${end})'`;
  return `,crop=${width}:${height}:${x}:${y}:enable='between(t,${start},${end})',scale=1920:1080`;
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
  return transitionAdjustedDurationMs(scenes.map((scene) => ({
    durationMs: scene.outMs - scene.inMs,
    speed: scene.speed,
    transition: scene.transition,
  }))) / 1000;
}

function escapeDrawtext(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readProjectForRender(root: string): Project {
  try {
    return ProjectSchema.parse(JSON.parse(readFileSync(join(root, "project.json"), "utf8")));
  } catch {
    throw new Error("render requires the current project for hash binding: pass options.project or persist project.json first");
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
