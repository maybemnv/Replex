import { describe, expect, it } from "vitest";
import { capturesFromRun } from "../src/project.js";

describe("capture-to-project bridge", () => {
  it("retains immutable provenance while converting artifact paths to the project root", () => {
    const result = capturesFromRun({
      run: { id: "run-1", attempt: 1, status: "passed" },
      runPath: "C:/work/project/run-1/run.json",
      rawVideoPath: "C:/work/project/run-1/raw.webm",
      tracePath: "C:/work/project/run-1/traces/trace.zip",
      logs: { actionsPath: "C:/work/project/run-1/logs/actions.jsonl", consolePath: "C:/work/project/run-1/logs/console.jsonl" },
      actionEvents: [], artifacts: [],
      captures: [{ sceneKey: "open-demo", sourcePath: "C:/work/project/run-1/captures/open-demo.webm", sha256: "a".repeat(64), width: 1920, height: 1080, durationMs: 10000, runId: "run-1", actionIds: ["open"], checkpointActionId: "open" }],
    });
    expect(result).toMatchObject({ root: "C:/work/project/run-1", captures: [{ path: "captures/open-demo.webm", runId: "run-1", actionIds: ["open"] }] });
  });
});
