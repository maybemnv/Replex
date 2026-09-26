import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOperationBatch } from "../src/operations-v2.js";
import type { ProjectV2 } from "../src/schema-v2.js";
import { LocalProjectService } from "../src/service/local.js";

const projectDirectory = (workspaceRoot: string, projectId: string) =>
  join(workspaceRoot, "projects", createHash("sha256").update(projectId).digest("hex"));
const projectPath = (workspaceRoot: string, projectId: string) =>
  join(projectDirectory(workspaceRoot, projectId), "project.json");
const operationLogPath = (workspaceRoot: string, projectId: string) =>
  join(projectDirectory(workspaceRoot, projectId), "operations", "operations.jsonl");
const revisionSnapshotPath = (workspaceRoot: string, projectId: string, revisionId: string) =>
  join(projectDirectory(workspaceRoot, projectId), "revisions", createHash("sha256").update(revisionId).digest("hex") + ".json");

describe("LocalProjectService", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  });

  async function createService() {
    workspaceRoot = await mkdtemp(join(tmpdir(), "replex-local-service-"));
    return new LocalProjectService({ workspaceRoot });
  }

  async function createProject(service: LocalProjectService, idempotencyKey = "create-project", name = "QA walkthrough") {
    return service.createProject({
      contractVersion: "v1",
      idempotencyKey,
      name,
      brief: { audience: "product users" },
    });
  }

  function titleRequest(projectId: string, baseRevisionId: string, idempotencyKey = "edit-title", layerId = "title-one") {
    return {
      contractVersion: "v1" as const,
      idempotencyKey,
      actor: "user" as const,
      projectId,
      baseRevisionId,
      operations: [{
        type: "add_text_layer" as const,
        layer: {
          id: layerId, trackId: "track-overlay", kind: "text" as const,
          timelineStartMs: 0, durationMs: 1000,
          properties: { text: "QA Issues", fontSize: 32 }, keyframes: [],
        },
      }],
    };
  }

  it("persists and reopens a V2 project by opaque project and revision IDs", async () => {
    const service = await createService();
    const created = await createProject(service);
    const opened = await service.openProject({
      contractVersion: "v1",
      idempotencyKey: "open-project-1",
      projectId: created.projectId,
      revisionId: created.revisionId,
    });

    expect(opened.summary.projectId).toBe(created.projectId);
    expect(opened.revisionId).toBe(created.revisionId);
    expect(opened.isCurrentRevision).toBe(true);
    expect(opened.summary.projectSchemaVersion).toBe(2);
    const persisted = JSON.parse(await readFile(projectPath(workspaceRoot!, created.projectId), "utf8")) as { schemaVersion: number; projectId: string };
    expect(persisted).toMatchObject({ schemaVersion: 2, projectId: created.projectId });
    expect(JSON.stringify(opened)).not.toContain(workspaceRoot);
    expect(service.capabilities().contractVersion).toBe("v1");
    expect(service.capabilities().assetTypes).toEqual(["uploaded_video", "image", "audio"]);
  });

  it("returns a strict historical snapshot and replays an idempotent typed batch", async () => {
    const service = await createService();
    const created = await createProject(service);
    const request = titleRequest(created.projectId, created.revisionId);
    const applied = await service.applyOperations(request);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const opened = await service.openProject({
      contractVersion: "v1", idempotencyKey: "open-edited",
      projectId: created.projectId, revisionId: applied.revisionId,
    });
    expect(opened.isCurrentRevision).toBe(true);
    expect(opened.composition.layers).toHaveLength(1);
    expect(opened.composition.layers[0]).toMatchObject({ id: "title-one", properties: { text: "QA Issues" } });
    expect(await service.applyOperations(request)).toEqual(applied);

    const historical = await service.openProject({
      contractVersion: "v1", idempotencyKey: "open-original",
      projectId: created.projectId, revisionId: created.revisionId,
    });
    expect(historical.isCurrentRevision).toBe(false);
    expect(historical.summary.currentRevisionId).toBe(applied.revisionId);
    expect(historical.composition.layers).toHaveLength(0);
  });

  it("serializes same-base writes and rejects the losing stale revision without changing state", async () => {
    const service = await createService();
    const secondService = new LocalProjectService({ workspaceRoot: workspaceRoot! });
    const created = await createProject(service, "create-concurrency", "Concurrency");
    const makeRequest = (key: string, layerId: string) => ({
      contractVersion: "v1" as const, idempotencyKey: key, actor: "user" as const,
      projectId: created.projectId, baseRevisionId: created.revisionId,
      operations: [{
        type: "add_text_layer" as const,
        layer: {
          id: layerId, trackId: "track-overlay", kind: "text" as const,
          timelineStartMs: 0, durationMs: 1000,
          properties: { text: layerId }, keyframes: [],
        },
      }],
    });

    const results = await Promise.all([
      service.applyOperations(makeRequest("concurrent-a", "title-a")),
      secondService.applyOperations(makeRequest("concurrent-b", "title-b")),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "STALE_REVISION")).toHaveLength(1);
    const winner = results.find((result) => result.ok)!;
    const current = await service.openProject({
      contractVersion: "v1", idempotencyKey: "open-after-race",
      projectId: created.projectId, revisionId: winner.revisionId,
    });
    expect(current.composition.layers).toHaveLength(1);
  });

  it("rejects an invalid semantic batch without publishing a revision", async () => {
    const service = await createService();
    const created = await createProject(service, "create-atomicity", "Atomicity");
    const bad = await service.applyOperations({
      contractVersion: "v1", idempotencyKey: "invalid-edit", actor: "user",
      projectId: created.projectId, baseRevisionId: created.revisionId,
      operations: [{
        type: "add_text_layer",
        layer: {
          id: "bad-title", trackId: "missing-track", kind: "text",
          timelineStartMs: 0, durationMs: 1000, properties: { text: "bad" }, keyframes: [],
        },
      }],
    });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
    const current = await service.openProject({
      contractVersion: "v1", idempotencyKey: "open-after-failure",
      projectId: created.projectId, revisionId: created.revisionId,
    });
    expect(current.summary.currentRevisionId).toBe(created.revisionId);
    expect(current.composition.layers).toHaveLength(0);
  });

  it("persists multiple consecutive revisions without overwriting their history", async () => {
    const service = await createService();
    const created = await createProject(service, "create-sequence", "Revision sequence");
    const first = await service.applyOperations(titleRequest(created.projectId, created.revisionId, "edit-one", "title-one"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await service.applyOperations(titleRequest(created.projectId, first.revisionId, "edit-two", "title-two"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const current = await service.openProject({
      contractVersion: "v1", idempotencyKey: "open-sequence",
      projectId: created.projectId, revisionId: second.revisionId,
    });
    expect(current.revisions).toHaveLength(3);
    expect(current.composition.layers.map((layer) => layer.id)).toEqual(["title-one", "title-two"]);
  });

  it("rejects reusing an operation idempotency key for a different batch", async () => {
    const service = await createService();
    const created = await createProject(service, "create-idem-conflict", "Idempotency conflict");
    const request = titleRequest(created.projectId, created.revisionId, "same-edit-key");
    const first = await service.applyOperations(request);
    expect(first.ok).toBe(true);
    await expect(service.applyOperations(titleRequest(created.projectId, created.revisionId, "same-edit-key", "other-title")))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("deduplicates create retries and rejects a reused key with different input", async () => {
    const service = await createService();
    const first = await createProject(service, "same-create-key", "Original name");
    const retry = await createProject(service, "same-create-key", "Original name");
    expect(retry).toEqual(first);
    await expect(createProject(service, "same-create-key", "Different name"))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("does not treat an orphaned operation-log row as a committed edit", async () => {
    const service = await createService();
    const created = await createProject(service, "create-orphan", "Orphan recovery");
    const request = titleRequest(created.projectId, created.revisionId, "retry-after-crash");
    const canonical = JSON.parse(await readFile(projectPath(workspaceRoot!, created.projectId), "utf8")) as ProjectV2;
    const predicted = applyOperationBatch(canonical, {
      baseRevisionId: request.baseRevisionId,
      actor: "user",
      intentId: "intent-" + createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 32),
      evidenceRefs: [],
      operations: request.operations,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(predicted.ok).toBe(true);
    if (!predicted.ok) return;

    await writeFile(revisionSnapshotPath(workspaceRoot!, created.projectId, predicted.revisionId), JSON.stringify(predicted.project));
    await writeFile(operationLogPath(workspaceRoot!, created.projectId), predicted.operationLog.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await expect(service.openProject({
      contractVersion: "v1", idempotencyKey: "open-orphan",
      projectId: created.projectId, revisionId: predicted.revisionId,
    })).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    const retried = await service.applyOperations(request);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.revisionId).toBe(predicted.revisionId);
    const current = await service.openProject({
      contractVersion: "v1", idempotencyKey: "open-recovered",
      projectId: created.projectId, revisionId: retried.revisionId,
    });
    expect(current.composition.layers).toHaveLength(1);
  });

  it("fails closed when a committed operation is missing from the operation log", async () => {
    const service = await createService();
    const created = await createProject(service, "create-log-check", "Log integrity");
    const applied = await service.applyOperations(titleRequest(created.projectId, created.revisionId, "committed-edit"));
    expect(applied.ok).toBe(true);
    await writeFile(operationLogPath(workspaceRoot!, created.projectId), "");

    await expect(service.openProject({
      contractVersion: "v1", idempotencyKey: "open-corrupt-log",
      projectId: created.projectId, revisionId: created.revisionId,
    })).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });

  it("fails closed when a project exists without its create idempotency metadata", async () => {
    const service = await createService();
    const created = await createProject(service, "create-metadata", "Metadata");
    await rm(join(projectDirectory(workspaceRoot!, created.projectId), "metadata.json"));
    await expect(createProject(service, "create-metadata", "Metadata"))
      .rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });

  it("detects a valid-shape operation-log edit by replaying the revision", async () => {
    const service = await createService();
    const created = await createProject(service, "create-replay-check", "Replay integrity");
    const applied = await service.applyOperations(titleRequest(created.projectId, created.revisionId, "replay-edit"));
    expect(applied.ok).toBe(true);

    const path = operationLogPath(workspaceRoot!, created.projectId);
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { input: { layer: { properties: { text: string } } } });
    records[0]!.input.layer.properties.text = "tampered";
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    await expect(service.openProject({
      contractVersion: "v1", idempotencyKey: "open-tampered",
      projectId: created.projectId, revisionId: applied.ok ? applied.revisionId : created.revisionId,
    })).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });
  it("does not resolve an invalid project ID as a filesystem path", async () => {
    const service = await createService();
    await expect(service.openProject({
      contractVersion: "v1", idempotencyKey: "path-probe",
      projectId: "project..outside", revisionId: "revision-0",
    })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});
