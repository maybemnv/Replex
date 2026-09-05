import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { inspectProject } from "../src/inspect.js";
import { createProject } from "../src/project.js";

function project() {
  return createProject({
    projectId: "inspect-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment("http://127.0.0.1:4173"),
    flow: normalFlow("http://127.0.0.1:4173"),
    captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 10000 })),
  });
}

describe("bounded inspection", () => {
  it("returns a capped project summary and disclosure audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-"));
    try {
      const source = project();
      const result = inspectProject(source, root, { kind: "inspect_project" });
      expect(result).toMatchObject({ ok: true, truncated: false });
      if (!result.ok) return;
      expect(result.summary).toContain("inspect-project");
      expect(result.summary.length).toBeLessThanOrEqual(1000);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ id: "capture:capture-0", path: "captures/0.mp4" }));
      expect(result.details?.scenes).toContainEqual(expect.objectContaining({ id: source.scenes[0].id, sceneKey: "open-demo", checkpointActionId: "open-release-page" }));
      expect(await readFile(join(root, "logs", "disclosures.jsonl"), "utf8")).toContain('"tool":"inspect_project"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses fixed IDs and refuses paths while requiring named evidence", async () => {
    const source = project();
    const flow = inspectProject(source, "unused", { kind: "inspect_flow" });
    expect(flow).toMatchObject({ ok: true, details: { flow: { steps: expect.arrayContaining([expect.objectContaining({ id: "open-release-page", checkpoint: expect.objectContaining({ kind: "visible" }) })]) } } });
    const scene = inspectProject(source, "unused", { kind: "inspect_scene", sceneId: source.scenes[0].id });
    expect(scene).toMatchObject({ ok: true, details: { scenes: [expect.objectContaining({ id: source.scenes[0].id, actionIds: ["open-release-page"], checkpoint: expect.objectContaining({ expected: "Release Replay Demo" }) })] } });
    expect(inspectProject(source, "unused", { kind: "inspect_capture", captureId: "missing" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(inspectProject(source, "unused", { kind: "inspect_browser_trace" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(inspectProject(source, "unused", { kind: "inspect_project", path: "../secrets" } as unknown as { kind: "inspect_project" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("discloses only named trace, screenshot, and verification handles", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-evidence-"));
    try {
      const source = project();
      await mkdir(join(root, "traces"), { recursive: true });
      await mkdir(join(root, "screenshots"), { recursive: true });
      await mkdir(join(root, "verification"), { recursive: true });
      await writeFile(join(root, "traces", "trace.zip"), "trace");
      await writeFile(join(root, "screenshots", "open-demo-after.png"), "image");
      await writeFile(join(root, "verification", "revision-0.json"), "{}");
      expect(inspectProject(source, root, { kind: "inspect_browser_trace" })).toMatchObject({ ok: true, artifacts: [{ id: "trace:latest" }] });
      expect(inspectProject(source, root, { kind: "inspect_screenshot", sceneId: source.scenes[0].id })).toMatchObject({ ok: true, artifacts: [{ id: `screenshot:${source.scenes[0].id}:after` }] });
      expect(inspectProject(source, root, { kind: "inspect_verification_results" })).toMatchObject({ ok: true, artifacts: [{ id: "verification:revision-0" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns bounded verification check detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-inspect-verification-"));
    try {
      const source = project();
      await mkdir(join(root, "verification"), { recursive: true });
      await writeFile(join(root, "verification", "revision-0.json"), JSON.stringify({ id: "verification-revision-0", phase: "scene", passed: false, firstCause: "capture", checks: [{ code: "CAPTURE_EXISTS", passed: false, detail: "Capture is missing" }] }));
      expect(inspectProject(source, root, { kind: "inspect_verification_results" })).toMatchObject({ ok: true, details: { verification: { passed: false, firstCause: "capture", failedChecks: 1, checks: [expect.objectContaining({ code: "CAPTURE_EXISTS", passed: false })] } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts secret-shaped text before it becomes inspection output", () => {
    const source = project();
    const result = inspectProject({ ...source, brief: { ...source.brief, message: "token=not-for-model" } }, "unused", { kind: "inspect_project" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.summary).not.toContain("not-for-model");
  });
});
