import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { semanticHashV2 } from "./operations-v2.js";
import { AssetHandleSchema, CameraPushMotionPresetSchema, ProjectV2Schema, type AssetHandle, type ProjectV2 } from "./schema-v2.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInt = z.number().int().positive().finite();
const finite = z.number().finite();
export const MAX_MOTION_ARTIFACT_BYTES = 256 * 1024 * 1024;

const motionJobPayloadSchema = z.object({
  jobVersion: z.literal(1),
  projectId: z.string().min(1),
  sourceRevisionId: z.string().min(1),
  sourceRevisionHash: sha256Schema,
  target: z.object({
    clipId: z.string().min(1),
    assetId: z.string().min(1),
    assetHandle: AssetHandleSchema,
    source: z.object({ width: positiveInt, height: positiveInt, durationMs: positiveInt }).strict(),
    sourceInMs: z.number().int().nonnegative(),
    sourceOutMs: positiveInt,
    speed: z.number().finite().min(0.25).max(4),
  }).strict(),
  composition: z.object({ fps: z.number().finite().min(1).max(60) }).strict(),
  preset: z.object({ presetId: z.literal("camera-push"), presetVersion: z.literal("1"), strength: z.number().finite().min(0.02).max(0.08) }).strict(),
  output: z.object({ width: positiveInt, height: positiveInt, fps: z.number().finite().min(1).max(60), frameCount: positiveInt, durationMs: finite.positive() }).strict(),
}).strict();

type MotionJobPayload = z.infer<typeof motionJobPayloadSchema>;
type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly unknown[] ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type MotionExecutionJobV1 = DeepReadonly<MotionJobPayload & { jobHash: string }>;

export interface MotionResolvedAssetHandle extends AssetHandle { path: string }
export interface MotionExecutionAuthorization {
  projectRoot: string;
  resolvedHandles: readonly MotionResolvedAssetHandle[];
  isRevisionCurrent: (revisionId: string, semanticHash: string) => boolean | Promise<boolean>;
}
export interface MotionExecutionOptions {
  /** Host-owned path to a trusted native direct FFmpeg binary; wrappers are unsupported because cancellation drains this child process. */
  ffmpegPath?: string;
  /** Host-owned path to a trusted native direct FFprobe binary. */
  ffprobePath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const motionArtifactHandleSchema = z.object({
  artifactId: z.string().uuid(),
  ref: z.string().regex(/^\.replex-staging\/motion\/jobs\/[0-9a-f-]{36}\/motion\.mp4$/),
  sha256: sha256Schema,
  motionJobHash: sha256Schema,
  sourceRevisionId: z.string().min(1),
  sourceRevisionHash: sha256Schema,
  targetClipId: z.string().min(1),
  sourceAssetId: z.string().min(1),
}).strict();
export type MotionArtifactHandle = Readonly<z.infer<typeof motionArtifactHandleSchema>>;

interface IssuedArtifact {
  projectRoot: string;
  path: string;
  stagingDirectory: string;
  directoryDevice: number;
  directoryInode: number;
}
const issuedArtifacts = new WeakMap<object, IssuedArtifact>();

export interface MotionExecutionResult {
  artifactRef: string;
  artifactSha256: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationMs: number;
  sampleAspectRatio: string;
  pixelFormat: string;
  alphaMode: "none";
  audioPresent: false;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  backendId: "native-ffmpeg-motion";
  backendVersion: string;
  ffmpegVersion: string;
  presetId: "camera-push";
  presetVersion: "1";
  sourceRevisionId: string;
  sourceRevisionHash: string;
  sourceAssetId: string;
  motionJobHash: string;
  verification: {
    id: string;
    status: "passed";
    evidenceRef: string;
    evidenceSha256: string;
    checks: { probe: true; decode: true; hash: true };
  };
}

export interface MotionBackend {
  readonly id: "native-ffmpeg-motion";
  execute(job: MotionExecutionJobV1, authorization: MotionExecutionAuthorization, options?: MotionExecutionOptions): Promise<{ job: MotionExecutionJobV1; handle: MotionArtifactHandle; result: MotionExecutionResult }>;
}

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value as DeepReadonly<T>;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function pathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

function numberText(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function seconds(milliseconds: number): string {
  return numberText(milliseconds / 1000);
}

export function buildMotionExecutionJobV1(projectInput: ProjectV2, targetClipId: string, handleInput: AssetHandle): MotionExecutionJobV1 {
  const project = ProjectV2Schema.parse(projectInput);
  const preset = (project.composition.motionPresets ?? []).find(({ targetId }) => targetId === targetClipId);
  if (!preset) throw new Error("camera-push motion preset is not active for this clip");
  const parsedPreset = CameraPushMotionPresetSchema.parse(preset);
  const clip = project.composition.clips.find(({ id }) => id === targetClipId);
  if (!clip) throw new Error("camera-push target clip does not exist");
  const asset = project.assets[clip.assetId];
  const track = project.composition.tracks.find(({ id }) => id === clip.trackId);
  if (!asset || !["uploaded_video", "browser_capture"].includes(asset.type) || !track || track.kind !== "video") throw new Error("camera-push requires a video clip");
  const source = { width: asset.probe.width, height: asset.probe.height, durationMs: asset.probe.durationMs };
  if (!source.width || !source.height || source.width > 4096 || source.height > 4096 || source.width * source.height > 16_777_216
    || !source.durationMs || clip.sourceOutMs > source.durationMs || project.composition.durationMs > 120_000) {
    throw new Error("camera-push source or composition exceeds the local motion limits");
  }
  const handle = AssetHandleSchema.parse(handleInput);
  if (handle.assetId !== asset.id || handle.sha256 !== asset.sha256 || handle.ref !== (asset.path ?? asset.objectRef)) throw new Error("authorized asset handle does not match the selected immutable video");
  const revision = project.revisions.find(({ id }) => id === project.currentRevisionId);
  const sourceRevisionHash = semanticHashV2(project);
  if (!revision || revision.manifestSha256 !== sourceRevisionHash) throw new Error("current revision manifest hash does not match semantic project state");
  const frameCount = Math.max(1, Math.round(((clip.sourceOutMs - clip.sourceInMs) / clip.speed) * project.composition.fps / 1000));
  const durationMs = frameCount * 1000 / project.composition.fps;
  const payload = motionJobPayloadSchema.parse({
    jobVersion: 1,
    projectId: project.projectId,
    sourceRevisionId: project.currentRevisionId,
    sourceRevisionHash,
    target: {
      clipId: clip.id,
      assetId: asset.id,
      assetHandle: handle,
      source,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
    },
    composition: { fps: project.composition.fps },
    preset: { presetId: parsedPreset.presetId, presetVersion: parsedPreset.presetVersion, strength: parsedPreset.parameters.strength },
    output: { width: source.width, height: source.height, fps: project.composition.fps, frameCount, durationMs },
  });
  return freezeDeep({ ...payload, jobHash: digest(canonicalJson(payload)) }) as MotionExecutionJobV1;
}

function assertMotionJob(job: MotionExecutionJobV1): MotionJobPayload {
  const { jobHash, ...payloadInput } = job;
  const payload = motionJobPayloadSchema.parse(payloadInput);
  if (digest(canonicalJson(payload)) !== jobHash) throw new Error("motion execution job hash does not match its frozen plan");
  const { target, composition, output } = payload;
  const frameCount = Math.max(1, Math.round(((target.sourceOutMs - target.sourceInMs) / target.speed) * composition.fps / 1000));
  const durationMs = frameCount * 1000 / composition.fps;
  if (target.source.width > 4096 || target.source.height > 4096 || target.source.width * target.source.height > 16_777_216
    || target.sourceInMs >= target.sourceOutMs || target.sourceOutMs > target.source.durationMs
    || output.width !== target.source.width || output.height !== target.source.height || output.fps !== composition.fps
    || output.frameCount !== frameCount || output.frameCount > 7_200 || output.durationMs !== durationMs || output.durationMs > 120_000) {
    throw new Error("motion execution job does not match its canonical trim and output semantics");
  }
  return payload;
}

async function checkedSourcePath(rootInput: string, resolved: MotionResolvedAssetHandle | undefined, expected: AssetHandle): Promise<string> {
  if (!resolved || resolved.assetId !== expected.assetId || resolved.sha256 !== expected.sha256 || resolved.ref !== expected.ref) throw new Error("authorized motion source handle was not resolved for this job");
  const root = await realpath(rootInput);
  const pathRef = resolve(root, ...expected.ref.replace(/\\/g, "/").split("/"));
  const path = resolve(resolved.path);
  if (!pathInside(root, pathRef) || pathRef !== path || !pathInside(root, path)) throw new Error("authorized motion source escapes the project root");
  const [realFile, fileInfo, linkInfo] = await Promise.all([realpath(path), stat(path), lstat(path)]);
  if (!pathInside(root, realFile) || !fileInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.nlink !== 1) throw new Error("authorized motion source is not a regular project media file");
  if (await digestFile(realFile) !== expected.sha256) throw new Error("motion source bytes changed since the job was planned");
  return realFile;
}

async function verifyCurrent(job: MotionJobPayload, authorization: MotionExecutionAuthorization, sourcePath: string, boundary: string): Promise<void> {
  const resolved = authorization.resolvedHandles.find(({ assetId }) => assetId === job.target.assetId);
  const currentSource = await checkedSourcePath(authorization.projectRoot, resolved, job.target.assetHandle);
  if (currentSource !== sourcePath || !await authorization.isRevisionCurrent(job.sourceRevisionId, job.sourceRevisionHash)) {
    throw new Error(`motion execution revision or source changed ${boundary}`);
  }
}

async function containedDirectory(root: string, relativePath: string): Promise<string> {
  let directory = root;
  for (const part of relativePath.split(/[\\/]+/).filter(Boolean)) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !pathInside(root, actual)) throw new Error("motion staging directory escapes the project root");
    directory = actual;
  }
  return directory;
}

interface ProcessResult { stdout: string; stderr: string }
function runProcess(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal, outputLimit = 1024 * 1024): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(new Error("motion execution was cancelled"));
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try { child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { rejectPromise(new Error("motion backend could not start")); return; }
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener("abort", cancel);
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const cancel = () => stop(new Error("motion execution was cancelled"));
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = target === "stdout" ? stdout + chunk.toString("utf8") : stderr + chunk.toString("utf8");
      if (Buffer.byteLength(next) > outputLimit) stop(new Error("motion backend output exceeded its limit"));
      else if (target === "stdout") stdout = next;
      else stderr = next;
    };
    const timer = setTimeout(() => stop(new Error("motion execution timed out")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(failure ?? new Error("motion backend could not start"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) rejectPromise(failure);
      else if (code !== 0) rejectPromise(new Error("motion backend execution failed"));
      else resolvePromise({ stdout, stderr });
    });
  });
}

function buildCameraPushArgs(job: MotionJobPayload, sourcePath: string, outputPath: string, sampleAspectRatio: string): string[] {
  const { width, height, fps, frameCount } = job.output;
  const denominator = Math.max(1, frameCount - 1);
  const strength = numberText(job.preset.strength);
  const filter = `[0:v]trim=start=${seconds(job.target.sourceInMs)}:end=${seconds(job.target.sourceOutMs)},setpts=(PTS-STARTPTS)/${numberText(job.target.speed)},fps=${numberText(fps)},setsar=${sampleAspectRatio.replace(":", "/")},zoompan=z='1+${strength}*on/${denominator}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${numberText(fps)},trim=end_frame=${frameCount},setpts=PTS-STARTPTS,setsar=${sampleAspectRatio.replace(":", "/")},format=yuv444p[out]`;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-filter_complex_threads", "1", "-filter_complex", filter, "-map", "[out]", "-an",
    "-frames:v", String(frameCount), "-r", numberText(fps), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "1", "-pix_fmt", "yuv444p",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-metadata", "creation_time=1970-01-01T00:00:00Z", "-movflags", "+faststart",
    "-fs", String(MAX_MOTION_ARTIFACT_BYTES), outputPath,
  ];
}

interface MotionProbe {
  width: number; height: number; fps: number; frameCount: number; durationMs: number; codec: string; pixelFormat: string;
  sampleAspectRatio: string;
  colorSpace?: string; colorTransfer?: string; colorPrimaries?: string; hasAudio: boolean;
}

function parseRate(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : Number(value) || 0;
}

async function probeSourceSar(path: string, job: MotionJobPayload, ffprobePath: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const response = await runProcess(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", path], timeoutMs, signal, 64 * 1024);
  let parsed: { streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string }> };
  try { parsed = JSON.parse(response.stdout) as typeof parsed; } catch { throw new Error("motion source probe returned malformed data"); }
  const source = parsed.streams?.[0];
  if (!source || source.width !== job.target.source.width || source.height !== job.target.source.height) throw new Error("motion source dimensions differ from the frozen source facts");
  const sar = source.sample_aspect_ratio === "N/A" || source.sample_aspect_ratio === undefined ? "1:1" : source.sample_aspect_ratio;
  if (!/^\d{1,5}:\d{1,5}$/.test(sar)) throw new Error("motion source sample aspect ratio is unsupported");
  const [numerator, denominator] = sar.split(":").map(Number);
  if (!numerator || !denominator || numerator > 1000 || denominator > 1000) throw new Error("motion source sample aspect ratio is outside the local limit");
  return sar;
}

async function verifyIntermediate(path: string, job: MotionJobPayload, expectedSar: string, ffprobePath: string, ffmpegPath: string, timeoutMs: number, signal?: AbortSignal): Promise<{ probe: MotionProbe; sha256: string; size: number }> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > MAX_MOTION_ARTIFACT_BYTES) throw new Error("motion artifact is unsafe or exceeds its size limit");
  const response = await runProcess(ffprobePath, [
    "-v", "error", "-count_frames", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,nb_read_frames,pix_fmt,sample_aspect_ratio,color_space,color_transfer,color_primaries", "-of", "json", path,
  ], timeoutMs, signal, 128 * 1024);
  let parsed: { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  try { parsed = JSON.parse(response.stdout) as typeof parsed; } catch { throw new Error("motion artifact probe returned malformed data"); }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  const durationSeconds = Number(parsed.format?.duration);
  const frameCount = Number(video?.nb_read_frames ?? video?.nb_frames);
  const fps = parseRate(video?.avg_frame_rate);
  if (!video || video.width !== job.output.width || video.height !== job.output.height || video.codec_name !== "h264"
    || video.pix_fmt !== "yuv444p" || video.sample_aspect_ratio !== expectedSar || audio || frameCount !== job.output.frameCount || Math.abs(fps - job.output.fps) > 0.01
    || !Number.isFinite(durationSeconds) || Math.abs(durationSeconds * 1000 - job.output.durationMs) > 1500 / job.output.fps) {
    throw new Error("motion artifact does not meet its frozen output requirements");
  }
  await runProcess(ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"], timeoutMs, signal, 128 * 1024);
  const hash = await digestFile(path);
  const final = await lstat(path);
  if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size) throw new Error("motion artifact changed while being verified");
  return {
    probe: {
      width: video.width as number, height: video.height as number, fps, frameCount,
      durationMs: Math.round(durationSeconds * 1000), codec: video.codec_name, pixelFormat: video.pix_fmt,
      sampleAspectRatio: expectedSar,
      ...(typeof video.color_space === "string" ? { colorSpace: video.color_space } : {}),
      ...(typeof video.color_transfer === "string" ? { colorTransfer: video.color_transfer } : {}),
      ...(typeof video.color_primaries === "string" ? { colorPrimaries: video.color_primaries } : {}),
      hasAudio: audio,
    },
    sha256: hash,
    size: final.size,
  };
}

export async function executeMotionExecutionJob(
  job: MotionExecutionJobV1,
  authorization: MotionExecutionAuthorization,
  options: MotionExecutionOptions = {},
): Promise<{ job: MotionExecutionJobV1; handle: MotionArtifactHandle; result: MotionExecutionResult }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("motion execution timeout is outside the supported range");
  const payload = assertMotionJob(job);
  if (!await authorization.isRevisionCurrent(payload.sourceRevisionId, payload.sourceRevisionHash)) throw new Error("motion execution job revision is no longer current");
  const resolved = authorization.resolvedHandles.find(({ assetId }) => assetId === payload.target.assetId);
  const sourcePath = await checkedSourcePath(authorization.projectRoot, resolved, payload.target.assetHandle);
  const root = await realpath(authorization.projectRoot);
  const jobsRoot = await containedDirectory(root, ".replex-staging/motion/jobs");
  const artifactId = randomUUID();
  const stagingDirectory = join(jobsRoot, artifactId);
  await mkdir(stagingDirectory, { mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  const stagedPath = join(stagingDirectory, "motion.mp4");
  const evidencePath = join(stagingDirectory, "verification.json");
  let durableReceiptDirectory: string | undefined;
  try {
    const ffmpegPath = options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
    const ffprobePath = options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
    const sampleAspectRatio = await probeSourceSar(sourcePath, payload, ffprobePath, timeoutMs, options.signal);
    await runProcess(ffmpegPath, buildCameraPushArgs(payload, sourcePath, stagedPath, sampleAspectRatio), timeoutMs, options.signal, 1024 * 1024);
    const verified = await verifyIntermediate(stagedPath, payload, sampleAspectRatio, ffprobePath, ffmpegPath, timeoutMs, options.signal);
    const version = await runProcess(ffmpegPath, ["-version"], timeoutMs, options.signal, 32 * 1024);
    const ffmpegVersion = version.stdout.split(/\r?\n/, 1)[0]?.trim();
    if (!ffmpegVersion) throw new Error("motion backend did not report its version");
    await verifyCurrent(payload, authorization, sourcePath, "before returning the verified intermediate");
    const artifactRef = `.replex-staging/motion/jobs/${artifactId}/motion.mp4`;
    const receiptRoot = await containedDirectory(root, ".replex-evidence/motion/receipts");
    durableReceiptDirectory = join(receiptRoot, artifactId);
    await mkdir(durableReceiptDirectory, { mode: 0o700 });
    await chmod(durableReceiptDirectory, 0o700);
    const evidenceRef = `.replex-evidence/motion/receipts/${artifactId}/verification.json`;
    const verification = {
      version: 1,
      status: "passed",
      sourceAssetId: payload.target.assetId,
      sourceAssetSha256: payload.target.assetHandle.sha256,
      targetClipId: payload.target.clipId,
      preset: { presetId: payload.preset.presetId, presetVersion: payload.preset.presetVersion, parameters: { strength: payload.preset.strength } },
      sourceRevisionId: payload.sourceRevisionId,
      sourceRevisionHash: payload.sourceRevisionHash,
      motionJobHash: job.jobHash,
      artifactRef,
      artifactSha256: verified.sha256,
      probe: verified.probe,
      backend: { id: "native-ffmpeg-motion", version: "1", ffmpegVersion },
      checks: { probe: true, decode: true, hash: true },
    };
    const evidenceBytes = `${canonicalJson(verification)}\n`;
    await writeFile(evidencePath, evidenceBytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(durableReceiptDirectory, "verification.json"), evidenceBytes, { flag: "wx", mode: 0o600 });
    const handle = Object.freeze(motionArtifactHandleSchema.parse({
      artifactId, ref: artifactRef, sha256: verified.sha256, motionJobHash: job.jobHash,
      sourceRevisionId: payload.sourceRevisionId, sourceRevisionHash: payload.sourceRevisionHash,
      targetClipId: payload.target.clipId, sourceAssetId: payload.target.assetId,
    }));
    const directoryInfo = await lstat(stagingDirectory);
    issuedArtifacts.set(handle, { projectRoot: root, path: stagedPath, stagingDirectory, directoryDevice: directoryInfo.dev, directoryInode: directoryInfo.ino });
    const result: MotionExecutionResult = {
      artifactRef, artifactSha256: verified.sha256,
      width: verified.probe.width, height: verified.probe.height, fps: verified.probe.fps, frameCount: verified.probe.frameCount, durationMs: verified.probe.durationMs,
      sampleAspectRatio: verified.probe.sampleAspectRatio,
      pixelFormat: verified.probe.pixelFormat, alphaMode: "none", audioPresent: false,
      ...(verified.probe.colorSpace ? { colorSpace: verified.probe.colorSpace } : {}),
      ...(verified.probe.colorTransfer ? { colorTransfer: verified.probe.colorTransfer } : {}),
      ...(verified.probe.colorPrimaries ? { colorPrimaries: verified.probe.colorPrimaries } : {}),
      backendId: "native-ffmpeg-motion", backendVersion: "1", ffmpegVersion,
      presetId: payload.preset.presetId, presetVersion: payload.preset.presetVersion,
      sourceRevisionId: payload.sourceRevisionId, sourceRevisionHash: payload.sourceRevisionHash, sourceAssetId: payload.target.assetId,
      motionJobHash: job.jobHash,
      verification: {
        id: `motion-verification-${job.jobHash.slice(0, 24)}-${artifactId.slice(0, 8)}`,
        status: "passed", evidenceRef, evidenceSha256: digest(evidenceBytes), checks: { probe: true, decode: true, hash: true },
      },
    };
    return { job, handle, result };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (durableReceiptDirectory) await rm(durableReceiptDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function assertIssuedMotionArtifactHandle(input: unknown): MotionArtifactHandle {
  const parsed = motionArtifactHandleSchema.parse(input);
  if (!input || typeof input !== "object" || issuedArtifacts.get(input as object) === undefined) throw new Error("motion artifact handle was not issued by the motion executor");
  return parsed as MotionArtifactHandle;
}

export async function resolveMotionArtifactHandle(input: MotionArtifactHandle, projectRoot: string): Promise<string> {
  const handle = assertIssuedMotionArtifactHandle(input);
  const issued = issuedArtifacts.get(input as object)!;
  const root = await realpath(projectRoot);
  if (root !== issued.projectRoot) throw new Error("motion artifact handle belongs to a different project root");
  const expectedPath = resolve(root, ...handle.ref.replace(/\\/g, "/").split("/"));
  if (expectedPath !== issued.path || !pathInside(root, issued.path)) throw new Error("motion artifact reference escapes its authorized staging root");
  const stageRoot = await realpath(join(root, ".replex-staging", "motion", "jobs"));
  const [stageInfo, directoryInfo, fileReal, fileInfo, linkInfo] = await Promise.all([
    lstat(stageRoot), lstat(issued.stagingDirectory), realpath(issued.path), stat(issued.path), lstat(issued.path),
  ]);
  if (!pathInside(stageRoot, issued.stagingDirectory) || !pathInside(issued.stagingDirectory, fileReal)
    || !stageInfo.isDirectory() || stageInfo.isSymbolicLink()
    || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.dev !== issued.directoryDevice || directoryInfo.ino !== issued.directoryInode
    || !fileInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.nlink !== 1 || fileInfo.size > MAX_MOTION_ARTIFACT_BYTES) {
    throw new Error("motion artifact handle is unsafe or outside its private staging root");
  }
  if (await digestFile(fileReal) !== handle.sha256) throw new Error("motion artifact bytes changed after verification");
  return fileReal;
}

export async function cleanupMotionArtifact(input: MotionArtifactHandle): Promise<void> {
  const handle = assertIssuedMotionArtifactHandle(input);
  const issued = issuedArtifacts.get(input as object)!;
  const directoryInfo = await lstat(issued.stagingDirectory).catch(() => undefined);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.dev !== issued.directoryDevice || directoryInfo.ino !== issued.directoryInode) {
    throw new Error("motion artifact staging directory changed before cleanup");
  }
  const stageRootPath = join(issued.projectRoot, ".replex-staging", "motion", "jobs");
  const [stageRootInfo, stageRoot, realDirectory] = await Promise.all([lstat(stageRootPath), realpath(stageRootPath), realpath(issued.stagingDirectory)]);
  if (!stageRootInfo.isDirectory() || stageRootInfo.isSymbolicLink() || !pathInside(issued.projectRoot, stageRoot) || !pathInside(stageRoot, realDirectory)) {
    throw new Error("motion artifact cleanup path escapes its private staging root");
  }
  await rm(issued.stagingDirectory, { recursive: true, force: true });
  issuedArtifacts.delete(input as object);
}

export const nativeFfmpegMotionBackend: MotionBackend = Object.freeze({ id: "native-ffmpeg-motion", execute: executeMotionExecutionJob });
