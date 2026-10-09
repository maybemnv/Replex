import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { probeVideo, runCapture } from "../src/capture.js";
import { createProjectV2, semanticHashV2 } from "../src/operations-v2.js";
import { MediaAssetSchema, ProjectV2Schema, type MediaAsset } from "../src/schema-v2.js";
import type { BrowserTargets } from "../src/service/local.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { ffmpegPath, ffprobePath } from "./media.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
export const TARGET_SCENE = "apply-filter";
export const TARGET_CLIP_MS = 500;

/** Normal-flow release page whose post-apply release note is the controlled product change. */
export async function startReleaseFixture() {
  let note = "Release note: filters v1";
  const page = () => `<!doctype html>
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
    <p id="release-note" hidden>${note}</p>
  </section>
</main><script>
  const panel = document.querySelector('[data-testid="filter-panel"]');
  document.querySelector('#open-filter').addEventListener('click', () => { panel.hidden = false; });
  document.querySelector('#apply-filter').addEventListener('click', () => {
    document.querySelector('[data-testid="result"]').hidden = false;
    document.querySelector('#release-note').hidden = false;
  });
</script></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === "/__reset" && request.method === "POST") {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("browser fixture failed to start");
  const origin = `http://127.0.0.1:${address.port}`;
  const flow = normalFlow(origin);
  const browserTargets: BrowserTargets = {
    [flow.id]: { flow, environment: normalEnvironment(origin), values: { filterValue: "release" }, resetUrl: `${origin}/__reset` },
  };
  return {
    origin,
    flow,
    browserTargets,
    setNote(value: string) { note = value; },
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

/**
 * Seeds a workspace project from one approved capture run: every scene becomes an immutable browser asset and the
 * target scene is placed at 0..TARGET_CLIP_MS on the video track. The project leaves room for one 1s upload after it.
 */
export async function seedBrowserProject(roots: string[], workspaceRoot: string, fixture: Awaited<ReturnType<typeof startReleaseFixture>>, projectId: string) {
  const captureRoot = await mkdtemp(join(tmpdir(), "replex-seed-captures-"));
  roots.push(captureRoot);
  const capture = await runCapture(fixture.flow, fixture.browserTargets[fixture.flow.id]!.environment, {
    artifactRoot: captureRoot, values: { filterValue: "release" }, ffmpegPath, ffprobePath,
  });
  const assets: MediaAsset[] = [];
  const blobs = new Map<string, Buffer>();
  for (const scene of capture.captures) {
    const bytes = await readFile(scene.sourcePath);
    const probe = probeVideo(ffprobePath, scene.sourcePath);
    const hash = sha256(bytes);
    blobs.set(`media/assets/${hash}`, bytes);
    assets.push(MediaAssetSchema.parse({
      id: `asset-browser-${scene.sceneKey}`,
      type: "browser_capture",
      path: `media/assets/${hash}`,
      sha256: hash,
      probe: { width: probe.width, height: probe.height, durationMs: Math.round(probe.durationSeconds * 1000), fps: probe.fps, videoCodec: "vp9" },
      provenance: {
        kind: "browser", flowId: fixture.flow.id, sceneKey: scene.sceneKey, actionIds: scene.actionIds,
        checkpointActionId: scene.checkpointActionId, runId: capture.run.id, capturedAt: capture.run.endedAt,
      },
    }));
  }
  const target = assets.find((asset) => asset.provenance.kind === "browser" && asset.provenance.sceneKey === TARGET_SCENE)!;
  if (target.probe.durationMs! < TARGET_CLIP_MS + 200) throw new Error("target scene is too short for the fixture clip");

  let project = createProjectV2({
    projectId,
    brief: { audience: "Product users", message: "Show the release filter" },
    width: 1920, height: 1080, fps: 30, durationMs: TARGET_CLIP_MS + 1000, createdAt: "2026-10-09T00:00:00.000Z",
  });
  project.assets = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
  project.browser = { flows: { [fixture.flow.id]: fixture.flow }, recaptureLineage: [] };
  project.composition.clips = [{
    id: "clip-browser-target", assetId: target.id, trackId: "track-video", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: TARGET_CLIP_MS,
    speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false,
  }];
  project.composition.layers = [
    { id: "layer-title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 400, properties: { text: "Release filters", fontSize: 36 }, keyframes: [] },
  ];
  project = ProjectV2Schema.parse(project);
  project.revisions[0]!.manifestSha256 = semanticHashV2(project);

  await new LocalProjectStore(workspaceRoot).create(project, `${projectId}-create`, "Selective recapture");
  const projectRoot = join(workspaceRoot, "projects", sha256(projectId));
  await mkdir(join(projectRoot, "media", "assets"), { recursive: true });
  await Promise.all([...blobs].map(([path, bytes]) => writeFile(join(projectRoot, path), bytes, { flag: "wx" })));
  return { project, projectRoot, targetAsset: target, revisionId: project.currentRevisionId };
}
