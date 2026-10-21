import { describe, expect, it } from "vitest";
import { parseDemoArgs, runDemoCli } from "../src/demo/cli.js";

describe("local demo CLI", () => {
  it("defaults to scripted mode and requires explicit live opt-in and a model together", () => {
    expect(parseDemoArgs([])).toMatchObject({ once: false, check: false });
    expect(parseDemoArgs([])).not.toHaveProperty("liveModel");
    expect(() => parseDemoArgs(["--agent-model", "test-model"])).toThrow("both --live");
    expect(() => parseDemoArgs(["--live"])).toThrow("both --live");
    expect(parseDemoArgs(["--live", "--agent-model", "test-model", "--once"])).toMatchObject({ liveModel: "test-model", once: true });
  });
  it("rejects malformed/repeated options and any requested public binding", () => {
    for (const argv of [["--workspace"], ["--workspace", "--once"], ["--once", "--once"], ["--once", "--check"], ["--host", "0.0.0.0"], ["--allow-private-networks"]]) {
      expect(() => parseDemoArgs(argv)).toThrow();
    }
  });
  it("prints help and argument errors without starting services or needing provider keys", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io = { stdout: (text: string) => { output.push(text); }, stderr: (text: string) => { errors.push(text); } };
    expect(await runDemoCli(["--help"], io)).toBe(0);
    expect(output.join("")).toContain("npm run demo");
    expect(await runDemoCli(["--live"], io)).toBe(1);
    expect(errors.join("")).toContain("both --live");
    expect(errors.join("")).not.toContain("Starting");
  });
});
