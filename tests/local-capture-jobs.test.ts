import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView } from "../src/service-contract/index.js";
import { LocalExecutor } from "../src/service/executor.js";
import { LocalProjectService } from "../src/service/local.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { startReleaseFixture } from "./browser-fixture.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function untilRunning(executor: LocalExecutor, jobId: string): Promise<JobView> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await executor.getJob(jobId);
    if (job.state !== "queued") return job;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`job ${jobId} never started`);
}

describe("local browser capture jobs", () => {
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("captures an approved flow into immutable scene assets, registers it once, and replays without capturing", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-capture-jobs-"));
    roots.push(workspaceRoot);
    const media = { ffmpegPath, ffprobePath };
    const executor = new LocalExecutor({ workspaceRoot, media, browserTargets: fixture.browserTargets });
    await executor.start();
    const project = await executor.createProject({ contractVersion: "v1", idempotencyKey: "capture-create", name: "Capture" });
    const projectId = project.projectId;
    const projectRoot = join(workspaceRoot, "projects", sha256(projectId));
    const request = {
      contractVersion: "v1" as const, idempotencyKey: "capture-1", projectId, baseRevisionId: project.revisionId,
      flowId: fixture.flow.id, approved: true as const, executionTarget: "local" as const,
    };
    let firstRevisionId: string;
    let firstAssetId: string;
    try {
      expect(executor.capabilities()).toMatchObject({
        availableCommands: expect.arrayContaining(["start_browser_capture"]), jobKinds: expect.arrayContaining(["browser_capture"]),
      });
      const submitted = await executor.submitCapture(request);
      expect(submitted).toMatchObject({ kind: "browser_capture", state: "queued", baseRevisionId: project.revisionId });
      const job = await executor.waitForJob(submitted.id, 120_000);
      expect(job, JSON.stringify(job)).toMatchObject({ state: "succeeded", result: { revisionId: expect.any(String), assetId: expect.any(String) } });
      if (job.state !== "succeeded") throw new Error("capture failed");
      firstRevisionId = job.result.revisionId!;
      firstAssetId = job.result.assetId!;

      const store = new LocalProjectStore(workspaceRoot);
      const captured = await store.current(projectId);
      expect(captured.browser?.flows[fixture.flow.id]).toEqual(fixture.flow);
      const browserAssets = Object.values(captured.assets).filter((asset) => asset.type === "browser_capture");
      const sceneOf = (asset: (typeof browserAssets)[number]) => asset.provenance.kind === "browser" ? asset.provenance.sceneKey : undefined;
      expect(browserAssets.map(sceneOf).sort()).toEqual(["apply-filter", "open-demo", "open-filter"]);
      // The result names the flow's first scene.
      expect(sceneOf(captured.assets[firstAssetId]!)).toBe("open-demo");
      for (const asset of browserAssets) {
        expect(sha256(await readFile(join(projectRoot, ...asset.path!.split("/"))))).toBe(asset.sha256);
        expect(asset.provenance).toMatchObject({ kind: "browser", flowId: fixture.flow.id });
      }
      const log = await store.operationLog(projectId);
      expect(log.map(({ input }) => input.type)).toEqual(["register_browser_flow", "import_asset", "import_asset", "import_asset"]);
      expect(new Set(log.map(({ actor, resultRevisionId }) => `${actor}:${resultRevisionId}`))).toEqual(new Set([`user:${firstRevisionId}`]));
      expect((await executor.eventsAfter(projectId)).events.some((event) => event.type === "revision.created" && event.revision.id === firstRevisionId)).toBe(true);

      // A second capture of the registered flow adds a new run's scenes without registering the flow again.
      const again = await executor.waitForJob((await executor.submitCapture({ ...request, idempotencyKey: "capture-2", baseRevisionId: firstRevisionId })).id, 120_000);
      expect(again, JSON.stringify(again)).toMatchObject({ state: "succeeded" });
      if (again.state !== "succeeded") throw new Error("second capture failed");
      const secondLog = (await store.operationLog(projectId)).slice(log.length);
      expect(secondLog.map(({ input }) => input.type)).toEqual(["import_asset", "import_asset", "import_asset"]);
      expect(Object.values((await store.current(projectId)).assets).filter((asset) => asset.type === "browser_capture")).toHaveLength(6);

      const stale = await executor.waitForJob((await executor.submitCapture({ ...request, idempotencyKey: "capture-stale" })).id, 60_000);
      expect(stale).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT" } });
      const unknown = await executor.waitForJob((await executor.submitCapture({ ...request, idempotencyKey: "capture-unknown", baseRevisionId: again.result.revisionId!, flowId: "flow-unknown" })).id, 60_000);
      expect(unknown).toMatchObject({ state: "failed", error: { code: "CAPABILITY_UNAVAILABLE" } });
    } finally {
      await executor.stop();
    }

    // A restart between the commit and the saved job state replays the request without driving the browser.
    const runsBefore = await readdir(join(projectRoot, "captures"));
    const service = new LocalProjectService({ workspaceRoot, media, browserTargets: fixture.browserTargets });
    const replayed = await service.startCapture(request, new AbortController().signal);
    expect(replayed).toMatchObject({ ok: true, revisionId: firstRevisionId, assetId: firstAssetId });
    expect(await readdir(join(projectRoot, "captures"))).toEqual(runsBefore);
  }, 300_000);

  it.skipIf(!mediaAvailable)("reruns a retryable capture failure when it is resubmitted with the same key", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-capture-retry-"));
    roots.push(workspaceRoot);
    const executor = new LocalExecutor({ workspaceRoot, media: { ffmpegPath, ffprobePath }, browserTargets: fixture.browserTargets });
    await executor.start();
    try {
      const project = await executor.createProject({ contractVersion: "v1", idempotencyKey: "retry-create", name: "Retry capture" });
      const request = {
        contractVersion: "v1" as const, idempotencyKey: "retry-capture", projectId: project.projectId, baseRevisionId: project.revisionId,
        flowId: fixture.flow.id, approved: true as const, executionTarget: "local" as const,
      };
      fixture.failResets(1);
      const failed = await executor.waitForJob((await executor.submitCapture(request)).id, 60_000);
      expect(failed).toMatchObject({ state: "failed", error: { code: "BROWSER_CAPTURE_FAILED", retryable: true } });

      const resubmitted = await executor.submitCapture(request);
      expect(resubmitted).toMatchObject({ id: failed.id, state: "queued", cancellable: true });
      expect(resubmitted).not.toHaveProperty("error");
      const retried = await executor.waitForJob(resubmitted.id, 120_000);
      expect(retried, JSON.stringify(retried)).toMatchObject({ id: failed.id, state: "succeeded", result: { assetId: expect.any(String) } });
      // A succeeded job stays terminal on another resubmission.
      expect(await executor.submitCapture(request)).toEqual(retried);

      // A non-retryable failure is not rerun.
      const stale = await executor.waitForJob((await executor.submitCapture({ ...request, idempotencyKey: "retry-stale" })).id, 60_000);
      expect(stale).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT", retryable: false } });
      expect(await executor.submitCapture({ ...request, idempotencyKey: "retry-stale" })).toEqual(stale);
    } finally {
      await executor.stop();
    }
  }, 300_000);

  it.skipIf(!mediaAvailable)("cancels a running capture before it commits", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-capture-cancel-"));
    roots.push(workspaceRoot);
    const executor = new LocalExecutor({ workspaceRoot, media: { ffmpegPath, ffprobePath }, browserTargets: fixture.browserTargets });
    await executor.start();
    try {
      const project = await executor.createProject({ contractVersion: "v1", idempotencyKey: "cancel-create", name: "Cancel capture" });
      const submitted = await executor.submitCapture({
        contractVersion: "v1", idempotencyKey: "cancel-capture", projectId: project.projectId, baseRevisionId: project.revisionId,
        flowId: fixture.flow.id, approved: true, executionTarget: "local",
      });
      const running = await untilRunning(executor, submitted.id);
      expect(running).toMatchObject({ state: "running", stage: "capturing", cancellable: true });
      const cancel = await executor.cancelJob({ contractVersion: "v1", idempotencyKey: "cancel-capture-request", projectId: project.projectId, jobId: submitted.id });
      expect(cancel.disposition).toBe("requested");
      expect(await executor.waitForJob(submitted.id, 60_000)).toMatchObject({ state: "cancelled" });
      const after = await new LocalProjectStore(workspaceRoot).current(project.projectId);
      expect(after.currentRevisionId).toBe(project.revisionId);
      expect(after.assets).toEqual({});
    } finally {
      await executor.stop();
    }
  }, 120_000);

  it("advertises capture only for host targets that carry an approved flow", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-capture-off-"));
    roots.push(workspaceRoot);
    const { flow: _flow, ...recaptureOnly } = fixture.browserTargets[fixture.flow.id]!;
    const executor = new LocalExecutor({ workspaceRoot, browserTargets: { [fixture.flow.id]: recaptureOnly } });
    await executor.start();
    try {
      expect(executor.capabilities().availableCommands).toContain("recapture_browser_scene");
      expect(executor.capabilities().availableCommands).not.toContain("start_browser_capture");
      await expect(executor.submitCapture({
        contractVersion: "v1", idempotencyKey: "capture-off", projectId: "project-any", baseRevisionId: "revision-any",
        flowId: fixture.flow.id, approved: true, executionTarget: "local",
      })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    } finally {
      await executor.stop();
    }
  });
});
