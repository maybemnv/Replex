import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderDynamicFixture, type DynamicFixtureState } from "../../fixtures/apps/dynamic/app.js";
import { changeDynamicFixture } from "../../fixtures/apps/dynamic/change.js";
import { dynamicEnvironment, dynamicFlow } from "../../fixtures/apps/dynamic/flow.js";
import { resetDynamicFixture as resetDynamic } from "../../fixtures/apps/dynamic/reset.js";
import { renderDifficultFixture, type DifficultFixtureState } from "../../fixtures/apps/difficult/app.js";
import { changeDifficultFixture } from "../../fixtures/apps/difficult/change.js";
import { difficultEnvironment, difficultFlow } from "../../fixtures/apps/difficult/flow.js";
import { resetDifficultFixture as resetDifficult } from "../../fixtures/apps/difficult/reset.js";
import { probeVideo, runCapture } from "../../src/capture.js";
import { runRecordedAgentDraft } from "../../src/agent.js";
import { capturesFromRun, createProject, type ProjectCaptureInput } from "../../src/project.js";
import { reconcileCapture } from "../../src/reconcile.js";
import { buildRenderJob, executeRenderJob } from "../../src/render.js";
import { verifyProject } from "../../src/verify.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "../media.js";

describe.skipIf(!mediaAvailable)("dynamic and difficult POC-13 end-to-end paths", () => {
  for (const kind of ["dynamic", "difficult"] as const) {
    it(`${kind} produces a baseline, agent draft, selective recapture, and revised render`, async () => {
      const fixture = await startFixture(kind);
      const root = await mkdtemp(join(tmpdir(), `replex-poc13-${kind}-`));
      const uploadPath = join(root, "release-asset.txt");
      await writeFile(uploadPath, "release replay fixture\n", "utf8");

      try {
        const values: Record<string, string> = kind === "dynamic"
          ? { dynamicEmail: "demo@example.test", dynamicPassword: "fixture-password", dynamicPlan: "priority" }
          : { difficultProjectName: "Release Replay", difficultAsset: uploadPath };
        const environment = kind === "dynamic" ? dynamicEnvironment(fixture.origin) : difficultEnvironment(fixture.origin);
        const flow = kind === "dynamic" ? dynamicFlow(fixture.origin) : difficultFlow(fixture.origin);
        const baseline = await runCapture(flow, environment, {
          artifactRoot: join(root, "baseline"),
          attempt: 1,
          values,
          reset: fixture.reset,
          ...(kind === "difficult" ? { uploadRoots: [root] } : {}),
        });
        const materialized = capturesFromRun(baseline);
        const sceneDurationSeconds = 30 / materialized.captures.length;
        const captures = await normalizeCaptures(materialized.root, materialized.captures, `${kind}-baseline`, sceneDurationSeconds);
        const project = createProject({
          projectId: `poc13-${kind}`,
          brief: { audience: "Product teams", message: `Show the ${kind} release flow`, targetDurationMs: 30000 },
          environment,
          flow,
          captures,
        });
        const verification = verifyProject(project, materialized.root, { checkMedia: true });
        expect(verification.passed, JSON.stringify(verification.checks.filter((check) => !check.passed))).toBe(true);
        const baselineRender = executeRenderJob(
          buildRenderJob(project, materialized.root, verification),
          materialized.root,
          { ffmpegPath, ffprobePath, project },
        );
        expect(baselineRender.probe.durationMs).toBeGreaterThanOrEqual(25000);

        const agent = runRecordedAgentDraft(project, materialized.root, [
          { tool: "inspect_project", input: {} },
          { tool: "set_title", input: {
            baseRevisionId: project.currentRevisionId,
            evidenceRefs: [`capture:${materialized.captures[0].id}`],
            overlay: { id: `${kind}-agent-title`, sceneId: project.scenes[1].id, kind: "title", text: `${kind} release update`, placement: "top", startMs: 0, endMs: 2500 },
          } },
          { tool: "verify_project", input: {} },
          { tool: "render_draft", input: {} },
          { tool: "inspect_render_result", input: {} },
        ]);
        expect(agent.ok).toBe(true);
        if (!agent.ok) return;
        expect(existsSync(join(materialized.root, "renders", `${agent.project.currentRevisionId}.mp4`))).toBe(true);

        await fixture.change();
        const changedFlow = kind === "dynamic" ? dynamicFlow(fixture.origin, { changed: true }) : difficultFlow(fixture.origin, { changed: true });
        const changed = await runCapture(changedFlow, environment, {
          artifactRoot: join(root, "changed"),
          attempt: 2,
          values,
          ...(kind === "difficult" ? { uploadRoots: [root] } : {}),
        });
        const changedCapture = changed.captures[0];
        const replacementCapture = (await normalizeCaptures(dirname(changed.runPath), [changedCapture], `${kind}-replacement`, sceneDurationSeconds))[0];
        const replacementPath = join(dirname(changed.runPath), replacementCapture.path);
        await mkdir(join(materialized.root, "captures"), { recursive: true });
        const projectReplacementPath = `captures/${kind}-replacement.mp4`;
        await copyFile(replacementPath, join(materialized.root, projectReplacementPath));
        const replacement = reconcileCapture(agent.project, materialized.root, {
          id: `${changedCapture.sceneKey}-${changedCapture.runId}`,
          sceneKey: changedCapture.sceneKey,
          path: projectReplacementPath,
          sha256: createHash("sha256").update(await readFile(join(materialized.root, projectReplacementPath))).digest("hex"),
          durationMs: replacementCapture.durationMs,
          changedStepIds: [agent.project.scenes[0].checkpointActionId],
          reason: `${kind} controlled state change`,
          ffprobePath,
        });
        expect(replacement.ok).toBe(true);
        if (!replacement.ok) return;
        const revisedVerification = verifyProject(replacement.project, materialized.root, { checkMedia: true });
        expect(revisedVerification.passed, JSON.stringify(revisedVerification.checks.filter((check) => !check.passed))).toBe(true);
        const revisedRender = executeRenderJob(
          buildRenderJob(replacement.project, materialized.root, revisedVerification),
          materialized.root,
          { ffmpegPath, ffprobePath, project: replacement.project },
        );
        expect(revisedRender.probe.durationMs).toBeGreaterThanOrEqual(25000);
      } finally {
        await fixture.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 300_000);
  }
});

async function startFixture(kind: "dynamic" | "difficult"): Promise<{ origin: string; reset: () => Promise<void>; change: () => Promise<void>; close: () => Promise<void> }> {
  let state: DynamicFixtureState | DifficultFixtureState = { changed: false };
  const server: Server = createServer((request, response) => {
    if (request.url === "/__reset" && request.method === "POST") {
      state = { changed: false };
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/__change" && request.method === "POST") {
      state = { ...state, changed: true };
      response.writeHead(204).end();
      return;
    }
    const respond = () => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(kind === "dynamic"
      ? renderDynamicFixture(state as DynamicFixtureState)
      : renderDifficultFixture(state as DifficultFixtureState));
    respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(`${kind} fixture server did not start`);
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    reset: () => kind === "dynamic" ? resetDynamic(origin) : resetDifficult(origin),
    change: () => kind === "dynamic" ? changeDynamicFixture(origin) : changeDifficultFixture(origin),
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function normalizeCaptures(root: string, captures: Array<Pick<ProjectCaptureInput, "sceneKey" | "path" | "sourcePath" | "runId" | "actionIds" | "checkpointActionId">>, prefix: string, durationSeconds: number) {
  await mkdir(join(root, "captures"), { recursive: true });
  return Promise.all(captures.map(async (capture) => {
    const outputPath = join(root, "captures", `${prefix}-${capture.sceneKey}.mp4`);
    const sourcePath = capture.path ?? capture.sourcePath;
    if (!sourcePath || !capture.actionIds || !capture.checkpointActionId) throw new Error(`capture ${capture.sceneKey} lacks immutable provenance`);
    const inputPath = isAbsolute(sourcePath) ? sourcePath : join(root, sourcePath);
    const run = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", inputPath, "-t", String(durationSeconds), "-an", "-vf", "fps=30,scale=1920:1080", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outputPath], { encoding: "utf8", windowsHide: true });
    if (run.status !== 0) throw new Error(run.stderr || "fixture media normalization failed");
    const probe = probeVideo(ffprobePath, outputPath);
    return {
      id: `capture-${capture.sceneKey}-${capture.runId}`,
      sceneKey: capture.sceneKey,
      path: relative(root, outputPath).replace(/\\/g, "/"),
      runId: capture.runId,
      actionIds: capture.actionIds,
      checkpointActionId: capture.checkpointActionId,
      sha256: createHash("sha256").update(await readFile(outputPath)).digest("hex"),
      durationMs: Math.round(probe.durationSeconds * 1000),
      width: probe.width,
      height: probe.height,
      fps: 30 as const,
    };
  }));
}
