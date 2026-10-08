import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOperationBatch, createProjectV2, semanticHashV2 } from "../src/operations-v2.js";
import { LocalProjectStore } from "../src/service/project-store.js";

describe("LocalProjectStore candidate commits", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function setup() {
    root = await mkdtemp(join(tmpdir(), "replex-store-commit-"));
    const store = new LocalProjectStore(root);
    const base = await store.create(createProjectV2({ projectId: "commit-project", brief: {}, width: 320, height: 180, fps: 24, durationMs: 2000 }), "f".repeat(64), "Commit");
    const reduced = applyOperationBatch(base, {
      baseRevisionId: base.currentRevisionId,
      actor: "agent",
      intentId: "intent-agent-title",
      evidenceRefs: ["evidence/index.json"],
      operations: [{ type: "add_text_layer", layer: { id: "title", trackId: "track-overlay", kind: "text", timelineStartMs: 0, durationMs: 500, properties: { text: "Hello" }, keyframes: [] } }],
      createdAt: "2026-10-06T00:00:00.000Z",
    });
    if (!reduced.ok) throw new Error(reduced.detail);
    return { store, base, reduced };
  }

  it("publishes a reducer-equivalent candidate and stays idempotent on retry", async () => {
    const { store, base, reduced } = await setup();
    const input = { baseRevisionId: base.currentRevisionId, baseRevisionHash: semanticHashV2(base), project: reduced.project, operationLog: reduced.operationLog };

    const committed = await store.commitCandidate("commit-project", input);
    expect(committed).toMatchObject({ ok: true, revisionId: reduced.revisionId });
    expect((await store.current("commit-project")).currentRevisionId).toBe(reduced.revisionId);
    expect(await store.operationLog("commit-project")).toHaveLength(1);

    // A retried CAS with the old base is stale rather than double-applied.
    expect(await store.commitCandidate("commit-project", input)).toMatchObject({ ok: false, code: "STALE_REVISION" });
  });

  it("rejects a candidate whose semantic state differs from the replayed batch", async () => {
    const { store, base, reduced } = await setup();
    const tampered = structuredClone(reduced.project);
    tampered.brief = { message: "smuggled" };

    await expect(store.commitCandidate("commit-project", {
      baseRevisionId: base.currentRevisionId, baseRevisionHash: semanticHashV2(base), project: tampered, operationLog: reduced.operationLog,
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    expect((await store.current("commit-project")).currentRevisionId).toBe(base.currentRevisionId);
  });

  it("rejects a candidate built against a different base hash", async () => {
    const { store, base, reduced } = await setup();
    expect(await store.commitCandidate("commit-project", {
      baseRevisionId: base.currentRevisionId, baseRevisionHash: "0".repeat(64), project: reduced.project, operationLog: reduced.operationLog,
    })).toMatchObject({ ok: false, code: "STALE_REVISION" });
  });
});
