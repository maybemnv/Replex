import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalFlow } from "../fixtures/apps/normal/flow.js";
import {
  BACKEND_SUPPORTED_OPERATION_TYPES,
  REDUCER_SUPPORTED_OPERATION_TYPES,
  SCHEMA_RECOGNIZED_OPERATION_TYPES,
  OperationBatchSchema,
  OperationSchemas,
  OperationSchema,
  applyOperationBatch,
  semanticHashV2,
  type OperationBatchInput,
} from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function project(): ProjectV2 {
  const revisionId = "revision-0";
  const asset = {
    id: "asset-browser",
    type: "browser_capture" as const,
    path: "assets/browser.mp4",
    sha256: sha("browser"),
    probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 },
    provenance: {
      kind: "browser" as const,
      flowId: "flow-release",
      sceneKey: "hero",
      actionIds: ["open-hero"],
      checkpointActionId: "open-hero",
      runId: "run-1",
      capturedAt: "2026-09-22T00:00:00.000Z",
    },
  };
  const base = {
    schemaVersion: 2 as const,
    projectId: "project-v2",
    brief: { audience: "Founders", message: "Show the launch", targetDurationMs: 4000 },
    assets: { [asset.id]: asset },
    composition: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 4000,
      tracks: [
        { id: "track-video", kind: "video" as const, order: 0, muted: false, locked: false },
        { id: "track-overlay", kind: "overlay" as const, order: 1, muted: false, locked: false },
      ],
      clips: [{
        id: "clip-hero",
        assetId: asset.id,
        trackId: "track-video",
        timelineStartMs: 0,
        sourceInMs: 0,
        sourceOutMs: 4000,
        speed: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        opacity: 1,
        audioGainDb: 0,
        muted: false,
      }],
      layers: [],
    },
    revisions: [{ id: revisionId, actor: "user" as const, operationIds: [], manifestSha256: "0".repeat(64), createdAt: "2026-09-22T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId, status: "unknown" as const, refs: [] },
    browser: {
      flows: {
        "flow-release": {
          ...normalFlow("https://example.test"),
          id: "flow-release",
          steps: [{
            id: "open-hero",
            order: 0,
            action: "goto" as const,
            target: { kind: "url" as const, value: "https://example.test/" },
            consequential: false,
            approved: true,
            checkpoint: { kind: "visible" as const, expected: "Launch" },
            sceneKey: "hero",
          }],
        },
      },
      recaptureLineage: [],
    },
    currentRevisionId: revisionId,
  } satisfies Omit<ProjectV2, "revisions"> & { revisions: ProjectV2["revisions"] };
  base.revisions[0].manifestSha256 = semanticHashV2(base as ProjectV2);
  return base as ProjectV2;
}

function batch(projectValue: ProjectV2, operations: unknown[]): OperationBatchInput {
  return { baseRevisionId: projectValue.currentRevisionId, actor: "user", intentId: "intent-1", evidenceRefs: [], operations };
}

describe("V2 operation boundary", () => {
  it("recognizes exactly the architecture operation vocabulary", () => {
    const vocabulary = [
      "import_asset", "remove_asset", "create_clip", "split_clip", "trim_clip", "move_clip", "remove_clip", "replace_asset",
      "set_transform", "set_opacity", "set_speed", "set_transition", "add_text_layer", "update_text_layer", "add_image_layer",
      "remove_layer", "set_volume", "mute_clip", "animate_property", "apply_motion_preset", "recapture_browser_asset", "replace_browser_capture",
    ];
    expect(SCHEMA_RECOGNIZED_OPERATION_TYPES).toEqual(vocabulary);
    expect(Object.keys(OperationSchemas)).toEqual(vocabulary);
    expect(REDUCER_SUPPORTED_OPERATION_TYPES).toEqual(vocabulary.filter((type) => type !== "recapture_browser_asset"));
    expect(BACKEND_SUPPORTED_OPERATION_TYPES).toEqual([]);
  });

  it("recognizes the exact architecture vocabulary and applies one canonical revision", () => {
    const input = { type: "set_opacity", clipId: "clip-hero", opacity: 0.5 };
    expect(OperationSchema.safeParse(input).success).toBe(true);
    const source = project();
    const result = applyOperationBatch(source, batch(source, [input]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.composition.clips[0].opacity).toBe(0.5);
      expect(result.project.revisions).toHaveLength(2);
      expect(result.project.revisions[1]).toMatchObject({ parentId: "revision-0", actor: "user", operationIds: [result.operationLog[0].id] });
      expect(result.project.currentRevisionId).toBe(result.revisionId);
    }
    expect(source.composition.clips[0].opacity).toBe(1);
  });

  it("rejects stale, malformed, and deferred batches without changing state or emitting a log", () => {
    const source = project();
    const before = JSON.stringify(source);
    expect(applyOperationBatch(source, { ...batch(source, [{ type: "set_opacity", clipId: "clip-hero", opacity: 0.5 }]), baseRevisionId: "revision-stale" })).toMatchObject({ ok: false, code: "STALE_REVISION" });
    expect(applyOperationBatch(source, batch(source, [{ type: "set_opacity", clipId: "clip-hero", opacity: 0.5 }, { type: "set_opacity", clipId: "missing", opacity: 0.2 }]))).toMatchObject({ ok: false, code: "INVALID_OPERATION", operationIndex: 1 });
    expect(applyOperationBatch(source, batch(source, [{ type: "recapture_browser_asset", assetId: "asset-browser", reason: "new product state" }]))).toMatchObject({ ok: false, code: "UNSUPPORTED_OPERATION", operationType: "recapture_browser_asset" });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("applies and replays a strict camera-push preset as canonical revision state", () => {
    const source = project();
    const operation = { type: "apply_motion_preset", targetId: "clip-hero", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.05 } };
    const first = applyOperationBatch(source, batch(source, [operation]));
    const second = applyOperationBatch(source, batch(source, [operation]));

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.project.composition.motionPresets).toEqual([{ targetId: "clip-hero", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.05 } }]);
      expect(first.project.currentRevisionId).toBe(second.project.currentRevisionId);
      expect(first.operationLog[0]?.input).toEqual(operation);
      expect(semanticHashV2(first.project)).toBe(semanticHashV2(second.project));
    }
    expect(source.composition).not.toHaveProperty("motionPresets");
  });

  it("replaces one clip's preset atomically and removes it with the clip", () => {
    const source = project();
    const first = applyOperationBatch(source, batch(source, [{ type: "apply_motion_preset", targetId: "clip-hero", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.03 } }]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const updated = applyOperationBatch(first.project, batch(first.project, [{ type: "apply_motion_preset", targetId: "clip-hero", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.07 } }]));
    expect(updated.ok && updated.project.composition.motionPresets).toEqual([{ targetId: "clip-hero", presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.07 } }]);
    if (!updated.ok) return;
    const removed = applyOperationBatch(updated.project, batch(updated.project, [{ type: "remove_clip", clipId: "clip-hero" }]));
    expect(removed.ok && removed.project.composition.motionPresets).toBeUndefined();
  });

  it("rejects unsupported motion params, non-video targets, and locked tracks without partial state", () => {
    const source = project();
    const operation = (targetId: string, presetId = "camera-push", strength = 0.05, presetVersion = "1") => ({ type: "apply_motion_preset", targetId, presetId, presetVersion, parameters: { strength } });
    const before = JSON.stringify(source);
    for (const bad of [
      operation("clip-hero", "title-reveal"),
      operation("clip-hero", "camera-push", 0.01),
      operation("clip-hero", "camera-push", 0.09),
      operation("clip-hero", "camera-push", 0.05, "2"),
      { ...operation("clip-hero"), parameters: { strength: 0.05, durationMs: 500 } },
      operation("missing"),
    ]) {
      expect(applyOperationBatch(source, batch(source, [bad]))).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
    }
    const locked = structuredClone(source);
    locked.composition.tracks[0]!.locked = true;
    locked.revisions[0]!.manifestSha256 = semanticHashV2(locked);
    expect(applyOperationBatch(locked, batch(locked, [operation("clip-hero")]))).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("replays identical input to an identical revision and semantic hash", () => {
    const source = project();
    const input = batch(source, [{ type: "set_transform", clipId: "clip-hero", transform: { x: 4, y: -2, scale: 1.1, rotation: 3, anchorX: 0.5, anchorY: 0.5 } }]);
    const first = applyOperationBatch(source, input);
    const second = applyOperationBatch(source, input);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.revisionId).toBe(second.revisionId);
      expect(first.operationLog).toEqual(second.operationLog);
      expect(semanticHashV2(first.project)).toBe(semanticHashV2(second.project));
    }
  });

  it("excludes mutable verification evidence from semantic revision hashes", () => {
    const source = project();
    const before = semanticHashV2(source);
    source.verification = { revisionId: source.currentRevisionId, status: "passed", refs: [{ id: "verification-1", revisionId: source.currentRevisionId, status: "passed", evidenceRefs: ["evidence/check.json"] }] };
    expect(semanticHashV2(source)).toBe(before);
    source.verification.status = "failed";
    expect(semanticHashV2(source)).toBe(before);

    const withoutMute = structuredClone(source);
    delete (withoutMute.composition.clips[0] as Partial<typeof withoutMute.composition.clips[number]>).muted;
    expect(semanticHashV2(withoutMute)).toBe(semanticHashV2({ ...withoutMute, composition: { ...withoutMute.composition, clips: [{ ...withoutMute.composition.clips[0], muted: false }, ...withoutMute.composition.clips.slice(1)] } }));
  });

  it("allows edits on migrated crossfade clips and rejects a transition without a neighbor", () => {
    const source = project();
    const first = source.composition.clips[0];
    first.sourceOutMs = 2000;
    first.transitionOut = { type: "crossfade", durationMs: 500 };
    source.composition.clips.push({ ...first, id: "clip-next", timelineStartMs: 2000, sourceInMs: 2000, sourceOutMs: 4000, transitionOut: { type: "cut", durationMs: 0 } });
    source.revisions[0].manifestSha256 = semanticHashV2(source);
    const parsed = ProjectV2Schema.parse(source);
    const trimmed = applyOperationBatch(parsed, batch(parsed, [{ type: "trim_clip", clipId: "clip-hero", sourceInMs: 0, sourceOutMs: 1800 }]));
    const sped = applyOperationBatch(parsed, batch(parsed, [{ type: "set_speed", clipId: "clip-hero", speed: 1.1 }]));
    expect(trimmed.ok).toBe(true);
    expect(sped.ok).toBe(true);

    expect(applyOperationBatch(project(), batch(project(), [{ type: "set_transition", clipId: "clip-hero", transition: { type: "crossfade", durationMs: 500 } }]))).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
  });

  it("keeps prior render evidence immutable while invalidating only current verification", () => {
    const source = project();
    const verificationId = "verification-0";
    source.verification = { revisionId: source.currentRevisionId, status: "passed", refs: [{ id: verificationId, revisionId: source.currentRevisionId, status: "passed", evidenceRefs: ["evidence/verification.json"] }] };
    source.outputs = [{ outputId: "output-0", ref: "renders/revision-0.mp4", sha256: sha("output"), probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 }, sourceRevisionId: source.currentRevisionId, renderJobHash: sha("job"), backendId: "native-media", backendVersion: "1", verificationRefId: verificationId }];
    const result = applyOperationBatch(source, batch(source, [{ type: "set_opacity", clipId: "clip-hero", opacity: 0.9 }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.outputs).toEqual(source.outputs);
      expect(result.project.verification).toMatchObject({ revisionId: result.revisionId, status: "stale", refs: source.verification.refs });
    }
  });

  it("preserves browser asset and clip identity while replacing only the captured source", () => {
    const source = project();
    const replacement = {
      id: "asset-browser-new",
      type: "browser_capture" as const,
      path: "assets/browser-new.mp4",
      sha256: sha("browser-new"),
      probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 },
      provenance: { ...source.assets["asset-browser"].provenance, runId: "run-2", capturedAt: "2026-09-22T00:01:00.000Z" },
    };
    expect(applyOperationBatch(source, batch(source, [{
      type: "replace_browser_capture",
      previousAssetId: "asset-browser",
      replacementAsset: replacement,
      changedActionIds: ["unrelated-action"],
      reason: "updated product state",
    }]))).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
    const result = applyOperationBatch(source, batch(source, [{
      type: "replace_browser_capture",
      previousAssetId: "asset-browser",
      replacementAsset: replacement,
      changedActionIds: ["open-hero"],
      reason: "updated product state",
    }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.assets["asset-browser"]).toEqual(source.assets["asset-browser"]);
      expect(result.project.composition.clips[0]).toMatchObject({ id: "clip-hero", assetId: "asset-browser-new" });
      expect(result.project.browser?.recaptureLineage[0]).toMatchObject({ previousAssetId: "asset-browser", replacementAssetId: "asset-browser-new", revisionId: result.revisionId });
    }
  });

  it("accepts schema-recognized canonical clip and layer operations", () => {
    const source = project();
    const image = {
      id: "asset-image",
      type: "image" as const,
      path: "assets/image.png",
      sha256: sha("image"),
      probe: { width: 800, height: 600 },
      provenance: { kind: "upload" as const, originalFilename: "image.png", importedAt: "2026-09-22T00:00:00.000Z", sourceSha256: sha("image"), importMethod: "path" as const, originalProbe: { width: 800, height: 600 } },
    };
    const layer = { id: "layer-title", trackId: "track-overlay", kind: "text" as const, timelineStartMs: 0, durationMs: 1000, properties: { text: "Launch" }, keyframes: [] };
    const result = applyOperationBatch(source, batch(source, [
      { type: "import_asset", asset: image },
      { type: "add_text_layer", layer },
      { type: "set_opacity", layerId: layer.id, opacity: 0.7 },
      { type: "update_text_layer", layerId: layer.id, properties: { text: "Updated" } },
      { type: "animate_property", layerId: layer.id, keyframes: [{ property: "opacity", timeMs: 500, value: 1, interpolation: "ease_in" }] },
      { type: "remove_layer", layerId: layer.id },
      { type: "remove_asset", assetId: image.id },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.assets[image.id]).toBeUndefined();
    expect(OperationBatchSchema.safeParse(result.ok ? result.operationLog.map((entry) => entry.input) : []).success).toBe(result.ok);
  });

  it("covers clip placement, timing, visual, audio, and asset operations", () => {
    const source = project();
    const replacement = {
      id: "asset-upload",
      type: "uploaded_video" as const,
      path: "assets/upload.mp4",
      sha256: sha("upload"),
      probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 },
      provenance: { kind: "upload" as const, originalFilename: "upload.mp4", importedAt: "2026-09-22T00:00:00.000Z", sourceSha256: sha("upload"), importMethod: "path" as const, originalProbe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 } },
    };
    const result = applyOperationBatch(source, batch(source, [
      { type: "import_asset", asset: replacement },
      { type: "replace_asset", clipId: "clip-hero", assetId: replacement.id },
      { type: "trim_clip", clipId: "clip-hero", sourceInMs: 500, sourceOutMs: 3500 },
      { type: "move_clip", clipId: "clip-hero", timelineStartMs: 100 },
      { type: "set_speed", clipId: "clip-hero", speed: 2 },
      { type: "create_clip", clip: { id: "clip-next", assetId: replacement.id, trackId: "track-video", timelineStartMs: 1600, sourceInMs: 3500, sourceOutMs: 4000, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false } },
      { type: "set_transform", clipId: "clip-hero", transform: { x: 2, y: 3, scale: 1.2, rotation: 5, anchorX: 0.5, anchorY: 0.5 }, crop: { x: 0, y: 0, width: 0.8, height: 0.8 } },
      { type: "set_opacity", clipId: "clip-hero", opacity: 0.8 },
      { type: "set_transition", clipId: "clip-hero", transition: { type: "crossfade", durationMs: 250 } },
      { type: "set_volume", clipId: "clip-hero", audioGainDb: -3 },
      { type: "mute_clip", clipId: "clip-hero", muted: true },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.composition.clips[0]).toMatchObject({ assetId: replacement.id, timelineStartMs: 100, sourceInMs: 500, sourceOutMs: 3500, speed: 2, opacity: 0.8, audioGainDb: -3, muted: true });

    const split = applyOperationBatch(project(), batch(project(), [{ type: "split_clip", clipId: "clip-hero", atTimelineMs: 2000, newClipId: "clip-hero-second" }]));
    expect(split.ok).toBe(true);
    if (split.ok) expect(split.project.composition.clips.map((clip) => [clip.id, clip.sourceInMs, clip.sourceOutMs])).toEqual([["clip-hero", 0, 2000], ["clip-hero-second", 2000, 4000]]);

    const removed = applyOperationBatch(project(), batch(project(), [{ type: "remove_clip", clipId: "clip-hero" }]));
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.project.composition.clips).toHaveLength(0);
  });
});
