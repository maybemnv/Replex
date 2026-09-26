import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalExecutor } from "../src/service/executor.js";
import { LocalExecutorError } from "../src/service/local-jobs.js";
import { LocalProjectService } from "../src/service/local.js";

describe("LocalExecutor apply-operation jobs", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  });

  async function startExecutor() {
    workspaceRoot = await mkdtemp(join(tmpdir(), "replex-local-jobs-"));
    const executor = new LocalExecutor({ workspaceRoot });
    await executor.start();
    return executor;
  }

  async function createProject(executor: LocalExecutor) {
    return executor.createProject({
      contractVersion: "v1",
      idempotencyKey: "create-job-project",
      name: "Job test",
    });
  }

  function titleRequest(projectId: string, baseRevisionId: string, idempotencyKey = "job-edit", layerId = "job-title") {
    return {
      contractVersion: "v1" as const,
      idempotencyKey,
      projectId,
      baseRevisionId,
      actor: "user" as const,
      operations: [{
        type: "add_text_layer" as const,
        layer: {
          id: layerId,
          trackId: "track-overlay",
          kind: "text" as const,
          timelineStartMs: 0,
          durationMs: 1000,
          properties: { text: "QA walkthrough" },
          keyframes: [],
        },
      }],
    };
  }

  it("persists an async edit and emits ordered revision/job events", async () => {
    const executor = await startExecutor();
    const created = await createProject(executor);
    const request = titleRequest(created.projectId, created.revisionId);

    const submitted = await executor.submitApplyOperations(request);
    expect(submitted.state).toBe("queued");
    const completed = await executor.waitForJob(submitted.id, 10_000);
    expect(completed).toMatchObject({ id: submitted.id, state: "succeeded" });
    if (completed.state !== "succeeded") throw new Error("job did not succeed");
    expect(completed.result.revisionId).not.toBe(created.revisionId);

    const events = await executor.eventsAfter(created.projectId);
    expect(events.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(events.events.map(({ type }) => type)).toEqual([
      "job.updated", "job.updated", "revision.created", "job.updated",
    ]);
    expect(events.events.at(-1)).toMatchObject({ type: "job.updated", job: { state: "succeeded" } });
    expect(await executor.submitApplyOperations(request)).toEqual(completed);
    expect((await executor.eventsAfter(created.projectId)).events).toHaveLength(4);

    await executor.stop();
    const restarted = new LocalExecutor({ workspaceRoot: workspaceRoot! });
    await restarted.start();
    expect(await restarted.getJob(submitted.id)).toEqual(completed);
    expect(await restarted.eventsAfter(created.projectId)).toEqual(events);
  });

  it("marks a reconnect cursor expired when retained events begin after its sequence", async () => {
    const executor = await startExecutor();
    const created = await createProject(executor);
    const submitted = await executor.submitApplyOperations(titleRequest(created.projectId, created.revisionId));
    await executor.waitForJob(submitted.id, 10_000);

    const statePath = join(workspaceRoot!, ".replex-service", "jobs.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      events: Array<{ projectId: string; sequence: number }>;
    };
    state.events = state.events.filter((event) => event.projectId !== created.projectId || event.sequence > 2);
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const expired = await executor.eventsAfter(created.projectId, 0);
    expect(expired).toMatchObject({
      contractVersion: "v1", projectId: created.projectId, afterSequence: 0,
      latestSequence: 4, cursorExpired: true, hasMore: false,
    });
    expect(expired.events.map(({ sequence }) => sequence)).toEqual([3, 4]);
    await expect(executor.eventsAfter(created.projectId, 5)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("recovers a running job after its operation committed before the completion record", async () => {
    const executor = await startExecutor();
    const created = await createProject(executor);
    const request = titleRequest(created.projectId, created.revisionId);
    const submitted = await executor.submitApplyOperations(request);
    await executor.stop();

    const directService = new LocalProjectService({ workspaceRoot: workspaceRoot! });
    const committed = await directService.applyOperations(request);
    expect(committed.ok).toBe(true);

    const statePath = join(workspaceRoot!, ".replex-service", "jobs.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      jobs: Record<string, { job: Record<string, unknown> }>;
    };
    const record = state.jobs[submitted.id]!;
    record.job = {
      ...record.job,
      state: "running",
      stage: "applying_revision",
      progress: { completed: 0, total: 1, percent: 0, unit: "batch" },
      cancellable: false,
      cancellationRequested: false,
    };
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const restarted = new LocalExecutor({ workspaceRoot: workspaceRoot! });
    await restarted.start();
    const completed = await restarted.waitForJob(submitted.id, 10_000);
    expect(completed.state).toBe("succeeded");
    if (completed.state !== "succeeded") throw new Error("recovered job did not succeed");
    const snapshot = await restarted.openProject({
      contractVersion: "v1", idempotencyKey: "open-after-recovery",
      projectId: created.projectId, revisionId: completed.result.revisionId!,
    });
    expect(snapshot.revisions).toHaveLength(2);
    expect(snapshot.composition.layers.map(({ id }) => id)).toEqual(["job-title"]);
  });

  it("rejects changed requests under one idempotency key", async () => {
    const executor = await startExecutor();
    const created = await createProject(executor);
    const submitted = await executor.submitApplyOperations(titleRequest(created.projectId, created.revisionId));

    await expect(executor.submitApplyOperations(
      titleRequest(created.projectId, created.revisionId, "job-edit", "different-title"),
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await executor.waitForJob(submitted.id, 10_000);
  });

  it("rejects invalid operations without a canonical revision", async () => {
    const executor = await startExecutor();
    const created = await createProject(executor);
    const request = titleRequest(created.projectId, created.revisionId);
    request.operations[0].layer.trackId = "missing-track";

    const submitted = await executor.submitApplyOperations(request);
    const failed = await executor.waitForJob(submitted.id, 10_000);
    expect(failed).toMatchObject({ state: "failed", error: { code: "OPERATION_REJECTED" } });
    const snapshot = await executor.openProject({
      contractVersion: "v1",
      idempotencyKey: "open-after-invalid-job",
      projectId: created.projectId,
      revisionId: created.revisionId,
    });
    expect(snapshot.summary.currentRevisionId).toBe(created.revisionId);
    expect(snapshot.composition.layers).toHaveLength(0);
  });

  it("cancels a queued job before dispatch without changing the project", async () => {
    vi.useFakeTimers();
    try {
      const executor = await startExecutor();
      const created = await createProject(executor);
      const submitted = await executor.submitApplyOperations(titleRequest(created.projectId, created.revisionId));
      const cancelRequest = {
        contractVersion: "v1" as const,
        idempotencyKey: "cancel-queued-job",
        projectId: created.projectId,
        jobId: submitted.id,
      };

      expect(await executor.cancelJob(cancelRequest)).toMatchObject({
        disposition: "requested", job: { state: "cancelling" },
      });
      await expect(executor.cancelJob({ ...cancelRequest, jobId: "job-another" }))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await vi.runAllTimersAsync();
      await executor.stop();
      const restarted = new LocalExecutor({ workspaceRoot: workspaceRoot! });
      await restarted.start();
      expect((await restarted.getJob(submitted.id)).state).toBe("cancelled");
      expect(await restarted.cancelJob(cancelRequest)).toMatchObject({ disposition: "already_terminal" });
      const snapshot = await restarted.openProject({
        contractVersion: "v1", idempotencyKey: "open-after-cancel",
        projectId: created.projectId, revisionId: created.revisionId,
      });
      expect(snapshot.summary.currentRevisionId).toBe(created.revisionId);
      await restarted.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates persisted job IDs before looking up storage", async () => {
    const executor = await startExecutor();
    await expect(executor.getJob("../../jobs.json")).rejects.toBeInstanceOf(LocalExecutorError);
  });
});
