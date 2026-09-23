import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ProjectV2Schema,
  parseProjectV2,
  type ProjectV2,
} from "../src/schema-v2.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function validProject(): ProjectV2 {
  const revisionId = "revision-1";
  const browserAsset = {
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
  return {
    schemaVersion: 2,
    projectId: "project-v2",
    brief: { audience: "Founders", message: "Show the launch", targetDurationMs: 4000 },
    assets: { [browserAsset.id]: browserAsset },
    composition: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 4000,
      tracks: [
        { id: "track-video", kind: "video", order: 0, muted: false, locked: false },
        { id: "track-overlay", kind: "overlay", order: 1, muted: false, locked: false },
      ],
      clips: [{
        id: "clip-hero",
        assetId: browserAsset.id,
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
      layers: [{
        id: "layer-title",
        trackId: "track-overlay",
        kind: "text",
        timelineStartMs: 0,
        durationMs: 2000,
        properties: { text: "Launch day" },
        keyframes: [{ property: "opacity", timeMs: 0, value: 1, interpolation: "linear" }],
      }],
    },
    revisions: [{ id: revisionId, actor: "user", operationIds: [], manifestSha256: sha("manifest"), createdAt: "2026-09-22T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId, status: "unknown", refs: [] },
    browser: {
      flows: {
        "flow-release": {
          id: "flow-release",
          approvedAt: "2026-09-21T00:00:00.000Z",
          prohibitedActions: ["delete", "publish"],
          steps: [{
            id: "open-hero",
            order: 0,
            action: "goto",
            target: { kind: "url", value: "https://example.test/" },
            consequential: false,
            approved: true,
            checkpoint: { kind: "visible", expected: "Launch" },
            sceneKey: "hero",
          }],
        },
      },
      recaptureLineage: [],
    },
    currentRevisionId: revisionId,
  };
}

describe("ProjectV2Schema", () => {
  it("accepts source-agnostic browser composition state", () => {
    expect(parseProjectV2(validProject())).toMatchObject({ schemaVersion: 2, projectId: "project-v2" });
  });

  it("accepts uploaded and generated provenance without browser context", () => {
    const project = validProject();
    delete project.browser;
    project.assets = {
      "asset-upload": {
        id: "asset-upload",
        type: "uploaded_video",
        objectRef: "objects/uploaded.mp4",
        sha256: sha("uploaded"),
        probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 },
        provenance: {
          kind: "upload",
          originalFilename: "launch.mp4",
          importedAt: "2026-09-22T00:00:00.000Z",
          sourceSha256: sha("uploaded"),
          importMethod: "upload",
          originalProbe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 },
        },
      },
      "asset-generated": {
        id: "asset-generated",
        type: "generated_graphic",
        path: "assets/generated.png",
        sha256: sha("generated"),
        probe: { width: 800, height: 600 },
        provenance: { kind: "generated", generator: "preset:card", generatedAt: "2026-09-22T00:00:00.000Z", inputRefs: ["asset-upload"] },
      },
    };
    project.composition.clips[0] = { ...project.composition.clips[0], assetId: "asset-upload" };
    expect(ProjectV2Schema.parse(project).assets["asset-generated"].provenance.kind).toBe("generated");
  });

  it.each([
    ["unknown project fields", () => ({ ...validProject(), extra: true })],
    ["dangling asset references", () => ({ ...validProject(), composition: { ...validProject().composition, clips: [{ ...validProject().composition.clips[0], assetId: "missing" }] } })],
    ["invalid timeline range", () => ({ ...validProject(), composition: { ...validProject().composition, clips: [{ ...validProject().composition.clips[0], sourceOutMs: 5000 }] } })],
    ["keyframe outside layer timing", () => ({ ...validProject(), composition: { ...validProject().composition, layers: [{ ...validProject().composition.layers[0], keyframes: [{ property: "opacity", timeMs: 2001, value: 1, interpolation: "linear" }] }] } })],
    ["absolute or escaping paths", () => ({ ...validProject(), assets: { ...validProject().assets, "asset-browser": { ...validProject().assets["asset-browser"], path: "../outside.mp4" } } })],
    ["local file URLs in asset refs", () => ({ ...validProject(), assets: { ...validProject().assets, "asset-browser": { ...validProject().assets["asset-browser"], path: "file:///private/video.mp4" } } })],
    ["local file URLs in verification evidence", () => ({ ...validProject(), verification: { revisionId: "revision-1", status: "failed", refs: [{ id: "verification-1", revisionId: "revision-1", status: "failed", evidenceRefs: ["file:///private/evidence.json"] }] } })],
    ["provenance union mismatch", () => ({ ...validProject(), assets: { ...validProject().assets, "asset-browser": { ...validProject().assets["asset-browser"], provenance: { kind: "upload", originalFilename: "x.mp4", importedAt: "2026-09-22T00:00:00.000Z", sourceSha256: sha("x"), importMethod: "upload", originalProbe: {} } } } })],
  ])("rejects %s", (_name, makeInvalid) => {
    expect(() => ProjectV2Schema.parse(makeInvalid())).toThrow();
  });

  it("keeps render artifacts separate from immutable source assets and checks verification refs", () => {
    const project = validProject();
    const verificationId = "verification-1";
    project.verification = { revisionId: "revision-1", status: "passed", refs: [{ id: verificationId, revisionId: "revision-1", status: "passed", evidenceRefs: ["evidence/verification.json"] }] };
    project.outputs = [{
      outputId: "output-1",
      ref: "renders/revision-1.mp4",
      sha256: sha("output"),
      probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30 },
      sourceRevisionId: "revision-1",
      renderJobHash: sha("job"),
      backendId: "native-media",
      backendVersion: "1",
      verificationRefId: verificationId,
    }];
    expect(ProjectV2Schema.parse(project).outputs[0].outputId).toBe("output-1");
    expect(() => ProjectV2Schema.parse({ ...project, outputs: [{ ...project.outputs[0], verificationRefId: "missing" }] })).toThrow();
    expect(() => ProjectV2Schema.parse({ ...project, outputs: [project.outputs[0], { ...project.outputs[0] }] })).toThrow();
  });

  it("rejects asset timing and layer type mismatches", () => {
    const project = validProject();
    project.composition.durationMs = 6000;
    expect(() => ProjectV2Schema.parse({
      ...project,
      composition: { ...project.composition, clips: [{ ...project.composition.clips[0], sourceOutMs: 5000 }] },
    })).toThrow();
    expect(() => ProjectV2Schema.parse({
      ...project,
      composition: {
        ...project.composition,
        layers: [...project.composition.layers, {
          id: "layer-image",
          trackId: "track-overlay",
          kind: "image",
          timelineStartMs: 0,
          durationMs: 100,
          properties: { assetId: "asset-browser" },
          keyframes: [],
        }],
      },
    })).toThrow();
  });

  it("rejects a browser predecessor from another scene", () => {
    const project = validProject();
    project.browser!.flows["flow-release"].steps.push({
      id: "open-other",
      order: 1,
      action: "click",
      target: { kind: "testId", value: "other" },
      consequential: false,
      approved: true,
      checkpoint: { kind: "visible", expected: "Other" },
      sceneKey: "other",
    });
    project.assets["asset-other"] = {
      ...project.assets["asset-browser"],
      id: "asset-other",
      path: "assets/other.mp4",
      provenance: { kind: "browser", flowId: "flow-release", sceneKey: "other", actionIds: ["open-other"], checkpointActionId: "open-other", runId: "run-other", capturedAt: "2026-09-22T00:00:00.000Z", predecessorAssetId: "asset-browser" },
    };
    expect(() => ProjectV2Schema.parse(project)).toThrow();
  });

  it("allows historical verification evidence but requires a passed ref for the current revision", () => {
    const project = validProject();
    project.revisions.unshift({ id: "revision-0", actor: "user", operationIds: [], manifestSha256: sha("old"), createdAt: "2026-09-22T00:00:00.000Z" });
    const historicalRef = { id: "verification-old", revisionId: "revision-0", status: "passed" as const, evidenceRefs: ["evidence/old.json"] };
    project.verification = {
      revisionId: "revision-1",
      status: "passed",
      refs: [historicalRef, { id: "verification-current", revisionId: "revision-1", status: "passed", evidenceRefs: ["evidence/current.json"] }],
    };

    expect(ProjectV2Schema.parse(project).verification.refs[0]).toEqual(historicalRef);
    expect(() => ProjectV2Schema.parse({ ...project, verification: { ...project.verification, refs: [historicalRef] } })).toThrow();
  });

  it("rejects cyclic revision ancestry and verification refs to unknown revisions", () => {
    const project = validProject();
    project.revisions.unshift({ id: "revision-0", parentId: "revision-1", actor: "user", operationIds: [], manifestSha256: sha("old"), createdAt: "2026-09-22T00:00:00.000Z" });
    project.revisions[1].parentId = "revision-0";
    expect(() => ProjectV2Schema.parse(project)).toThrow();

    const second = validProject();
    second.verification.refs = [{ id: "verification-orphan", revisionId: "revision-missing", status: "failed", evidenceRefs: [] }];
    expect(() => ProjectV2Schema.parse(second)).toThrow();
  });

  it("defaults missing clip mute state to false and models crossfades without overlap", () => {
    const project = validProject();
    delete (project.composition.clips[0] as Partial<typeof project.composition.clips[number]>).muted;
    expect(ProjectV2Schema.parse(project).composition.clips[0].muted).toBe(false);
    project.composition.clips[0].sourceOutMs = 2000;
    project.composition.clips[0].transitionOut = { type: "crossfade", durationMs: 500 };
    project.composition.clips.push({
      ...project.composition.clips[0],
      id: "clip-next",
      timelineStartMs: 2000,
      sourceInMs: 2000,
      sourceOutMs: 4000,
      transitionOut: { type: "cut", durationMs: 0 },
    });
    expect(() => ProjectV2Schema.parse(project)).not.toThrow();

    project.composition.clips[1].timelineStartMs = 1500;
    expect(() => ProjectV2Schema.parse(project)).toThrow();
  });

  it("rejects a crossfade without a following same-track clip", () => {
    const project = validProject();
    project.composition.clips[0].transitionOut = { type: "crossfade", durationMs: 500 };
    expect(() => ProjectV2Schema.parse(project)).toThrow();
  });
});
