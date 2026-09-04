import { createHash, randomUUID } from "node:crypto";
import { open, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
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
  constructor(
    readonly code: "AUTH_EXPIRED" | "CHECKPOINT_MISMATCH",
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
  values?: Record<string, string>;
  reset?: () => Promise<void>;
}

export interface CaptureResult {
  run: { id: string; status: "passed" };
  tracePath: string;
  actionEvents: Array<{ actionId: string; atMs: number }>;
  captures: Array<{ sceneKey: string; durationMs: number; actionIds: string[] }>;
  artifacts: Array<{ sceneKey: string; path: string }>;
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
  if (target.kind === "role") return page.getByRole(target.value as "button", target.name ? { name: target.name } : undefined);
  if (target.kind === "label") return page.getByLabel(target.value);
  if (target.kind === "testId") return page.getByTestId(target.value);
  return page.locator(`a[href="${target.value}"]`);
}

async function checkCheckpoint(page: Page, step: BrowserStep): Promise<void> {
  const locator = locatorFor(page, { ...step, target: step.checkpoint.target ?? step.target });
  try {
    if (step.checkpoint.kind === "text") {
      const text = await locator.textContent();
      if (!text?.includes(step.checkpoint.expected)) throw new Error("expected text was not present");
    } else if (!(await locator.isVisible())) {
      throw new Error("target was not visible");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CaptureRunError("CHECKPOINT_MISMATCH", step.id, detail);
  }
}

async function executeStep(page: Page, step: BrowserStep, values: Record<string, string>): Promise<void> {
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
    await locatorFor(page, step).setInputFiles(values[step.valueRef ?? ""]);
  } else {
    await page.waitForTimeout(1);
  }
}

export async function runCapture(flow: Flow, environment: Environment, options: CaptureOptions): Promise<CaptureResult> {
  validateCapturePlan(flow, environment);
  await options.reset?.();
  const browser = await chromium.launch();
  const context = await browser.newContext(browserContextOptions(environment));
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const startedAt = Date.now();
  const actionEvents: CaptureResult["actionEvents"] = [];
  const scenePlan = buildScenePlan(flow);
  const runId = randomUUID();
  const tracePath = join(options.artifactRoot, runId, "trace.zip");
  const artifacts: CaptureResult["artifacts"] = [];

  try {
    for (const step of flow.steps) {
      await executeStep(page, step, options.values ?? {});
      await checkCheckpoint(page, step);
      actionEvents.push({ actionId: step.id, atMs: Date.now() - startedAt });
    }
    for (const scene of scenePlan) {
      const path = join(options.artifactRoot, runId, `${scene.sceneKey}.png`);
      await writeImmutableArtifact(path, await page.screenshot());
      artifacts.push({ sceneKey: scene.sceneKey, path });
    }
    await context.tracing.stop({ path: tracePath });
    return {
      run: { id: runId, status: "passed" },
      tracePath,
      actionEvents,
      captures: scenePlan.map((scene) => ({ sceneKey: scene.sceneKey, durationMs: Math.max(1, Date.now() - startedAt), actionIds: scene.actionIds })),
      artifacts,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
