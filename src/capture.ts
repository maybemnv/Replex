import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { open, mkdir, readFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, expect as playwrightExpect, type Locator, type Page } from "@playwright/test";
import { checkStartupTools, StartupCheckError } from "./cli.js";
import type { BrowserStep, Environment, Flow } from "./schema.js";

export class CapturePlanError extends Error {
  constructor(
    readonly code: "ACTION_NOT_APPROVED" | "ORIGIN_NOT_ALLOWED",
    readonly actionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CapturePlanError";
  }
}

export class CaptureRunError extends Error {
  evidencePath?: string;
  tracePath?: string;
  runPath?: string;

  constructor(
    readonly code: "ACTION_FAILED" | "AUTH_EXPIRED" | "CHECKPOINT_MISMATCH" | "ORIGIN_NOT_ALLOWED",
    readonly actionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CaptureRunError";
  }
}

export interface ScenePlan {
  sceneKey: string;
  actionIds: string[];
  checkpointActionId: string;
}

export interface CaptureOptions {
  artifactRoot: string;
  attempt?: number;
  values?: Record<string, string>;
  reset?: () => Promise<void>;
  ffmpegPath?: string;
  ffprobePath?: string;
  storageStatePath?: string;
  uploadRoots?: string[];
}

export interface CaptureResult {
  run: { id: string; attempt: number; status: "passed" };
  runPath: string;
  rawVideoPath: string;
  tracePath: string;
  logs: { actionsPath: string; consolePath: string };
  actionEvents: Array<{
    actionId: string;
    attempt: number;
    atMs: number;
    target?: BrowserStep["target"];
    checkpoint: BrowserStep["checkpoint"];
    outcome: "passed" | "failed";
  }>;
  captures: Array<{
    sceneKey: string;
    sourcePath: string;
    sha256: string;
    width: number;
    height: number;
    durationMs: number;
    runId: string;
    actionIds: string[];
    checkpointActionId: string;
  }>;
  artifacts: Array<{ sceneKey: string; boundary: "before" | "after"; path: string }>;
}

export function fingerprintCapture(
  bytes: Buffer,
  provenance: { runId: string; actionIds: string[]; checkpointActionId: string },
): string {
  if (bytes.length === 0) throw new Error("capture is empty");
  return createHash("sha256")
    .update(bytes)
    .update(JSON.stringify(provenance))
    .digest("hex");
}

export function browserContextOptions(environment: Environment) {
  return {
    viewport: environment.viewport,
    locale: environment.locale,
    timezoneId: environment.timezone,
    reducedMotion: environment.reducedMotion,
    colorScheme: environment.colorScheme,
    serviceWorkers: "block" as const,
  };
}

export function resolveStorageStatePath(artifactRoot: string, storageStatePath: string): string {
  const projectRoot = resolve(artifactRoot);
  const storagePath = resolve(storageStatePath);
  const relation = relative(projectRoot, storagePath);
  if (!relation || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("browser storage state must remain outside project artifacts");
  }
  return storagePath;
}

export function resolveUploadPath(path: string, roots: string[]): string {
  const resolvedPath = resolve(path);
  const allowed = roots.some((root) => {
    const relation = relative(resolve(root), resolvedPath);
    return !relation || (!relation.startsWith("..") && !isAbsolute(relation));
  });
  if (!allowed) throw new Error("upload path is outside approved roots");
  return resolvedPath;
}

export function redactEvidenceText(value: string): string {
  return value
    .replace(/([?&](?:token|key|password|secret|auth)=)[^&#\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:token|password|secret|authorization)\s*[:=]\s*[^\s<"']+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
}

export function validateCapturePlan(flow: Flow, environment: Environment): void {
  if (!environment.allowedOrigins.includes(environment.appOrigin)) {
    throw new CapturePlanError("ORIGIN_NOT_ALLOWED", flow.id, "app origin is not allowed");
  }

  for (const step of flow.steps) {
    if (!step.approved) {
      throw new CapturePlanError("ACTION_NOT_APPROVED", step.id, "action is not approved");
    }
    if (step.action === "goto" && step.target?.kind === "url") {
      const origin = new URL(step.target.value).origin;
      if (!environment.allowedOrigins.includes(origin)) {
        throw new CapturePlanError("ORIGIN_NOT_ALLOWED", step.id, `origin is not allowed: ${origin}`);
      }
    }
    const targetText = `${step.target?.value ?? ""} ${step.target?.name ?? ""}`.toLowerCase();
    if (step.consequential && flow.prohibitedActions.some((action) => targetText.includes(action.toLowerCase()))) {
      throw new CapturePlanError("ACTION_NOT_APPROVED", step.id, "consequential action is prohibited");
    }
  }
}

export function buildScenePlan(flow: Flow): ScenePlan[] {
  const scenes = new Map<string, ScenePlan>();
  for (const step of flow.steps) {
    if (!step.sceneKey) continue;
    const scene = scenes.get(step.sceneKey) ?? { sceneKey: step.sceneKey, actionIds: [], checkpointActionId: step.id };
    scene.actionIds.push(step.id);
    scene.checkpointActionId = step.id;
    scenes.set(step.sceneKey, scene);
  }
  return [...scenes.values()];
}

export async function writeImmutableArtifact(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

function locatorFor(page: Page, step: BrowserStep): Locator {
  const target = step.target;
  if (!target) throw new CaptureRunError("CHECKPOINT_MISMATCH", step.id, "step has no target");
  if (target.kind === "role") return page.getByRole(target.value as Parameters<Page["getByRole"]>[0], target.name ? { name: target.name } : undefined);
  if (target.kind === "label") return page.getByLabel(target.value);
  if (target.kind === "testId") return page.getByTestId(target.value);
  return page.locator(`a[href="${target.value}"]`);
}

async function checkCheckpoint(page: Page, step: BrowserStep): Promise<void> {
  try {
    if (step.checkpoint.kind === "url") {
      await playwrightExpect(page).toHaveURL(step.checkpoint.expected);
      return;
    }
    const locator = locatorFor(page, { ...step, target: step.checkpoint.target ?? step.target });
    if (step.checkpoint.kind === "text") {
      await playwrightExpect(locator).toContainText(step.checkpoint.expected);
    } else if (step.checkpoint.kind === "attribute") {
      const separator = step.checkpoint.expected.indexOf("=");
      if (separator < 1) throw new Error("attribute checkpoint must use name=value");
      const name = step.checkpoint.expected.slice(0, separator);
      const expected = step.checkpoint.expected.slice(separator + 1);
      await playwrightExpect(locator).toHaveAttribute(name, expected);
    } else {
      await playwrightExpect(locator).toBeVisible();
      const observed = [await locator.textContent(), await locator.getAttribute("aria-label"), step.checkpoint.target?.name, step.checkpoint.target?.value]
        .filter(Boolean)
        .join(" ");
      if (!observed.includes(step.checkpoint.expected)) throw new Error("visible state did not match expected value");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CaptureRunError("CHECKPOINT_MISMATCH", step.id, detail);
  }
}

async function executeStep(page: Page, step: BrowserStep, values: Record<string, string>, uploadRoots: string[]): Promise<void> {
  if (step.action === "goto") {
    const response = await page.goto(step.target?.value ?? "");
    if (response?.status() === 401) throw new CaptureRunError("AUTH_EXPIRED", step.id, "authentication expired");
  } else if (step.action === "click") {
    await locatorFor(page, step).click();
  } else if (step.action === "fill") {
    await locatorFor(page, step).fill(values[step.valueRef ?? ""] ?? "");
  } else if (step.action === "select") {
    await locatorFor(page, step).selectOption(values[step.valueRef ?? ""] ?? "");
  } else if (step.action === "upload") {
    await locatorFor(page, step).setInputFiles(resolveUploadPath(values[step.valueRef ?? ""], uploadRoots));
  } else if (step.action === "waitFor") {
    await locatorFor(page, step).waitFor({ state: "visible" });
  }
}

function assertRuntimeOrigin(page: Page, environment: Environment, actionId: string): void {
  const origin = new URL(page.url()).origin;
  if (!environment.allowedOrigins.includes(origin)) {
    throw new CaptureRunError("ORIGIN_NOT_ALLOWED", actionId, `origin is not allowed: ${origin}`);
  }
}

export function deriveSceneBoundaries(
  scenes: ScenePlan[],
  events: Array<{ actionId: string; atMs: number }>,
  videoDurationSeconds: number,
): Array<ScenePlan & { startSeconds: number; endSeconds: number }> {
  const eventTimes = new Map(events.map((event) => [event.actionId, event.atMs]));
  let startSeconds = 0;
  return scenes.map((scene, index) => {
    const checkpointSeconds = (eventTimes.get(scene.checkpointActionId) ?? 0) / 1000;
    const endSeconds = index === scenes.length - 1
      ? videoDurationSeconds
      : Math.min(videoDurationSeconds, Math.max(startSeconds + 0.05, checkpointSeconds));
    const boundary = { ...scene, startSeconds, endSeconds };
    startSeconds = endSeconds;
    return boundary;
  });
}

export async function runCapture(flow: Flow, environment: Environment, options: CaptureOptions): Promise<CaptureResult> {
  validateCapturePlan(flow, environment);
  const startup = checkStartupTools({ ffmpeg: options.ffmpegPath, ffprobe: options.ffprobePath });
  if (!startup.ok) throw new StartupCheckError(startup);
  await options.reset?.();
  const runId = randomUUID();
  const runRoot = join(options.artifactRoot, runId);
  const rawVideoRoot = join(runRoot, "raw-video");
  await mkdir(rawVideoRoot, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...browserContextOptions(environment),
    recordVideo: { dir: rawVideoRoot, size: environment.viewport },
    storageState: options.storageStatePath
      ? resolveStorageStatePath(options.artifactRoot, options.storageStatePath)
      : undefined,
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const video = page.video();
  const consoleEvents: string[] = [];
  page.on("console", (message) => consoleEvents.push(message.text()));
  page.on("pageerror", (error) => consoleEvents.push(error.message));
  const startedAt = performance.now();
  const actionEvents: CaptureResult["actionEvents"] = [];
  const scenePlan = buildScenePlan(flow);
  const tracePath = join(runRoot, "traces", "trace.zip");
  const actionLogPath = join(runRoot, "logs", "actions.json");
  const consoleLogPath = join(runRoot, "logs", "console.json");
  const artifacts: CaptureResult["artifacts"] = [];
  const attempt = options.attempt ?? 1;
  const runPath = join(runRoot, "run.json");
  let contextClosed = false;
  let logsWritten = false;
  let currentActionId = flow.id;
  let runtimeOriginError: CaptureRunError | undefined;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return route.continue();
    const origin = new URL(url).origin;
    if (environment.allowedOrigins.includes(origin)) return route.continue();
    runtimeOriginError = new CaptureRunError("ORIGIN_NOT_ALLOWED", currentActionId, `origin is not allowed: ${origin}`);
    await route.abort("blockedbyclient");
  });
  const observePage = (observedPage: Page) => observedPage.on("framenavigated", (frame) => {
    const url = frame.url();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;
    const origin = new URL(url).origin;
    if (!environment.allowedOrigins.includes(origin)) {
      runtimeOriginError = new CaptureRunError("ORIGIN_NOT_ALLOWED", currentActionId, `origin is not allowed: ${origin}`);
    }
  });
  context.on("page", observePage);
  observePage(page);

  try {
    const startedScenes = new Set<string>();
    for (const step of flow.steps) {
      currentActionId = step.id;
      if (step.sceneKey && !startedScenes.has(step.sceneKey)) {
        const path = join(runRoot, "screenshots", `${step.sceneKey}-before.png`);
        await writeImmutableArtifact(path, await page.screenshot());
        artifacts.push({ sceneKey: step.sceneKey, boundary: "before", path });
        startedScenes.add(step.sceneKey);
      }
      try {
        await executeStep(page, step, options.values ?? {}, options.uploadRoots ?? []);
        if (runtimeOriginError) throw runtimeOriginError;
        assertRuntimeOrigin(page, environment, step.id);
        await checkCheckpoint(page, step);
      } catch (error) {
        const failure = runtimeOriginError ?? (error instanceof CaptureRunError
          ? error
          : new CaptureRunError("ACTION_FAILED", step.id, error instanceof Error ? error.message : String(error)));
        actionEvents.push({
          actionId: step.id,
          attempt,
          atMs: performance.now() - startedAt,
          target: step.target,
          checkpoint: step.checkpoint,
          outcome: "failed",
        });
        throw failure;
      }
      actionEvents.push({
        actionId: step.id,
        attempt,
        atMs: performance.now() - startedAt,
        target: step.target,
        checkpoint: step.checkpoint,
        outcome: "passed",
      });
      const scene = scenePlan.find((candidate) => candidate.checkpointActionId === step.id);
      if (scene) {
        const path = join(runRoot, "screenshots", `${scene.sceneKey}-after.png`);
        await writeImmutableArtifact(path, await page.screenshot());
        artifacts.push({ sceneKey: scene.sceneKey, boundary: "after", path });
      }
    }
    await context.tracing.stop({ path: tracePath });
    await context.close();
    contextClosed = true;
    await writeImmutableArtifact(actionLogPath, Buffer.from(redactEvidenceText(JSON.stringify(actionEvents, null, 2))));
    await writeImmutableArtifact(consoleLogPath, Buffer.from(redactEvidenceText(JSON.stringify(consoleEvents, null, 2))));
    logsWritten = true;
    if (!video) throw new Error("Playwright video recording did not start");
    const rawVideoPath = await video.path();
    const captures = await splitSourceCaptures(rawVideoPath, runRoot, runId, scenePlan, actionEvents, options);
    await writeImmutableArtifact(runPath, Buffer.from(JSON.stringify({ id: runId, attempt, status: "passed" }, null, 2)));
    return {
      run: { id: runId, attempt, status: "passed" },
      runPath,
      rawVideoPath,
      tracePath,
      logs: { actionsPath: actionLogPath, consolePath: consoleLogPath },
      actionEvents,
      captures,
      artifacts,
    };
  } catch (error) {
    const failure = error instanceof CaptureRunError
      ? error
      : new CaptureRunError("ACTION_FAILED", currentActionId, error instanceof Error ? error.message : String(error));
    if (!contextClosed) {
      const failureRoot = join(runRoot, "failure");
      const screenshotPath = join(failureRoot, "screenshot.png");
      const evidencePath = join(failureRoot, "evidence.json");
      await writeImmutableArtifact(screenshotPath, await page.screenshot());
      const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
      const domExcerpt = (await page.locator("body").evaluate((element) => element.outerHTML).catch(() => "")).slice(0, 4000);
      await writeImmutableArtifact(
        evidencePath,
        Buffer.from(JSON.stringify({
          actionId: failure.actionId,
          code: failure.code,
          message: failure.message,
          url: redactEvidenceText(page.url()),
          bodyText: redactEvidenceText(bodyText),
          domExcerpt: redactEvidenceText(domExcerpt),
          consoleEvents: consoleEvents.slice(-50).map(redactEvidenceText),
          screenshotPath,
        }, null, 2)),
      );
      await context.tracing.stop({ path: tracePath });
      failure.evidencePath = evidencePath;
      failure.tracePath = tracePath;
      failure.runPath = runPath;
    }
    if (!logsWritten) {
      await writeImmutableArtifact(actionLogPath, Buffer.from(redactEvidenceText(JSON.stringify(actionEvents, null, 2))));
      await writeImmutableArtifact(consoleLogPath, Buffer.from(redactEvidenceText(JSON.stringify(consoleEvents, null, 2))));
    }
    await writeImmutableArtifact(runPath, Buffer.from(JSON.stringify({
      id: runId,
      attempt,
      status: "failed",
      actionId: failure.actionId,
      code: failure.code,
    }, null, 2))).catch(() => undefined);
    failure.runPath = runPath;
    throw failure;
  } finally {
    if (!contextClosed) await context.close();
    await browser.close();
  }
}

async function splitSourceCaptures(
  rawVideoPath: string,
  runRoot: string,
  runId: string,
  scenes: ScenePlan[],
  events: CaptureResult["actionEvents"],
  options: CaptureOptions,
): Promise<CaptureResult["captures"]> {
  const ffmpeg = options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
  const rawProbe = probeVideo(ffprobe, rawVideoPath);
  const captures: CaptureResult["captures"] = [];

  for (const scene of deriveSceneBoundaries(scenes, events, rawProbe.durationSeconds)) {
    const durationSeconds = Math.max(0.05, scene.endSeconds - scene.startSeconds);
    const sourcePath = join(runRoot, "captures", `${scene.sceneKey}.webm`);
    const temporaryPath = join(runRoot, "captures", `${scene.sceneKey}.${randomUUID()}.tmp.webm`);
    await mkdir(dirname(temporaryPath), { recursive: true });
    const result = spawnSync(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-ss", scene.startSeconds.toFixed(3), "-i", rawVideoPath, "-t", durationSeconds.toFixed(3), "-an", "-c:v", "libvpx-vp9", temporaryPath],
      { encoding: "utf8", windowsHide: true, shell: false },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`ffmpeg scene split failed: ${result.error?.message ?? result.stderr.trim()}`);
    }
    const temporaryBytes = await readFile(temporaryPath);
    await writeImmutableArtifact(sourcePath, temporaryBytes);
    await rm(temporaryPath);
    const probe = probeVideo(ffprobe, sourcePath);
    const provenance = { runId, actionIds: scene.actionIds, checkpointActionId: scene.checkpointActionId };
    const bytes = await readFile(sourcePath);
    captures.push({
      sceneKey: scene.sceneKey,
      sourcePath,
      sha256: fingerprintCapture(bytes, provenance),
      width: probe.width,
      height: probe.height,
      durationMs: Math.max(1, Math.round(probe.durationSeconds * 1000)),
      ...provenance,
    });
  }
  return captures;
}

function probeVideo(ffprobe: string, path: string): { width: number; height: number; durationSeconds: number } {
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
    { encoding: "utf8", windowsHide: true, shell: false },
  );
  if (result.error || result.status !== 0) throw new Error(`ffprobe failed: ${result.error?.message ?? result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  const stream = parsed.streams?.[0];
  const durationSeconds = Number(parsed.format?.duration);
  if (!stream?.width || !stream.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe returned invalid video metadata");
  }
  return { width: stream.width, height: stream.height, durationSeconds };
}
