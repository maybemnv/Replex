import { describe, expect, it } from "vitest";
import { capturesFromRun } from "../src/project.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("capture-to-project bridge", () => {
  it("retains immutable provenance while converting artifact paths to the project root", () => {
    const root = join(tmpdir(), "replex-project", "run-1");
    const result = capturesFromRun({
      run: { id: "run-1", attempt: 1, startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-09-01T00:00:01.000Z", status: "passed" },
      runPath: join(root, "run.json"),
      rawVideoPath: join(root, "raw.webm"),
      tracePath: join(root, "traces", "trace.zip"),
      logs: { actionsPath: join(root, "logs", "actions.jsonl"), consolePath: join(root, "logs", "console.jsonl") },
      actionEvents: [], artifacts: [],
      captures: [{ sceneKey: "open-demo", sourcePath: join(root, "captures", "open-demo.webm"), sha256: "a".repeat(64), width: 1920, height: 1080, durationMs: 10000, runId: "run-1", actionIds: ["open"], checkpointActionId: "open" }],
    });
    expect(result).toMatchObject({ root, captures: [{ path: "captures/open-demo.webm", tracePath: "traces/trace.zip", runId: "run-1", actionIds: ["open"] }] });
  });
});
