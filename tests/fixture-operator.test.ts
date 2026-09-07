import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureDefinition, startFixtureServers, type RunningFixtureServers } from "../fixtures/operator.js";

describe("fixture operator", () => {
  let running: RunningFixtureServers | undefined;
  afterEach(async () => { await running?.close(); running = undefined; });
  it("starts every fixture and exposes deterministic controls", async () => {
    running = await startFixtureServers({ normal: 0, dynamic: 0, difficult: 0 });
    for (const kind of ["normal", "dynamic", "difficult"] as const) { const origin = running.origins[kind]; expect((await fetch(origin)).status).toBe(200); expect((await fetch(`${origin}/__reset`, { method: "POST" })).status).toBe(204); }
    const dynamic = running.origins.dynamic; await fetch(`${dynamic}/__change`, { method: "POST" }); expect(await (await fetch(dynamic)).text()).toContain("Loaded 84 records");
  });
  it("builds fixture definitions without placeholder capture metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-fixture-definition-"));
    try { const definition = fixtureDefinition("difficult", "http://127.0.0.1:4175", root); expect(definition.values.difficultAsset).toBe(join(root, "uploads", "release-asset.txt")); expect(definition.flow.steps.some((step) => step.action === "upload")).toBe(true); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});
