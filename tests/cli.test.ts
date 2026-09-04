import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

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
});
