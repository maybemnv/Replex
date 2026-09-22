import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../src/schema.js";
import { ProjectV1Schema, parseProjectV1 } from "../src/schema-v1.js";

describe("frozen V1 project contract", () => {
  it("parses the existing golden project through the explicit V1 boundary", async () => {
    const golden = JSON.parse(await readFile(new URL("./golden/project-v1.json", import.meta.url), "utf8"));

    expect(parseProjectV1(golden)).toEqual(ProjectV1Schema.parse(golden));
    expect(ProjectV1Schema.parse(golden)).toEqual(ProjectSchema.parse(golden));
  });

  it("keeps V1 strict and rejects unknown versions and fields", async () => {
    const golden = JSON.parse(await readFile(new URL("./golden/project-v1.json", import.meta.url), "utf8"));

    expect(() => parseProjectV1({ ...golden, schemaVersion: 2 })).toThrow();
    expect(() => parseProjectV1({ ...golden, unexpected: true })).toThrow();
  });
});
