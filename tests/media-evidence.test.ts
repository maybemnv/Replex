import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { describe, expect, it } from "vitest";
import { MediaEvidenceError, MediaEvidenceIndexSchema, generateMediaEvidence, parseMediaProbeOutput } from "../src/media-evidence.js";
import { ffmpegPath, mediaAvailable } from "./media.js";

describe("media evidence source binding", () => {
  it("rejects bytes that no longer match the authorized asset handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-source-"));
    const sourcePath = join(root, "source.mp4");
    const evidenceRoot = join(root, "project", "evidence");
    const authorizedBytes = Buffer.from("original source bytes");
    await writeFile(sourcePath, "changed source bytes");

    try {
      await expect(generateMediaEvidence({
        asset: {
          assetId: "asset-evidence",
          sha256: createHash("sha256").update(authorizedBytes).digest("hex"),
          ref: "media/source.mp4",
        },
        evidenceRoot,
        resolveSource: async () => sourcePath,
      })).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
      await expect(readdir(evidenceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked evidence roots before invoking media tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-root-"));
    const sourcePath = join(root, "source.bin");
    const evidenceRoot = join(root, "linked-evidence");
    const outsideRoot = join(root, "outside");
    await writeFile(sourcePath, "valid bytes for root check");
    await mkdir(outsideRoot);

    try {
      await symlink(outsideRoot, evidenceRoot, "junction");
      await expect(generateMediaEvidence({
        asset: await authorizedAsset(sourcePath, "asset-root"),
        evidenceRoot,
        resolveSource: async () => sourcePath,
      })).rejects.toMatchObject({ code: "UNSAFE_EVIDENCE_ROOT" });
      await expect(readdir(outsideRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strictly rejects malformed and out-of-contract FFprobe output", () => {
    expect(() => parseMediaProbeOutput("{broken json")).toThrowError(MediaEvidenceError);
    expect(() => parseMediaProbeOutput(JSON.stringify({ streams: [], format: {} }))).toThrowError(MediaEvidenceError);
    expect(() => parseMediaProbeOutput(JSON.stringify({
      streams: [{ index: 0, codec_type: "video", filename: "C:/private/video.mp4" }],
    }))).toThrowError(MediaEvidenceError);
  });

  it("enforces frame and artifact-byte limits in the versioned index", () => {
    const assetHash = "a".repeat(64);
    const runRef = `media-evidence/${"b".repeat(24)}/${"e".repeat(24)}`;
    const frame = (timestampMs: number) => ({
      kind: "selected_frame" as const,
      ref: `${runRef}/selected-frame-${assetHash}.png`,
      sha256: assetHash,
      sizeBytes: 1,
      contentType: "image/png" as const,
      timestampMs,
    });
    const index = {
      version: 1 as const,
      sourceAssetId: "asset-bounds",
      sourceSha256: "c".repeat(64),
      generator: "replex-native-media-evidence" as const,
      generatorVersion: "1" as const,
      configHash: "d".repeat(64),
      runHash: "e".repeat(64),
      indexRef: `${runRef}/index.json`,
      artifacts: [frame(100), frame(200), frame(300), frame(400)],
    };
    expect(MediaEvidenceIndexSchema.safeParse(index).success).toBe(true);
    expect(MediaEvidenceIndexSchema.safeParse({ ...index, artifacts: [...index.artifacts, frame(500)] }).success).toBe(false);
    expect(MediaEvidenceIndexSchema.safeParse({ ...index, artifacts: [{ ...frame(100), sizeBytes: 8 * 1024 * 1024 + 1 }] }).success).toBe(false);
  });

  const whenMediaAvailable = mediaAvailable ? it : it.skip;

  whenMediaAvailable("creates a deterministic bounded index with real local video evidence and no audio artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-video-"));
    const sourcePath = join(root, "video.mp4");
    try {
      makeVideo(sourcePath, false);
      const asset = await authorizedAsset(sourcePath, "asset-video");
      const request = { asset, evidenceRoot: join(root, "project", "evidence"), resolveSource: async () => sourcePath };
      const first = await generateMediaEvidence(request);
      const second = await generateMediaEvidence(request);
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        version: 1,
        sourceAssetId: asset.assetId,
        sourceSha256: asset.sha256,
        generator: "replex-native-media-evidence",
        generatorVersion: "1",
      });
      expect(first.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(["probe", "selected_frame", "contact_sheet", "scene_boundaries"]));
      expect(first.artifacts.filter((artifact) => artifact.kind === "selected_frame").length).toBeLessThanOrEqual(4);
      expect(first.artifacts.some((artifact) => artifact.kind === "audio_summary")).toBe(false);
      expect(JSON.stringify(first)).not.toContain(sourcePath);
      expect(JSON.parse(await readEvidenceFile(request.evidenceRoot, first.indexRef))).toEqual(first);

      for (const artifact of first.artifacts) {
        const bytes = await readEvidenceFile(request.evidenceRoot, artifact.ref, true);
        expect(bytes.byteLength).toBe(artifact.sizeBytes);
        expect(bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  whenMediaAvailable("records silence and bounded loudness/peak evidence for silent audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-silence-"));
    const sourcePath = join(root, "silent-audio.mp4");
    try {
      makeVideo(sourcePath, true);
      const asset = await authorizedAsset(sourcePath, "asset-silence");
      const evidenceRoot = join(root, "project", "evidence");
      const index = await generateMediaEvidence({ asset, evidenceRoot, resolveSource: async () => sourcePath });
      const audioArtifact = index.artifacts.find((artifact) => artifact.kind === "audio_summary");
      expect(audioArtifact).toBeDefined();
      const audio = JSON.parse(await readEvidenceFile(evidenceRoot, audioArtifact!.ref)) as {
        peakDbfs: number | null;
        meanDbfs: number | null;
        silenceSegments: Array<{ startMs: number; endMs: number | null }>;
        loudness: { integratedLufs: number | null; truePeakDbtp: number | null; rangeLufs: number | null };
      };
      expect(audio.silenceSegments.length).toBeGreaterThan(0);
      expect(audio.peakDbfs).not.toBeNull();
      expect(audio.peakDbfs!).toBeLessThan(-50);
      expect(audio.meanDbfs!).toBeLessThan(-50);
      expect(audio.loudness.integratedLufs === null || audio.loudness.integratedLufs < -50).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  whenMediaAvailable("rejects a changed source after analysis and publishes no stale index", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-changed-during-run-"));
    const sourcePath = join(root, "video.mp4");
    const evidenceRoot = join(root, "project", "evidence");
    try {
      makeVideo(sourcePath, false);
      const asset = await authorizedAsset(sourcePath, "asset-changing");
      let changed = false;
      await mkdir(evidenceRoot, { recursive: true });
      const watcher = watch(evidenceRoot, { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      const mutation = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("analysis did not stage scene evidence")), 10_000);
        watcher.on("change", (_event, filename) => {
          const path = filename?.toString().replaceAll("\\", "/") ?? "";
          if (changed || !path.includes(".stage-") || !path.endsWith("scene-boundaries.json")) return;
          changed = true;
          void writeFile(sourcePath, "source changed during analysis").then(resolve, reject);
        });
      });
      const generation = generateMediaEvidence({ asset, evidenceRoot, resolveSource: async () => sourcePath });
      try {
        const outcome = await Promise.race([
          mutation.then(() => "mutated" as const),
          generation.then(() => "completed" as const, () => "failed" as const),
        ]);
        expect(outcome).toBe("mutated");
        await expect(generation).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
      } finally {
        watcher.close();
        if (timer) clearTimeout(timer);
      }
      expect(changed).toBe(true);
      expect(await listFiles(evidenceRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  whenMediaAvailable("leaves no published evidence files when tool output is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-corrupt-"));
    const sourcePath = join(root, "invalid.mp4");
    const evidenceRoot = join(root, "project", "evidence");
    await writeFile(sourcePath, "not a media file");
    try {
      await expect(generateMediaEvidence({
        asset: await authorizedAsset(sourcePath, "asset-invalid"),
        evidenceRoot,
        resolveSource: async () => sourcePath,
      })).rejects.toBeInstanceOf(MediaEvidenceError);
      expect(await listFiles(evidenceRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function authorizedAsset(path: string, assetId: string) {
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  return { assetId, sha256: hash, ref: `media/${assetId}.mp4` };
}

function makeVideo(path: string, silentAudio: boolean): void {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=12:d=1"];
  if (silentAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000:d=1");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (silentAudio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  const result = spawnSync(ffmpegPath, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("could not create the small media-evidence fixture");
}

async function readEvidenceFile(root: string, ref: string): Promise<string>;
async function readEvidenceFile(root: string, ref: string, asBuffer: true): Promise<Buffer>;
async function readEvidenceFile(root: string, ref: string, asBuffer = false): Promise<string | Buffer> {
  const path = join(root, ...ref.split("/"));
  const contents = await readFile(path);
  return asBuffer ? contents : contents.toString("utf8").trimEnd();
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}
