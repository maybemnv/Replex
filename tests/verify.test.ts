import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { createProject } from "../src/project.js";
import { verifyProject } from "../src/verify.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "replex-verify-"));
  await mkdir(join(root, "captures"), { recursive: true });
  const bodies = ["one", "two", "three"];
  for (const [index, body] of bodies.entries()) await writeFile(join(root, "captures", `${index}.mp4`), body);
  const project = createProject({
    projectId: "verify-project",
    brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
    environment: normalEnvironment("http://127.0.0.1:4173"),
    flow: normalFlow("http://127.0.0.1:4173"),
    captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({
      id: `capture-${index}`,
      sceneKey,
      path: `captures/${index}.mp4`,
      durationMs: 10000,
      sha256: createHash("sha256").update(bodies[index]).digest("hex"),
    })),
  });
  return { root, project };
}

describe("project verification", () => {
  it("authorizes a complete, hash-matched 30-second scene revision", async () => {
    const { root, project } = await fixture();
    try {
      const result = verifyProject(project, root);
      expect(result).toMatchObject({ passed: true, phase: "scene" });
      expect(result.checks.every((check) => check.passed)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the earliest causal failure and blocks invalid media", async () => {
    const { root, project } = await fixture();
    try {
      const missing = { ...project, captures: { ...project.captures, "capture-0": { ...project.captures["capture-0"], path: "captures/missing.mp4" } } };
      const result = verifyProject(missing, root);
      expect(result).toMatchObject({ passed: false, firstCause: "capture" });
      expect(result.checks).toContainEqual(expect.objectContaining({ code: "CAPTURE_EXISTS", passed: false }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
