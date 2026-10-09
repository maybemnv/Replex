import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecapturePreservationReportSchema } from "../src/recapture-v2.js";
import { LocalExecutor } from "../src/service/executor.js";
import { LocalProjectService } from "../src/service/local.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { seedBrowserProject, startReleaseFixture, TARGET_CLIP_MS } from "./browser-fixture.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

describe("local browser recapture jobs", () => {
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("replaces one scene from its approved flow, replays without recapturing, and rejects stale pins", async () => {
    const fixture = await startReleaseFixture();
    closers.push(fixture.close);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-recapture-jobs-"));
    roots.push(workspaceRoot);
    const seeded = await seedBrowserProject(roots, workspaceRoot, fixture, "project-recapture-jobs");
    const media = { ffmpegPath, ffprobePath };
    const executor = new LocalExecutor({ workspaceRoot, media, browserTargets: fixture.browserTargets });
    await executor.start();
    const projectId = seeded.project.projectId;
    const request = {
      contractVersion: "v1" as const, idempotencyKey: "recapture-1", projectId, baseRevisionId: seeded.revisionId,
      assetId: seeded.targetAsset.id, changedActionIds: ["apply-filter"], reason: "The release note changed", executionTarget: "local" as const,
    };
    let revisionId: string;
    let replacementId: string;
    try {
      expect(executor.capabilities()).toMatchObject({
        availableCommands: expect.arrayContaining(["recapture_browser_scene"]), jobKinds: expect.arrayContaining(["browser_recapture"]),
      });
      fixture.setNote("Release note: filters v2");
      const submitted = await executor.submitRecapture(request);
      expect(submitted).toMatchObject({ kind: "browser_recapture", state: "queued", baseRevisionId: seeded.revisionId });
      expect((await executor.submitRecapture(request)).id).toBe(submitted.id);
      const job = await executor.waitForJob(submitted.id, 120_000);
      expect(job, JSON.stringify(job)).toMatchObject({ state: "succeeded", result: { revisionId: expect.any(String), assetId: expect.any(String) } });
      if (job.state !== "succeeded") throw new Error("recapture failed");
      revisionId = job.result.revisionId!;
      replacementId = job.result.assetId!;
      expect(replacementId).not.toBe(seeded.targetAsset.id);

      const store = new LocalProjectStore(workspaceRoot);
      const after = await store.current(projectId);
      expect(after.currentRevisionId).toBe(revisionId);
      expect(after.assets[seeded.targetAsset.id]).toEqual(seeded.targetAsset);
      for (const asset of Object.values(seeded.project.assets)) expect(after.assets[asset.id]).toEqual(asset);
      expect(after.assets[replacementId]).toMatchObject({ type: "browser_capture", provenance: { kind: "browser", sceneKey: "apply-filter", predecessorAssetId: seeded.targetAsset.id } });
      expect(after.composition.clips).toEqual([{ ...seeded.project.composition.clips[0]!, assetId: replacementId }]);
      expect(after.composition.clips[0]!.sourceOutMs).toBe(TARGET_CLIP_MS);
      expect(after.composition.layers).toEqual(seeded.project.composition.layers);
      expect(after.browser?.recaptureLineage).toHaveLength(1);
      const log = await store.operationLog(projectId);
      expect(log.at(-1)).toMatchObject({ actor: "recapture", baseRevisionId: seeded.revisionId, resultRevisionId: revisionId, input: { type: "replace_browser_capture" } });

      const reportRoot = join(seeded.projectRoot, "evidence", "recapture");
      const reports = await readdir(reportRoot);
      expect(reports).toHaveLength(1);
      const report = RecapturePreservationReportSchema.parse(JSON.parse(await readFile(join(reportRoot, reports[0]!), "utf8")));
      expect(report).toMatchObject({ resultRevisionId: revisionId, replacementAsset: { id: replacementId }, changedActionIds: { source: "host_asserted", ids: ["apply-filter"] } });
      expect(JSON.stringify(report)).not.toContain(workspaceRoot);
      expect(JSON.stringify(report)).not.toContain(fixture.origin);

      const events = (await executor.eventsAfter(projectId)).events;
      expect(events.some((event) => event.type === "revision.created" && event.revision.id === revisionId)).toBe(true);

      const stale = await executor.waitForJob((await executor.submitRecapture({ ...request, idempotencyKey: "recapture-stale" })).id, 60_000);
      expect(stale).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT" } });
      const missing = await executor.waitForJob((await executor.submitRecapture({ ...request, idempotencyKey: "recapture-missing", baseRevisionId: revisionId, assetId: "asset-missing" })).id, 60_000);
      expect(missing).toMatchObject({ state: "failed", error: { code: "VALIDATION_FAILED" } });
    } finally {
      await executor.stop();
    }

    // A restart between the commit and the saved job state replays the request: it reports the published revision without driving the browser.
    const runsBefore = await readdir(join(seeded.projectRoot, "captures"));
    const service = new LocalProjectService({ workspaceRoot, media, browserTargets: fixture.browserTargets });
    const replayed = await service.recaptureScene(request, new AbortController().signal);
    expect(replayed).toMatchObject({ ok: true, revisionId, assetId: replacementId, revision: { id: revisionId, isCurrent: true } });
    expect(await readdir(join(seeded.projectRoot, "captures"))).toEqual(runsBefore);

    // A host without a target for this flow cannot recapture it.
    const otherHost = new LocalExecutor({ workspaceRoot, media, browserTargets: { "other-approved-flow": fixture.browserTargets[fixture.flow.id]! } });
    await otherHost.start();
    try {
      const unavailable = await otherHost.waitForJob((await otherHost.submitRecapture({ ...request, idempotencyKey: "recapture-no-target", baseRevisionId: revisionId, assetId: replacementId })).id, 60_000);
      expect(unavailable).toMatchObject({ state: "failed", error: { code: "CAPABILITY_UNAVAILABLE" } });
    } finally {
      await otherHost.stop();
    }
  }, 300_000);

  it("does not advertise or accept recapture without host browser targets", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-recapture-off-"));
    roots.push(workspaceRoot);
    const executor = new LocalExecutor({ workspaceRoot });
    await executor.start();
    try {
      expect(executor.capabilities().availableCommands).not.toContain("recapture_browser_scene");
      expect(executor.capabilities().jobKinds).not.toContain("browser_recapture");
      await expect(executor.submitRecapture({
        contractVersion: "v1", idempotencyKey: "recapture-off", projectId: "project-any", baseRevisionId: "revision-any",
        assetId: "asset-any", changedActionIds: ["apply-filter"], reason: "Changed", executionTarget: "local",
      })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    } finally {
      await executor.stop();
    }
  });

  it("rejects browser targets whose reset URL leaves the allowed origins", () => {
    expect(() => new LocalProjectService({ workspaceRoot: tmpdir(), browserTargets: {
      "normal-approved-flow": {
        environment: { appOrigin: "http://127.0.0.1:4173", allowedOrigins: ["http://127.0.0.1:4173"], viewport: { width: 1920, height: 1080 }, locale: "en-US", timezone: "UTC", browserVersion: "bundled-chromium", reducedMotion: "reduce", colorScheme: "light" },
        resetUrl: "http://example.com/__reset",
      },
    } })).toThrow();
  });
});
