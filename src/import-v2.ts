import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { applyOperationBatch, type OperationLogRecord } from "./operations-v2.js";
import { MediaAssetSchema, MediaProbeV2Schema, ProjectV2Schema, type AssetType, type MediaAsset, type MediaProbeV2, type ProjectV2 } from "./schema-v2.js";

export interface AuthorizedLocalImport {
  readonly token: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export type LocalImportErrorCode = "SOURCE_NOT_AUTHORIZED" | "SOURCE_TOO_LARGE" | "SOURCE_CHANGED" | "UNSUPPORTED_MEDIA" | "MEDIA_PROBE_FAILED" | "MEDIA_DECODE_FAILED" | "PROJECT_ROOT_INVALID" | "STORAGE_FAILED" | "IMPORT_REJECTED" | "IMPORT_CANCELLED" | "IMPORT_TIMEOUT" | "UPLOAD_INTERRUPTED";

export class LocalImportError extends Error {
  constructor(readonly code: LocalImportErrorCode, message: string) {
    super(message);
    this.name = "LocalImportError";
  }
}

export interface LocalImportResult {
  asset: MediaAsset;
  project: ProjectV2;
  revisionId: string;
  operationLog: OperationLogRecord[];
}

export interface LocalImportOptions {
  ffprobePath?: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

interface SourceEntry {
  file: FileHandle;
  filename: string;
  importMethod: "file_picker" | "path";
  initialStat: BigIntStats;
  consumed: boolean;
}

interface ProbeResult {
  type: AssetType;
  probe: MediaProbeV2;
}

const authorizedSources = new WeakMap<AuthorizedLocalImport, SourceEntry>();
const hashLocks = new Map<string, Promise<void>>();
// POC limits: 256 MiB input, 60 s total, 15 s probe, 30 s decode, 10 min duration, 4K/16 MP, 60 fps.
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;
const MEDIA_CHECK_TIMEOUT_MS = 30_000;
const MAX_MEDIA_DURATION_MS = 10 * 60 * 1_000;
const MAX_MEDIA_DIMENSION = 4_096;
const MAX_MEDIA_PIXELS = 16_777_216;
const MAX_MEDIA_FPS = 60;
const MAX_AUDIO_CHANNELS = 8;
const MAX_SAMPLE_RATE_HZ = 192_000;
const imageCodecs = new Set(["bmp", "gif", "jpeg2000", "mjpeg", "png", "ppm", "tiff", "webp"]);
const stillImageFormats = new Set(["avif", "bmp_pipe", "gif", "image2", "image2pipe", "jpeg_pipe", "png_pipe", "ppm_pipe", "tiff_pipe", "webp_pipe"]);

function fail(code: LocalImportErrorCode, message: string): never {
  throw new LocalImportError(code, message);
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile();
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sourceFlags(): number {
  return constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
}

/** Called by the local host after a user has selected a file inside an approved root. */
export async function authorizeLocalImport(sourcePath: string, approvedRoots: string[], importMethod: "file_picker" | "path" = "file_picker"): Promise<AuthorizedLocalImport> {
  if (typeof sourcePath !== "string" || !sourcePath || !Array.isArray(approvedRoots) || approvedRoots.length === 0 || approvedRoots.some((root) => typeof root !== "string" || !root)
    || (importMethod !== "file_picker" && importMethod !== "path")) fail("SOURCE_NOT_AUTHORIZED", "source is outside approved import roots");

  const lexicalSource = resolve(sourcePath);
  const lexicalRoots = approvedRoots.map((root) => resolve(root));
  if (!lexicalRoots.some((root) => isWithin(root, lexicalSource))) fail("SOURCE_NOT_AUTHORIZED", "source is outside approved import roots");

  let file: FileHandle | undefined;
  try {
    const beforeOpen = await lstat(lexicalSource, { bigint: true });
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.nlink !== 1n) fail("SOURCE_NOT_AUTHORIZED", "source must be a regular, unlinked file");

    const canonicalRoots = await Promise.all(approvedRoots.map(async (root) => {
      const resolvedRoot = await realpath(root);
      const info = await stat(resolvedRoot);
      if (!info.isDirectory()) fail("SOURCE_NOT_AUTHORIZED", "approved import root is invalid");
      return resolvedRoot;
    }));
    const canonicalSource = await realpath(lexicalSource);
    if (!canonicalRoots.some((root) => isWithin(root, canonicalSource))) fail("SOURCE_NOT_AUTHORIZED", "source is outside approved import roots");

    const resolvedStat = await stat(canonicalSource, { bigint: true });
    file = await open(canonicalSource, sourceFlags());
    const openedStat = await file.stat({ bigint: true });
    if (openedStat.size > BigInt(MAX_IMPORT_BYTES)) fail("SOURCE_TOO_LARGE", "source exceeds the 256 MiB local import limit");
    if (!sameFile(beforeOpen, resolvedStat) || !sameFile(resolvedStat, openedStat) || openedStat.nlink !== 1n || openedStat.size === 0n) {
      fail("SOURCE_NOT_AUTHORIZED", "source changed or is not a regular file");
    }
    if (openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("SOURCE_NOT_AUTHORIZED", "source is too large to import safely");

    const handle = Object.freeze({ token: randomUUID(), filename: basename(lexicalSource), sizeBytes: Number(openedStat.size) });
    authorizedSources.set(handle, { file, filename: handle.filename, importMethod, initialStat: openedStat, consumed: false });
    file = undefined;
    return handle;
  } catch (error) {
    if (error instanceof LocalImportError) throw error;
    return fail("SOURCE_NOT_AUTHORIZED", "source could not be authorized");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function closeAuthorizedLocalImport(source: AuthorizedLocalImport): Promise<void> {
  const entry = authorizedSources.get(source);
  if (!entry || entry.consumed) return;
  entry.consumed = true;
  authorizedSources.delete(source);
  await entry.file.close();
}

export async function importLocalAssetV2(
  project: ProjectV2,
  projectRoot: string,
  source: AuthorizedLocalImport,
  options: LocalImportOptions = {},
): Promise<LocalImportResult> {
  const entry = authorizedSources.get(source);
  if (!entry || entry.consumed) fail("SOURCE_NOT_AUTHORIZED", "authorized source handle is invalid or already used");
  entry.consumed = true;
  authorizedSources.delete(source);

  let stageDirectory: string | undefined;
  const timeoutSignal = AbortSignal.timeout(IMPORT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const checkActive = (): void => {
    if (!signal.aborted) return;
    if (timeoutSignal.aborted) fail("IMPORT_TIMEOUT", "local import exceeded its 60 second limit");
    fail("IMPORT_CANCELLED", "local import was cancelled");
  };
  try {
    checkActive();
    const initialStat = await entry.file.stat({ bigint: true });
    checkActive();
    if (!sameSnapshot(entry.initialStat, initialStat)) fail("SOURCE_CHANGED", "source changed after authorization");

    const canonicalProjectRoot = await checkedProjectRoot(projectRoot);
    checkActive();
    const stagingRoot = await ensureDirectory(canonicalProjectRoot, [".replex-staging"]);
    stageDirectory = await mkdtemp(join(stagingRoot, "import-"));
    await chmod(stageDirectory, 0o700);
    const stagePath = join(stageDirectory, "source");
    const staged = await copyAndHash(entry, stagePath, signal, checkActive);
    checkActive();

    const afterCopy = await entry.file.stat({ bigint: true });
    checkActive();
    if (!sameSnapshot(entry.initialStat, afterCopy) || staged.bytes !== Number(entry.initialStat.size)) fail("SOURCE_CHANGED", "source changed while it was being imported");
    if (await hashExistingFile(stagePath, signal, checkActive) !== staged.sha256) fail("STORAGE_FAILED", "staged source bytes failed integrity validation");

    const ffprobePath = options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
    const media = probeMedia(stagePath, ffprobePath, signal, checkActive);
    checkActive();
    const ffmpegPath = options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
    decodeMedia(stagePath, ffmpegPath, media.probe, signal, checkActive);
    checkActive();
    const afterProbe = await entry.file.stat({ bigint: true });
    checkActive();
    if (!sameSnapshot(entry.initialStat, afterProbe)) fail("SOURCE_CHANGED", "source changed while it was being imported");

    const assetRelativePath = `media/assets/${staged.sha256}`;
    const lockRoot = process.platform === "win32" ? canonicalProjectRoot.toLowerCase() : canonicalProjectRoot;
    const lockKey = `${lockRoot}|${staged.sha256}`;
    return await withLock(lockKey, async () => {
      const assetRoot = await ensureDirectory(canonicalProjectRoot, ["media", "assets"]);
      const finalPath = join(assetRoot, staged.sha256);
      checkActive();
      const promotion = await promoteImmutable(stagePath, finalPath, staged.sha256, signal, checkActive);
      try {
        if (stageDirectory) {
          await rmdir(stageDirectory);
          stageDirectory = undefined;
        }
        checkActive();
        const now = new Date().toISOString();
        const asset = MediaAssetSchema.parse({
          id: `asset-${randomUUID()}`,
          type: media.type,
          path: assetRelativePath,
          sha256: staged.sha256,
          probe: media.probe,
          provenance: {
            kind: "upload",
            originalFilename: entry.filename,
            importedAt: now,
            sourceSha256: staged.sha256,
            importMethod: entry.importMethod,
            originalProbe: media.probe,
          },
        });
        const applied = applyOperationBatch(project, {
          baseRevisionId: project.currentRevisionId,
          actor: "user",
          intentId: `import-${randomUUID()}`,
          evidenceRefs: [],
          operations: [{ type: "import_asset", asset }],
          createdAt: now,
        });
        if (!applied.ok) fail("IMPORT_REJECTED", `canonical import was rejected: ${applied.detail}`);

        return { asset, project: applied.project, revisionId: applied.revisionId, operationLog: applied.operationLog };
      } catch (error) {
        if (promotion.created) await removePromoted(finalPath);
        throw error;
      }
    }, checkActive);
  } catch (error) {
    if (signal.aborted) checkActive();
    if (error instanceof LocalImportError) throw error;
    return fail("STORAGE_FAILED", "local asset import failed before canonical publication");
  } finally {
    await entry.file.close().catch(() => undefined);
    if (stageDirectory) {
      const stagePath = join(stageDirectory, "source");
      await chmod(stagePath, 0o600).catch(() => undefined);
      await rm(stageDirectory, { recursive: true, force: true }).catch(() => fail("STORAGE_FAILED", "failed import staging data could not be cleaned"));
    }
  }
}

async function checkedProjectRoot(projectRoot: string): Promise<string> {
  try {
    const resolved = resolve(projectRoot);
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("PROJECT_ROOT_INVALID", "project root must be a real directory");
    return await realpath(resolved);
  } catch (error) {
    if (error instanceof LocalImportError) throw error;
    return fail("PROJECT_ROOT_INVALID", "project root is unavailable");
  }
}

async function ensureDirectory(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("STORAGE_FAILED", "project media store could not be prepared");
    }
    try {
      const info = await lstat(current);
      const canonical = await realpath(current);
      if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(root, canonical)) fail("STORAGE_FAILED", "project media store escaped its root");
    } catch (error) {
      if (error instanceof LocalImportError) throw error;
      fail("STORAGE_FAILED", "project media store could not be inspected");
    }
  }
  return current;
}

async function copyAndHash(entry: SourceEntry, stagePath: string, signal: AbortSignal, checkActive: () => void): Promise<{ sha256: string; bytes: number }> {
  let output: FileHandle | undefined;
  try {
    output = await open(stagePath, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const value of entry.file.createReadStream({ autoClose: false, start: 0, signal })) {
      checkActive();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes + chunk.length > MAX_IMPORT_BYTES) fail("SOURCE_TOO_LARGE", "source exceeds the 256 MiB local import limit");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await output.write(chunk, offset, chunk.length - offset, bytes + offset);
        if (result.bytesWritten === 0) fail("STORAGE_FAILED", "source could not be staged safely");
        offset += result.bytesWritten;
      }
      bytes += chunk.length;
    }
    await output.sync();
    checkActive();
    const copiedStat = await output.stat({ bigint: true });
    if (copiedStat.size !== BigInt(bytes) || bytes === 0) fail("STORAGE_FAILED", "staged source bytes are incomplete");
    return { sha256: hash.digest("hex"), bytes };
  } catch (error) {
    if (signal.aborted) checkActive();
    if (error instanceof LocalImportError) throw error;
    return fail("STORAGE_FAILED", "source could not be staged safely");
  } finally {
    await output?.close().catch(() => undefined);
  }
}

function probeMedia(path: string, ffprobePath: string, signal: AbortSignal, checkActive: () => void): ProbeResult {
  checkActive();
  const result = spawnSync(ffprobePath, [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", path,
  ], { encoding: "utf8", windowsHide: true, shell: false, timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
  checkActive();
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") fail("IMPORT_TIMEOUT", "media probing exceeded its 15 second limit");
  if (result.error || result.status !== 0 || !result.stdout) fail("MEDIA_PROBE_FAILED", "media could not be probed");

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail("MEDIA_PROBE_FAILED", "media probe returned invalid metadata");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { streams?: unknown }).streams)) fail("MEDIA_PROBE_FAILED", "media probe returned invalid metadata");

  const root = parsed as { streams: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  if (root.streams.some((stream) => !stream || typeof stream !== "object" || Array.isArray(stream) || typeof stream.codec_type !== "string")
    || (root.format !== undefined && (!root.format || typeof root.format !== "object" || Array.isArray(root.format)))) {
    fail("MEDIA_PROBE_FAILED", "media probe returned invalid metadata");
  }
  const streams = root.streams;
  const video = streams.find((stream) => stream.codec_type === "video" && (stream.disposition as Record<string, unknown> | undefined)?.attached_pic !== 1);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const formatNames = typeof root.format?.format_name === "string" ? root.format.format_name.split(",") : [];
  const videoCodec = typeof video?.codec_name === "string" ? video.codec_name : undefined;
  const durationSeconds = positiveNumber(root.format?.duration)
    ?? positiveNumber(video?.duration)
    ?? positiveNumber(audio?.duration);
  const durationMs = durationSeconds === undefined ? undefined : Math.round(durationSeconds * 1000);
  const image = Boolean(video && !audio && (stillImageFormats.has(formatNames[0]) || (imageCodecs.has(videoCodec ?? "") && durationMs === undefined)));

  let type: AssetType;
  if (image) type = "image";
  else if (video && durationMs) type = "uploaded_video";
  else if (audio && durationMs) type = "audio";
  else fail("UNSUPPORTED_MEDIA", "media must contain a supported image, video, or audio stream");

  const width = positiveInteger(video?.width);
  const height = positiveInteger(video?.height);
  if (type === "uploaded_video" && (width === undefined || height === undefined)) fail("UNSUPPORTED_MEDIA", "video stream dimensions are missing");
  if (type === "image" && (width === undefined || height === undefined)) fail("UNSUPPORTED_MEDIA", "image dimensions are missing");
  if (durationMs !== undefined && durationMs > MAX_MEDIA_DURATION_MS) fail("UNSUPPORTED_MEDIA", "media exceeds the 10 minute local import limit");
  if (width !== undefined && width > MAX_MEDIA_DIMENSION || height !== undefined && height > MAX_MEDIA_DIMENSION) fail("UNSUPPORTED_MEDIA", "media dimensions exceed the local import limit");
  if (width !== undefined && height !== undefined && width * height > MAX_MEDIA_PIXELS) fail("UNSUPPORTED_MEDIA", "media pixel count exceeds the local import limit");
  const fps = positiveRational(video?.avg_frame_rate) ?? positiveRational(video?.r_frame_rate);
  if (fps !== undefined && fps > MAX_MEDIA_FPS) fail("UNSUPPORTED_MEDIA", "media frame rate exceeds the local import limit");
  const channels = positiveInteger(audio?.channels);
  if (channels !== undefined && channels > MAX_AUDIO_CHANNELS) fail("UNSUPPORTED_MEDIA", "audio channel count exceeds the local import limit");
  const sampleRateHz = positiveInteger(audio?.sample_rate);
  if (sampleRateHz !== undefined && sampleRateHz > MAX_SAMPLE_RATE_HZ) fail("UNSUPPORTED_MEDIA", "audio sample rate exceeds the local import limit");

  try {
    const probe = MediaProbeV2Schema.parse({
      ...(durationMs ? { durationMs } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(fps ? { fps } : {}),
      ...(videoCodec ? { videoCodec } : {}),
      ...(typeof audio?.codec_name === "string" ? { audioCodec: audio.codec_name } : {}),
      ...(channels ? { channels } : {}),
      ...(sampleRateHz ? { sampleRateHz } : {}),
    });
    return { type, probe };
  } catch {
    fail("MEDIA_PROBE_FAILED", "media probe returned invalid technical facts");
  }
}

function decodeMedia(path: string, ffmpegPath: string, probe: MediaProbeV2, signal: AbortSignal, checkActive: () => void): void {
  checkActive();
  const result = spawnSync(ffmpegPath, [
    "-hide_banner", "-v", "error", "-xerror", "-nostdin", "-max_alloc", "268435456", "-err_detect", "explode", "-threads", "1",
    "-i", path, "-map", "0:v?", "-map", "0:a?", "-progress", "pipe:1", "-nostats", "-f", "null", "-",
  ], { encoding: "utf8", windowsHide: true, shell: false, timeout: MEDIA_CHECK_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
  checkActive();
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") fail("IMPORT_TIMEOUT", "media decoding exceeded its 30 second limit");
  if (result.error || result.status !== 0) fail("MEDIA_DECODE_FAILED", "media failed full decode validation");

  if (probe.durationMs === undefined) return;
  const progress = [...result.stdout.matchAll(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/gm)].at(-1);
  if (!progress) fail("MEDIA_DECODE_FAILED", "media decode did not report its completed duration");
  const decodedSeconds = Number(progress[1]) * 3_600 + Number(progress[2]) * 60 + Number(progress[3]);
  const frameTolerance = probe.fps ? 2 / probe.fps : 0.05;
  if (!Number.isFinite(decodedSeconds) || decodedSeconds + Math.max(frameTolerance, 0.05) < probe.durationMs / 1000) {
    fail("MEDIA_DECODE_FAILED", "media decode ended before the probed duration");
  }
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = positiveNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function positiveRational(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

async function promoteImmutable(stagePath: string, finalPath: string, sha256: string, signal: AbortSignal, checkActive: () => void): Promise<{ created: boolean }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    checkActive();
    let linked = false;
    try {
      await link(stagePath, finalPath);
      linked = true;
      await chmod(finalPath, 0o444);
      await unlink(stagePath);
      return { created: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (linked) await removePromoted(finalPath);
      if (code !== "EEXIST") {
        if (code === "ENOENT") continue;
        fail("STORAGE_FAILED", "validated media could not be published to the project store");
      }
    }

    const existing = await lstat(finalPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      fail("STORAGE_FAILED", "existing content-addressed media could not be inspected");
    });
    if (!existing) {
      await new Promise((done) => setTimeout(done, 25));
      continue;
    }
    if (existing.isSymbolicLink() || !existing.isFile()) fail("STORAGE_FAILED", "existing content-addressed media is invalid");
    if (existing.nlink !== 1n) {
      await new Promise((done) => setTimeout(done, 25));
      continue;
    }
    if (await hashExistingFile(finalPath, signal, checkActive) !== sha256) fail("STORAGE_FAILED", "existing content-addressed media has a different hash");
    await unlink(stagePath).catch(() => fail("STORAGE_FAILED", "duplicate staging bytes could not be cleaned"));
    return { created: false };
  }
  fail("STORAGE_FAILED", "content-addressed media publication did not settle");
}

async function hashExistingFile(path: string, signal: AbortSignal, checkActive: () => void): Promise<string> {
  let file: FileHandle | undefined;
  try {
    checkActive();
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) fail("STORAGE_FAILED", "existing media is not a regular immutable file");
    file = await open(path, sourceFlags());
    const opened = await file.stat({ bigint: true });
    if (!sameFile(before, opened)) fail("STORAGE_FAILED", "existing media changed during validation");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, signal })) {
      checkActive();
      hash.update(chunk as Buffer);
    }
    const after = await file.stat({ bigint: true });
    checkActive();
    if (!sameSnapshot(opened, after)) fail("STORAGE_FAILED", "existing media changed during validation");
    return hash.digest("hex");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function removePromoted(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    fail("STORAGE_FAILED", "failed import media could not be removed");
  });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isFile()) fail("STORAGE_FAILED", "failed import media could not be safely removed");
  await chmod(path, 0o600).catch(() => undefined);
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") fail("STORAGE_FAILED", "failed import media could not be removed");
  });
}

async function withLock<T>(key: string, action: () => Promise<T>, checkActive: () => void): Promise<T> {
  const previous = hashLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  hashLocks.set(key, current);
  await previous;
  try {
    checkActive();
    return await action();
  } finally {
    release();
    if (hashLocks.get(key) === current) hashLocks.delete(key);
  }
}
