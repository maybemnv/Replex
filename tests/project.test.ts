import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { ProjectSchema } from "../src/schema.js";
import { captureInputFromResult, createProject, deriveCaptureId, loadProject, normalizeCapturePath, semanticHash, stableSceneId, writeRevision, type ProjectInput } from "../src/project.js";

const origin = "http://127.0.0.1:4173";

function project() {
  return createProject({
    projectId: "demo-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment(origin),
    flow: normalFlow(origin),
    captures: [
      { id: "capture-open", sceneKey: "open-demo", sourcePath: "captures/open.webm", durationMs: 10000, sha256: "a".repeat(64) },
      { id: "capture-filter", sceneKey: "open-filter", sourcePath: "captures/filter.webm", durationMs: 10000, sha256: "b".repeat(64) },
      { id: "capture-apply", sceneKey: "apply-filter", sourcePath: "captures/apply.webm", durationMs: 10000, sha256: "c".repeat(64) },
    ],
  });
}

describe("project persistence", () => {
  it("matches the v1 semantic hash golden while ignoring volatile revision and output metadata", async () => {
    const golden = ProjectSchema.parse(JSON.parse(await readFile(new URL("./golden/project-v1.json", import.meta.url), "utf8")));
    const changed = {
      ...golden,
      currentRevisionId: "revision-later",
      revisions: [{ ...golden.revisions[0], id: "revision-later", createdAt: "2026-09-02T00:00:00.000Z", manifestSha256: "f".repeat(64) }],
      outputs: [{
        id: "output-later",
        revisionId: "revision-later",
        renderJobSha256: "e".repeat(64),
        path: "renders/later.mp4",
        ffprobe: { durationMs: 30000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" },
        verificationId: "verification-later",
      }],
    };

    expect(semanticHash(golden)).toBe("92f281939d1b6ce4ca12f6f74e4a03747e9ab1dde94a59703e6958717089970f");
    expect(semanticHash(changed)).toBe(semanticHash(golden));
  });

  it("round-trips the strict canonical manifest and rejects unknown fields", () => {
    const first = project();
    const roundTrip = ProjectSchema.parse(JSON.parse(JSON.stringify(first)));

    expect(roundTrip).toEqual(first);
    expect(roundTrip).toMatchObject({
      schemaVersion: 1,
      environment: expect.any(Object),
      flow: expect.any(Object),
      captures: expect.any(Object),
      overlays: {},
      outputs: [],
      revisions: expect.any(Array),
    });
    expect(() => ProjectSchema.parse({ ...first, unknown: true })).toThrow();
  });

  it("rejects ungrounded capture provenance and dangling revisions", () => {
    const first = project();
    expect(() => createProject({ ...projectInput(), projectId: "bad-provenance", captures: [{ id: "capture-bad", sceneKey: "open-demo", sourcePath: "captures/open.webm", durationMs: 10000, sha256: "a".repeat(64), actionIds: ["wrong-action"] }] })).toThrow("capture actions do not match approved flow");
    expect(() => ProjectSchema.parse({ ...first, currentRevisionId: "missing" })).toThrow("current revision does not exist");
    expect(() => ProjectSchema.parse({ ...first, captures: { ...first.captures, "capture-open": { ...first.captures["capture-open"], path: "../outside.mp4" } } })).toThrow("project-relative");
  });

  it("derives stable scene IDs from only the project and approved scene key", () => {
    const first = project();
    const second = project();

    expect(first.scenes.map((scene) => scene.id)).toEqual(second.scenes.map((scene) => scene.id));
    expect(first.scenes.map((scene) => scene.id)).not.toEqual(projectWithId("other-project").scenes.map((scene) => scene.id));
    expect(first.scenes[0].id).toBe(stableSceneId("demo-project", "open-demo"));
    expect(first.scenes[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps flow, action, and scene IDs while reruns create new capture and run IDs", () => {
    const first = createProject(projectInputWithCapture("capture-run-one", "run-one"));
    const second = createProject(projectInputWithCapture("capture-run-two", "run-two"));

    expect(second.flow.id).toBe(first.flow.id);
    expect(second.flow.steps.map((step) => step.id)).toEqual(first.flow.steps.map((step) => step.id));
    expect(second.scenes.map((scene) => scene.id)).toEqual(first.scenes.map((scene) => scene.id));
    expect(Object.keys(second.captures)).not.toEqual(Object.keys(first.captures));
    expect(Object.values(second.captures).map((capture) => capture.runId)).toEqual(["run-two", "run-two", "run-two"]);
  });

  it("hashes semantic state independently of revision metadata", () => {
    const first = project();
    const second = { ...project(), currentRevisionId: "revision-later", revision: { id: "revision-later", manifestSha256: "ignored" } };

    expect(semanticHash(first)).toBe(semanticHash(second));
  });

  it("keeps the last complete project after an interrupted atomic write", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-project-"));
    const first = project();
    const baseline = project();
    const next = {
      ...baseline,
      currentRevisionId: "revision-next",
      revisions: [...baseline.revisions, {
        id: "revision-next",
        parentId: "revision-0",
        actor: "operator" as const,
        operationIds: [],
        manifestSha256: semanticHash(baseline),
        createdAt: "2026-09-02T00:00:00.000Z",
      }],
    };

    try {
      await writeRevision(root, first);
      await expect(writeRevision(root, next, { interruptBeforeCommit: true })).rejects.toThrow("simulated interruption");
      await expect(loadProject(root)).resolves.toEqual(first);
      await expect(readFile(join(root, "project.json"), "utf8")).resolves.toContain('"demo-project"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("relativizes absolute capture outputs under the project root", () => {
    const root = join(tmpdir(), "replex-project-root");
    expect(normalizeCapturePath(root, join(root, "captures", "open.webm"))).toBe("captures/open.webm");
    expect(() => normalizeCapturePath(root, join(tmpdir(), "elsewhere", "open.webm"))).toThrow("escapes the project root");
    expect(() => normalizeCapturePath(root, "../outside.webm")).toThrow("project-relative");
  });

  it("binds derived capture IDs to immutable media", () => {
    const first = deriveCaptureId("open-demo", "run-one", "a".repeat(64));
    expect(deriveCaptureId("open-demo", "run-one", "a".repeat(64))).toBe(first);
    expect(deriveCaptureId("open-demo", "run-one", "b".repeat(64))).not.toBe(first);
    expect(deriveCaptureId("open-demo", "run-two", "a".repeat(64))).not.toBe(first);

    const adapted = captureInputFromResult(resolve(tmpdir(), "replex-project-root"), {
      runPath: join(resolve(tmpdir(), "replex-project-root"), "run-id", "run.json"),
      captures: [{
        sceneKey: "open-demo",
        sourcePath: join(resolve(tmpdir(), "replex-project-root"), "run-id", "captures", "open-demo.webm"),
        sha256: "a".repeat(64),
        width: 1920,
        height: 1080,
        durationMs: 10000,
        runId: "run-one",
        actionIds: ["open-release-page"],
        checkpointActionId: "open-release-page",
      }],
    });
    expect(adapted.captures[0].id).toBe(deriveCaptureId("open-demo", "run-one", "a".repeat(64)));
    expect(adapted.captures[0].path).toBe("run-id/captures/open-demo.webm");
  });
});

function projectWithId(projectId: string) {
  return createProject({ ...projectInput(), projectId });
}

function projectInput(): Omit<ProjectInput, "projectId"> {
  return {
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment(origin),
    flow: normalFlow(origin),
    captures: [
      { id: "capture-open", sceneKey: "open-demo", sourcePath: "captures/open.webm", durationMs: 10000, sha256: "a".repeat(64) },
      { id: "capture-filter", sceneKey: "open-filter", sourcePath: "captures/filter.webm", durationMs: 10000, sha256: "b".repeat(64) },
      { id: "capture-apply", sceneKey: "apply-filter", sourcePath: "captures/apply.webm", durationMs: 10000, sha256: "c".repeat(64) },
    ],
  };
}

function projectInputWithCapture(capturePrefix: string, runId: string): ProjectInput {
  return {
    projectId: "demo-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment(origin),
    flow: normalFlow(origin),
    captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({
      id: `${capturePrefix}-${index}`,
      sceneKey,
      sourcePath: `captures/${sceneKey}.webm`,
      durationMs: 10000,
      runId,
      actionIds: normalFlow(origin).steps.filter((step) => step.sceneKey === sceneKey).map((step) => step.id),
      checkpointActionId: normalFlow(origin).steps.filter((step) => step.sceneKey === sceneKey).at(-1)?.id,
      sha256: `${String(index + 1).repeat(64)}`,
      width: 1920,
      height: 1080,
      fps: 30,
      capturedAt: "2026-09-01T00:00:00.000Z",
    })),
  };
}
