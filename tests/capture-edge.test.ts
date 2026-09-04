import { describe, expect, it } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import {
  browserContextOptions,
  deriveSceneBoundaries,
  resolveStorageStatePath,
  runCapture,
  validateCapturePlan,
} from "../src/capture.js";

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

  it("keeps browser storage state outside project artifacts", () => {
    expect(() => resolveStorageStatePath("work/project", "work/project/auth.json")).toThrow("outside project artifacts");
    expect(resolveStorageStatePath("work/project", join(tmpdir(), "replex-auth.json"))).toBe(resolve(tmpdir(), "replex-auth.json"));
  });

  it("reports a checkpoint mismatch as a typed failure", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<main>wrong page</main>");
    });
    const origin = server.origin;

    try {
      let failure: { code: string; actionId: string; evidencePath: string; tracePath: string; runPath: string };
      try {
        await runCapture(normalFlow(origin), normalEnvironment(origin), {
          artifactRoot: "work/edge-checkpoint",
          attempt: 4,
        });
        throw new Error("expected capture to fail");
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure).toMatchObject({ code: "CHECKPOINT_MISMATCH", actionId: "open-release-page" });
      const evidence = JSON.parse(await readFile(failure.evidencePath, "utf8")) as Record<string, unknown>;
      expect(evidence).toMatchObject({ actionId: "open-release-page", url: `${origin}/` });
      expect(evidence.domExcerpt).toEqual(expect.any(String));
      expect(String(evidence.domExcerpt).length).toBeLessThanOrEqual(4000);
      await expect(stat(failure.tracePath)).resolves.toMatchObject({ size: expect.any(Number) });
      const run = JSON.parse(await readFile(failure.runPath, "utf8")) as Record<string, unknown>;
      expect(run).toMatchObject({ attempt: 4, status: "failed", actionId: "open-release-page" });
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
          artifactRoot: join(tmpdir(), "replex-edge-auth"),
          attempt: 3,
        }),
      ).rejects.toMatchObject({ code: "AUTH_EXPIRED", actionId: "open-release-page" });
    } finally {
      await server.close();
    }
  }, 30_000);

  it("attributes action failures to the action that failed", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<main data-testid=\"release-page\">ok</main>");
    });
    try {
      await expect(
        runCapture(normalFlow(server.origin), normalEnvironment(server.origin), {
          artifactRoot: join(tmpdir(), "replex-edge-action"),
        }),
      ).rejects.toMatchObject({ code: "ACTION_FAILED", actionId: "open-filter" });
    } finally {
      await server.close();
    }
  }, 30_000);

  it("enforces a declared wait condition", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end(`
        <main data-testid="release-page">ok</main>
        <p data-testid="status">Loading</p>
        <script>setTimeout(() => { document.querySelector('[data-testid=status]').textContent = 'Ready'; }, 50)</script>
      `);
    });
    const flow = normalFlow(server.origin);
    flow.steps = [
      flow.steps[0],
      {
        id: "wait-ready",
        order: 1,
        action: "waitFor",
        target: { kind: "testId", value: "status" },
        consequential: false,
        approved: true,
        checkpoint: { kind: "text", target: { kind: "testId", value: "status" }, expected: "Ready" },
        sceneKey: "ready",
      },
    ];
    try {
      await expect(
        runCapture(flow, normalEnvironment(server.origin), {
          artifactRoot: join(tmpdir(), "replex-edge-wait"),
        }),
      ).resolves.toMatchObject({ run: { status: "passed" } });
    } finally {
      await server.close();
    }
  }, 30_000);

  it("checks URL and attribute checkpoints using their declared semantics", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<main data-testid=\"status\" data-state=\"ready\">ok</main>");
    });
    try {
      const urlFlow = normalFlow(server.origin);
      urlFlow.steps = [{
        ...urlFlow.steps[0],
        checkpoint: { kind: "url", expected: `${server.origin}/` },
      }];
      await expect(runCapture(urlFlow, normalEnvironment(server.origin), {
        artifactRoot: join(tmpdir(), "replex-edge-url"),
      })).resolves.toMatchObject({ run: { status: "passed" } });

      const attributeFlow = normalFlow(server.origin);
      attributeFlow.steps = [{
        ...attributeFlow.steps[0],
        checkpoint: { kind: "attribute", target: { kind: "testId", value: "status" }, expected: "data-state=ready" },
      }];
      await expect(runCapture(attributeFlow, normalEnvironment(server.origin), {
        artifactRoot: join(tmpdir(), "replex-edge-attribute"),
      })).resolves.toMatchObject({ run: { status: "passed" } });
    } finally {
      await server.close();
    }
  }, 30_000);

  it("rejects a runtime redirect outside the allowed origin", async () => {
    const target = await listen((_, response) => response.writeHead(200).end("outside"));
    const source = await listen((_, response) => response.writeHead(302, { location: target.origin }).end());
    const flow = normalFlow(source.origin);

    try {
      await expect(runCapture(flow, normalEnvironment(source.origin), {
        artifactRoot: "work/edge-redirect",
      })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED", actionId: "open-release-page" });
    } finally {
      await source.close();
      await target.close();
    }
  }, 30_000);

  it("uses the declared semantic role instead of assuming a button", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end('<main data-testid="release-page"><a aria-label="Details" href="#details">Open</a></main>');
    });
    const flow = normalFlow(server.origin);
    flow.steps = [
      flow.steps[0],
      {
        id: "open-details",
        order: 1,
        action: "click",
        target: { kind: "role", value: "link", name: "Details" },
        consequential: false,
        approved: true,
        checkpoint: { kind: "url", expected: `${server.origin}/#details` },
        sceneKey: "details",
      },
    ];
    try {
      await expect(runCapture(flow, normalEnvironment(server.origin), {
        artifactRoot: join(tmpdir(), "replex-edge-role"),
      })).resolves.toMatchObject({ run: { status: "passed" } });
    } finally {
      await server.close();
    }
  }, 30_000);

  it("records the attempt and action log when media finalization fails", async () => {
    const server = await listen((_, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end('<main data-testid="release-page">ok</main>');
    });
    const flow = normalFlow(server.origin);
    flow.steps = [flow.steps[0]];
    let failure: { runPath: string };
    try {
      try {
        await runCapture(flow, normalEnvironment(server.origin), {
          artifactRoot: join(tmpdir(), "replex-edge-media-failure"),
          attempt: 7,
          ffprobePath: "C:/missing/ffprobe.exe",
        });
        throw new Error("expected media finalization to fail");
      } catch (error) {
        failure = error as typeof failure;
      }
      await expect(readFile(failure.runPath, "utf8")).resolves.toContain('"attempt": 7');
      const actionsPath = join(dirname(failure.runPath), "logs", "actions.json");
      const actions = JSON.parse(await readFile(actionsPath, "utf8")) as Array<Record<string, unknown>>;
      expect(actions[0]).toMatchObject({ attempt: 7, actionId: "open-release-page", outcome: "passed" });
    } finally {
      await server.close();
    }
  }, 30_000);
});

it("derives scene boundaries directly from monotonic event times", () => {
  expect(deriveSceneBoundaries(
    [
      { sceneKey: "one", actionIds: ["a"], checkpointActionId: "a" },
      { sceneKey: "two", actionIds: ["b"], checkpointActionId: "b" },
      { sceneKey: "three", actionIds: ["c"], checkpointActionId: "c" },
    ],
    [
      { actionId: "a", atMs: 2_000 },
      { actionId: "b", atMs: 6_000 },
      { actionId: "c", atMs: 9_000 },
    ],
    20,
  ).map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds])).toEqual([
    [0, 2],
    [2, 6],
    [6, 20],
  ]);
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
