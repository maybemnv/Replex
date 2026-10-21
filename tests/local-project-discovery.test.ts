import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/service/executor.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { runProjectsCli } from "../src/service/projects-cli.js";

describe("persistent host project discovery", () => {
  let root: string;
  let executor: LocalExecutor;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "replex-project-list-"));
    executor = new LocalExecutor({ workspaceRoot: root });
    await executor.start();
  });
  afterEach(async () => { await executor.stop(); await rm(root, { recursive: true, force: true }); });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");

  it("discovers projects after restart from disk and reflects the latest committed job revision", async () => {
    const first = await executor.createProject({ contractVersion: "v1", idempotencyKey: "first", name: "First" });
    const second = await executor.createProject({ contractVersion: "v1", idempotencyKey: "second", name: "Second" });
    const submitted = await executor.submitApplyOperations({
      contractVersion: "v1", idempotencyKey: "title", projectId: first.projectId, baseRevisionId: first.revisionId, actor: "user",
      operations: [{ type: "add_text_layer", layer: { id: "title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 1000, properties: { text: "Persisted" }, keyframes: [] } }],
    });
    const completed = await executor.waitForJob(submitted.id);
    if (completed.state !== "succeeded") throw new Error("edit failed");
    await executor.stop();
    executor = new LocalExecutor({ workspaceRoot: root });
    await executor.start();
    expect(await executor.getJob(submitted.id)).toEqual(completed);
    const catalog = await new LocalProjectStore(root).listProjects();
    expect(catalog).toEqual({ unavailableCount: 0, projects: [
      { projectId: first.projectId, name: "First", currentRevisionId: completed.result.revisionId },
      { projectId: second.projectId, name: "Second", currentRevisionId: second.revisionId },
    ].sort((a, b) => a.projectId < b.projectId ? -1 : 1) });
    const stdout: string[] = [];
    expect(await runProjectsCli(["--workspace", root], { stdout: (text) => stdout.push(text), stderr: () => undefined })).toBe(0);
    expect(JSON.parse(stdout[0])).toEqual(catalog);
    expect(stdout[0]).not.toContain(root);
  });

  it("reports corrupt and linked entries while preserving intact projects", async () => {
    const good = await executor.createProject({ contractVersion: "v1", idempotencyKey: "good", name: "Good" });
    const bad = await executor.createProject({ contractVersion: "v1", idempotencyKey: "bad", name: "Bad" });
    const badPath = join(root, "projects", hash(bad.projectId), "project.json");
    await writeFile(badPath, "broken");
    await symlink(join(root, "projects", hash(good.projectId)), join(root, "projects", "a".repeat(64)));
    expect(await new LocalProjectStore(root).listProjects()).toEqual({
      projects: [{ projectId: good.projectId, name: "Good", currentRevisionId: good.revisionId }], unavailableCount: 2,
    });
    expect(await readFile(badPath, "utf8")).toBe("broken");
  });

  it("rejects a manifest copied under a different identity and a linked projects root", async () => {
    const created = await executor.createProject({ contractVersion: "v1", idempotencyKey: "identity", name: "Identity" });
    const directory = join(root, "projects", hash(created.projectId));
    await rename(directory, join(root, "projects", "b".repeat(64)));
    expect(await new LocalProjectStore(root).listProjects()).toEqual({ projects: [], unavailableCount: 1 });
    await rename(join(root, "projects"), join(root, "outside-projects"));
    await symlink(join(root, "outside-projects"), join(root, "projects"));
    await expect(new LocalProjectStore(root).listProjects()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });

  it("returns an empty catalog for a new workspace and sanitizes CLI errors", async () => {
    expect(await new LocalProjectStore(root).listProjects()).toEqual({ projects: [], unavailableCount: 0 });
    const stderr: string[] = [];
    const io = { stdout: () => undefined, stderr: (text: string) => stderr.push(text) };
    expect(await runProjectsCli([], io)).toBe(1);
    const file = join(root, "file");
    await writeFile(file, "file");
    expect(await runProjectsCli(["--workspace", file], io)).toBe(1);
    expect(stderr.join("")).not.toContain(root);
    expect(stderr.join("")).not.toContain("stack");
  });

  it("does not treat partial project creation as a usable project", async () => {
    await mkdir(join(root, "projects", "c".repeat(64)), { recursive: true });
    expect(await new LocalProjectStore(root).listProjects()).toEqual({ projects: [], unavailableCount: 1 });
  });
});
