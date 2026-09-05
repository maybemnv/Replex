import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { difficultEnvironment, difficultFlow } from "../../fixtures/apps/difficult/flow.js";
import { renderDifficultFixture, type DifficultFixtureState } from "../../fixtures/apps/difficult/app.js";
import { injectDifficultFailure, resetDifficultFixture } from "../../fixtures/apps/difficult/reset.js";
import { changeDifficultFixture } from "../../fixtures/apps/difficult/change.js";
import { runCapture, type CaptureRunError } from "../../src/capture.js";

describe("difficult browser approved flow", () => {
  let server: Server;
  let origin: string;
  let state: DifficultFixtureState;
  let uploadPath: string;

  beforeAll(async () => {
    state = { changed: false };
    uploadPath = join(tmpdir(), "replex-difficult-fixture.txt");
    await writeFile(uploadPath, "synthetic release replay fixture\n", "utf8");
    server = createServer((request, response) => {
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
      if (request.url?.startsWith("/__failure") && request.method === "POST") {
        const actionId = new URL(request.url, "http://fixture").searchParams.get("action") ?? "";
        state = { ...state, failureActionId: actionId };
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderDifficultFixture(state));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("difficult fixture server did not start");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const captureOptions = (attempt: number, reset = true) => ({
    artifactRoot: join(tmpdir(), `replex-difficult-${attempt}`),
    attempt,
    values: { difficultProjectName: "Release Replay", difficultAsset: uploadPath },
    uploadRoots: [tmpdir()],
    ...(reset ? { reset: () => resetDifficultFixture(origin) } : {}),
  });

  it("resets deterministically and captures wizard/upload/slow-validation states twice", async () => {
    const first = await runCapture(difficultFlow(origin), difficultEnvironment(origin), captureOptions(1));
    const second = await runCapture(difficultFlow(origin), difficultEnvironment(origin), captureOptions(2));

    expect(first.run.status).toBe("passed");
    expect(second.run.status).toBe("passed");
    expect(first.captures).toHaveLength(5);
    expect(first.captures.map((capture) => capture.sceneKey)).toEqual([
      "open-wizard",
      "configure-step",
      "upload-asset",
      "review-state",
      "slow-validation",
    ]);
    expect(first.captures.map((capture) => capture.sceneKey)).toEqual(second.captures.map((capture) => capture.sceneKey));
    expect(first.actionEvents.map((event) => event.actionId)).toEqual(second.actionEvents.map((event) => event.actionId));
    expect(first.captures.every((capture) => capture.durationMs > 0 && /^[a-f0-9]{64}$/.test(capture.sha256))).toBe(true);
    await Promise.all(first.captures.map(async (capture) => expect((await stat(capture.sourcePath)).size).toBeGreaterThan(0)));
  }, 60_000);

  it("captures the controlled changed review state with the same stable scene keys", async () => {
    await resetDifficultFixture(origin);
    await changeDifficultFixture(origin);
    const changed = await runCapture(difficultFlow(origin, { changed: true }), difficultEnvironment(origin), captureOptions(3, false));

    expect(changed.run.status).toBe("passed");
    expect(changed.captures.map((capture) => capture.sceneKey)).toEqual([
      "open-wizard",
      "configure-step",
      "upload-asset",
      "review-state",
      "slow-validation",
    ]);
    expect(changed.actionEvents.at(-1)?.actionId).toBe("difficult-run-validation");
  }, 30_000);

  it("retains named slow-validation evidence for the injected failure", async () => {
    await resetDifficultFixture(origin);
    await injectDifficultFailure(origin, "difficult-run-validation");

    let failure: CaptureRunError;
    try {
      await runCapture(difficultFlow(origin), difficultEnvironment(origin), captureOptions(4, false));
      throw new Error("expected difficult slow-validation checkpoint failure");
    } catch (error) {
      failure = error as CaptureRunError;
    }

    expect(failure).toMatchObject({ code: "CHECKPOINT_MISMATCH", actionId: "difficult-run-validation" });
    const evidence = JSON.parse(await readFile(failure.evidencePath!, "utf8")) as Record<string, unknown>;
    expect(evidence).toMatchObject({ actionId: "difficult-run-validation", code: "CHECKPOINT_MISMATCH" });
    expect(String(evidence.message)).toMatch(/timeout|expected|received/i);
  }, 30_000);
});
