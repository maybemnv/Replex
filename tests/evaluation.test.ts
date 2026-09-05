import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateDecision, runAdversarialEvaluation, type EvaluationRow, writeEvaluation } from "../src/evaluation.js";

const passingRows: EvaluationRow[] = (["normal", "dynamic", "difficult"] as const).flatMap((app) => ([1, 2] as const).map((attempt) => ({ app, attempt, browser: "passed", capture: "passed", edit: "passed", model: "passed", verify: "passed", render: "passed", recapture: attempt === 1 ? "passed" : "not_applicable", artifacts: ["run.json", "actions.jsonl", "render.mp4"], correctionMinutes: 5, safetyViolation: false, firstCause: null })));

describe("adversarial evaluation ledger", () => {
  it("records exactly two attributable attempts per app without hiding first-pass failures", async () => {
    const rows = await runAdversarialEvaluation(["normal", "dynamic", "difficult"], async (app, attempt) => ({ ...passingRows.find((row) => row.app === app && row.attempt === attempt)!, browser: attempt === 1 && app === "dynamic" ? "failed" : "passed", firstCause: attempt === 1 && app === "dynamic" ? "checkpoint_state" : null }));
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.app === "dynamic" && row.attempt === 1)).toMatchObject({ browser: "failed", firstCause: "checkpoint_state" });
  });

  it("requires retained artifacts before a decision can pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evaluation-artifacts-"));
    try {
      expect(calculateDecision(passingRows, { usefulnessReviews: [true, true, false], evidenceRoot: root })).toMatchObject({ decision: "REWORK", missing: expect.arrayContaining(["retained evaluation artifacts"]) });
      await Promise.all(["run.json", "actions.jsonl", "render.mp4"].map((path) => writeFile(join(root, path), "evidence")));
      expect(calculateDecision(passingRows, { usefulnessReviews: [true, true, false], evidenceRoot: root })).toMatchObject({ decision: "PASS" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(calculateDecision(passingRows, { usefulnessReviews: [] })).toMatchObject({ decision: "REWORK", missing: expect.arrayContaining(["usefulness reviews"]) });
  });

  it("fails closed for safety violations and cannot recommend production", () => {
    const unsafe = passingRows.map((row, index) => index === 0 ? { ...row, safetyViolation: true } : row);
    const decision = calculateDecision(unsafe, { usefulnessReviews: [true, true, true] });
    expect(decision).toMatchObject({ decision: "FAIL", productionAuthorized: false });
  });

  it("persists raw rows with a decision and never lets not-run stages pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evaluation-"));
    try {
      await Promise.all(["run.json", "actions.jsonl", "render.mp4"].map((path) => writeFile(join(root, path), "evidence")));
      const result = writeEvaluation(root, passingRows, { usefulnessReviews: [true, true, false] });
      expect(result.decision).toMatchObject({ decision: "PASS", productionAuthorized: false });
      expect(await readFile(result.summaryPath, "utf8")).toContain('"decision": "PASS"');
      expect(await readFile(result.decisionPath, "utf8")).toContain("Production authorization: **no**");
      expect(calculateDecision([{ ...passingRows[0], model: "not_run" }, ...passingRows.slice(1)], { usefulnessReviews: [true, true, false] })).toMatchObject({ decision: "REWORK", missing: expect.arrayContaining(["normal attempt 1 model evidence"]) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
