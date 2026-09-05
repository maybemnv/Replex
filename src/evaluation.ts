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

/** Calls every app twice and records each attempt as evidence, including failures. */
export async function runAdversarialEvaluation(
  apps: AppId[],
  runner: (app: AppId, attempt: 1 | 2) => Promise<EvaluationRow>,
): Promise<EvaluationRow[]> {
  const rows: EvaluationRow[] = [];
  for (const app of apps) for (const attempt of [1, 2] as const) rows.push(await runner(app, attempt));
  return rows;
}

/** Applies fixed POC thresholds. It never upgrades missing external evidence into a pass. */
export function calculateDecision(rows: EvaluationRow[], input: { usefulnessReviews: boolean[] }): GateDecision {
  const missing: string[] = [];
  const failed: string[] = [];
  const expected = ["normal", "dynamic", "difficult"] as const;
  for (const app of expected) if (rows.filter((row) => row.app === app).length !== 2) missing.push(`${app} two-run evidence`);
  const browserPassed = rows.filter((row) => row.browser === "passed").length;
  const finalOutputs = rows.filter((row) => row.render === "passed").length + rows.filter((row) => row.recapture === "passed").length;
  const recapturesPassed = rows.filter((row) => row.recapture === "passed").length;
  const usefulnessYes = input.usefulnessReviews.filter(Boolean).length;
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

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
