import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import {
  CapturePlanError,
  buildScenePlan,
  validateCapturePlan,
  writeImmutableArtifact,
} from "../src/capture.js";

describe("approved capture plan", () => {
  it("rejects an unapproved consequential action before execution", () => {
    const flow = normalFlow("http://127.0.0.1:4173");
    flow.steps[1] = { ...flow.steps[1], consequential: true, approved: false };

    expect(() => validateCapturePlan(flow, normalEnvironment("http://127.0.0.1:4173"))).toThrowError(
      expect.objectContaining({ code: "ACTION_NOT_APPROVED", actionId: flow.steps[1].id }),
    );
  });

  it("rejects a declared navigation outside the allowed origins", () => {
    const flow = normalFlow("http://127.0.0.1:4173");
    flow.steps[0] = {
      ...flow.steps[0],
      target: { kind: "url", value: "https://example.invalid/" },
    };

    expect(() => validateCapturePlan(flow, normalEnvironment("http://127.0.0.1:4173"))).toThrowError(
      expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }),
    );
  });

  it("groups approved scene markers without changing their stable keys", () => {
    const plan = buildScenePlan(normalFlow("http://127.0.0.1:4173"));

    expect(plan.map((scene) => scene.sceneKey)).toEqual(["open-demo", "open-filter", "apply-filter"]);
    expect(plan[0].actionIds).toEqual(["open-release-page"]);
    expect(plan[2].checkpointActionId).toBe("apply-filter");
  });
});

describe("immutable capture artifacts", () => {
  it("does not overwrite an existing artifact", async () => {
    const root = join(tmpdir(), `replex-capture-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "capture.webm");

    try {
      await writeImmutableArtifact(path, Buffer.from("first"));
      await expect(writeImmutableArtifact(path, Buffer.from("second"))).rejects.toThrow();
      await expect(readFile(path, "utf8")).resolves.toBe("first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("uses a typed capture-plan error", () => {
  const flow = normalFlow("http://127.0.0.1:4173");
  flow.steps[0] = { ...flow.steps[0], approved: false };

  try {
    validateCapturePlan(flow, normalEnvironment("http://127.0.0.1:4173"));
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CapturePlanError);
  }
});
