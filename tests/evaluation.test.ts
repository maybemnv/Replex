import { describe, expect, it } from "vitest";
import { calculateDecision, runAdversarialEvaluation, type EvaluationRow } from "../src/evaluation.js";

const passingRows: EvaluationRow[] = (["normal", "dynamic", "difficult"] as const).flatMap((app) => ([1, 2] as const).map((attempt) => ({ app, attempt, browser: "passed", capture: "passed", edit: "passed", model: "passed", verify: "passed", render: "passed", recapture: attempt === 1 ? "passed" : "not_applicable", artifacts: ["run.json", "actions.jsonl", "render.mp4"], correctionMinutes: 5, safetyViolation: false, firstCause: null })));

describe("adversarial evaluation ledger", () => {
  it("records exactly two attributable attempts per app without hiding first-pass failures", async () => {
    const rows = await runAdversarialEvaluation(["normal", "dynamic", "difficult"], async (app, attempt) => ({ ...passingRows.find((row) => row.app === app && row.attempt === attempt)!, browser: attempt === 1 && app === "dynamic" ? "failed" : "passed", firstCause: attempt === 1 && app === "dynamic" ? "checkpoint_state" : null }));
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.app === "dynamic" && row.attempt === 1)).toMatchObject({ browser: "failed", firstCause: "checkpoint_state" });
  });

  it("requires every technical and external gate before PASS", () => {
    expect(calculateDecision(passingRows, { usefulnessReviews: [true, true, false] })).toMatchObject({ decision: "PASS" });
    expect(calculateDecision(passingRows, { usefulnessReviews: [] })).toMatchObject({ decision: "REWORK", missing: expect.arrayContaining(["usefulness reviews"]) });
  });

  it("fails closed for safety violations and cannot recommend production", () => {
    const unsafe = passingRows.map((row, index) => index === 0 ? { ...row, safetyViolation: true } : row);
    const decision = calculateDecision(unsafe, { usefulnessReviews: [true, true, true] });
    expect(decision).toMatchObject({ decision: "FAIL", productionAuthorized: false });
  });
});
