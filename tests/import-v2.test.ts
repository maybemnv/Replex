import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mediaAvailable, ffmpegPath, ffprobePath } from "./media.js";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { authorizeLocalImport, importLocalAssetV2 } from "../src/import-v2.js";

const roots: string[] = [];

function emptyProject(): ProjectV2 {
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "project-import-test",
    brief: {},
    assets: {},
    composition: {
      width: 320,
      height: 240,
      fps: 24,
      durationMs: 1,
      tracks: [
        { id: "track-video", kind: "video", order: 0, muted: false, locked: false },
        { id: "track-audio", kind: "audio", order: 1, muted: false, locked: false },
        { id: "track-overlay", kind: "overlay", order: 2, muted: false, locked: false },
      ],
      clips: [],
      layers: [],
    },
    revisions: [{ id: "revision-0", actor: "user", operationIds: [], manifestSha256: "0".repeat(64), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-0", status: "unknown", refs: [] },
    currentRevisionId: "revision-0",
  });
  project.revisions[0].manifestSha256 = semanticHashV2(project);
  return project;
}

async function workspace(): Promise<{ root: string; sourceRoot: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "replex-v2-import-"));
  roots.push(root);
  const sourceRoot = join(root, "authorized");
  const projectRoot = join(root, "project");
  await mkdir(sourceRoot);
  await mkdir(projectRoot);
  return { root, sourceRoot, projectRoot };
}

function ppmFixture(): Buffer {
  return Buffer.concat([
    Buffer.from("P6\n2 2\n255\n", "ascii"),
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
  ]);
}

function wavFixture(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 5000), 44 + index * 2);
  }
  return buffer;
}

function makeVideo(path: string): void {
  const run = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=0.6",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.6",
    "-shortest", "-c:v", "mpeg4", "-q:v", "10", "-c:a", "aac", "-threads", "1", "-movflags", "+faststart", "-y", path,
  ], { encoding: "utf8", windowsHide: true, timeout: 20_000, shell: false });
  if (run.error || run.status !== 0) throw new Error("FFmpeg could not create the small video fixture");
}

async function writeSparsePpm(path: string): Promise<{ size: number; pixelOffset: number }> {
  const header = Buffer.from("P6\n4096 4096\n255\n", "ascii");
  const size = header.length + (4096 * 4096 * 3);
  const file = await open(path, "wx", 0o600);
  try {
    await file.truncate(size);
    await file.write(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  return { size, pixelOffset: header.length + Math.floor((size - header.length) / 2) };
}

async function entries(path: string): Promise<string[]> {
  return readdir(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 local asset import", () => {
  it.skipIf(!mediaAvailable)("stages and validates media before one canonical import revision, preserving provenance on byte deduplication", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const filename = "product.ppm";
    const sourcePath = join(sourceRoot, filename);
    const imageBytes = ppmFixture();
    await writeFile(sourcePath, imageBytes);

    const original = emptyProject();
    const firstSource = await authorizeLocalImport(sourcePath, [sourceRoot]);
    expect(JSON.stringify(firstSource)).not.toContain(sourcePath);
    const first = await importLocalAssetV2(original, projectRoot, firstSource);

    expect(first.project.assets[first.asset.id]).toEqual(first.asset);
    expect(first.asset).toMatchObject({ type: "image", provenance: { kind: "upload", originalFilename: filename, importMethod: "file_picker" } });
    expect(first.project.revisions).toHaveLength(2);
    expect(first.project.currentRevisionId).toBe(first.revisionId);
    expect(first.operationLog).toHaveLength(1);
    expect(first.operationLog[0].input).toMatchObject({ type: "import_asset", asset: { id: first.asset.id } });
    expect(original.assets).toEqual({});
    expect(first.asset.sha256).toBe(createHash("sha256").update(imageBytes).digest("hex"));
    expect(await readFile(join(projectRoot, first.asset.path!))).toEqual(imageBytes);
    expect((await stat(join(projectRoot, first.asset.path!))).nlink).toBe(1);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);

    const secondSource = await authorizeLocalImport(sourcePath, [sourceRoot]);
    const second = await importLocalAssetV2(first.project, projectRoot, secondSource);
    expect(second.asset.id).not.toBe(first.asset.id);
    expect(second.asset.path).toBe(first.asset.path);
    expect(second.asset.provenance).toMatchObject({ kind: "upload", originalFilename: filename, sourceSha256: first.asset.sha256 });
    expect(Object.keys(second.project.assets)).toHaveLength(2);
  });

  it.skipIf(!mediaAvailable)("imports small video and audio fixtures using FFprobe technical facts", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const videoPath = join(sourceRoot, "launch.mp4");
    const audioPath = join(sourceRoot, "voice.wav");
    makeVideo(videoPath);
    await writeFile(audioPath, wavFixture());

    const base = emptyProject();
    const video = await importLocalAssetV2(base, projectRoot, await authorizeLocalImport(videoPath, [sourceRoot]), { ffprobePath });
    expect(video.asset).toMatchObject({ type: "uploaded_video", probe: { width: 64, height: 48, videoCodec: "mpeg4", audioCodec: "aac" } });
    const audio = await importLocalAssetV2(video.project, projectRoot, await authorizeLocalImport(audioPath, [sourceRoot]), { ffprobePath });
    expect(audio.asset).toMatchObject({ type: "audio", probe: { durationMs: expect.any(Number), audioCodec: "pcm_s16le", channels: 1, sampleRateHz: 8000 } });
    expect(audio.project.revisions).toHaveLength(3);
    expect(audio.operationLog[0]).toMatchObject({ actor: "user", baseRevisionId: video.revisionId, resultRevisionId: audio.revisionId });
  }, 30_000);

  it.skipIf(!mediaAvailable)("serializes concurrent same-byte imports and leaves one immutable content object", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const sourcePath = join(sourceRoot, "same.ppm");
    await writeFile(sourcePath, ppmFixture());
    const base = emptyProject();
    const [firstHandle, secondHandle] = await Promise.all([
      authorizeLocalImport(sourcePath, [sourceRoot]),
      authorizeLocalImport(sourcePath, [sourceRoot]),
    ]);

    const results = await Promise.all([
      importLocalAssetV2(base, projectRoot, firstHandle, { ffprobePath }),
      importLocalAssetV2(base, projectRoot, secondHandle, { ffprobePath }),
    ]);
    expect(results[0].asset.path).toBe(results[1].asset.path);
    expect(results[0].asset.id).not.toBe(results[1].asset.id);
    expect(await entries(join(projectRoot, "media", "assets"))).toEqual([results[0].asset.sha256]);
    expect((await stat(join(projectRoot, results[0].asset.path!))).nlink).toBe(1);
  }, 30_000);

  it("rejects sources outside approved roots, hard links, and changed sources before staging", async () => {
    const { root, sourceRoot, projectRoot } = await workspace();
    const sourcePath = join(sourceRoot, "approved.dat");
    const outsidePath = join(root, "outside.dat");
    await writeFile(sourcePath, "authorized bytes");
    await writeFile(outsidePath, "outside bytes");

    await expect(authorizeLocalImport(outsidePath, [sourceRoot])).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
    const aliasPath = join(sourceRoot, "linked.dat");
    await link(sourcePath, aliasPath);
    await expect(authorizeLocalImport(aliasPath, [sourceRoot])).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
    await unlink(aliasPath);

    const changed = await authorizeLocalImport(sourcePath, [sourceRoot]);
    await writeFile(sourcePath, "modified bytes!");
    const original = emptyProject();
    const before = JSON.stringify(original);
    await expect(importLocalAssetV2(original, projectRoot, changed)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(JSON.stringify(original)).toBe(before);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);
    expect(await entries(join(projectRoot, "media", "assets"))).toEqual([]);
  });

  it("rejects symlink sources without following them", async ({ skip }) => {
    const { sourceRoot } = await workspace();
    const sourcePath = join(sourceRoot, "source.dat");
    const aliasPath = join(sourceRoot, "alias.dat");
    await writeFile(sourcePath, "source bytes");
    try {
      await symlink(sourcePath, aliasPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return skip();
      throw error;
    }
    await expect(authorizeLocalImport(aliasPath, [sourceRoot])).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
  });

  it("rejects a project-root escape and leaves its V2 state unchanged", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const sourcePath = join(sourceRoot, "any.bin");
    await writeFile(sourcePath, "non-media");
    const original = emptyProject();
    const before = JSON.stringify(original);
    await expect(importLocalAssetV2(original, join(projectRoot, "missing"), await authorizeLocalImport(sourcePath, [sourceRoot])))
      .rejects.toMatchObject({ code: "PROJECT_ROOT_INVALID" });
    expect(JSON.stringify(original)).toBe(before);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);
  });

  it("honors cancellation before staging and rejects inputs above the POC import limit", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const sourcePath = join(sourceRoot, "cancel.bin");
    await writeFile(sourcePath, "still unchanged");
    const source = await authorizeLocalImport(sourcePath, [sourceRoot]);
    const original = emptyProject();
    const before = JSON.stringify(original);
    const controller = new AbortController();
    controller.abort();
    await expect(importLocalAssetV2(original, projectRoot, source, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(JSON.stringify(original)).toBe(before);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);

    const largePath = join(sourceRoot, "too-large.bin");
    const oversized = await open(largePath, "wx");
    try {
      await oversized.truncate(256 * 1024 * 1024 + 1);
    } finally {
      await oversized.close();
    }
    await expect(authorizeLocalImport(largePath, [sourceRoot])).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });

  it("detects source mutation while staged copying is still in progress", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const sourcePath = join(sourceRoot, "large.ppm");
    const { size, pixelOffset } = await writeSparsePpm(sourcePath);
    const original = emptyProject();
    const source = await authorizeLocalImport(sourcePath, [sourceRoot]);
    const completed = importLocalAssetV2(original, projectRoot, source);
    const outcome = completed.then((value) => ({ value }), (error: unknown) => ({ error }));

    const deadline = Date.now() + 10_000;
    let changedDuringCopy = false;
    while (!changedDuringCopy && Date.now() < deadline) {
      for (const directory of await entries(join(projectRoot, ".replex-staging"))) {
        const staged = join(projectRoot, ".replex-staging", directory, "source");
        const stagedStat = await stat(staged).catch(() => undefined);
        if (!stagedStat || stagedStat.size === 0 || stagedStat.size >= size) continue;
        const writer = await open(sourcePath, "r+");
        try {
          await writer.write(Buffer.from([1]), 0, 1, pixelOffset);
          await writer.sync();
        } finally {
          await writer.close();
        }
        changedDuringCopy = true;
        break;
      }
      if (!changedDuringCopy) await new Promise((done) => setTimeout(done, 1));
    }

    const result = await outcome;
    expect(changedDuringCopy).toBe(true);
    expect("error" in result ? result.error : undefined).toMatchObject({ code: "SOURCE_CHANGED" });
    expect(JSON.stringify(original)).toBe(JSON.stringify(emptyProject()));
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);
    expect(await entries(join(projectRoot, "media", "assets"))).toEqual([]);
  }, 30_000);

  it.skipIf(!mediaAvailable)("rejects corrupt and unsupported media without publishing assets", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const original = emptyProject();
    const corruptPath = join(sourceRoot, "corrupt.mp4");
    await writeFile(corruptPath, "this is not a media container");
    await expect(importLocalAssetV2(original, projectRoot, await authorizeLocalImport(corruptPath, [sourceRoot]), { ffprobePath }))
      .rejects.toMatchObject({ code: "MEDIA_PROBE_FAILED" });

    const subtitlePath = join(sourceRoot, "captions.srt");
    const subtitleBytes = "1\n00:00:00,000 --> 00:00:01,000\nCaption only\n";
    await writeFile(subtitlePath, subtitleBytes);
    const containerPath = join(sourceRoot, "captions.mkv");
    const encoded = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "srt", "-i", subtitlePath, "-c:s", "srt", "-y", containerPath], { encoding: "utf8", windowsHide: true, timeout: 20_000, shell: false });
    if (encoded.error || encoded.status !== 0) throw new Error("FFmpeg could not create the small unsupported subtitle fixture");
    await expect(importLocalAssetV2(original, projectRoot, await authorizeLocalImport(containerPath, [sourceRoot]), { ffprobePath }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    expect(original.assets).toEqual({});
    expect(original.revisions).toHaveLength(1);
    expect(await entries(join(projectRoot, "media", "assets"))).toEqual([]);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);
  }, 30_000);

  it.skipIf(!mediaAvailable)("decodes the staged timeline and rejects a truncated video before registration", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const videoPath = join(sourceRoot, "launch.mp4");
    makeVideo(videoPath);
    const completeBytes = await readFile(videoPath);
    const truncatedPath = join(sourceRoot, "truncated.mp4");
    await writeFile(truncatedPath, completeBytes.subarray(0, Math.floor(completeBytes.length * 0.65)));
    const original = emptyProject();
    const before = JSON.stringify(original);

    await expect(importLocalAssetV2(original, projectRoot, await authorizeLocalImport(truncatedPath, [sourceRoot]), { ffprobePath }))
      .rejects.toMatchObject({ code: "MEDIA_DECODE_FAILED" });
    expect(JSON.stringify(original)).toBe(before);
    expect(original.assets).toEqual({});
    expect(await entries(join(projectRoot, "media", "assets"))).toEqual([]);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);
  }, 30_000);

  it.skipIf(!mediaAvailable)("removes promoted bytes when the canonical reducer rejects the import", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const sourcePath = join(sourceRoot, "valid.ppm");
    await writeFile(sourcePath, ppmFixture());
    const invalidProject = emptyProject();
    (invalidProject.composition as unknown as { fps: number }).fps = 0;
    const before = JSON.stringify(invalidProject);
    const sha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");

    await expect(importLocalAssetV2(invalidProject, projectRoot, await authorizeLocalImport(sourcePath, [sourceRoot]), { ffprobePath }))
      .rejects.toMatchObject({ code: "IMPORT_REJECTED" });
    expect(JSON.stringify(invalidProject)).toBe(before);
    expect(await entries(join(projectRoot, "media", "assets"))).toEqual([]);
    expect(await entries(join(projectRoot, ".replex-staging"))).toEqual([]);
    expect(await readFile(sourcePath)).toEqual(ppmFixture());
    expect(await readFile(join(projectRoot, "media", "assets", sha256)).catch(() => undefined)).toBeUndefined();
  }, 30_000);
});
