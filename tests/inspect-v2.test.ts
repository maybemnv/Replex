import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalFlow } from "../fixtures/apps/normal/flow.js";
import { inspectProjectV2, V2InspectRequestSchema, type V2InspectionContext, type V2InspectRequest, type V2InspectResult } from "../src/inspect-v2.js";
import { semanticHashV2, type OperationLogRecord } from "../src/operations-v2.js";
import { generateMediaEvidence, MediaEvidenceIndexSchema, type MediaEvidenceArtifact, type MediaEvidenceIndex } from "../src/media-evidence.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { ffmpegPath, mediaAvailable } from "./media.js";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pngFixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJZkAAAAASUVORK5CYII=", "base64");

function fixtureProject(): ProjectV2 {
  const video = {
    id: "asset-browser",
    type: "browser_capture" as const,
    path: "media/assets/browser.mp4",
    sha256: sha("browser bytes"),
    probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" },
    provenance: {
      kind: "browser" as const, flowId: "flow-launch", sceneKey: "hero",
      actionIds: ["open-launch"], checkpointActionId: "open-launch",
      runId: "run-private-123", capturedAt: "2026-09-24T10:00:00.000Z",
    },
  };
  const audio = {
    id: "asset-audio", type: "audio" as const, path: "media/assets/audio.wav", sha256: sha("audio bytes"),
    probe: { durationMs: 4000, audioCodec: "pcm_s16le", channels: 1, sampleRateHz: 48000 },
    provenance: {
      kind: "upload" as const, originalFilename: "D:\\Private\\token=local-secret\\voice.wav",
      importedAt: "2026-09-24T10:00:00.000Z", sourceSha256: sha("audio bytes"), importMethod: "file_picker" as const,
      originalProbe: { durationMs: 4000, audioCodec: "pcm_s16le", channels: 1, sampleRateHz: 48000 },
    },
  };
  const image = {
    id: "asset-image", type: "image" as const, path: "media/assets/cover.png", sha256: sha("image bytes"),
    probe: { width: 1280, height: 720 },
    provenance: {
      kind: "upload" as const, originalFilename: "cover.png",
      importedAt: "2026-09-24T10:00:00.000Z", sourceSha256: sha("image bytes"), importMethod: "file_picker" as const,
      originalProbe: { width: 1280, height: 720 },
    },
  };
  const flow = normalFlow("https://private.example.test");
  flow.id = "flow-launch";
  flow.steps = [{
    ...flow.steps[0], id: "open-launch", order: 0, sceneKey: "hero",
    target: { kind: "url", value: "https://private.example.test/?session=private-flow-secret" },
  }];
  const project = {
    schemaVersion: 2 as const,
    projectId: "project-launch",
    brief: { audience: "Founders", message: "Bearer top-secret; show release flow from /mnt/data/private/launch.mp4", targetDurationMs: 4000 },
    assets: { [video.id]: video, [audio.id]: audio, [image.id]: image },
    composition: {
      width: 1920, height: 1080, fps: 30, durationMs: 4000,
      tracks: [
        { id: "track-video", kind: "video" as const, order: 0, muted: false, locked: false },
        { id: "track-audio", kind: "audio" as const, order: 1, muted: false, locked: false },
        { id: "track-overlay", kind: "overlay" as const, order: 2, muted: false, locked: false },
      ],
      clips: [0, 1, 2].map((index) => ({
        id: "clip-" + index, assetId: video.id, trackId: "track-video",
        timelineStartMs: index * 1000, sourceInMs: index * 1000, sourceOutMs: (index + 1) * 1000,
        speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        opacity: 1, audioGainDb: 0, muted: false,
      })),
      layers: [{
        id: "layer-title", trackId: "track-overlay", kind: "text" as const,
        timelineStartMs: 0, durationMs: 1000,
        properties: { text: "Product title password=layer-secret", fontSize: 40 }, keyframes: [],
      }],
    },
    revisions: [{ id: "revision-0", actor: "user" as const, operationIds: [], manifestSha256: "0".repeat(64), createdAt: "2026-09-24T10:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-0", status: "unknown" as const, refs: [] },
    browser: { flows: { [flow.id]: flow }, recaptureLineage: [] },
    currentRevisionId: "revision-0",
  };
  project.revisions[0].manifestSha256 = semanticHashV2(project as ProjectV2);
  return ProjectV2Schema.parse(project);
}

function speedRecord(project: ProjectV2): OperationLogRecord {
  return {
    id: "operation-speed-1", baseRevisionId: "revision-0", resultRevisionId: project.currentRevisionId,
    actor: "agent", intentId: "intent-speed-1", input: { type: "set_speed", clipId: "clip-0", speed: 1.25 },
    accepted: true, evidenceRefs: ["C:\\private\\capture.mp4"], createdAt: "2026-09-24T10:01:00.000Z",
  };
}

function context(project: ProjectV2, options: Partial<V2InspectionContext> = {}): V2InspectionContext {
  return { project, evidenceRoot: join(tmpdir(), "unused-evidence-root"), ...options };
}

function success(result: V2InspectResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("inspection failed: " + result.code);
  return result;
}

async function evidenceFixture(root: string, project: ProjectV2, options: { sourceSha256?: string; imageBytes?: Buffer; artifactSha256?: string } = {}) {
  const runRef = "media-evidence/" + "a".repeat(24) + "/" + "b".repeat(24);
  const asset = project.assets["asset-browser"];
  const probeBytes = Buffer.from(JSON.stringify({ durationMs: 4000, bitRateBps: 1200000, streams: [{ index: 0, type: "video", codec: "token=codec-secret", width: 1920, height: 1080, fps: 30 }] }));
  const sceneBytes = Buffer.from(JSON.stringify({ version: 1, threshold: 0.3, boundariesMs: [0, 2000, 4000] }));
  const audioBytes = Buffer.from(JSON.stringify({
    version: 1, silenceThresholdDb: -50, peakDbfs: -4.5, meanDbfs: -22.1,
    silenceSegments: [{ startMs: 3000, endMs: 4000 }],
    loudness: { integratedLufs: -20, truePeakDbtp: -3, rangeLufs: 7 },
  }));
  const contactBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const definitions = [
    { kind: "probe" as const, contentType: "application/json" as const, bytes: probeBytes, name: "probe", ext: "json" },
    { kind: "scene_boundaries" as const, contentType: "application/json" as const, bytes: sceneBytes, name: "scene-boundaries", ext: "json" },
    { kind: "audio_summary" as const, contentType: "application/json" as const, bytes: audioBytes, name: "audio-summary", ext: "json" },
    { kind: "selected_frame" as const, contentType: "image/png" as const, bytes: options.imageBytes ?? pngFixture, name: "selected-frame", ext: "png", timestampMs: 1200 },
    { kind: "contact_sheet" as const, contentType: "image/jpeg" as const, bytes: contactBytes, name: "contact-sheet", ext: "jpg" },
  ];
  const artifacts: MediaEvidenceArtifact[] = definitions.map((definition) => {
    const digest = options.artifactSha256 ?? sha(definition.bytes);
    return {
      kind: definition.kind,
      ref: runRef + "/" + definition.name + "-" + digest + "." + definition.ext,
      sha256: digest, sizeBytes: definition.bytes.byteLength, contentType: definition.contentType,
      ...(definition.timestampMs !== undefined ? { timestampMs: definition.timestampMs } : {}),
    };
  });
  const index = MediaEvidenceIndexSchema.parse({
    version: 1, sourceAssetId: asset.id, sourceSha256: options.sourceSha256 ?? asset.sha256,
    generator: "replex-native-media-evidence", generatorVersion: "1",
    configHash: "c".repeat(64), runHash: "b".repeat(64), indexRef: runRef + "/index.json", artifacts,
  }) as MediaEvidenceIndex;
  const runDirectory = join(root, ...index.indexRef.split("/").slice(0, -1));
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "index.json"), JSON.stringify(index));
  for (const [number, definition] of definitions.entries()) {
    const filePath = join(root, ...artifacts[number].ref.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, definition.bytes);
  }
  return { index, definitions };
}

describe("V2 bounded model inspection", () => {
  it("returns a sanitized project summary without canonical state or session details", async () => {
    const project = fixtureProject();
    const result = success(await inspectProjectV2({ kind: "project_summary" }, context(project)));
    const serialized = JSON.stringify(result);
    expect(result.data).toMatchObject({ projectId: "project-launch", currentRevisionId: "revision-0", composition: { durationMs: 4000 }, assetCount: 3, clipCount: 3 });
    expect(result.evidenceRefs).toEqual([]);
    expect(serialized).not.toContain('"schemaVersion"');
    expect(serialized).not.toContain('"revisions"');
    expect(serialized).not.toContain('"browser"');
    expect(serialized).not.toContain("private.example.test");
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("layer-secret");
    expect(serialized).not.toContain("/mnt/data");
    expect(serialized).toContain("[LOCAL_PATH]");
    expect(serialized).not.toContain("run-private-123");
    expect(serialized).not.toContain("media/assets/browser.mp4");
  });

  it("paginates allowlisted assets and safely exposes browser provenance", async () => {
    const project = fixtureProject();
    const result = success(await inspectProjectV2({ kind: "assets", offset: 1, limit: 2 }, context(project)));
    expect(result.data).toMatchObject({
      total: 3, offset: 1, limit: 2,
      items: [
        { assetId: "asset-browser", type: "browser_capture", provenance: { kind: "browser", flowId: "flow-launch", sceneKey: "hero", actionIds: ["open-launch"], checkpointActionId: "open-launch" } },
        { assetId: "asset-image", type: "image", provenance: { kind: "upload", originalFilename: "cover.png" } },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("run-private-123");
    expect(serialized).not.toContain("private.example.test");
    expect(serialized).not.toContain("local-secret");
    expect(serialized).not.toContain("media/assets/browser.mp4");
    await expect(inspectProjectV2({ kind: "assets", offset: 0, limit: 1000 }, context(project)))
      .resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("paginates clips and exposes only semantic timing and transform fields", async () => {
    const project = fixtureProject();
    const result = success(await inspectProjectV2({ kind: "clips", offset: 1, limit: 1 }, context(project)));
    expect(result.data).toMatchObject({ total: 3, offset: 1, limit: 1, items: [{ clipId: "clip-1", assetId: "asset-browser", timelineStartMs: 1000, speed: 1 }] });
    expect(JSON.stringify(result)).not.toContain("path");
    expect(JSON.stringify(result)).not.toContain("properties");
  });

  it("returns bounded media summaries and typed image bytes only after persisted evidence checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-evidence-"));
    try {
      const project = fixtureProject();
      const { index } = await evidenceFixture(root, project);
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame", frameOffset: 0 },
        context(project, { evidenceRoot: root, evidenceIndexes: [index] }),
      ));
      expect(result.data).toMatchObject({
        status: "available", assetId: "asset-browser",
        probe: { durationMs: 4000, bitRateBps: 1200000 },
        sceneBoundariesMs: [0, 2000, 4000],
        audio: { peakDbfs: -4.5, silenceSegmentCount: 1 },
        transcriptStatus: "unavailable",
      });
      expect(JSON.stringify(result)).not.toContain("codec-secret");
      expect(result.evidenceRefs).toContain(index.artifacts[0].ref);
      expect(result.images).toHaveLength(1);
      expect(result.images?.[0]).toMatchObject({ ref: index.artifacts[3].ref, mimeType: "image/png" });
      expect(Buffer.from(result.images![0].bytes)).toEqual(pngFixture);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("index.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks source-stale evidence unavailable and discloses no stale reference or image", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-stale-"));
    try {
      const project = fixtureProject();
      const { index } = await evidenceFixture(root, project, { sourceSha256: "f".repeat(64) });
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot: root, evidenceIndexes: [index] }),
      ));
      expect(result.data).toMatchObject({ status: "stale", assetId: "asset-browser", transcriptStatus: "unavailable" });
      expect(result.images).toBeUndefined();
      expect(result.evidenceRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mismatched artifact bytes before returning refs or images", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-hash-"));
    try {
      const project = fixtureProject();
      const { index } = await evidenceFixture(root, project, { artifactSha256: "d".repeat(64) });
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot: root, evidenceIndexes: [index] }),
      ));
      expect(result.data).toMatchObject({ status: "invalid" });
      expect(result.images).toBeUndefined();
      expect(result.evidenceRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unsafe refs and symlinked evidence artifacts", async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-unsafe-"));
    try {
      const evidenceRoot = join(root, "owned-evidence");
      await mkdir(evidenceRoot, { recursive: true });
      const project = fixtureProject();
      const { index } = await evidenceFixture(evidenceRoot, project);
      const unsafe = {
        ...index,
        artifacts: index.artifacts.map((artifact) => artifact.kind === "selected_frame"
          ? { ...artifact, ref: "media-evidence/../../outside.png" }
          : artifact),
      } as unknown as MediaEvidenceIndex;
      const badRef = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot, evidenceIndexes: [unsafe] }),
      ));
      expect(badRef.data).toMatchObject({ status: "invalid" });
      expect(badRef.images).toBeUndefined();
      expect(badRef.evidenceRefs).toEqual([]);

      const frame = index.artifacts.find((artifact) => artifact.kind === "selected_frame")!;
      const framePath = join(evidenceRoot, ...frame.ref.split("/"));
      const outside = join(root, "outside.png");
      await writeFile(outside, "private file bytes");
      await rm(framePath);
      try {
        await symlink(outside, framePath, "file");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return skip();
        throw error;
      }
      const linked = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot, evidenceIndexes: [index] }),
      ));
      expect(linked.data).toMatchObject({ status: "invalid" });
      expect(linked.images).toBeUndefined();
      expect(linked.evidenceRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces byte budgets and returns only compact operation summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-budget-"));
    try {
      const project = fixtureProject();
      const { index } = await evidenceFixture(root, project, { imageBytes: Buffer.alloc(1024, 7) });
      const imageLimited = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot: root, evidenceIndexes: [index], imageByteBudget: 32 }),
      ));
      expect(imageLimited.data).toMatchObject({ visualStatus: "omitted_budget" });
      expect(imageLimited.images).toBeUndefined();

      const history = success(await inspectProjectV2(
        { kind: "operation_history", limit: 5 },
        context(project, { operationLog: [speedRecord(project)] }),
      ));
      expect(history.data).toMatchObject({ total: 1, items: [{ actor: "agent", revisionId: "revision-0", operationType: "set_speed" }] });
      expect(JSON.stringify(history)).not.toContain("input");
      expect(JSON.stringify(history)).not.toContain("capture.mp4");
      expect(history.evidenceRefs).toEqual([]);
      await expect(inspectProjectV2({ kind: "operation_history", limit: 1000 }, context(project)))
        .resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns verification and output status without artifact paths", async () => {
    const project = fixtureProject();
    const result = success(await inspectProjectV2({ kind: "verification" }, context(project)));
    expect(result.data).toMatchObject({ status: "unknown", revisionId: "revision-0", outputs: [] });
    expect(result.evidenceRefs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("operationLogRef");
  });

  it("serves a verified JPEG contact sheet as a typed image block", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-contact-"));
    try {
      const project = fixtureProject();
      const { index, definitions } = await evidenceFixture(root, project);
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "contact_sheet" },
        context(project, { evidenceRoot: root, evidenceIndexes: [index] }),
      ));
      const jpeg = result.images?.[0];
      expect(jpeg).toMatchObject({ mimeType: "image/jpeg", ref: index.artifacts.find((item) => item.kind === "contact_sheet")?.ref });
      expect(Buffer.from(jpeg!.bytes)).toEqual(definitions[4].bytes);
      expect(result.evidenceRefs).toContain(jpeg!.ref);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an index file symlink that targets outside the evidence root", async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-index-link-"));
    try {
      const evidenceRoot = join(root, "owned-evidence");
      const project = fixtureProject();
      const { index } = await evidenceFixture(evidenceRoot, project);
      const outsideIndex = join(root, "outside-index.json");
      await writeFile(outsideIndex, JSON.stringify(index));
      const indexPath = join(evidenceRoot, ...index.indexRef.split("/"));
      await rm(indexPath);
      try {
        await symlink(outsideIndex, indexPath, "file");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return skip();
        throw error;
      }
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot, evidenceIndexes: [index] }),
      ));
      expect(result.data).toMatchObject({ status: "invalid" });
      expect(result.images).toBeUndefined();
      expect(result.evidenceRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a nested evidence directory junction that escapes its root", async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-dir-link-"));
    try {
      const evidenceRoot = join(root, "owned-evidence");
      const project = fixtureProject();
      const { index } = await evidenceFixture(evidenceRoot, project);
      const prefix = index.indexRef.split("/")[1];
      const nested = join(evidenceRoot, "media-evidence", prefix);
      const outside = join(root, "outside-evidence-run");
      await rm(outside, { recursive: true, force: true });
      await import("node:fs/promises").then(({ rename }) => rename(nested, outside));
      try {
        await symlink(outside, nested, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return skip();
        throw error;
      }
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "selected_frame" },
        context(project, { evidenceRoot, evidenceIndexes: [index] }),
      ));
      expect(result.data).toMatchObject({ status: "invalid" });
      expect(result.images).toBeUndefined();
      expect(result.evidenceRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies a maximum serialized response size and validates the shared tool schema", async () => {
    const project = fixtureProject();
    await expect(inspectProjectV2({ kind: "project_summary" }, context(project, { responseByteLimit: 64 })))
      .resolves.toMatchObject({ ok: false, code: "OUTPUT_LIMIT" });
    expect(V2InspectRequestSchema.safeParse({ kind: "media_evidence", assetId: "asset-browser", image: "selected_frame", frameOffset: 0 }).success).toBe(true);
    expect(V2InspectRequestSchema.safeParse({ kind: "media_evidence", assetId: "../private", image: "selected_frame" }).success).toBe(false);
    expect(V2InspectRequestSchema.safeParse({ kind: "clips", offset: -1 }).success).toBe(false);
  });

  it.skipIf(!mediaAvailable)("projects actual generated evidence-index output into a verified image and bounded summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-generated-"));
    const source = join(root, "source.mp4");
    try {
      const encoded = spawnSync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=12:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
      ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30000, maxBuffer: 1024 * 1024 });
      if (encoded.error || encoded.status !== 0) throw new Error("could not create the inspection media fixture");
      const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(source));
      const project = fixtureProject();
      project.assets["asset-browser"].sha256 = sha(bytes);
      project.revisions[0].manifestSha256 = semanticHashV2(project);
      const evidenceRoot = join(root, "owned-evidence");
      const assetHandle = { assetId: "asset-browser", sha256: sha(bytes), ref: "media/assets/browser.mp4" };
      const index = await generateMediaEvidence({ asset: assetHandle, evidenceRoot, resolveSource: async () => source });
      const result = success(await inspectProjectV2(
        { kind: "media_evidence", assetId: "asset-browser", image: "contact_sheet" },
        context(project, { evidenceRoot, evidenceIndexes: [index] }),
      ));
      expect(result.data).toMatchObject({ status: "available", audio: { silenceSegmentCount: 0 }, transcriptStatus: "unavailable" });
      expect(result.images?.[0]?.mimeType).toBe("image/jpeg");
      expect(result.evidenceRefs).toContain(index.artifacts.find((artifact) => artifact.kind === "scene_boundaries")?.ref);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
