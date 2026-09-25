import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { buildCompositionExecutionJob, verifyCompositionExecutionPreflight } from "../src/render-v2.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function mixedProject(): ProjectV2 {
  const videoProbe = { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264" };
  const audioProbe = { durationMs: 4000, audioCodec: "aac", channels: 2, sampleRateHz: 48000 };
  const imageProbe = { width: 640, height: 360 };
  const videoAsset = (id: string, filename: string) => ({
    id, type: "uploaded_video" as const, path: `assets/${filename}`, sha256: sha(id), probe: videoProbe,
    provenance: { kind: "upload" as const, originalFilename: filename, importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sha(id), importMethod: "path" as const, originalProbe: videoProbe },
  });
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "composition-render-test",
    brief: { message: "Mixed media composition" },
    assets: {
      "video-a": videoAsset("video-a", "a.mp4"),
      "video-b": videoAsset("video-b", "b.mp4"),
      "audio-a": {
        id: "audio-a", type: "audio", path: "assets/music.m4a", sha256: sha("audio-a"), probe: audioProbe,
        provenance: { kind: "upload", originalFilename: "music.m4a", importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sha("audio-a"), importMethod: "path", originalProbe: audioProbe },
      },
      "image-a": {
        id: "image-a", type: "image", path: "assets/product.png", sha256: sha("image-a"), probe: imageProbe,
        provenance: { kind: "upload", originalFilename: "product.png", importedAt: "2026-09-25T00:00:00.000Z", sourceSha256: sha("image-a"), importMethod: "path", originalProbe: imageProbe },
      },
    },
    composition: {
      width: 320, height: 180, fps: 24, durationMs: 2280,
      tracks: [
        { id: "video", kind: "video", order: 0, muted: false, locked: false },
        { id: "audio", kind: "audio", order: 1, muted: false, locked: false },
        { id: "overlay", kind: "overlay", order: 2, muted: false, locked: false },
      ],
      clips: [
        { id: "clip-a", assetId: "video-a", trackId: "video", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 1280, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: -3, muted: false, transitionOut: { type: "crossfade", durationMs: 250 } },
        { id: "clip-b", assetId: "video-b", trackId: "video", timelineStartMs: 1280, sourceInMs: 200, sourceOutMs: 1200, speed: 1, transform: { x: 0, y: 0, scale: 1.1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false },
        { id: "music", assetId: "audio-a", trackId: "audio", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 2200, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: -12, muted: false },
      ],
      layers: [
        { id: "title", trackId: "overlay", kind: "text", timelineStartMs: 100, durationMs: 1500, properties: { text: "Ship faster", fontSize: 36, color: "#ffffff" }, keyframes: [] },
        { id: "product-image", trackId: "overlay", kind: "image", timelineStartMs: 1500, durationMs: 500, properties: { assetId: "image-a" }, keyframes: [] },
      ],
    },
    revisions: [{ id: "revision-1", actor: "user", operationIds: [], manifestSha256: sha("initial"), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-1", status: "unknown", refs: [] },
    currentRevisionId: "revision-1",
  });
  project.revisions[0]!.manifestSha256 = semanticHashV2(project);
  return ProjectV2Schema.parse(project);
}

describe("V2 composition render planning", () => {
  it("freezes mixed media handles, timeline semantics, and the derived crossfade duration", () => {
    const project = mixedProject();
    const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));

    const first = buildCompositionExecutionJob(project, handles);
    const second = buildCompositionExecutionJob(project, handles);

    expect(first.jobVersion).toBe(2);
    expect(first.jobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.jobHash).toBe(first.jobHash);
    expect(first.sourceRevisionId).toBe(project.currentRevisionId);
    expect(first.composition).toMatchObject({ durationMs: 2280, outputDurationMs: 2030 });
    expect(first.videoClips).toHaveLength(2);
    expect(first.audioClip).toMatchObject({ id: "music", audioGainDb: -12 });
    expect(first.layers.map(({ kind }) => kind)).toEqual(["text", "image"]);
    expect(Object.isFrozen(first.videoClips[0]!.transform)).toBe(true);
    expect(first).not.toHaveProperty("project");
    expect(JSON.stringify(project.composition)).toContain('"durationMs":2280');
  });

  it("rejects a gap instead of inventing timeline timing for the renderer", () => {
    const project = mixedProject();
    project.composition.clips[1]!.timelineStartMs += 100;
    project.composition.durationMs += 100;
    project.revisions[0]!.manifestSha256 = semanticHashV2(project);
    const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));

    expect(() => buildCompositionExecutionJob(project, handles)).toThrow("contiguous");
  });

  it("authorizes every source and rejects a hard-linked immutable asset", async () => {
    const project = mixedProject();
    const handles = Object.values(project.assets).map((asset) => ({ assetId: asset.id, sha256: asset.sha256, ref: asset.path! }));
    const job = buildCompositionExecutionJob(project, handles);
    const root = await mkdtemp(join(tmpdir(), "replex-composition-preflight-"));
    await mkdir(join(root, "assets"));
    const resolvedHandles = [] as Array<{ assetId: string; sha256: string; ref: string; path: string }>;
    try {
      for (const handle of handles) {
        const path = join(root, ...handle.ref.split("/"));
        await writeFile(path, handle.assetId);
        resolvedHandles.push({ ...handle, path });
      }
      const authorization = { projectRoot: root, resolvedHandles, isRevisionCurrent: async () => true };
      await expect(verifyCompositionExecutionPreflight(job, authorization)).resolves.toMatchObject({
        status: "passed", sourceRevisionId: project.currentRevisionId, assets: handles.map(({ assetId, sha256 }) => ({ assetId, sha256 })),
      });
      await expect(verifyCompositionExecutionPreflight(job, { ...authorization, resolvedHandles: resolvedHandles.slice(0, -1) })).rejects.toThrow("not resolved");
      await link(resolvedHandles[0]!.path, join(root, "assets", "second-link"));
      await expect(verifyCompositionExecutionPreflight(job, authorization)).rejects.toThrow("regular project media file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
