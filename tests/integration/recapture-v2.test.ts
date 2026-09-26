import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../../fixtures/apps/normal/flow.js";
import { resetNormalFixture } from "../../fixtures/apps/normal/reset.js";
import { canonicalJson } from "../../src/canonical-json.js";
import { probeVideo, runCapture } from "../../src/capture.js";
import { authorizeLocalImport } from "../../src/import-v2.js";
import { createProjectV2, semanticHashV2 } from "../../src/operations-v2.js";
import { MediaAssetSchema, ProjectV2Schema, type MediaAsset } from "../../src/schema-v2.js";
import { recaptureBrowserSceneV2 } from "../../src/recapture-v2.js";
import { LocalProjectStore } from "../../src/service/project-store.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";

const roots: string[] = [];
let fixtureServer: Server | undefined;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const projectDirectory = (root: string, id: string) => join(root, "projects", createHash("sha256").update(id).digest("hex"));

const pageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Release Replay Demo</title></head>
<body><main data-testid="release-page">
  <h1>Release Replay Demo</h1>
  <button type="button" aria-label="Open filters" id="open-filter">Open filters</button>
  <section data-testid="filter-panel" hidden>
    <h2>Filter releases</h2>
    <label for="filter-value">Filter value</label>
    <input id="filter-value" name="filter-value" />
    <button type="button" aria-label="Apply" id="apply-filter">Apply</button>
    <p data-testid="result" hidden>Showing 3 matching releases</p>
    <p id="visible-filter"></p>
  </section>
</main><script>
  const panel = document.querySelector('[data-testid="filter-panel"]');
  document.querySelector('#open-filter').addEventListener('click', () => { panel.hidden = false; });
  document.querySelector('#apply-filter').addEventListener('click', () => {
    document.querySelector('[data-testid="result"]').hidden = false;
    document.querySelector('#visible-filter').textContent = 'Selected: ' + document.querySelector('#filter-value').value;
  });
</script></body></html>`;

afterEach(async () => {
  if (fixtureServer) await new Promise<void>((resolve, reject) => fixtureServer!.close((error) => error ? reject(error) : resolve()));
  fixtureServer = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixtureWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 5_000), 44 + index * 2);
  return bytes;
}

function makeUploadVideo(path: string): void {
  const result = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=2",
    "-an", "-c:v", "mpeg4", "-q:v", "10", "-threads", "1", "-y", path,
  ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error("FFmpeg could not create the uploaded video fixture");
}

function uploadAsset(
  id: string,
  filename: string,
  type: "uploaded_video" | "image" | "audio",
  bytes: Buffer,
  probe: MediaAsset["probe"],
): MediaAsset {
  const sha256 = hash(bytes);
  return MediaAssetSchema.parse({
    id, type, path: `media/assets/${sha256}`, sha256, probe,
    provenance: { kind: "upload", originalFilename: filename, importedAt: "2026-09-27T00:00:00.000Z", sourceSha256: sha256, importMethod: "path", originalProbe: probe },
  });
}

function browserAsset(capture: Awaited<ReturnType<typeof runCapture>>["captures"][number], bytes: Buffer, run: Awaited<ReturnType<typeof runCapture>>["run"], flowId: string): MediaAsset {
  const probe = probeVideo(ffprobePath, capture.sourcePath);
  const sha256 = hash(bytes);
  return MediaAssetSchema.parse({
    id: `asset-browser-${capture.sceneKey}`,
    type: "browser_capture",
    path: `media/assets/${sha256}`,
    sha256,
    probe: { width: probe.width, height: probe.height, durationMs: Math.round(probe.durationSeconds * 1000), fps: probe.fps, videoCodec: "vp9" },
    provenance: {
      kind: "browser", flowId, sceneKey: capture.sceneKey, actionIds: capture.actionIds,
      checkpointActionId: capture.checkpointActionId, runId: run.id, capturedAt: run.endedAt,
    },
  });
}

describe("V2 local selective recapture integration", () => {
  it.skipIf(!mediaAvailable)("replaces one approved scene in a mixed project after a visible product-state change", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-recapture-e2e-"));
    roots.push(root);
    fixtureServer = createServer((request, response) => {
      if (request.url === "/__reset" && request.method === "POST") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml);
    });
    await new Promise<void>((resolve) => fixtureServer!.listen(0, "127.0.0.1", resolve));
    const address = fixtureServer.address();
    if (!address || typeof address === "string") throw new Error("local browser fixture failed to start");
    const origin = `http://127.0.0.1:${address.port}`;
    const flow = normalFlow(origin);
    const environment = normalEnvironment(origin);
    const firstCapture = await runCapture(flow, environment, {
      artifactRoot: join(root, "captures"), values: { filterValue: "release" },
      reset: () => resetNormalFixture(origin), ffmpegPath, ffprobePath,
    });
    const secondCapture = await runCapture(flow, environment, {
      artifactRoot: join(root, "captures"), values: { filterValue: "launch" },
      reset: () => resetNormalFixture(origin), ffmpegPath, ffprobePath,
    });
    expect(firstCapture.run.status).toBe("passed");
    expect(secondCapture.run.status).toBe("passed");
    const previousScene = firstCapture.captures.find(({ sceneKey }) => sceneKey === "apply-filter");
    const replacementScene = secondCapture.captures.find(({ sceneKey }) => sceneKey === "apply-filter");
    const unrelatedScenes = firstCapture.captures.filter(({ sceneKey }) => sceneKey !== "apply-filter");
    expect(previousScene).toBeDefined();
    expect(replacementScene).toBeDefined();
    expect(unrelatedScenes.length).toBeGreaterThan(0);
    const previousBytes = await readFile(previousScene!.sourcePath);
    const replacementBytes = await readFile(replacementScene!.sourcePath);
    expect(hash(previousBytes)).toBe(previousScene!.sha256);
    expect(hash(replacementBytes)).toBe(replacementScene!.sha256);
    expect(previousScene!.sha256).not.toBe(replacementScene!.sha256);

    const uploadVideoPath = join(root, "upload.mp4");
    makeUploadVideo(uploadVideoPath);
    const uploadVideoBytes = await readFile(uploadVideoPath);
    const uploadProbe = probeVideo(ffprobePath, uploadVideoPath);
    const imageBytes = Buffer.concat([Buffer.from("P6\n2 2\n255\n"), Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])]);
    const audioBytes = fixtureWav();
    const browserAssets = await Promise.all(firstCapture.captures.map(async (scene) => browserAsset(scene, await readFile(scene.sourcePath), firstCapture.run, flow.id)));
    const upload = uploadAsset("asset-upload-video", "walkthrough.mp4", "uploaded_video", uploadVideoBytes, {
      durationMs: Math.round(uploadProbe.durationSeconds * 1000), width: uploadProbe.width, height: uploadProbe.height,
      fps: uploadProbe.fps, videoCodec: "mpeg4",
    });
    const image = uploadAsset("asset-support-image", "product.ppm", "image", imageBytes, { width: 2, height: 2 });
    const audio = uploadAsset("asset-support-audio", "voice.wav", "audio", audioBytes, { durationMs: 100, audioCodec: "pcm_s16le", channels: 1, sampleRateHz: 8_000 });
    const selectedAsset = browserAssets.find((asset) => asset.provenance.kind === "browser" && asset.provenance.sceneKey === "apply-filter")!;
    const otherAssets = browserAssets.filter((asset) => asset.id !== selectedAsset.id);
    const incomingProbe = probeVideo(ffprobePath, replacementScene!.sourcePath);
    const targetRangeMs = Math.min(previousScene!.durationMs, replacementScene!.durationMs) - 100;
    expect(targetRangeMs).toBeGreaterThan(0);
    let timeline = targetRangeMs + 500;
    const clipFor = (id: string, asset: MediaAsset, startMs: number, sourceOutMs: number, trackId = "track-video") => ({
      id, assetId: asset.id, trackId, timelineStartMs: startMs, sourceInMs: 0, sourceOutMs,
      speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1, audioGainDb: 0, muted: false,
    });
    const browserClips = otherAssets.map((asset, index) => {
      const scene = firstCapture.captures.find(({ sceneKey }) => asset.provenance.kind === "browser" && sceneKey === asset.provenance.sceneKey)!;
      const clip = clipFor(`clip-browser-other-${index}`, asset, timeline, scene.durationMs);
      timeline += scene.durationMs + 300;
      return clip;
    });
    const uploadStart = timeline + 300;
    const audioStart = 0;
    const uploadClip = {
      ...clipFor("clip-upload-video", upload, uploadStart, 1_000),
      transform: { x: 0, y: 0, scale: 1.05, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      audioGainDb: -2,
    };
    let project = createProjectV2({
      projectId: "project-selective-recapture-e2e",
      brief: { audience: "Product users", message: "Show the release filter" },
      width: 1920, height: 1080, fps: 30, durationMs: uploadStart + 2_000, createdAt: "2026-09-27T00:00:00.000Z",
    });
    project.assets = Object.fromEntries([...browserAssets, upload, image, audio].map((asset) => [asset.id, asset]));
    project.browser = { flows: { [flow.id]: flow }, recaptureLineage: [] };
    project.composition.clips = [
      clipFor("clip-browser-target", selectedAsset, 0, targetRangeMs),
      ...browserClips,
      uploadClip,
      clipFor("clip-audio", audio, audioStart, 100, "track-audio"),
    ];
    project.composition.layers = [
      { id: "layer-title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 1_200, properties: { text: "Release filters", fontSize: 36 }, keyframes: [] },
      { id: "layer-image", trackId: "track-overlay", kind: "image", timelineStartMs: timeline, durationMs: 800, properties: { assetId: image.id }, keyframes: [] },
    ];
    project.composition.motionPresets = [{ targetId: uploadClip.id, presetId: "camera-push", presetVersion: "1", parameters: { strength: 0.04 } }];
    project = ProjectV2Schema.parse(project);
    project.revisions[0]!.manifestSha256 = semanticHashV2(project);

    const store = new LocalProjectStore(root);
    await store.create(project, "create-selective-recapture-e2e", "Selective recapture");
    const projectRoot = projectDirectory(root, project.projectId);
    const assetRoot = join(projectRoot, "media", "assets");
    await mkdir(assetRoot, { recursive: true });
    const mediaBytes = new Map<string, Buffer>();
    for (const capture of firstCapture.captures) mediaBytes.set(`asset-browser-${capture.sceneKey}`, await readFile(capture.sourcePath));
    mediaBytes.set(upload.id, uploadVideoBytes);
    mediaBytes.set(image.id, imageBytes);
    mediaBytes.set(audio.id, audioBytes);
    const uniqueBlobs = new Map<string, Buffer>();
    for (const asset of Object.values(project.assets)) uniqueBlobs.set(asset.path!, mediaBytes.get(asset.id)!);
    await Promise.all([...uniqueBlobs].map(([path, bytes]) => writeFile(join(projectRoot, path), bytes, { flag: "wx" })));

    const result = await recaptureBrowserSceneV2(store, {
      projectId: project.projectId,
      baseRevisionId: project.currentRevisionId,
      previousAssetId: selectedAsset.id,
      capture: secondCapture,
      sceneKey: "apply-filter",
      changedActionIds: ["apply-filter"],
      reason: "The selected filter result changed",
      intentId: `replace-${secondCapture.run.id}-apply-filter`,
    }, { ffmpegPath, ffprobePath });

    expect(result.project.revisions).toHaveLength(2);
    expect(result.operationLog).toHaveLength(1);
    expect(result.operationLog[0]).toMatchObject({ actor: "recapture", baseRevisionId: project.currentRevisionId, input: { type: "replace_browser_capture", previousAssetId: selectedAsset.id } });
    expect(result.project.assets[selectedAsset.id]).toEqual(selectedAsset);
    expect(result.project.assets[upload.id]).toEqual(upload);
    expect(result.project.assets[image.id]).toEqual(image);
    expect(result.project.assets[audio.id]).toEqual(audio);
    expect(result.project.composition.motionPresets).toEqual(project.composition.motionPresets);
    expect(result.project.composition.layers).toEqual(project.composition.layers);
    expect(result.project.composition.clips.find(({ id }) => id === "clip-browser-target")).toMatchObject({
      id: "clip-browser-target", assetId: result.replacementAsset.id, timelineStartMs: 0, sourceInMs: 0,
      sourceOutMs: targetRangeMs, speed: 1, transform: { scale: 1 },
    });
    expect(result.project.composition.clips.find(({ id }) => id === "clip-upload-video")).toMatchObject({
      transform: { scale: 1.05 }, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, audioGainDb: -2,
    });
    expect(result.project.composition.clips.filter(({ id }) => id !== "clip-browser-target")).toEqual(
      project.composition.clips.filter(({ id }) => id !== "clip-browser-target"),
    );
    expect(result.project.browser?.recaptureLineage).toHaveLength(1);
    expect(result.report.checks.every((check) => check.passed)).toBe(true);
    expect(canonicalJson(await store.current(project.projectId))).toBe(canonicalJson(result.project));

    const oldTargetBytes = await readFile(join(projectRoot, selectedAsset.path!));
    expect(hash(oldTargetBytes)).toBe(selectedAsset.sha256);
    expect(hash(await readFile(join(projectRoot, result.replacementAsset.path!)))).toBe(result.replacementAsset.sha256);
    const reportRoot = join(process.cwd(), "work", "v2-901");
    await mkdir(reportRoot, { recursive: true });
    const reportPath = join(reportRoot, "preservation-report.json");
    await writeFile(reportPath, JSON.stringify(result.report, null, 2) + "\n", "utf8");
    expect(JSON.stringify(result.report)).not.toContain(root);
    expect(JSON.stringify(result.report)).not.toContain(origin);
    expect(await readFile(reportPath, "utf8")).toContain('"schemaVersion": 1');
    expect(incomingProbe.width).toBe(result.replacementAsset.probe.width);
  }, 120_000);
});
