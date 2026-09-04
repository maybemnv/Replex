import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { EditOperationSchema } from "../src/schema.js";
import { applyOperations } from "../src/operations.js";
import { createProject, semanticHash, type Project } from "../src/project.js";

const origin = "http://127.0.0.1:4173";

function project(): Project {
  return createProject({
    projectId: "operation-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment(origin),
    flow: normalFlow(origin),
    captures: [
      { id: "capture-open", sceneKey: "open-demo", sourcePath: "captures/open.webm", durationMs: 10000 },
      { id: "capture-filter", sceneKey: "open-filter", sourcePath: "captures/filter.webm", durationMs: 10000 },
      { id: "capture-apply", sceneKey: "apply-filter", sourcePath: "captures/apply.webm", durationMs: 10000 },
    ],
  });
}

function scene(projectValue: Project, index = 0) {
  return projectValue.scenes[index];
}

function capture(id: string, sceneKey: string, durationMs = 10000, actionIds = [sceneKey], checkpointActionId = actionIds.at(-1)!) {
  return {
    id,
    sceneKey,
    runId: `run-${id}`,
    actionIds,
    checkpointActionId,
    path: `captures/${id}.webm`,
    sha256: createHash("sha256").update(id).digest("hex"),
    durationMs,
    width: 1920,
    height: 1080,
    fps: 30 as const,
    capturedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("EditOperationSchema", () => {
  it("accepts each of the nine strict operation shapes", () => {
    const value = project();
    const first = scene(value);
    const second = scene(value, 1);
    const operations = [
      { type: "create_scene", scene: { ...first, id: "new-scene", sceneKey: "new-scene", captureId: "capture-new", actionIds: ["open-release-page"], checkpointActionId: "open-release-page" } },
      { type: "trim_scene", sceneId: first.id, sourceInMs: 0, sourceOutMs: 9999 },
      { type: "reorder_scene", sceneIds: value.scenes.map((item) => item.id) },
      { type: "replace_capture", sceneId: first.id, captureId: "capture-new", reason: "product state changed" },
      { type: "set_speed", sceneId: first.id, speed: 1.25 },
      { type: "set_focus", sceneId: first.id, focus: { preset: "box", bounds: { x: 0, y: 0, width: 0.5, height: 0.5 }, startMs: 0, endMs: 1000 } },
      { type: "set_title", overlay: { id: "title-1", sceneId: first.id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 1000 } },
      { type: "set_callout", overlay: { id: "callout-1", sceneId: second.id, kind: "callout", text: "Results update", placement: "target", startMs: 0, endMs: 1000 } },
      { type: "set_transition", sceneId: first.id, transition: { type: "crossfade", durationMs: 250 } },
    ];

    expect(operations.every((operation) => EditOperationSchema.safeParse(operation).success)).toBe(true);
  });

  it("rejects unknown fields, invalid IDs, non-millisecond ranges, and out-of-range values", () => {
    expect(EditOperationSchema.safeParse({ type: "trim_scene", sceneId: "bad id", sourceInMs: 0, sourceOutMs: 1 }).success).toBe(false);
    expect(EditOperationSchema.safeParse({ type: "trim_scene", sceneId: "scene-1", sourceInMs: 0.5, sourceOutMs: 1 }).success).toBe(false);
    expect(EditOperationSchema.safeParse({ type: "set_speed", sceneId: "scene-1", speed: 1.1 }).success).toBe(false);
    expect(EditOperationSchema.safeParse({ type: "set_title", overlay: { id: "title-1", sceneId: "scene-1", kind: "title", text: "x", placement: "top", startMs: 0, endMs: 1, extra: true } }).success).toBe(false);
  });
});

describe("operation reducer", () => {
  it("creates a scene only from an existing capture and valid flow links", () => {
    const source = project();
    const newCapture = capture("capture-new", "new-scene", 1000, ["new-step"], "new-step");
    const input = {
      ...source,
      captures: { ...source.captures, [newCapture.id]: newCapture },
      flow: { ...source.flow, steps: [...source.flow.steps, { ...source.flow.steps[0], id: "new-step", sceneKey: "new-scene" }] },
    };
    const result = applyOperations(input, input.currentRevisionId, [{ type: "create_scene", scene: { id: "new-scene-id", sceneKey: "new-scene", captureId: newCapture.id, actionIds: ["new-step"], checkpointActionId: "new-step", sourceInMs: 0, sourceOutMs: 1000, speed: 1, order: 3, transition: { type: "cut", durationMs: 0 } } }]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.scenes.at(-1)).toMatchObject({ sceneKey: "new-scene", captureId: newCapture.id });
  });

  it("trims a scene at the source boundary", () => {
    const source = project();
    const result = applyOperations(source, source.currentRevisionId, [{ type: "trim_scene", sceneId: scene(source).id, sourceInMs: 0, sourceOutMs: 10000 }]);
    expect(result.ok).toBe(true);
  });

  it("reorders only an exact current scene ID set", () => {
    const source = project();
    const ids = source.scenes.map((item) => item.id).reverse();
    const result = applyOperations(source, source.currentRevisionId, [{ type: "reorder_scene", sceneIds: ids }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.scenes.map((item) => item.id)).toEqual(ids);
    expect(applyOperations(source, source.currentRevisionId, [{ type: "reorder_scene", sceneIds: ids.slice(1) }])).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
  });

  it("replaces a capture without changing source bytes or scene identity", () => {
    const source = project();
    const replacement = capture("capture-open-new", "open-demo", 10000, ["open-release-page"], "open-release-page");
    const input = { ...source, captures: { ...source.captures, [replacement.id]: replacement } };
    const sourceHash = source.captures["capture-open"].sha256;
    const result = applyOperations(input, input.currentRevisionId, [{ type: "replace_capture", sceneId: scene(input).id, captureId: replacement.id, reason: "changed UI" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.scenes[0]).toMatchObject({ id: scene(source).id, captureId: replacement.id });
      expect(result.project.captures["capture-open"].sha256).toBe(sourceHash);
      expect(result.project.recaptureLineage[0]).toMatchObject({ previousCaptureId: "capture-open", replacementCaptureId: replacement.id });
    }
  });

  it.each([0.75, 1, 1.25, 1.5, 2] as const)("sets an allowed speed (%s)", (speed) => {
    const source = project();
    const result = applyOperations(source, source.currentRevisionId, [{ type: "set_speed", sceneId: scene(source).id, speed }]);
    expect(result.ok).toBe(true);
  });

  it("sets a bounded scene-local focus", () => {
    const source = project();
    const result = applyOperations(source, source.currentRevisionId, [{ type: "set_focus", sceneId: scene(source).id, focus: { preset: "box", bounds: { x: 0, y: 0, width: 1, height: 1 }, startMs: 0, endMs: 10000 } }]);
    expect(result.ok).toBe(true);
  });

  it("upserts title and callout overlays at their range boundaries", () => {
    const source = project();
    const first = scene(source);
    const title = { id: "title-1", sceneId: first.id, kind: "title" as const, text: "Filter releases", placement: "top" as const, startMs: 0, endMs: 10000 };
    const result = applyOperations(source, source.currentRevisionId, [{ type: "set_title", overlay: title }, { type: "set_callout", overlay: { ...title, id: "callout-1", kind: "callout" as const, text: "Results update", placement: "target" as const } }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.overlays).toMatchObject({ "title-1": title, "callout-1": expect.any(Object) });
  });

  it("sets a valid crossfade transition and rejects a non-neighbor mutation", () => {
    const source = project();
    const result = applyOperations(source, source.currentRevisionId, [{ type: "set_transition", sceneId: scene(source).id, transition: { type: "crossfade", durationMs: 250 } }]);
    expect(result.ok).toBe(true);
    const invalid = applyOperations(source, source.currentRevisionId, [{ type: "set_transition", sceneId: "missing-scene", transition: { type: "crossfade", durationMs: 250 } }]);
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
  });

  it("rejects a stale parent and leaves the source project untouched", () => {
    const source = project();
    const before = JSON.stringify(source);
    expect(applyOperations(source, "revision-stale", [])).toMatchObject({ ok: false, code: "STALE_REVISION" });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("rejects an invalid batch atomically with no partial accepted revision", () => {
    const source = project();
    const before = semanticHash(source);
    const result = applyOperations(source, source.currentRevisionId, [
      { type: "trim_scene", sceneId: scene(source).id, sourceInMs: 100, sourceOutMs: 9000 },
      { type: "set_speed", sceneId: "missing-scene", speed: 1.25 },
    ]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
    expect(semanticHash(source)).toBe(before);
    expect(source.revisions).toHaveLength(1);
  });

  it("replays ordered inputs to the same semantic manifest hash", () => {
    const source = project();
    const operations = [{ type: "trim_scene" as const, sceneId: scene(source).id, sourceInMs: 100, sourceOutMs: 9000 }, { type: "set_speed" as const, sceneId: scene(source).id, speed: 1.25 as const }];
    const first = applyOperations(source, source.currentRevisionId, operations);
    const second = applyOperations(source, source.currentRevisionId, operations);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(semanticHash(first.project)).toBe(semanticHash(second.project));
      expect(first.project.currentRevisionId).toBe(second.project.currentRevisionId);
    }
  });
});
