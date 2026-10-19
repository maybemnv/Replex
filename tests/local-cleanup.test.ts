import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectV2 } from "../src/operations-v2.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { cleanupAbandonedStaging } from "../src/service/cleanup.js";
import { LocalExecutorServer } from "../src/service/http.js";

describe("abandoned job staging cleanup", () => {
  let root: string;
  let projectRoot: string;
  let server: LocalExecutorServer | undefined;
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "replex-cleanup-"));
    const store = new LocalProjectStore(root);
    await store.create(createProjectV2({ projectId: "cleanup-project", brief: {}, width: 320, height: 180, fps: 24, durationMs: 1000 }), "a".repeat(64), "Cleanup");
    projectRoot = await store.projectRoot("cleanup-project");
  });
  afterEach(async () => { await server?.stop(); server = undefined; await rm(root, { recursive: true, force: true }); });
  async function stage(name: string, stale = true) {
    const path = join(projectRoot, ".replex-staging", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "temporary"), "temporary bytes");
    if (stale) { await utimes(join(path, "temporary"), old, old); await utimes(path, old, old); }
    return path;
  }

  it("removes only old recognized staging trees and preserves canonical files, capture evidence, outputs, and fresh work", async () => {
    await stage("import-Ab1234");
    await stage("a".repeat(16) + "-Cd5678");
    await stage("motion/jobs/12345678-1234-1234-1234-123456789abc");
    await stage("import-Fresh1", false);
    await stage("unknown-stage");
    for (const name of ["assets/source", "captures/run/evidence", "renders/final.mp4"]) {
      const path = join(projectRoot, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "preserve");
    }
    const manifest = await readFile(join(projectRoot, "project.json"), "utf8");
    expect(await cleanupAbandonedStaging(root, now)).toMatchObject({ removedDirectories: 3, unavailableProjects: 0 });
    expect(await readdir(join(projectRoot, ".replex-staging"))).toEqual(expect.arrayContaining(["import-Fresh1", "unknown-stage", "motion"]));
    expect(await readFile(join(projectRoot, "project.json"), "utf8")).toBe(manifest);
    for (const name of ["assets/source", "captures/run/evidence", "renders/final.mp4"]) expect(await readFile(join(projectRoot, name), "utf8")).toBe("preserve");
  });

  it("refuses links and recently changed descendants even under an old staging directory", async () => {
    const canonical = join(projectRoot, "canonical.txt");
    await writeFile(canonical, "keep");
    const symbolic = await stage("import-Symb12");
    await symlink(canonical, join(symbolic, "linked")); await utimes(symbolic, old, old);
    const hard = await stage("import-Hard12");
    await link(canonical, join(hard, "linked")); await utimes(hard, old, old);
    const freshChild = await stage("import-Child1");
    await writeFile(join(freshChild, "new"), "active"); await utimes(freshChild, old, old);
    expect(await cleanupAbandonedStaging(root, now)).toMatchObject({ removedDirectories: 0 });
    expect(await readFile(canonical, "utf8")).toBe("keep");
  });

  it("does not follow a staging root link and performs startup cleanup only after acquiring the workspace lease", async () => {
    const abandoned = await stage("import-Stale1");
    server = new LocalExecutorServer({ workspaceRoot: root });
    await server.start();
    await expect(readFile(join(abandoned, "temporary"))).rejects.toMatchObject({ code: "ENOENT" });
    const next = await stage("import-Stale2");
    const second = new LocalExecutorServer({ workspaceRoot: root });
    await expect(second.start()).rejects.toMatchObject({ code: "EXECUTOR_OFFLINE" });
    await second.stop();
    expect(await readFile(join(next, "temporary"), "utf8")).toBe("temporary bytes");
    await server.stop(); server = undefined;
    await rm(join(projectRoot, ".replex-staging"), { recursive: true });
    await symlink(join(projectRoot, "renders"), join(projectRoot, ".replex-staging"));
    expect(await cleanupAbandonedStaging(root, now)).toMatchObject({ removedDirectories: 0 });
  });
});
