import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { checkStartupTools, runCli } from "../src/cli.js";

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
    const result = checkStartupTools({
      chromium: process.execPath,
      ffmpeg: "C:/missing/ffmpeg.exe",
      ffprobe: "C:/missing/ffprobe.exe",
    });

    expect(result.tools.find((tool) => tool.name === "chromium")).toMatchObject({
      available: true,
      version: expect.stringContaining("v"),
    });
  });
});
