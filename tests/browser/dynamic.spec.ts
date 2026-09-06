import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dynamicEnvironment, dynamicFlow } from "../../fixtures/apps/dynamic/flow.js";
import { renderDynamicFixture, type DynamicFixtureState } from "../../fixtures/apps/dynamic/app.js";
import { injectDynamicFailure, resetDynamicFixture } from "../../fixtures/apps/dynamic/reset.js";
import { changeDynamicFixture } from "../../fixtures/apps/dynamic/change.js";
import { runCapture, type CaptureRunError } from "../../src/capture.js";

describe("dynamic SaaS approved flow", () => {
  let server: Server;
  let origin: string;
  let state: DynamicFixtureState;

  beforeAll(async () => {
    state = { changed: false };
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
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderDynamicFixture(state));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("dynamic fixture server did not start");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("resets deterministically and captures auth, async, modal, dropdown, and toast states twice", async () => {
    const options = (attempt: number) => ({
      artifactRoot: join(tmpdir(), `replex-dynamic-${attempt}`),
      attempt,
      values: { dynamicEmail: "demo@example.test", dynamicPassword: "fixture-password", dynamicPlan: "priority" },
      reset: () => resetDynamicFixture(origin),
    });
    const first = await runCapture(dynamicFlow(origin), dynamicEnvironment(origin), options(1));
    const second = await runCapture(dynamicFlow(origin), dynamicEnvironment(origin), options(2));

    expect(first.run.status).toBe("passed");
    expect(second.run.status).toBe("passed");
    expect(first.captures).toHaveLength(5);
    expect(first.captures.map((capture) => capture.sceneKey)).toEqual([
      "authenticate",
      "choose-plan",
      "inspect-details",
      "load-async",
      "save-toast",
    ]);
    expect(first.captures.map((capture) => capture.sceneKey)).toEqual(second.captures.map((capture) => capture.sceneKey));
    expect(first.actionEvents.map((event) => event.actionId)).toEqual(second.actionEvents.map((event) => event.actionId));
    expect(first.captures.every((capture) => capture.durationMs > 0 && /^[a-f0-9]{64}$/.test(capture.sha256))).toBe(true);
    await Promise.all(first.captures.map(async (capture) => expect((await stat(capture.sourcePath)).size).toBeGreaterThan(0)));
  }, 60_000);

  it("captures a controlled changed state without changing flow or scene keys", async () => {
    await resetDynamicFixture(origin);
    await changeDynamicFixture(origin);
    const changed = await runCapture(dynamicFlow(origin, { changed: true }), dynamicEnvironment(origin), {
      artifactRoot: join(tmpdir(), "replex-dynamic-changed"),
      attempt: 3,
      values: { dynamicEmail: "demo@example.test", dynamicPassword: "fixture-password", dynamicPlan: "priority" },
    });

    expect(changed.run.status).toBe("passed");
    expect(changed.captures.map((capture) => capture.sceneKey)).toEqual(dynamicFlow(origin).steps
      .filter((step) => step.sceneKey)
      .reduce<string[]>((keys, step) => (keys.at(-1) === step.sceneKey ? keys : [...keys, step.sceneKey!]), []));
    expect(changed.actionEvents.at(-1)?.actionId).toBe("dynamic-save-workspace");
  }, 30_000);

  it("retains named async-timeout evidence for the injected failure", async () => {
    await resetDynamicFixture(origin);
    await injectDynamicFailure(origin, "dynamic-load-async");

    let failure: CaptureRunError;
    try {
      await runCapture(dynamicFlow(origin), dynamicEnvironment(origin), {
        artifactRoot: join(tmpdir(), "replex-dynamic-failure"),
        attempt: 4,
        values: { dynamicEmail: "demo@example.test", dynamicPassword: "fixture-password", dynamicPlan: "priority" },
      });
      throw new Error("expected dynamic async checkpoint failure");
    } catch (error) {
      failure = error as CaptureRunError;
    }

    expect(failure).toMatchObject({ code: "CHECKPOINT_MISMATCH", actionId: "dynamic-load-async" });
    const evidence = JSON.parse(await readFile(failure.evidencePath!, "utf8")) as Record<string, unknown>;
    expect(evidence).toMatchObject({ actionId: "dynamic-load-async", code: "CHECKPOINT_MISMATCH" });
    expect(String(evidence.message)).toMatch(/timeout|expected|received/i);
  }, 30_000);
});
