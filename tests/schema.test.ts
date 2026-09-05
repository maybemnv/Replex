import { describe, expect, it } from "vitest";
import { RuntimeConfigSchema } from "../src/schema.js";

const validConfig = {
  appOrigin: "http://localhost:3000",
  allowedOrigins: ["http://localhost:3000"],
  locale: "en-US",
  timezone: "Asia/Calcutta",
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
