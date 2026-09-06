import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { checkStartupTools, runCli } from "../src/cli.js";
import { createProject, loadProject, writeRevision } from "../src/project.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

function captureOutput() {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    io: {
      stdout: (value: string) => {
        output.stdout += value;
      },
      stderr: (value: string) => {
        output.stderr += value;
      },
    },
  };
}

describe("CLI", () => {
  it("lists every POC command in help", async () => {
    const { output, io } = captureOutput();

    const exitCode = await runCli(["--help"], { io });

    expect(exitCode).toBe(0);
    expect(output.stdout).toContain("capture");
    expect(output.stdout).toContain("baseline");
    expect(output.stdout).toContain("agent-draft");
    expect(output.stdout).toContain("verify");
    expect(output.stdout).toContain("render");
    expect(output.stdout).toContain("recapture");
    expect(output.stdout).toContain("report");
  });

  it("returns a typed failure naming every missing startup tool", async () => {
    const { output, io } = captureOutput();

    const exitCode = await runCli(["capture"], {
      io,
      toolPaths: {
        chromium: "C:/missing/chromium.exe",
        ffmpeg: "C:/missing/ffmpeg.exe",
        ffprobe: "C:/missing/ffprobe.exe",
      },
    });

    expect(exitCode).toBe(1);
    expect(output.stderr).toContain('"code":"STARTUP_CHECK_FAILED"');
    expect(output.stderr).toContain("chromium");
    expect(output.stderr).toContain("ffmpeg");
    expect(output.stderr).toContain("ffprobe");
  });

  it("executes Chromium's version probe instead of trusting an existing path", () => {
    const result = checkStartupTools({
      chromium: fileURLToPath(import.meta.url),
      ffmpeg: "C:/missing/ffmpeg.exe",
      ffprobe: "C:/missing/ffprobe.exe",
    });

    expect(result.missing).toContain("chromium");
  });

  it("records the version reported by an executable", () => {
    const probe = checkStartupTools({ ffmpeg: "C:/missing/ffmpeg.exe", ffprobe: "C:/missing/ffprobe.exe", chromium: process.env.REPLEX_CHROMIUM_PATH });
    const chromiumTool = probe.tools.find((tool) => tool.name === "chromium");
    if (!chromiumTool?.available) {
      console.warn("skipping Chromium version probe: bundled Chromium is not installed (run `npx playwright install chromium`)");
      return;
    }

    const result = checkStartupTools({ ffmpeg: "C:/missing/ffmpeg.exe", ffprobe: "C:/missing/ffprobe.exe" });

    expect(result.tools.find((tool) => tool.name === "chromium")).toMatchObject({
      available: true,
      version: expect.stringMatching(/(?:Chrome|Chromium)\//),
    });
  }, 20_000);

  it("preserves typed codes for usage and config failures", async () => {
    const unknown = captureOutput();
    expect(await runCli(["bogus-command"], { io: unknown.io })).toBe(1);
    expect(unknown.output.stderr).toContain('"code":"CLI_USAGE_ERROR"');

    const unreadable = captureOutput();
    expect(await runCli(["capture", "--config", "C:/missing/runtime-config.json"], { io: unreadable.io })).toBe(1);
    expect(unreadable.output.stderr).toContain('"code":"CONFIG_READ_FAILED"');
  });

  it("rejects an exit-0 executable without the expected tool signature", () => {
    const cross = checkStartupTools({
      chromium: "C:/missing/chromium.exe",
      ffmpeg: "C:/missing/ffmpeg.exe",
      ffprobe: process.env.REPLEX_FFPROBE_PATH ?? "ffprobe",
    });
    if (!cross.tools.find((tool) => tool.name === "ffprobe")?.available) {
      console.warn("skipping signature test: ffprobe is not installed");
      return;
    }
    const result = checkStartupTools({
      chromium: "C:/missing/chromium.exe",
      ffmpeg: process.env.REPLEX_FFPROBE_PATH ?? "ffprobe",
      ffprobe: "C:/missing/ffprobe.exe",
    });

    expect(result.missing).toContain("ffmpeg");
    expect(result.tools.find((tool) => tool.name === "ffmpeg")).toMatchObject({
      available: false,
      detail: expect.stringContaining("version signature"),
    });
  });

  describe.skipIf(!mediaAvailable)("capture materialization", () => {
    let server: Server;
    let origin: string;

    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
          <main data-testid="release-page">
            <h1>Release Replay Demo</h1>
            <button type="button" aria-label="Open filters" id="open-filter">Open filters</button>
            <section data-testid="filter-panel" hidden>
              <h2>Filter releases</h2>
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
          </script>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server did not start");
      origin = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });

    it("writes a canonical revision with immutable project-relative captures", async () => {
      const root = await mkdtemp(join(tmpdir(), "replex-cli-capture-"));
      try {
        const initial = createProject({
          projectId: "cli-capture-project",
          brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
          environment: normalEnvironment(origin),
          flow: normalFlow(origin),
          captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({
            id: `stale-${sceneKey}`,
            sceneKey,
            path: `captures/${sceneKey}.webm`,
            durationMs: 10000,
            sha256: String(index + 1).repeat(64),
          })),
        });
        await writeRevision(root, initial);

        const output = { stdout: "", stderr: "" };
        const exitCode = await runCli(["capture", "--project", root, "--values", JSON.stringify({ filterValue: "replay" })], {
          io: {
            stdout: (value) => { output.stdout += value; },
            stderr: (value) => { output.stderr += value; },
          },
          toolPaths: { ffmpeg: ffmpegPath, ffprobe: ffprobePath },
        });

        expect(exitCode, output.stderr).toBe(0);
        const materialized = await loadProject(root);
        expect(materialized.currentRevisionId).not.toBe(initial.currentRevisionId);
        expect(materialized.revisions).toHaveLength(2);
        expect(materialized.revisions.at(-1)).toMatchObject({ parentId: initial.currentRevisionId, actor: "baseline" });
        expect(Object.values(materialized.captures)).toHaveLength(3);
        for (const capture of Object.values(materialized.captures)) {
          expect(capture.path).not.toMatch(/^([A-Za-z]:[\\/]|[\\/]|\.\.)/);
          expect(await stat(join(root, capture.path))).toMatchObject({ size: expect.any(Number) });
        }
        expect(materialized.scenes.map((scene) => scene.id)).toEqual(initial.scenes.map((scene) => scene.id));
        const revisionPath = join(root, "revisions", `${materialized.currentRevisionId}.json`);
        await expect(readFile(revisionPath, "utf8")).resolves.toBe(await readFile(join(root, "project.json"), "utf8"));
        const response = output.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(response[0]).toMatchObject({ command: "capture", status: "completed" });
        expect(response[0].revisionId).toBe(materialized.currentRevisionId);
        expect(new Set((response[0].captures as Array<{ path: string }>).map(({ path }) => path)))
          .toEqual(new Set(Object.values(materialized.captures).map((capture) => capture.path)));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("rejects malformed flow values before launching the browser", async () => {
      const root = await mkdtemp(join(tmpdir(), "replex-cli-values-"));
      try {
        const initial = createProject({
          projectId: "cli-values-project",
          brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
          environment: normalEnvironment(origin),
          flow: normalFlow(origin),
          captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({
            id: `stale-${sceneKey}`,
            sceneKey,
            path: `captures/${sceneKey}.webm`,
            durationMs: 10000,
            sha256: String(index + 1).repeat(64),
          })),
        });
        await writeRevision(root, initial);
        const output = { stdout: "", stderr: "" };
        const io = {
          stdout: (value: string) => { output.stdout += value; },
          stderr: (value: string) => { output.stderr += value; },
        };
        const exitCode = await runCli(["capture", "--project", root, "--values", "not-json"], {
          io,
          toolPaths: { ffmpeg: ffmpegPath, ffprobe: ffprobePath },
        });
        expect(exitCode).toBe(1);
        expect(output.stderr).toContain('"code":"CLI_USAGE_ERROR"');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
