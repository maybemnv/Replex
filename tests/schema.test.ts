import { describe, expect, it } from "vitest";
import { RuntimeConfigSchema, transitionAdjustedDurationMs } from "../src/schema.js";

const validConfig = {
  appOrigin: "http://localhost:3000",
  allowedOrigins: ["http://localhost:3000"],
  locale: "en-US",
  timezone: "Asia/Kolkata",
  brief: {
    audience: "SaaS founders",
    message: "Show the new filter",
    targetDurationMs: 30000,
  },
};

describe("RuntimeConfigSchema", () => {
  it("accepts the fixed millisecond runtime config", () => {
    expect(RuntimeConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("rejects unknown fields", () => {
    expect(() => RuntimeConfigSchema.parse({ ...validConfig, extra: true })).toThrow();
  });

  it("rejects mixed time units", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        ...validConfig,
        brief: { ...validConfig.brief, targetDurationSeconds: 30 },
      }),
    ).toThrow();
  });

  it.each([
    ["path", "http://localhost:3000/dashboard"],
    ["query", "http://localhost:3000/?mode=preview"],
    ["fragment", "http://localhost:3000/#preview"],
    ["userinfo", "http://operator:secret@localhost:3000"],
    ["empty userinfo", "http://@localhost:3000"],
  ])("rejects an origin with a %s", (_part, invalidOrigin) => {
    expect(() =>
      RuntimeConfigSchema.parse({ ...validConfig, appOrigin: invalidOrigin }),
    ).toThrow();
    expect(() =>
      RuntimeConfigSchema.parse({
        ...validConfig,
        allowedOrigins: [validConfig.appOrigin, invalidOrigin],
      }),
    ).toThrow();
  });
});

describe("transitionAdjustedDurationMs", () => {
  it("sums speed-adjusted scene durations", () => {
    expect(transitionAdjustedDurationMs([
      { durationMs: 9000, speed: 1, transition: { type: "cut", durationMs: 0 } },
      { durationMs: 9000, speed: 1, transition: { type: "cut", durationMs: 0 } },
    ])).toBe(18000);
  });

  it("subtracts crossfade overlap once per transition", () => {
    expect(transitionAdjustedDurationMs([
      { durationMs: 9000, speed: 1, transition: { type: "crossfade", durationMs: 500 } },
      { durationMs: 9000, speed: 1, transition: { type: "cut", durationMs: 0 } },
    ])).toBe(17500);
  });
});

