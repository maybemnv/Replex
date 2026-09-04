import { describe, expect, it } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { browserContextOptions, runCapture, validateCapturePlan } from "../src/capture.js";

describe("capture safety boundary", () => {
  it("rejects a prohibited consequential action before execution", () => {
    const flow = normalFlow("http://127.0.0.1:4173");
    flow.steps[1] = {
      ...flow.steps[1],
      consequential: true,
      target: { kind: "role", value: "button", name: "Delete release" },
    };

    expect(() => validateCapturePlan(flow, normalEnvironment("http://127.0.0.1:4173"))).toThrowError(
      expect.objectContaining({ code: "ACTION_NOT_APPROVED", actionId: "open-filter" }),
    );
  });

  it("exposes fixed context settings", () => {
    expect(browserContextOptions(normalEnvironment("http://127.0.0.1:4173"))).toMatchObject({
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "Asia/Calcutta",
      reducedMotion: "reduce",
      colorScheme: "light",
      serviceWorkers: "block",
    });
  });

  it("reports a checkpoint mismatch as a typed failure", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<main>wrong page</main>");
    });
    const origin = server.origin;

    try {
      let failure: { code: string; actionId: string; evidencePath: string; tracePath: string };
      try {
        await runCapture(normalFlow(origin), normalEnvironment(origin), {
          artifactRoot: "work/edge-checkpoint",
        });
        throw new Error("expected capture to fail");
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure).toMatchObject({ code: "CHECKPOINT_MISMATCH", actionId: "open-release-page" });
      const evidence = JSON.parse(await readFile(failure.evidencePath, "utf8")) as Record<string, unknown>;
      expect(evidence).toMatchObject({ actionId: "open-release-page", url: `${origin}/` });
      await expect(stat(failure.tracePath)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await server.close();
    }
  }, 30_000);

  it("reports expired authentication as a typed failure", async () => {
    const server = await listen((_, response) => {
      response.writeHead(401, { "content-type": "text/plain" }).end("expired");
    });
    const origin = server.origin;

    try {
      await expect(
        runCapture(normalFlow(origin), normalEnvironment(origin), {
          artifactRoot: "work/edge-auth",
        }),
      ).rejects.toMatchObject({ code: "AUTH_EXPIRED", actionId: "open-release-page" });
    } finally {
      await server.close();
    }
  }, 30_000);
});

async function listen(handler: RequestListener) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not start");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
