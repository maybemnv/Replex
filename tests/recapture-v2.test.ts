import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalFlow } from "../fixtures/apps/normal/flow.js";
import { probeVideo, type CaptureResult } from "../src/capture.js";
import { canonicalJson } from "../src/canonical-json.js";
import { semanticHashV2, createProjectV2 } from "../src/operations-v2.js";
import { MediaAssetSchema, ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { recaptureBrowserSceneV2 } from "../src/recapture-v2.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

const roots: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const projectDirectory = (root: string, id: string) => join(root, "projects", createHash("sha256").update(id).digest("hex"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeVideo(
  path: string,
  color: "red" | "green",
  options: { width?: number; height?: number; duration?: number } = {},
): void {
  const { width = 64, height = 48, duration = 1 } = options;
  const result = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:r=30:d=${duration}`,
    "-an", "-c:v", "libvpx-vp9", "-threads", "1", "-y", path,
  ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error("FFmpeg could not create the recapture fixture");
}

function browserAsset(id: string, bytes: Buffer, probe: ReturnType<typeof probeVideo>, runId: string) {
  return MediaAssetSchema.parse({
    id,
    type: "browser_capture",
    path: `media/assets/${sha(bytes)}`,
    sha256: sha(bytes),
    probe: { width: probe.width, height: probe.height, durationMs: Math.round(probe.durationSeconds * 1000), fps: probe.fps, videoCodec: "vp9" },
    provenance: {
      kind: "browser", flowId: "normal-approved-flow", sceneKey: "apply-filter",
      actionIds: ["enter-filter", "apply-filter"], checkpointActionId: "apply-filter",
      runId, capturedAt: "2026-09-27T00:00:00.000Z",
    },
  });
}

async function seedProject(
  root: string,
  oldVideoPath: string,
  options: { clipRangeMs?: number } = {},
): Promise<{ store: LocalProjectStore; project: ProjectV2; oldBytes: Buffer }> {
  const oldBytes = await readFile(oldVideoPath);
  const oldProbe = probeVideo(ffprobePath, oldVideoPath);
  const oldAsset = browserAsset("asset-browser-old", oldBytes, oldProbe, "run-original");
  let project = createProjectV2({
    projectId: "project-recapture-test",
    brief: { audience: "Product users", message: "Show the filter workflow" },
    width: 64, height: 48, fps: 30, durationMs: 3000, createdAt: "2026-09-27T00:00:00.000Z",
  });
  project.assets[oldAsset.id] = oldAsset;
  project.browser = { flows: { "normal-approved-flow": normalFlow("https://example.test") }, recaptureLineage: [] };
  project.composition.clips.push({
    id: "clip-browser-scene", assetId: oldAsset.id, trackId: "track-video", timelineStartMs: 0,
    sourceInMs: 0, sourceOutMs: options.clipRangeMs ?? 500, speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1, audioGainDb: 0, muted: false,
  });
  project = ProjectV2Schema.parse(project);
  project.revisions[0]!.manifestSha256 = semanticHashV2(project);
  const store = new LocalProjectStore(root);
  await store.create(project, "create-recapture-test", "Recapture test");
  const assetRoot = join(projectDirectory(root, project.projectId), "media", "assets");
  await mkdir(assetRoot, { recursive: true });
  await writeFile(join(assetRoot, oldAsset.sha256), oldBytes, { flag: "wx" });
  return { store, project, oldBytes };
}

async function captureResult(root: string, videoPath: string): Promise<CaptureResult> {
  const id = "run-recapture-test";
  const runRoot = join(root, id);
  const captureRoot = join(runRoot, "captures");
  const logsRoot = join(runRoot, "logs");
  await Promise.all([mkdir(captureRoot, { recursive: true }), mkdir(logsRoot, { recursive: true })]);
  const sourcePath = join(captureRoot, `${Buffer.from("apply-filter").toString("hex")}.webm`);
  await writeFile(sourcePath, await readFile(videoPath));
  const startedAt = "2026-09-27T00:01:00.000Z";
  const endedAt = "2026-09-27T00:01:02.000Z";
  await writeFile(join(runRoot, "run.json"), JSON.stringify({ id, attempt: 1, startedAt, endedAt, status: "passed" }));
  const actionEvents = normalFlow("https://example.test").steps
    .filter((step) => step.sceneKey === "apply-filter")
    .map((step, index) => ({
      actionId: step.id, attempt: 1, atMs: (index + 1) * 100, target: step.target,
      checkpoint: step.checkpoint, outcome: "passed" as const,
    }));
  await writeFile(join(logsRoot, "actions.jsonl"), actionEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const probe = probeVideo(ffprobePath, sourcePath);
  return {
    run: { id, attempt: 1, startedAt, endedAt, status: "passed" },
    runPath: join(runRoot, "run.json"),
    rawVideoPath: join(runRoot, "raw-video", "recording.webm"),
    logs: { actionsPath: join(runRoot, "logs", "actions.jsonl"), consolePath: join(runRoot, "logs", "console.jsonl") },
    actionEvents,
    captures: [{
      sceneKey: "apply-filter", sourcePath, sha256: sha(await readFile(sourcePath)),
      width: probe.width, height: probe.height, durationMs: Math.round(probe.durationSeconds * 1000), runId: id,
      actionIds: ["enter-filter", "apply-filter"], checkpointActionId: "apply-filter",
    }],
    artifacts: [],
  };
}

describe("V2 selective browser recapture", () => {
  it.skipIf(!mediaAvailable)("commits one immutable replacement and proves mixed-state preservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-recapture-v2-"));
    roots.push(root);
    const oldVideoPath = join(root, "old.webm");
    const newVideoPath = join(root, "new.webm");
    makeVideo(oldVideoPath, "red");
    makeVideo(newVideoPath, "green");
    const seeded = await seedProject(root, oldVideoPath);
    const priorEdit = await seeded.store.applyBatch(seeded.project.projectId, {
      baseRevisionId: seeded.project.currentRevisionId,
      actor: "user",
      intentId: "prior-browser-audio-edit",
      evidenceRefs: [],
      operations: [{ type: "set_volume", clipId: "clip-browser-scene", audioGainDb: -3 }],
    });
    if (!priorEdit.ok) throw new Error("could not seed prior revision history");
    const { store, oldBytes } = seeded;
    const project = priorEdit.project;
    const capture = await captureResult(join(root, "runs"), newVideoPath);
    const result = await recaptureBrowserSceneV2(store, {
      projectId: project.projectId,
      baseRevisionId: project.currentRevisionId,
      previousAssetId: "asset-browser-old",
      capture,
      sceneKey: "apply-filter",
      changedActionIds: ["apply-filter"],
      reason: "Updated the filter result",
      intentId: "replace-apply-filter-run",
    }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] });

    expect(result.project.revisions).toHaveLength(3);
    expect(result.operationLog).toHaveLength(1);
    expect(result.operationLog[0]).toMatchObject({
      baseRevisionId: project.currentRevisionId,
      resultRevisionId: result.revisionId,
      actor: "recapture",
      intentId: "replace-apply-filter-run",
      input: { type: "replace_browser_capture" },
    });
    expect(result.project.assets["asset-browser-old"]).toEqual(project.assets["asset-browser-old"]);
    expect(result.project.composition.clips[0]).toMatchObject({ id: "clip-browser-scene", assetId: result.replacementAsset.id, timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 500 });
    expect(result.project.browser?.recaptureLineage).toHaveLength(1);
    expect(result.project.browser?.recaptureLineage[0]).toMatchObject({
      previousAssetId: "asset-browser-old", replacementAssetId: result.replacementAsset.id,
      changedActionIds: ["apply-filter"], reason: "Updated the filter result", revisionId: result.revisionId,
    });
    expect(result.operationLog[0]?.input).toMatchObject({ reason: "Updated the filter result" });
    expect(result.project.composition.clips[0]?.audioGainDb).toBe(-3);
    expect(result.report.changedActionIds).toEqual({ source: "host_asserted", ids: ["apply-filter"] });
    expect(result.report.checks).toHaveLength(7);
    expect(result.report.checks.every((check) => check.passed)).toBe(true);
    expect(result.report.checks.map(({ name }) => name)).toContain("revision-history-preserved");
    expect(result.project.revisions.slice(0, -1)).toEqual(project.revisions);
    expect(canonicalJson(await store.current(project.projectId))).toBe(canonicalJson(result.project));

    const projectRoot = projectDirectory(root, project.projectId);
    expect(await readFile(join(projectRoot, project.assets["asset-browser-old"]!.path!))).toEqual(oldBytes);
    const newBytes = await readFile(join(projectRoot, result.replacementAsset.path!));
    expect(sha(newBytes)).toBe(result.replacementAsset.sha256);
    expect(result.replacementAsset.provenance).toMatchObject({
      kind: "browser", flowId: "normal-approved-flow", sceneKey: "apply-filter",
      runId: capture.run.id, predecessorAssetId: "asset-browser-old",
    });
    const reportText = await readFile(join(projectRoot, result.evidenceRef), "utf8");
    expect(JSON.parse(reportText)).toEqual(result.report);
    expect(reportText).not.toContain(root);
  }, 60_000);

  it.skipIf(!mediaAvailable)("rejects stale, forged-path, and source-hash-mismatched captures without publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-recapture-reject-"));
    roots.push(root);
    const oldVideoPath = join(root, "old.webm");
    const newVideoPath = join(root, "new.webm");
    makeVideo(oldVideoPath, "red");
    makeVideo(newVideoPath, "green");
    const { store, project } = await seedProject(root, oldVideoPath);
    const capture = await captureResult(join(root, "runs"), newVideoPath);
    const request = {
      projectId: project.projectId,
      baseRevisionId: project.currentRevisionId,
      previousAssetId: "asset-browser-old",
      capture,
      sceneKey: "apply-filter",
      changedActionIds: ["apply-filter"],
      reason: "Updated the filter result",
      intentId: "reject-apply-filter-run",
    };
    await expect(recaptureBrowserSceneV2(store, { ...request, baseRevisionId: "revision-stale" }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] }))
      .rejects.toMatchObject({ code: "STALE_REVISION" });

    const forgedPath = structuredClone(capture);
    forgedPath.captures[0]!.sourcePath = join(root, "outside.webm");
    await writeFile(forgedPath.captures[0]!.sourcePath, await readFile(newVideoPath));
    await expect(recaptureBrowserSceneV2(store, { ...request, capture: forgedPath }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });

    const wrongHash = structuredClone(capture);
    wrongHash.captures[0]!.sha256 = "0".repeat(64);
    await expect(recaptureBrowserSceneV2(store, { ...request, capture: wrongHash }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    const failedCheckpoint = structuredClone(capture);
    failedCheckpoint.actionEvents[1]!.outcome = "failed";
    await expect(recaptureBrowserSceneV2(store, { ...request, capture: failedCheckpoint }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] }))
      .rejects.toMatchObject({ code: "CAPTURE_FAILED" });

    const fakeRoot = join(root, "outside", capture.run.id);
    const fakeCapturePath = join(fakeRoot, "captures", `${Buffer.from("apply-filter").toString("hex")}.webm`);
    await Promise.all([mkdir(join(fakeRoot, "logs"), { recursive: true }), mkdir(join(fakeRoot, "captures"), { recursive: true })]);
    await writeFile(fakeCapturePath, await readFile(newVideoPath));
    await writeFile(join(fakeRoot, "run.json"), JSON.stringify(capture.run));
    await writeFile(join(fakeRoot, "logs", "actions.jsonl"), capture.actionEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const fakeRun = structuredClone(capture);
    fakeRun.runPath = join(fakeRoot, "run.json");
    fakeRun.logs.actionsPath = join(fakeRoot, "logs", "actions.jsonl");
    fakeRun.captures[0]!.sourcePath = fakeCapturePath;
    await expect(recaptureBrowserSceneV2(store, { ...request, capture: fakeRun }, {
      ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")],
    })).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });

    expect(await store.current(project.projectId)).toEqual(project);
    const projectRoot = projectDirectory(root, project.projectId);
    expect(await readFile(join(projectRoot, project.assets["asset-browser-old"]!.path!))).toEqual(await readFile(oldVideoPath));
    expect(await readdir(join(projectRoot, "media", "assets"))).toEqual([project.assets["asset-browser-old"]!.sha256]);
    expect(await readdir(join(projectRoot, ".replex-staging"))).toEqual([]);
  }, 60_000);

  it.skipIf(!mediaAvailable)("leaves no canonical edit or new media when preservation evidence cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-recapture-evidence-failure-"));
    roots.push(root);
    const oldVideoPath = join(root, "old.webm");
    const newVideoPath = join(root, "new.webm");
    makeVideo(oldVideoPath, "red");
    makeVideo(newVideoPath, "green");
    const { store, project } = await seedProject(root, oldVideoPath);
    const capture = await captureResult(join(root, "runs"), newVideoPath);
    const projectRoot = projectDirectory(root, project.projectId);
    await writeFile(join(projectRoot, "evidence", "recapture"), "blocks evidence directory creation");

    await expect(recaptureBrowserSceneV2(store, {
      projectId: project.projectId,
      baseRevisionId: project.currentRevisionId,
      previousAssetId: "asset-browser-old",
      capture,
      sceneKey: "apply-filter",
      changedActionIds: ["apply-filter"],
      reason: "Updated the filter result",
      intentId: "evidence-failure-run",
    }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] })).rejects.toMatchObject({ code: "EVIDENCE_FAILED" });

    expect(await store.current(project.projectId)).toEqual(project);
    expect(await readdir(join(projectRoot, "media", "assets"))).toEqual([project.assets["asset-browser-old"]!.sha256]);
    expect(await readdir(join(projectRoot, ".replex-staging"))).toEqual([]);
  }, 60_000);

  it.skipIf(!mediaAvailable)("rolls back evidence, revision, operation log, and imported bytes when project publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-recapture-publish-failure-"));
    roots.push(root);
    const oldVideoPath = join(root, "old.webm");
    const newVideoPath = join(root, "new.webm");
    makeVideo(oldVideoPath, "red");
    makeVideo(newVideoPath, "green");
    const { store, project } = await seedProject(root, oldVideoPath);
    const capture = await captureResult(join(root, "runs"), newVideoPath);
    const projectRoot = projectDirectory(root, project.projectId);
    const revisionRoot = join(projectRoot, "revisions");
    const writeJsonAtomic = (store as unknown as {
      writeJsonAtomic(path: string, value: unknown, storageRoot: string): Promise<void>;
    }).writeJsonAtomic.bind(store);
    const writeProjectFailure = vi.spyOn(store as unknown as {
      writeJsonAtomic(path: string, value: unknown, storageRoot: string): Promise<void>;
    }, "writeJsonAtomic").mockImplementation(async (path, value, storageRoot) => {
      if (path === join(projectRoot, "project.json")) throw new Error("simulated final project pointer failure");
      await writeJsonAtomic(path, value, storageRoot);
    });

    try {
      await expect(recaptureBrowserSceneV2(store, {
        projectId: project.projectId,
        baseRevisionId: project.currentRevisionId,
        previousAssetId: "asset-browser-old",
        capture,
        sceneKey: "apply-filter",
        changedActionIds: ["apply-filter"],
        reason: "Updated the filter result",
        intentId: "publish-failure-run",
      }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] })).rejects.toMatchObject({ code: "EVIDENCE_FAILED" });
    } finally {
      writeProjectFailure.mockRestore();
    }

    expect(await store.current(project.projectId)).toEqual(project);
    expect(await store.operationLog(project.projectId)).toEqual([]);
    expect(await readdir(revisionRoot)).toHaveLength(1);
    expect(await readdir(join(projectRoot, "evidence", "recapture"))).toEqual([]);
    expect(await readdir(join(projectRoot, "media", "assets"))).toEqual([project.assets["asset-browser-old"]!.sha256]);
    expect(await readdir(join(projectRoot, ".replex-staging"))).toEqual([]);
  }, 60_000);

  it.skipIf(!mediaAvailable)("returns the committed preservation result for a concurrent idempotent retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-recapture-concurrent-retry-"));
    roots.push(root);
    const oldVideoPath = join(root, "old.webm");
    const newVideoPath = join(root, "new.webm");
    makeVideo(oldVideoPath, "red");
    makeVideo(newVideoPath, "green");
    const { store, project } = await seedProject(root, oldVideoPath);
    const capture = await captureResult(join(root, "runs"), newVideoPath);
    const request = {
      projectId: project.projectId,
      baseRevisionId: project.currentRevisionId,
      previousAssetId: "asset-browser-old",
      capture,
      sceneKey: "apply-filter",
      changedActionIds: ["apply-filter"],
      reason: "Updated the filter result",
      intentId: "concurrent-recapture-run",
    };
    const options = { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] };
    const [first, retry] = await Promise.all([
      recaptureBrowserSceneV2(store, request, options),
      recaptureBrowserSceneV2(store, request, options),
    ]);

    expect(first.revisionId).toBe(retry.revisionId);
    expect(retry.project.revisions).toHaveLength(2);
    expect(retry.report).toEqual(first.report);
    const replay = await recaptureBrowserSceneV2(store, request, options);
    expect(replay.revisionId).toBe(first.revisionId);
    expect(replay.report).toEqual(first.report);
    expect(replay.project.revisions).toHaveLength(2);
    expect(await store.operationLog(project.projectId)).toHaveLength(1);
  }, 60_000);

  it.skipIf(!mediaAvailable)("rolls back promoted bytes when replacement media is incompatible with retained clips", async () => {
    for (const [caseId, seedOptions] of [
      ["dimensions", { replacementWidth: 80, clipRangeMs: 500, previousDuration: 1 }],
      ["clip-range", { replacementWidth: 64, clipRangeMs: 1_500, previousDuration: 2 }],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `replex-recapture-${caseId}-`));
      roots.push(root);
      const oldVideoPath = join(root, "old.webm");
      const newVideoPath = join(root, "new.webm");
      makeVideo(oldVideoPath, "red", { duration: seedOptions.previousDuration });
      makeVideo(newVideoPath, "green", { width: seedOptions.replacementWidth });
      const { store, project } = await seedProject(root, oldVideoPath, { clipRangeMs: seedOptions.clipRangeMs });
      const capture = await captureResult(join(root, "runs"), newVideoPath);
      await expect(recaptureBrowserSceneV2(store, {
        projectId: project.projectId,
        baseRevisionId: project.currentRevisionId,
        previousAssetId: "asset-browser-old",
        capture,
        sceneKey: "apply-filter",
        changedActionIds: ["apply-filter"],
        reason: `Rejected ${caseId} incompatibility`,
        intentId: `reject-${caseId}-run`,
      }, { ffmpegPath, ffprobePath, captureRoots: [join(root, "runs")] })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
      expect(await store.current(project.projectId)).toEqual(project);
      const projectRoot = projectDirectory(root, project.projectId);
      expect(await readdir(join(projectRoot, "media", "assets"))).toEqual([project.assets["asset-browser-old"]!.sha256]);
      expect(await readdir(join(projectRoot, ".replex-staging"))).toEqual([]);
    }
  }, 90_000);
});
