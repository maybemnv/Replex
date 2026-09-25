import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AssetHandleSchema, type AssetHandle } from "./schema-v2.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRefSchema = z.string().regex(/^assets\/[a-f0-9]{24}\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/(?:index\.json|(?:probe|selected-frame|contact-sheet|scene-boundaries|audio-summary)-[a-f0-9]{64}\.(?:json|png|jpg))$/);
const MediaEvidenceArtifactSchema = z.object({
  kind: z.enum(["probe", "selected_frame", "contact_sheet", "scene_boundaries", "audio_summary"]),
  ref: evidenceRefSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(8 * 1024 * 1024),
  contentType: z.enum(["application/json", "image/png", "image/jpeg"]),
  timestampMs: z.number().int().nonnegative().optional(),
}).strict();

export const MediaEvidenceIndexSchema = z.object({
  version: z.literal(1),
  sourceAssetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  sourceSha256: sha256Schema,
  generator: z.literal("replex-native-media-evidence"),
  generatorVersion: z.literal("1"),
  configHash: sha256Schema,
  runHash: sha256Schema,
  indexRef: evidenceRefSchema,
  artifacts: z.array(MediaEvidenceArtifactSchema).max(12),
}).strict().superRefine((index, context) => {
  const selectedFrames = index.artifacts.filter((artifact) => artifact.kind === "selected_frame");
  if (selectedFrames.length > 4) context.addIssue({ code: "custom", path: ["artifacts"], message: "evidence may contain at most four selected frames" });
  if (index.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > 32 * 1024 * 1024) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "evidence artifact bytes exceed the configured limit" });
  }
  const runPrefix = index.indexRef.slice(0, -"index.json".length);
  if (index.artifacts.some((artifact) => !artifact.ref.startsWith(runPrefix))) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "evidence artifacts must belong to the indexed run" });
  }
});

export type MediaEvidenceArtifact = z.infer<typeof MediaEvidenceArtifactSchema>;
export type MediaEvidenceIndex = z.infer<typeof MediaEvidenceIndexSchema>;

export type MediaEvidenceErrorCode =
  | "INVALID_ASSET_HANDLE"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_HASH_MISMATCH"
  | "MEDIA_TOOLS_UNAVAILABLE"
  | "MEDIA_TOOL_FAILED"
  | "INVALID_TOOL_OUTPUT"
  | "TIMEOUT"
  | "OUTPUT_LIMIT"
  | "UNSAFE_EVIDENCE_ROOT"
  | "EVIDENCE_LIMIT_EXCEEDED"
  | "EVIDENCE_WRITE_FAILED";

export class MediaEvidenceError extends Error {
  constructor(readonly code: MediaEvidenceErrorCode) {
    super(code);
    this.name = "MediaEvidenceError";
  }
}

export interface GenerateMediaEvidenceRequest {
  asset: AssetHandle;
  /** Resolves a previously authorized handle to a private local input file. */
  resolveSource: (asset: AssetHandle) => Promise<string>;
  /** Absolute path to a Replex-owned evidence root. */
  evidenceRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Caller may shorten the job deadline; it cannot extend it beyond two minutes. */
  deadlineMs?: number;
}

type ToolResult = { stdout: string; stderr: string };
type EvidenceConfig = {
  generatorVersion: "1";
  ffmpegVersion: string;
  ffprobeVersion: string;
  selectedFrameFractions: number[];
  frameSize: [320, 180];
  contactSheetTileSize: [320, 180];
  sceneThreshold: 0.3;
  silenceThresholdDb: -50;
  silenceMinimumMs: 500;
  loudnessTarget: { integratedLufs: -16; truePeakDbtp: -1.5; rangeLufs: 11 };
};

const MAX_FRAMES = 4;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_SCENES = 128;
const MAX_SILENCE_SEGMENTS = 128;
const MAX_DEADLINE_MS = 120_000;
const PROCESS_DEADLINE_MS = 20_000;

/** Returns bounded, sanitized probe data. Unknown FFprobe keys never cross this boundary. */
export function parseMediaProbeOutput(value: string): {
  durationMs?: number;
  bitRateBps?: number;
  streams: Array<{
    index: number;
    type: "video" | "audio" | "subtitle" | "data" | "attachment";
    codec?: string;
    width?: number;
    height?: number;
    fps?: number;
    sampleRateHz?: number;
    channels?: number;
  }>;
} {
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_OUTPUT_BYTES) throw new MediaEvidenceError("OUTPUT_LIMIT");
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");
  }
  const rawSchema = z.object({
    streams: z.array(z.object({
      index: z.number().int().nonnegative(),
      codec_type: z.enum(["video", "audio", "subtitle", "data", "attachment"]),
      codec_name: z.string().max(64).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      avg_frame_rate: z.string().max(32).optional(),
      sample_rate: z.union([z.string().max(16), z.number().int().positive()]).optional(),
      channels: z.number().int().positive().optional(),
      duration: z.string().max(32).optional(),
    }).strict()).max(32),
    format: z.object({
      duration: z.string().max(32).optional(),
      bit_rate: z.string().max(32).optional(),
    }).strict().optional(),
  }).strict();
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success || parsed.data.streams.length === 0) throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");

  const durationSeconds = parseFiniteNumber(parsed.data.format?.duration)
    ?? parsed.data.streams.map((stream) => parseFiniteNumber(stream.duration)).find((duration) => duration !== undefined);
  const bitRateBps = parseFiniteNumber(parsed.data.format?.bit_rate);
  const streams = parsed.data.streams.map((stream) => ({
    index: stream.index,
    type: stream.codec_type,
    ...(safeCodec(stream.codec_name) ? { codec: stream.codec_name } : {}),
    ...(stream.width ? { width: stream.width } : {}),
    ...(stream.height ? { height: stream.height } : {}),
    ...(parseFrameRate(stream.avg_frame_rate) ? { fps: parseFrameRate(stream.avg_frame_rate) } : {}),
    ...(parseFiniteNumber(stream.sample_rate) ? { sampleRateHz: parseFiniteNumber(stream.sample_rate) } : {}),
    ...(stream.channels ? { channels: stream.channels } : {}),
  }));
  if (!streams.some((stream) => stream.type === "video" || stream.type === "audio")) throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");
  return {
    ...(durationSeconds !== undefined && durationSeconds > 0 ? { durationMs: Math.round(durationSeconds * 1000) } : {}),
    ...(bitRateBps !== undefined && bitRateBps > 0 ? { bitRateBps: Math.round(bitRateBps) } : {}),
    streams,
  };
}

export async function generateMediaEvidence(request: GenerateMediaEvidenceRequest): Promise<MediaEvidenceIndex> {
  const handle = AssetHandleSchema.safeParse(request.asset);
  if (!handle.success) throw new MediaEvidenceError("INVALID_ASSET_HANDLE");
  if (!isAbsolute(request.evidenceRoot)) throw new MediaEvidenceError("UNSAFE_EVIDENCE_ROOT");
  const startedAt = Date.now();
  const deadlineMs = Math.min(MAX_DEADLINE_MS, Math.max(1_000, request.deadlineMs ?? 60_000));

  let sourcePath: string;
  try {
    sourcePath = await realpath(await resolveWithDeadline(request.resolveSource(handle.data), startedAt, deadlineMs));
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error();
    if (sourceStat.size > MAX_SOURCE_BYTES) throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");
  } catch (error) {
    if (error instanceof MediaEvidenceError) throw error;
    throw new MediaEvidenceError("SOURCE_UNAVAILABLE");
  }
  try {
    let finalSourceHash: string;
    try {
      finalSourceHash = await hashFile(sourcePath, startedAt, deadlineMs);
    } catch (error) {
      if (error instanceof MediaEvidenceError) throw error;
      throw new MediaEvidenceError("SOURCE_UNAVAILABLE");
    }
    if (finalSourceHash !== handle.data.sha256) throw new MediaEvidenceError("SOURCE_HASH_MISMATCH");
  } catch (error) {
    if (error instanceof MediaEvidenceError) throw error;
    throw new MediaEvidenceError("SOURCE_UNAVAILABLE");
  }
  let rootReal: string;
  try {
    rootReal = await ensureRealDirectoryTree(request.evidenceRoot, startedAt, deadlineMs);
  } catch (error) {
    if (error instanceof MediaEvidenceError) throw error;
    throw new MediaEvidenceError("UNSAFE_EVIDENCE_ROOT");
  }

  const ffmpeg = request.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = request.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
  const run = (tool: string, args: string[], maxBuffer = MAX_TOOL_OUTPUT_BYTES): ToolResult => runTool(tool, args, startedAt, deadlineMs, maxBuffer);
  const ffmpegVersion = toolVersion(run(ffmpeg, ["-version"]), "ffmpeg");
  const ffprobeVersion = toolVersion(run(ffprobe, ["-version"]), "ffprobe");
  const probeOutput = run(ffprobe, [
    "-v", "error", "-show_entries",
    "format=duration,bit_rate:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels,duration",
    "-of", "json", sourcePath,
  ]).stdout;
  const probe = parseMediaProbeOutput(probeOutput);
  const hasVideo = probe.streams.some((stream) => stream.type === "video");
  const hasAudio = probe.streams.some((stream) => stream.type === "audio");
  if (!hasVideo && !hasAudio) throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");

  const config: EvidenceConfig = {
    generatorVersion: "1",
    ffmpegVersion,
    ffprobeVersion,
    selectedFrameFractions: [0.1, 0.35, 0.65, 0.9],
    frameSize: [320, 180],
    contactSheetTileSize: [320, 180],
    sceneThreshold: 0.3,
    silenceThresholdDb: -50,
    silenceMinimumMs: 500,
    loudnessTarget: { integratedLufs: -16, truePeakDbtp: -1.5, rangeLufs: 11 },
  };
  const configHash = sha256(stableJson(config));
  const assetKey = sha256(handle.data.assetId).slice(0, 24);
  const baseRef = `assets/${assetKey}/${handle.data.sha256}/${configHash}`;

  let basePath: string;
  let stagePath: string | undefined;
  try {
    basePath = await ensureEvidenceDirectory(rootReal, baseRef, startedAt, deadlineMs);
    stagePath = await mkdtemp(join(basePath, ".stage-"));
    const stageReal = await realpath(stagePath);
    if (!isWithin(rootReal, stageReal) || !samePath(stagePath, stageReal)) throw new MediaEvidenceError("UNSAFE_EVIDENCE_ROOT");
    const stageRoot = stagePath;

    const artifactFiles: Array<{ kind: MediaEvidenceArtifact["kind"]; filename: string; contentType: MediaEvidenceArtifact["contentType"]; timestampMs?: number }> = [];
    const probeFile = "probe.json";
    await writeJson(stagePath, probeFile, probe);
    artifactFiles.push({ kind: "probe", filename: probeFile, contentType: "application/json" });

    if (hasVideo) {
      const times = sampleTimes(probe.durationMs);
      const framePaths: string[] = [];
      for (const [index, timestampMs] of times.entries()) {
        const filename = `selected-${index}.png`;
        const outputPath = join(stagePath, filename);
        run(ffmpeg, [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", seconds(timestampMs), "-i", sourcePath,
          "-frames:v", "1", "-an", "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,format=rgb24",
          "-f", "image2", outputPath,
        ], 256 * 1024);
        framePaths.push(outputPath);
        artifactFiles.push({ kind: "selected_frame", filename, contentType: "image/png", timestampMs });
      }

      const contactFilename = "contact-sheet.jpg";
      if (framePaths.length === 1) {
        run(ffmpeg, [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", framePaths[0],
          "-frames:v", "1", "-q:v", "2", "-f", "image2", join(stageRoot, contactFilename),
        ], 256 * 1024);
        artifactFiles.push({ kind: "contact_sheet", filename: contactFilename, contentType: "image/jpeg" });
      } else {
        const columns = Math.ceil(Math.sqrt(framePaths.length));
        const layout = framePaths.map((_, index) => `${(index % columns) * 320}_${Math.floor(index / columns) * 180}`).join("|");
        run(ffmpeg, [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
          ...framePaths.flatMap((path) => ["-i", path]),
          "-filter_complex", `xstack=inputs=${framePaths.length}:layout=${layout}:shortest=1`,
          "-frames:v", "1", "-q:v", "2", "-f", "image2", join(stagePath, contactFilename),
        ], 256 * 1024);
        artifactFiles.push({ kind: "contact_sheet", filename: contactFilename, contentType: "image/jpeg" });
      }

      if (probe.durationMs !== undefined) {
        const scenesLog = run(ffmpeg, [
          "-hide_banner", "-nostdin", "-loglevel", "info", "-i", sourcePath,
          "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-",
        ]).stderr;
        const scenes = parseSceneBoundaries(scenesLog, probe.durationMs);
        const filename = "scene-boundaries.json";
        await writeJson(stagePath, filename, scenes);
        artifactFiles.push({ kind: "scene_boundaries", filename, contentType: "application/json" });
      }
    }

    if (hasAudio) {
      const audio = await analyzeAudio(run, ffmpeg, sourcePath, probe.durationMs);
      const filename = "audio-summary.json";
      await writeJson(stagePath, filename, audio);
      artifactFiles.push({ kind: "audio_summary", filename, contentType: "application/json" });
    }

    const artifacts = await Promise.all(artifactFiles.map(async (artifact): Promise<MediaEvidenceArtifact> => {
      const path = join(stageRoot, artifact.filename);
      const info = await stat(path);
      if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");
      return {
        kind: artifact.kind,
        ref: "", // Replaced after the content-addressed run directory is known.
        sha256: await hashFile(path, startedAt, deadlineMs),
        sizeBytes: info.size,
        contentType: artifact.contentType,
        ...(artifact.timestampMs !== undefined ? { timestampMs: artifact.timestampMs } : {}),
      };
    }));
    if (artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");
    }
    if (await hashFile(sourcePath, startedAt, deadlineMs) !== handle.data.sha256) throw new MediaEvidenceError("SOURCE_HASH_MISMATCH");

    const runHash = sha256(stableJson({
      configHash,
      sourceAssetId: handle.data.assetId,
      sourceSha256: handle.data.sha256,
      artifacts: artifacts.map(({ kind, sha256: hash, sizeBytes, contentType, timestampMs }) => ({ kind, sha256: hash, sizeBytes, contentType, ...(timestampMs !== undefined ? { timestampMs } : {}) })),
    }));
    const runRef = `${baseRef}/${runHash}`;
    const indexedArtifacts = artifacts.map((artifact, index) => ({
      ...artifact,
      ref: `${runRef}/${artifactFiles[index].kind.replaceAll("_", "-")}-${artifact.sha256}.${extensionFor(artifact.contentType)}`,
    }));
    const index = MediaEvidenceIndexSchema.parse({
      version: 1,
      sourceAssetId: handle.data.assetId,
      sourceSha256: handle.data.sha256,
      generator: "replex-native-media-evidence",
      generatorVersion: "1",
      configHash,
      runHash,
      indexRef: `${runRef}/index.json`,
      artifacts: indexedArtifacts,
    });
    const indexContents = `${stableJson(index)}\n`;
    if (Buffer.byteLength(indexContents, "utf8") > 64 * 1024) throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");

    const publishedNames = new Set<string>();
    for (const [index, artifact] of indexedArtifacts.entries()) {
      const filename = artifact.ref.slice(`${runRef}/`.length);
      const source = join(stageRoot, artifactFiles[index].filename);
      const destination = join(stageRoot, filename);
      if (source !== destination) {
        if (publishedNames.has(filename)) await rm(source, { force: true });
        else await rename(source, destination);
        publishedNames.add(filename);
      }
    }
    await writeFile(join(stageRoot, "index.json"), indexContents, { flag: "wx" });
    const finalPath = join(basePath, runHash);
    try {
      await rename(stageRoot, finalPath);
      stagePath = undefined;
    } catch {
      const existingIndex = await readFile(join(finalPath, "index.json"), "utf8").catch(() => undefined);
      if (existingIndex !== indexContents) throw new MediaEvidenceError("EVIDENCE_WRITE_FAILED");
      await rm(stageRoot, { recursive: true, force: true });
      stagePath = undefined;
    }
    return index;
  } catch (error) {
    if (error instanceof MediaEvidenceError) throw error;
    throw new MediaEvidenceError("EVIDENCE_WRITE_FAILED");
  } finally {
    if (stagePath) await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function analyzeAudio(
  run: (tool: string, args: string[], maxBuffer?: number) => ToolResult,
  ffmpeg: string,
  sourcePath: string,
  durationMs?: number,
): Promise<{ version: 1; silenceThresholdDb: -50; peakDbfs: number | null; meanDbfs: number | null; silenceSegments: Array<{ startMs: number; endMs: number | null }>; loudness: { integratedLufs: number | null; truePeakDbtp: number | null; rangeLufs: number | null } }> {
  const measurements = run(ffmpeg, [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-i", sourcePath,
    "-af", "silencedetect=noise=-50dB:d=0.5,volumedetect", "-vn", "-f", "null", "-",
  ]).stderr;
  const loudnessOutput = run(ffmpeg, [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-i", sourcePath,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-vn", "-f", "null", "-",
  ]).stderr;
  const peak = measurementDb(measurements, "max_volume");
  const mean = measurementDb(measurements, "mean_volume");
  if (peak === undefined || mean === undefined) throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");
  const silenceSegments = parseSilenceSegments(measurements, durationMs);
  const loudness = parseLoudness(loudnessOutput);
  return {
    version: 1,
    silenceThresholdDb: -50,
    peakDbfs: peak,
    meanDbfs: mean,
    silenceSegments,
    loudness,
  };
}

function parseSceneBoundaries(log: string, durationMs: number): { version: 1; threshold: 0.3; boundariesMs: number[] } {
  const cuts = [...log.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Math.round(Number(match[1]) * 1000))
    .filter((time) => time > 0 && time < durationMs);
  const boundariesMs = [...new Set([0, ...cuts, durationMs])].sort((left, right) => left - right);
  if (boundariesMs.length - 1 > MAX_SCENES) throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");
  return { version: 1, threshold: 0.3, boundariesMs };
}

function parseSilenceSegments(log: string, durationMs?: number): Array<{ startMs: number; endMs: number | null }> {
  const events = [...log.matchAll(/silence_(start|end):\s*(-?(?:\d+(?:\.\d+)?|inf))/gi)]
    .map((match) => ({ kind: match[1].toLowerCase(), time: Number(match[2]) }))
    .filter((event) => Number.isFinite(event.time));
  const segments: Array<{ startMs: number; endMs: number | null }> = [];
  let openStart: number | undefined;
  for (const event of events) {
    if (event.kind === "start") openStart = event.time;
    else if (openStart !== undefined) {
      segments.push({ startMs: Math.max(0, Math.round(openStart * 1000)), endMs: Math.max(0, Math.round(event.time * 1000)) });
      openStart = undefined;
    }
    if (segments.length > MAX_SILENCE_SEGMENTS) throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");
  }
  if (openStart !== undefined) segments.push({ startMs: Math.max(0, Math.round(openStart * 1000)), endMs: durationMs ?? null });
  return segments;
}

function parseLoudness(log: string): { integratedLufs: number | null; truePeakDbtp: number | null; rangeLufs: number | null } {
  const candidates = [...log.matchAll(/\{[^{}]*\}/gs)].reverse();
  for (const candidate of candidates) {
    try {
      const parsed = z.object({
        input_i: z.string().max(32),
        input_tp: z.string().max(32),
        input_lra: z.string().max(32),
        input_thresh: z.string().max(32),
        output_i: z.string().max(32),
        output_tp: z.string().max(32),
        output_lra: z.string().max(32),
        output_thresh: z.string().max(32),
        normalization_type: z.enum(["dynamic", "linear"]),
        target_offset: z.string().max(32),
      }).strict().safeParse(JSON.parse(candidate[0]));
      if (parsed.success) return {
        integratedLufs: finiteOrNull(parsed.data.input_i),
        truePeakDbtp: finiteOrNull(parsed.data.input_tp),
        rangeLufs: finiteOrNull(parsed.data.input_lra),
      };
    } catch { /* Try the next bounded JSON object in FFmpeg's diagnostic output. */ }
  }
  throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");
}

function measurementDb(log: string, label: "max_volume" | "mean_volume"): number | null | undefined {
  const match = [...log.matchAll(new RegExp(`${label}:\\s*(-?(?:\\d+(?:\\.\\d+)?|inf))\\s*dB`, "gi"))].at(-1);
  return match ? finiteOrNull(match[1]) : undefined;
}

function finiteOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sampleTimes(durationMs?: number): number[] {
  if (durationMs === undefined) return [0];
  const values = [0.1, 0.35, 0.65, 0.9].map((fraction) => Math.min(durationMs - 1, Math.max(0, Math.round(durationMs * fraction))));
  return [...new Set(values)].slice(0, MAX_FRAMES);
}

function toolVersion(result: ToolResult, tool: "ffmpeg" | "ffprobe"): string {
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = line.match(new RegExp(`^${tool} version ([A-Za-z0-9._+-]+)`, "i"));
  if (!match) throw new MediaEvidenceError("INVALID_TOOL_OUTPUT");
  return `${tool}-${match[1]}`;
}

function runTool(tool: string, args: string[], startedAt: number, deadlineMs: number, maxBuffer: number): ToolResult {
  const remaining = deadlineMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new MediaEvidenceError("TIMEOUT");
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: Math.min(remaining, PROCESS_DEADLINE_MS),
    maxBuffer,
  });
  if (result.error) {
    const code = "code" in result.error && typeof result.error.code === "string" ? result.error.code : undefined;
    if (code === "ETIMEDOUT") throw new MediaEvidenceError("TIMEOUT");
    if (code === "ENOBUFS") throw new MediaEvidenceError("OUTPUT_LIMIT");
    throw new MediaEvidenceError("MEDIA_TOOLS_UNAVAILABLE");
  }
  if (result.status !== 0) throw new MediaEvidenceError("MEDIA_TOOL_FAILED");
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function writeJson(root: string, filename: string, value: unknown): Promise<void> {
  await writeFile(join(root, filename), `${stableJson(value)}\n`, { flag: "wx" });
}

async function resolveWithDeadline(value: Promise<string>, startedAt: number, deadlineMs: number): Promise<string> {
  const remaining = deadlineMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new MediaEvidenceError("TIMEOUT");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MediaEvidenceError("TIMEOUT")), remaining); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureRealDirectoryTree(path: string, startedAt: number, deadlineMs: number): Promise<string> {
  const absolute = resolve(path);
  const volumeRoot = parse(absolute).root;
  let current = volumeRoot;
  for (const component of relative(volumeRoot, absolute).split(sep).filter(Boolean)) {
    assertDeadline(startedAt, deadlineMs);
    current = join(current, component);
    await makeDirectory(current);
    const info = await lstat(current);
    const actual = await realpath(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(current, actual)) {
      throw new MediaEvidenceError("UNSAFE_EVIDENCE_ROOT");
    }
  }
  return absolute;
}

async function ensureEvidenceDirectory(root: string, relativePath: string, startedAt: number, deadlineMs: number): Promise<string> {
  let current = root;
  for (const [index, component] of relativePath.split("/").entries()) {
    if ((index === 0 && component !== "assets") || (index > 0 && !/^[a-f0-9]{24,64}$/.test(component))) {
      throw new MediaEvidenceError("UNSAFE_EVIDENCE_ROOT");
    }
    assertDeadline(startedAt, deadlineMs);
    current = join(current, component);
    await makeDirectory(current);
    const info = await lstat(current);
    const actual = await realpath(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(current, actual) || !isWithin(root, actual)) {
      throw new MediaEvidenceError("UNSAFE_EVIDENCE_ROOT");
    }
  }
  return current;
}

async function makeDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
}

function assertDeadline(startedAt: number, deadlineMs: number): void {
  if (Date.now() - startedAt >= deadlineMs) throw new MediaEvidenceError("TIMEOUT");
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function hashFile(path: string, startedAt?: number, deadlineMs?: number): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    if (startedAt !== undefined && deadlineMs !== undefined) assertDeadline(startedAt, deadlineMs);
    bytes += chunk.length;
    if (bytes > MAX_SOURCE_BYTES) throw new MediaEvidenceError("EVIDENCE_LIMIT_EXCEEDED");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseFiniteNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const parsed = Number(numerator) / Number(denominator);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function safeCodec(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9._+-]{1,64}$/.test(value);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

function extensionFor(contentType: MediaEvidenceArtifact["contentType"]): string {
  return contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "json";
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
