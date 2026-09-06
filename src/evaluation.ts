import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type StageStatus = "passed" | "failed" | "not_run" | "not_applicable";
export type AppId = "normal" | "dynamic" | "difficult";

export interface EvaluationRow {
  app: AppId;
  attempt: 1 | 2;
  browser: StageStatus;
  capture: StageStatus;
  edit: StageStatus;
  model: StageStatus;
  verify: StageStatus;
  render: StageStatus;
  recapture: StageStatus;
  artifacts: string[];
  correctionMinutes?: number;
  safetyViolation: boolean;
  firstCause: string | null;
}

export interface GateDecision {
  decision: "PASS" | "FAIL" | "REWORK";
  productionAuthorized: false;
  missing: string[];
  failed: string[];
  summary: { browserPassed: number; finalOutputs: number; recapturesPassed: number; usefulnessYes: number };
}

export interface EvaluationEvidence {
  rowsPath: string;
  summaryPath: string;
  decisionPath: string;
  decision: GateDecision;
}

export interface EvaluationInput {
  usefulnessReviews: boolean[];
  evidenceRoot?: string;
}

/** Calls every app twice and records each attempt as evidence, including failures. */
export async function runAdversarialEvaluation(
  apps: AppId[],
  runner: (app: AppId, attempt: 1 | 2) => Promise<EvaluationRow>,
): Promise<EvaluationRow[]> {
  const rows: EvaluationRow[] = [];
  for (const app of apps) for (const attempt of [1, 2] as const) {
    const row = await runner(app, attempt);
    if (row.app !== app || row.attempt !== attempt) throw new Error(`evaluation runner returned mismatched identity for ${app} attempt ${attempt}`);
    rows.push(row);
  }
  return rows;
}

/** Applies fixed POC thresholds. It never upgrades missing external evidence into a pass. */
export function calculateDecision(rows: EvaluationRow[], input: EvaluationInput): GateDecision {
  const missing: string[] = [];
  const failed: string[] = [];
  const expected = ["normal", "dynamic", "difficult"] as const;
  for (const app of expected) {
    const appRows = rows.filter((row) => row.app === app);
    if (appRows.length !== 2) missing.push(`${app} two-run evidence`);
    const attempts = new Set(appRows.map((row) => row.attempt));
    if (appRows.length !== 2 || attempts.size !== 2 || !attempts.has(1) || !attempts.has(2)) missing.push(`${app} unique attempt IDs`);
    const recaptureStatuses = appRows.map((row) => row.recapture);
    if (recaptureStatuses.filter((status) => status !== "not_applicable").length !== 1 || recaptureStatuses.includes("not_run")) missing.push(`${app} exactly one recapture evidence`);
  }
  const browserPassed = rows.filter((row) => row.browser === "passed").length;
  const finalOutputs = rows.filter((row) => row.render === "passed").length + rows.filter((row) => row.recapture === "passed").length;
  const recapturesPassed = rows.filter((row) => row.recapture === "passed").length;
  const usefulnessYes = input.usefulnessReviews.filter(Boolean).length;
  if (!hasRetainedArtifacts(input.evidenceRoot, rows)) missing.push("retained evaluation artifacts");
  for (const row of rows) {
    const stages = ["browser", "capture", "edit", "model", "verify", "render"] as const;
    for (const stage of stages) {
      if (row[stage] === "not_run" || row[stage] === "not_applicable") missing.push(`${row.app} attempt ${row.attempt} ${stage} evidence`);
      if (!STAGE_STATUSES.includes(row[stage])) missing.push(`${row.app} attempt ${row.attempt} invalid ${stage} status`);
    }
    let blocked = false;
    for (const stage of stages) {
      if (blocked && row[stage] !== "not_run" && row[stage] !== "not_applicable") {
        missing.push(`${row.app} attempt ${row.attempt} contradictory stage statuses`);
        break;
      }
      blocked ||= row[stage] !== "passed";
    }
    if (row.render !== "passed" && row.recapture === "passed") missing.push(`${row.app} attempt ${row.attempt} recapture passed without a rendered draft`);
  }
  if (browserPassed < 5) failed.push("browser completion < 5/6");
  if (finalOutputs < 9) failed.push("fewer than nine verified final outputs");
  if (recapturesPassed < 3) failed.push("selective recapture < 3/3");
  if (rows.some((row) => row.safetyViolation)) failed.push("safety/privacy violation");
  if (rows.some((row) => row.model === "failed" || row.edit === "failed")) failed.push("agentic editing did not complete on every measured run");
  if (input.usefulnessReviews.length < 3) missing.push("usefulness reviews");
  else if (usefulnessYes < 2) failed.push("fewer than two reviewers would publish/send");
  if (rows.some((row) => row.correctionMinutes === undefined)) missing.push("correction-time evidence");
  else if (rows.some((row) => row.correctionMinutes! > 20) || median(rows.map((row) => row.correctionMinutes!)) >= 10) failed.push("correction-time threshold");
  const decision = failed.length ? "FAIL" : missing.length ? "REWORK" : "PASS";
  return { decision, productionAuthorized: false, missing, failed, summary: { browserPassed, finalOutputs, recapturesPassed, usefulnessYes } };
}

/** Persists raw measured rows and a fixed-threshold decision without changing either. */
export function writeEvaluation(root: string, rows: EvaluationRow[], input: EvaluationInput): EvaluationEvidence {
  const decision = calculateDecision(rows, { ...input, evidenceRoot: input.evidenceRoot ?? root });
  mkdirSync(root, { recursive: true });
  const rowsPath = join(root, "rows.json");
  const summaryPath = join(root, "summary.json");
  const decisionPath = join(root, "decision.md");
  writeJson(rowsPath, { rows });
  writeJson(summaryPath, { decision, rows });
  writeText(decisionPath, `# POC evaluation decision\n\nDecision: **${decision.decision}**\n\nProduction authorization: **no**\n\nMissing evidence:\n${list(decision.missing)}\n\nFailed gates:\n${list(decision.failed)}\n`);
  return { rowsPath, summaryPath, decisionPath, decision };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function list(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- None";
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
}

function hasRetainedArtifacts(root: string | undefined, rows: EvaluationRow[]): boolean {
  if (!root || !rows.length || rows.some((row) => !row.artifacts.length)) return false;
  const base = resolve(root);
  return rows.every((row) => row.artifacts.every((artifact) => {
    if (isAbsolute(artifact) || artifact.includes("..")) return false;
    const path = resolve(base, artifact);
    return !relative(base, path).startsWith("..") && existsSync(path) && statSync(path).size > 0;
  }));
}

const STAGE_STATUSES: StageStatus[] = ["passed", "failed", "not_run", "not_applicable"];
