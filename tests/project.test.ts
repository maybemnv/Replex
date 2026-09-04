import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { createProject, loadProject, semanticHash, writeRevision, type ProjectInput } from "../src/project.js";

const origin = "http://127.0.0.1:4173";

function project() {
  return createProject({
    projectId: "demo-project",
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

describe("project persistence", () => {
  it("derives stable scene IDs from only the project and approved scene key", () => {
    const first = project();
    const second = project();

    expect(first.scenes.map((scene) => scene.id)).toEqual(second.scenes.map((scene) => scene.id));
    expect(first.scenes.map((scene) => scene.id)).not.toEqual(projectWithId("other-project").scenes.map((scene) => scene.id));
  });

  it("hashes semantic state independently of revision metadata", () => {
    const first = project();
    const second = { ...project(), currentRevisionId: "revision-later", revision: { id: "revision-later", manifestSha256: "ignored" } };

    expect(semanticHash(first)).toBe(semanticHash(second));
  });

  it("keeps the last complete project after an interrupted atomic write", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-project-"));
    const first = project();
    const next = { ...project(), currentRevisionId: "revision-next", revision: { id: "revision-next", manifestSha256: "pending" } };

    try {
      await writeRevision(root, first);
      await expect(writeRevision(root, next, { interruptBeforeCommit: true })).rejects.toThrow("simulated interruption");
      await expect(loadProject(root)).resolves.toEqual(first);
      await expect(readFile(join(root, "project.json"), "utf8")).resolves.toContain('"demo-project"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      { id: "capture-open", sceneKey: "open-demo", sourcePath: "captures/open.webm", durationMs: 10000 },
      { id: "capture-filter", sceneKey: "open-filter", sourcePath: "captures/filter.webm", durationMs: 10000 },
      { id: "capture-apply", sceneKey: "apply-filter", sourcePath: "captures/apply.webm", durationMs: 10000 },
    ],
  };
}
