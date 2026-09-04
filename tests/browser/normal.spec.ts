import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { stat } from "node:fs/promises";
import { normalEnvironment, normalFlow } from "../../fixtures/apps/normal/flow.js";
import { runCapture } from "../../src/capture.js";

const pageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Release Replay Demo</title></head>
<body>
  <main data-testid="release-page">
    <h1>Release Replay Demo</h1>
    <button type="button" aria-label="Open filters" id="open-filter">Open filters</button>
    <section data-testid="filter-panel" hidden>
      <label for="filter-value">Filter value</label>
      <input id="filter-value" name="filter-value" />
      <button type="button" aria-label="Apply" id="apply-filter">Apply</button>
    </section>
    <p data-testid="result" hidden>Showing 3 matching releases</p>
  </main>
  <script>
    const panel = document.querySelector('[data-testid="filter-panel"]');
    document.querySelector('#open-filter').addEventListener('click', () => { panel.hidden = false; });
    document.querySelector('#apply-filter').addEventListener('click', () => {
      document.querySelector('[data-testid="result"]').hidden = false;
    });
  </script>
</body></html>`;

describe("normal approved flow", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/__reset" && request.method === "POST") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not start");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("captures every approved checkpoint twice with stable action and scene keys", async () => {
    const first = await runCapture(normalFlow(origin), normalEnvironment(origin), {
      artifactRoot: "work/test-normal-first",
      values: { filterValue: "release" },
      reset: async () => {
        await fetch(`${origin}/__reset`, { method: "POST" });
      },
    });
    const second = await runCapture(normalFlow(origin), normalEnvironment(origin), {
      artifactRoot: "work/test-normal-second",
      values: { filterValue: "release" },
      reset: async () => {
        await fetch(`${origin}/__reset`, { method: "POST" });
      },
    });

    expect(first.run.status).toBe("passed");
    expect(second.run.status).toBe("passed");
    expect(first.captures).toHaveLength(3);
    expect(first.captures.every((capture) => capture.durationMs > 0)).toBe(true);
    expect(new Set(first.captures.map((capture) => capture.sourcePath)).size).toBe(3);
    expect(first.captures.every((capture) => /^[a-f0-9]{64}$/.test(capture.sha256))).toBe(true);
    expect(first.captures.every((capture) => capture.checkpointActionId && capture.actionIds.length > 0)).toBe(true);
    await Promise.all(first.captures.map(async (capture) => expect((await stat(capture.sourcePath)).size).toBeGreaterThan(0)));
    expect(first.captures.map((capture) => capture.sceneKey)).toEqual(second.captures.map((capture) => capture.sceneKey));
    expect(first.actionEvents.map((event) => event.actionId)).toEqual(second.actionEvents.map((event) => event.actionId));
    expect(first.artifacts.every((artifact) => artifact.path)).toBe(true);
    expect(first.tracePath).toMatch(/trace\.zip$/);
  }, 30_000);
});
