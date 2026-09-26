import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalExecutor } from "../src/service/executor.js";
import { ffmpegPath, mediaAvailable } from "./media.js";

describe("local asset import jobs", () => {
  let roots: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  async function setup() {
    const workspace = await mkdtemp(join(tmpdir(), "replex-v2-702-workspace-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-v2-702-source-"));
    roots.push(workspace, sourceRoot);
    const sourcePath = join(sourceRoot, "fixture.mp4");
    const fixture = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=8:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath], { windowsHide: true, shell: false, timeout: 30_000 });
    expect(fixture.status, fixture.stderr?.toString()).toBe(0);
    const executor = new LocalExecutor({ workspaceRoot: workspace });
    await executor.start();
    const project = await executor.createProject({ contractVersion: "v1", idempotencyKey: "create-import-project", name: "Import job" });
    return { executor, project, sourceRoot, sourcePath };
  }

  it.skipIf(!mediaAvailable)("imports deterministic media through the service and publishes one asset revision", async () => {
    const { executor, project, sourceRoot, sourcePath } = await setup();
    const source = await executor.authorizeLocalImport(sourcePath, [sourceRoot]);
    expect(source).toMatchObject({ token: expect.any(String), filename: "fixture.mp4" });
    const submitted = await executor.submitImportAsset({ contractVersion: "v1", idempotencyKey: "import-fixture", projectId: project.projectId, baseRevisionId: project.revisionId, source: { kind: "local_token", ref: source.token }, declaredFilename: source.filename });
    const completed = await executor.waitForJob(submitted.id, 30_000);
    expect(completed).toMatchObject({ state: "succeeded", result: { assetId: expect.any(String) } });
    if (completed.state !== "succeeded") throw new Error("import did not succeed");
    const snapshot = await executor.openProject({ contractVersion: "v1", idempotencyKey: "open-imported", projectId: project.projectId, revisionId: completed.result.revisionId ?? project.revisionId });
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.summary.currentRevisionId).not.toBe(project.revisionId);
    expect((await executor.submitImportAsset({ contractVersion: "v1", idempotencyKey: "import-fixture", projectId: project.projectId, baseRevisionId: project.revisionId, source: { kind: "local_token", ref: source.token }, declaredFilename: source.filename })).id).toBe(submitted.id);
    await executor.stop();
  }, 60_000);

  it.skipIf(!mediaAvailable)("rejects unauthorized, corrupt, and stale imports without canonical mutation", async () => {
    const { executor, project, sourceRoot, sourcePath } = await setup();
    await expect(executor.submitImportAsset({ contractVersion: "v1", idempotencyKey: "unauthorized", projectId: project.projectId, baseRevisionId: project.revisionId, source: { kind: "local_token", ref: "not-authorized" }, declaredFilename: "fixture.mp4" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await writeFile(sourcePath, "not media");
    const corrupt = await executor.authorizeLocalImport(sourcePath, [sourceRoot]);
    const corruptJob = await executor.submitImportAsset({ contractVersion: "v1", idempotencyKey: "corrupt", projectId: project.projectId, baseRevisionId: project.revisionId, source: { kind: "local_token", ref: corrupt.token }, declaredFilename: corrupt.filename });
    expect(await executor.waitForJob(corruptJob.id, 30_000)).toMatchObject({ state: "failed", error: { code: "ASSET_UNSUPPORTED" } });
    const afterCorrupt = await executor.openProject({ contractVersion: "v1", idempotencyKey: "open-corrupt", projectId: project.projectId, revisionId: project.revisionId });
    expect(afterCorrupt.summary.currentRevisionId).toBe(project.revisionId);
    expect(afterCorrupt.assets).toHaveLength(0);

    vi.useFakeTimers();
    const cancelSource = await executor.authorizeLocalImport(sourcePath, [sourceRoot]);
    const cancelJob = await executor.submitImportAsset({ contractVersion: "v1", idempotencyKey: "cancelled", projectId: project.projectId, baseRevisionId: project.revisionId, source: { kind: "local_token", ref: cancelSource.token }, declaredFilename: cancelSource.filename });
    await executor.cancelJob({ contractVersion: "v1", idempotencyKey: "cancel-import", projectId: project.projectId, jobId: cancelJob.id });
    await vi.runAllTimersAsync();
    expect((await executor.getJob(cancelJob.id)).state).toBe("cancelled");
    vi.useRealTimers();

    const staleSource = await executor.authorizeLocalImport(sourcePath, [sourceRoot]);
    const edit = await executor.submitApplyOperations({ contractVersion: "v1", idempotencyKey: "advance", projectId: project.projectId, baseRevisionId: project.revisionId, actor: "user", operations: [{ type: "add_text_layer", layer: { id: "title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 1000, properties: { text: "advance" }, keyframes: [] } }] });
    await executor.waitForJob(edit.id, 30_000);
    const stale = await executor.submitImportAsset({ contractVersion: "v1", idempotencyKey: "stale", projectId: project.projectId, baseRevisionId: project.revisionId, source: { kind: "local_token", ref: staleSource.token }, declaredFilename: staleSource.filename });
    expect(await executor.waitForJob(stale.id, 30_000)).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT" } });
    await executor.stop();
  }, 90_000);
});
