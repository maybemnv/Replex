import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { buildMediaExecutionJob } from "../src/render-v2.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const handle = { assetId: "upload-1", sha256: sha("uploaded-media"), ref: "assets/product.mp4" };

function uploadedProject(): ProjectV2 {
  const base: Omit<ProjectV2, "revisions"> & { revisions: ProjectV2["revisions"] } = {
    schemaVersion: 2,
    projectId: "project-render-v2",
    brief: { message: "Product walkthrough" },
    assets: {
      "upload-1": {
        id: "upload-1",
        type: "uploaded_video",
        path: handle.ref,
        sha256: handle.sha256,
        probe: { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 2, sampleRateHz: 48000 },
        provenance: {
          kind: "upload",
          originalFilename: "product.mp4",
          importedAt: "2026-09-25T00:00:00.000Z",
          sourceSha256: handle.sha256,
          importMethod: "path",
          originalProbe: { durationMs: 2000, width: 320, height: 180, fps: 24, videoCodec: "h264", audioCodec: "aac", channels: 2, sampleRateHz: 48000 },
        },
      },
    },
    composition: {
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 1280,
      tracks: [{ id: "video-1", kind: "video", order: 0, muted: false, locked: false }],
      clips: [{
        id: "clip-1",
        assetId: "upload-1",
        trackId: "video-1",
        timelineStartMs: 0,
        sourceInMs: 200,
        sourceOutMs: 1800,
        speed: 1.25,
        transform: { x: 12, y: -6, scale: 1.1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        opacity: 0.75,
        audioGainDb: -6,
        muted: false,
      }],
      layers: [],
    },
    revisions: [{ id: "revision-1", actor: "user", operationIds: [], manifestSha256: sha("manifest"), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-1", status: "unknown", refs: [] },
    currentRevisionId: "revision-1",
  };
  base.revisions[0].manifestSha256 = semanticHashV2(base);
  return ProjectV2Schema.parse(base);
}

describe("V2 media render planning", () => {
  it("freezes a deterministic single uploaded-video job to the source revision", () => {
    const project = uploadedProject();
    const first = buildMediaExecutionJob(project, [handle]);
    const second = buildMediaExecutionJob(project, [handle]);

    expect(first.jobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.jobHash).toBe(first.jobHash);
    expect(first.sourceRevisionId).toBe(project.currentRevisionId);
    expect(first.sourceRevisionHash).toBe(project.revisions[0].manifestSha256);
    expect(first.clip).toMatchObject({ sourceInMs: 200, sourceOutMs: 1800, speed: 1.25, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, opacity: 0.75, audioGainDb: -6 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.clip.transform)).toBe(true);
    expect(first).not.toHaveProperty("project");

    project.composition.clips[0].speed = 2;
    expect(first.clip.speed).toBe(1.25);
  });
});
