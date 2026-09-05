import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { open, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, expect as playwrightExpect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { EnvironmentSchema, FlowSchema, IdSchema, normalizeOrigin, type BrowserStep, type Environment, type Flow } from "./schema.js";

const MAX_CONSOLE_EVENTS = 1000;

function assertSceneKey(sceneKey: string, actionId: string): void {
  if (!IdSchema.safeParse(sceneKey).success) {
    throw new CapturePlanError("FLOW_INVALID", actionId, `scene key is not a safe stable ID: ${sceneKey}`);
  }
}

function trackConsoleEvent(events: Array<{ attempt: number; atMs: number; type: string; message: string }>, event: { attempt: number; atMs: number; type: string; message: string }): void {
  events.push(event);
  if (events.length > MAX_CONSOLE_EVENTS) events.splice(0, events.length - MAX_CONSOLE_EVENTS);
}

export class CapturePlanError extends Error {
  constructor(
    readonly code: "ACTION_NOT_APPROVED" | "ORIGIN_NOT_ALLOWED" | "FLOW_INVALID",
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

export class CaptureStartupError extends Error {
  readonly code = "STARTUP_CHECK_FAILED" as const;
  constructor(readonly missing: Array<"ffmpeg" | "ffprobe">) {
    super(`missing required startup tools: ${missing.join(", ")}`);
    this.name = "CaptureStartupError";
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
  run: { id: string; attempt: number; startedAt: string; endedAt: string; status: "passed" };
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
  const isWithin = (root: string, candidate: string) => {
    const relation = relative(root, candidate);
    return !relation || (!relation.startsWith("..") && !isAbsolute(relation));
  };
  if (isWithin(projectRoot, storagePath)) {
    throw new Error("browser storage state must remain outside project artifacts");
  }
  try {
    const projectRealpath = realpathSync(projectRoot);
    const storageRealpath = realpathSync(storagePath);
    if (isWithin(projectRealpath, storageRealpath)) {
      throw new Error("browser storage state must remain outside project artifacts");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return storagePath;
}

export async function resolveUploadPath(path: string, roots: string[]): Promise<string> {
  const resolvedPath = await realpath(path);
  const resolvedRoots = await Promise.all(roots.map((root) => realpath(root)));
  const allowed = resolvedRoots.some((root) => {
    const relation = relative(root, resolvedPath);
    return !relation || (!relation.startsWith("..") && !isAbsolute(relation));
  });
  if (!allowed) throw new Error("upload path is outside approved roots");
  return resolvedPath;
}

export function redactEvidenceText(value: string): string {
  return value
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|api[_-]?key|password|secret|auth|cookie)=)[^&#\s"']+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|api[_-]?key|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"',}\s<]+/gi, "$1[REDACTED]");
}

function isAllowedOrigin(allowedOrigins: string[], origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
}

export function validateCapturePlan(flow: Flow, environment: Environment): void {
  try {
    FlowSchema.parse(flow);
  } catch (error) {
    const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues ?? [];
    const stepIssue = issues.find((issue) => typeof issue.path?.[1] === "number");
    const stepIndex = typeof stepIssue?.path?.[1] === "number" ? stepIssue.path[1] as number : 0;
    const actionId = flow.steps[stepIndex]?.id ?? flow.id ?? "unknown";
    throw new CapturePlanError("FLOW_INVALID", actionId, stepIssue?.message ?? "flow structure is invalid");
  }
  try {
    EnvironmentSchema.parse(environment);
  } catch {
    throw new CapturePlanError("ORIGIN_NOT_ALLOWED", flow.id, "environment is invalid");
  }
  validateFlowStructure(flow);
  for (const step of flow.steps) {
    if (step.sceneKey) assertSceneKey(step.sceneKey, step.id);
  }
  if (!isAllowedOrigin(environment.allowedOrigins, environment.appOrigin)) {
    throw new CapturePlanError("ORIGIN_NOT_ALLOWED", flow.id, "app origin is not allowed");
  }

  for (const step of flow.steps) {
    if (!step.approved) {
      throw new CapturePlanError("ACTION_NOT_APPROVED", step.id, "action is not approved");
    }
    if (step.target?.kind === "url") {
      const origin = new URL(step.target.value).origin;
      if (!isAllowedOrigin(environment.allowedOrigins, origin)) {
        throw new CapturePlanError("ORIGIN_NOT_ALLOWED", step.id, `origin is not allowed: ${origin}`);
      }
    }
    const targetText = `${step.target?.value ?? ""} ${step.target?.name ?? ""}`.toLowerCase();
    if (flow.prohibitedActions.some((action) => targetText.includes(action.toLowerCase()))) {
      throw new CapturePlanError("ACTION_NOT_APPROVED", step.id, "action matches a prohibited action");
    }
  }
}

export function validateFlowStructure(flow: Flow): void {
  const actionIds = new Set<string>();
  const sceneLastIndex = new Map<string, number>();
  for (const [index, step] of flow.steps.entries()) {
    if (actionIds.has(step.id)) {
      throw new CapturePlanError("FLOW_INVALID", step.id, "flow action IDs must be unique");
    }
    if (step.order !== index) {
      throw new CapturePlanError("FLOW_INVALID", step.id, `flow step order must match its declared position (${index})`);
    }
    actionIds.add(step.id);
    if (step.sceneKey) {
      const lastIndex = sceneLastIndex.get(step.sceneKey);
      if (lastIndex !== undefined && lastIndex !== index - 1) {
        throw new CapturePlanError("FLOW_INVALID", step.id, `scene key must form one contiguous block: ${step.sceneKey}`);
      }
      sceneLastIndex.set(step.sceneKey, index);
    }
  }
}

export function buildScenePlan(flow: Flow): ScenePlan[] {
  validateFlowStructure(flow);
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

function jsonLines(values: unknown[]): Buffer {
  return Buffer.from(values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function assertMediaTools(options: CaptureOptions): void {
  const tools = [
    ["ffmpeg", options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg", /ffmpeg version/i],
    ["ffprobe", options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe", /ffprobe version/i],
  ] as const;
  const missing = tools.flatMap(([name, path, signature]) => {
    const result = spawnSync(path, ["-version"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
    if (result.error || result.status !== 0) return [name];
    const firstLine = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/, 1)[0] ?? "";
    return signature.test(firstLine) ? [] : [name];
  });
  if (missing.length) throw new CaptureStartupError(missing);
}

function locatorFor(page: Page, step: BrowserStep): Locator {
  const target = step.target;
  if (!target) throw new CaptureRunError("CHECKPOINT_MISMATCH", step.id, "step has no target");
  if (target.kind === "role") return page.getByRole(target.value as Parameters<Page["getByRole"]>[0], target.name ? { name: target.name } : undefined);
  if (target.kind === "label") return page.getByLabel(target.value);
  if (target.kind === "testId") return page.getByTestId(target.value);
  if (target.kind === "url") throw new CaptureRunError("CHECKPOINT_MISMATCH", step.id, "url targets cannot be used as element locators");
  const escaped = target.value.replace(/"/g, '\\"');
  return page.locator(`a[href="${escaped}"]`);
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
      const observed = [await locator.textContent(), await locator.getAttribute("aria-label")]
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
    if (!step.valueRef || !(step.valueRef in values)) throw new CaptureRunError("ACTION_FAILED", step.id, `missing value for valueRef: ${step.valueRef ?? "(none)"}`);
    await locatorFor(page, step).fill(values[step.valueRef] ?? "");
  } else if (step.action === "select") {
    if (!step.valueRef || !(step.valueRef in values)) throw new CaptureRunError("ACTION_FAILED", step.id, `missing value for valueRef: ${step.valueRef ?? "(none)"}`);
    await locatorFor(page, step).selectOption(values[step.valueRef] ?? "");
  } else if (step.action === "upload") {
    if (!step.valueRef || !(step.valueRef in values)) throw new CaptureRunError("ACTION_FAILED", step.id, `missing value for valueRef: ${step.valueRef ?? "(none)"}`);
    await locatorFor(page, step).setInputFiles(await resolveUploadPath(values[step.valueRef], uploadRoots));
  } else if (step.action === "waitFor") {
    return;
  } else {
    throw new CaptureRunError("ACTION_FAILED", step.id, `unsupported action: ${(step as { action: string }).action}`);
  }
}

function assertRuntimeOrigin(page: Page, environment: Environment, actionId: string): void {
  const origin = new URL(page.url()).origin;
  if (!isAllowedOrigin(environment.allowedOrigins, origin)) {
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
  const EPSILON = 0.25;
  return scenes.map((scene, index) => {
    const checkpointMs = eventTimes.get(scene.checkpointActionId);
    if (checkpointMs === undefined) throw new Error(`missing scene checkpoint event: ${scene.checkpointActionId}`);
    let endSeconds = index === scenes.length - 1 ? videoDurationSeconds : checkpointMs / 1000;
    if (endSeconds > videoDurationSeconds && endSeconds <= videoDurationSeconds + EPSILON) endSeconds = videoDurationSeconds;
    if (endSeconds <= startSeconds || endSeconds > videoDurationSeconds) throw new Error(`invalid scene boundary: ${scene.sceneKey}`);
    const boundary = { ...scene, startSeconds, endSeconds };
    startSeconds = endSeconds;
    return boundary;
  });
}

export async function runCapture(flow: Flow, environment: Environment, options: CaptureOptions): Promise<CaptureResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const runRoot = join(options.artifactRoot, runId);
  const attempt = options.attempt ?? 1;
  const runPath = join(runRoot, "run.json");
  const actionLogPath = join(runRoot, "logs", "actions.jsonl");
  const consoleLogPath = join(runRoot, "logs", "console.jsonl");
  try {
    validateCapturePlan(flow, environment);
    assertMediaTools(options);
    await options.reset?.();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const actionId = "actionId" in failure && typeof failure.actionId === "string" ? failure.actionId : "preflight";
    const code = "code" in failure && typeof failure.code === "string" ? failure.code : "RESET_FAILED";
    await writeImmutableArtifact(actionLogPath, jsonLines([{
      runId, stage: "preflight", attempt, actionId, atMs: 0, outcome: "failed", code, message: redactEvidenceText(failure.message),
    }]));
    await writeImmutableArtifact(consoleLogPath, jsonLines([]));
    await writeImmutableArtifact(runPath, Buffer.from(JSON.stringify({ id: runId, attempt, startedAt, endedAt: new Date().toISOString(), status: "failed", actionId, code }, null, 2)));
    Object.assign(failure, { runPath, actionLogPath, consoleLogPath });
    throw failure;
  }
  const rawVideoRoot = join(runRoot, "raw-video");
  await mkdir(rawVideoRoot, { recursive: true });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const consoleEvents: Array<{ attempt: number; atMs: number; type: string; message: string }> = [];
  const actionEvents: CaptureResult["actionEvents"] = [];
  const scenePlan = buildScenePlan(flow);
  const tracePath = join(runRoot, "traces", "trace.zip");
  const artifacts: CaptureResult["artifacts"] = [];
  let contextClosed = false;
  let logsWritten = false;
  let currentActionId = flow.id;
  let runtimeOriginError: CaptureRunError | undefined;

  try {
    browser = await chromium.launch();
    const activeContext = await browser.newContext({
      ...browserContextOptions(environment),
      recordVideo: { dir: rawVideoRoot, size: environment.viewport },
      storageState: options.storageStatePath
        ? resolveStorageStatePath(options.artifactRoot, options.storageStatePath)
        : undefined,
    });
    context = activeContext;
    await activeContext.tracing.start({ screenshots: true, snapshots: true });
    const activePage = await activeContext.newPage();
    page = activePage;
    activePage.setDefaultTimeout(5_000);
    const video = activePage.video();
    const startedAtMs = performance.now();
    activePage.on("console", (message) => trackConsoleEvent(consoleEvents, { attempt, atMs: performance.now() - startedAtMs, type: message.type(), message: message.text() }));
    activePage.on("pageerror", (error) => trackConsoleEvent(consoleEvents, { attempt, atMs: performance.now() - startedAtMs, type: "pageerror", message: error.message }));
    await activeContext.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      const parsed = new URL(url);
      if (!request.isNavigationRequest() && !["http:", "https:"].includes(parsed.protocol)) return route.continue();
      if (isAllowedOrigin(environment.allowedOrigins, parsed.origin)) return route.continue();
      runtimeOriginError = new CaptureRunError("ORIGIN_NOT_ALLOWED", currentActionId, `origin is not allowed: ${parsed.origin}`);
      await route.abort("blockedbyclient");
    });
    await activeContext.routeWebSocket(/wss?:\/\//, (route) => {
      const url = new URL(route.url());
      const origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
      if (isAllowedOrigin(environment.allowedOrigins, origin)) return route.connectToServer();
      runtimeOriginError = new CaptureRunError("ORIGIN_NOT_ALLOWED", currentActionId, `origin is not allowed: ${origin}`);
      route.close({ code: 1008, reason: "origin is not allowed" });
    });
    const observePage = (observedPage: Page) => observedPage.on("framenavigated", (frame) => {
      const url = frame.url();
      if (url === "about:blank") return;
      const origin = new URL(url).origin;
      if (!isAllowedOrigin(environment.allowedOrigins, origin)) {
        runtimeOriginError = new CaptureRunError("ORIGIN_NOT_ALLOWED", currentActionId, `origin is not allowed: ${origin}`);
      }
    });
    activeContext.on("page", observePage);
    observePage(activePage);

    const startedScenes = new Set<string>();
    for (const step of flow.steps) {
      currentActionId = step.id;
      if (step.sceneKey && !startedScenes.has(step.sceneKey)) {
        const path = join(runRoot, "screenshots", `${step.sceneKey}-before.png`);
        await writeImmutableArtifact(path, await activePage.screenshot());
        artifacts.push({ sceneKey: step.sceneKey, boundary: "before", path });
        startedScenes.add(step.sceneKey);
      }
      try {
        await executeStep(activePage, step, options.values ?? {}, options.uploadRoots ?? []);
        if (runtimeOriginError) throw runtimeOriginError;
        assertRuntimeOrigin(activePage, environment, step.id);
        await checkCheckpoint(activePage, step);
      } catch (error) {
        const failure = runtimeOriginError ?? (error instanceof CaptureRunError
          ? error
          : new CaptureRunError("ACTION_FAILED", step.id, error instanceof Error ? error.message : String(error)));
        actionEvents.push({
          actionId: step.id,
          attempt,
          atMs: performance.now() - startedAtMs,
          target: step.target,
          checkpoint: step.checkpoint,
          outcome: "failed",
        });
        throw failure;
      }
      actionEvents.push({
        actionId: step.id,
        attempt,
        atMs: performance.now() - startedAtMs,
        target: step.target,
        checkpoint: step.checkpoint,
        outcome: "passed",
      });
      const scene = scenePlan.find((candidate) => candidate.checkpointActionId === step.id);
      if (scene) {
        const path = join(runRoot, "screenshots", `${scene.sceneKey}-after.png`);
        await writeImmutableArtifact(path, await activePage.screenshot());
        artifacts.push({ sceneKey: scene.sceneKey, boundary: "after", path });
      }
    }
    if (runtimeOriginError) throw runtimeOriginError;
    await activeContext.tracing.stop({ path: tracePath });
    await activeContext.close();
    contextClosed = true;
    await writeImmutableArtifact(actionLogPath, jsonLines(actionEvents.map((event) => JSON.parse(redactEvidenceText(JSON.stringify(event))))));
    await writeImmutableArtifact(consoleLogPath, jsonLines(consoleEvents.map((event) => ({ ...event, message: redactEvidenceText(event.message) }))));
    logsWritten = true;
    if (!video) throw new Error("Playwright video recording did not start");
    const rawVideoPath = await video.path();
    const captures = await splitSourceCaptures(rawVideoPath, runRoot, runId, scenePlan, actionEvents, options);
    const endedAt = new Date().toISOString();
    await writeImmutableArtifact(runPath, Buffer.from(JSON.stringify({ id: runId, attempt, startedAt, endedAt, status: "passed" }, null, 2)));
    return {
      run: { id: runId, attempt, startedAt, endedAt, status: "passed" },
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
    if (page && context && !contextClosed) {
      const failureRoot = join(runRoot, "failure");
      const screenshotPath = join(failureRoot, "screenshot.png");
      const evidencePath = join(failureRoot, "evidence.json");
      let screenshotError: string | undefined;
      try {
        await writeImmutableArtifact(screenshotPath, await page.screenshot());
      } catch (screenshotFailure) {
        screenshotError = screenshotFailure instanceof Error ? screenshotFailure.message : String(screenshotFailure);
      }
      const bodyText = await page.locator("body").innerText().catch(() => "").then((text) => text.slice(0, 4000));
      const domExcerpt = await page.locator("body").evaluate((element) => element.outerHTML).catch(() => "").then((html) => html.slice(0, 4000));
      const accessibilityExcerpt = await page.locator("body").ariaSnapshot().catch(() => "").then((snapshot) => snapshot.slice(0, 4000));
      let pageUrl = "";
      try {
        pageUrl = page.url();
      } catch {
        pageUrl = "";
      }
      await writeImmutableArtifact(
        evidencePath,
        Buffer.from(JSON.stringify({
          actionId: failure.actionId,
          code: failure.code,
          message: redactEvidenceText(failure.message),
          url: redactEvidenceText(pageUrl),
          bodyText: redactEvidenceText(bodyText),
          domExcerpt: redactEvidenceText(domExcerpt),
          accessibilityExcerpt: redactEvidenceText(accessibilityExcerpt),
          consoleEvents: consoleEvents.slice(-50).map((event) => ({ ...event, message: redactEvidenceText(event.message) })),
          screenshotPath,
          ...(screenshotError ? { screenshotError } : {}),
        }, null, 2)),
      );
      try {
        await context.tracing.stop({ path: tracePath });
        failure.tracePath = tracePath;
      } catch {
        if (existsSync(tracePath)) failure.tracePath = tracePath;
      }
      failure.evidencePath = evidencePath;
      failure.runPath = runPath;
    } else if (existsSync(tracePath)) {
      failure.tracePath = tracePath;
    }
    if (!logsWritten) {
      await writeImmutableArtifact(actionLogPath, jsonLines(actionEvents.map((event) => JSON.parse(redactEvidenceText(JSON.stringify(event))))));
      await writeImmutableArtifact(consoleLogPath, jsonLines(consoleEvents.map((event) => ({ ...event, message: redactEvidenceText(event.message) }))));
    }
    await writeImmutableArtifact(runPath, Buffer.from(JSON.stringify({
      id: runId,
      attempt,
      startedAt,
      endedAt: new Date().toISOString(),
      status: "failed",
      actionId: failure.actionId,
      code: failure.code,
    }, null, 2)));
    failure.runPath = runPath;
    throw failure;
  } finally {
    if (context && !contextClosed) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
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
    assertSceneKey(scene.sceneKey, scene.checkpointActionId);
    const durationSeconds = Math.max(0.05, scene.endSeconds - scene.startSeconds);
    const sourcePath = join(runRoot, "captures", `${scene.sceneKey}.webm`);
    const temporaryPath = join(runRoot, "captures", `${scene.sceneKey}.${randomUUID()}.tmp.webm`);
    await mkdir(dirname(temporaryPath), { recursive: true });
    const result = spawnSync(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-ss", scene.startSeconds.toFixed(3), "-i", rawVideoPath, "-t", durationSeconds.toFixed(3), "-an", "-c:v", "libvpx-vp9", temporaryPath],
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 60_000 },
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
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: probe.width,
      height: probe.height,
      durationMs: Math.max(1, Math.round(probe.durationSeconds * 1000)),
      ...provenance,
    });
  }
  return captures;
}

export function probeVideo(ffprobe: string, path: string): { width: number; height: number; durationSeconds: number } {
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 },
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
