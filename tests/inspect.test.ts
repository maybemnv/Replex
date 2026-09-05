import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      const result = inspectProject(project(), root, { kind: "inspect_project" });
      expect(result).toMatchObject({ ok: true, truncated: false });
      if (!result.ok) return;
      expect(result.summary).toContain("inspect-project");
      expect(result.summary.length).toBeLessThanOrEqual(1000);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ id: "capture:capture-0", path: "captures/0.mp4" }));
      expect(await readFile(join(root, "logs", "disclosures.jsonl"), "utf8")).toContain('"tool":"inspect_project"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses fixed IDs and refuses paths, raw traces, and missing evidence", () => {
    const source = project();
    expect(inspectProject(source, "unused", { kind: "inspect_scene", sceneId: source.scenes[0].id })).toMatchObject({ ok: true });
    expect(inspectProject(source, "unused", { kind: "inspect_capture", captureId: "missing" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(inspectProject(source, "unused", { kind: "inspect_browser_trace" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(inspectProject(source, "unused", { kind: "inspect_project", path: "../secrets" } as unknown as { kind: "inspect_project" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("redacts secret-shaped text before it becomes inspection output", () => {
    const source = project();
    const result = inspectProject({ ...source, brief: { ...source.brief, message: "token=not-for-model" } }, "unused", { kind: "inspect_project" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.summary).not.toContain("not-for-model");
  });
});
