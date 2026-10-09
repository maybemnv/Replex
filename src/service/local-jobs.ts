import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import { IdSchema } from "../schema.js";
import {
  ApplyOperationsRequestSchema,
  ImportAssetRequestSchema,
  CancelJobRequestSchema,
  CancelJobResponseSchema,
  ErrorSchema,
  JobEventSchema,
  JobEventPageSchema,
  JobViewSchema,
  RecaptureRequestSchema,
  RenderFinalRequestSchema,
  RenderPreviewRequestSchema,
  RequestAgentEditRequestSchema,
  type ApplyOperationsRequest,
  type RecaptureRequest,
  type RequestAgentEditRequest,
  type RenderArtifactView,
  type RenderFinalRequest,
  type RenderPreviewRequest,
  type ImportAssetRequest,
  type CancelJobRequest,
  type CancelJobResponse,
  type ContractError,
  type JobEvent,
  type JobEventPage,
  type JobView,
  type RevisionView,
} from "../service-contract/index.js";
import { DEFAULT_AGENT_THREAD_ID, LocalProjectService } from "./local.js";
import type { V2AgentModelClient, V2ConversationThread } from "../agent-v2.js";
import { LocalProjectStoreError } from "./project-store.js";
import { closeAuthorizedLocalImport, LocalImportError, type AuthorizedLocalImport } from "../import-v2.js";
import type { OperationBatchResult } from "../operations-v2.js";

const MAX_JOB_STATE_BYTES = 32 * 1024 * 1024;
const MAX_JOB_EVENTS = 20_000;
const MAX_AUTHORIZED_IMPORTS = 16;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const JobRecordSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.union([ApplyOperationsRequestSchema, ImportAssetRequestSchema, RenderFinalRequestSchema, RenderPreviewRequestSchema, RequestAgentEditRequestSchema, RecaptureRequestSchema]),
  job: JobViewSchema,
  commitFenced: z.boolean().default(false),
}).strict();
const CancelKeySchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: IdSchema,
  jobId: IdSchema,
}).strict();
const ThreadSchema = z.object({
  threadId: IdSchema,
  projectId: IdSchema,
  currentRevisionId: IdSchema,
  currentRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  previousResponseId: IdSchema.max(128).optional(),
  operationIds: z.array(IdSchema).max(10_000),
}).strict();
const JobStateSchema = z.object({
  version: z.literal(1),
  jobs: z.record(IdSchema, JobRecordSchema),
  cancelKeys: z.record(IdSchema, CancelKeySchema),
  nextSequence: z.record(IdSchema, z.number().int().nonnegative()),
  events: z.array(JobEventSchema).max(MAX_JOB_EVENTS),
  /** Host-owned agent conversations keyed by project and thread. */
  threads: z.record(z.string().max(512), ThreadSchema).default({}),
}).strict();
type JobState = z.infer<typeof JobStateSchema>;
type JobRecord = z.infer<typeof JobRecordSchema>;
type JobRequest = ApplyOperationsRequest | ImportAssetRequest | RenderPreviewRequest | RenderFinalRequest | RequestAgentEditRequest | RecaptureRequest;
type RenderJobKind = "render_preview" | "render_final";
type JobKind = "asset_import" | "apply_operations" | "agent_edit" | "browser_recapture" | RenderJobKind;
const RUNNING_STAGE = {
  asset_import: "importing",
  apply_operations: "applying_revision",
  agent_edit: "planning",
  browser_recapture: "capturing",
  render_preview: "rendering_preview",
  render_final: "rendering_final",
} as const;

interface JobSuccess {
  revisionId: string;
  /** Present only when the job published a new semantic revision. */
  revision?: RevisionView;
  assetId?: string;
  outputId?: string;
  artifact?: RenderArtifactView;
  thread?: V2ConversationThread;
}

const threadKey = (projectId: string, threadId: string): string => `${projectId}:${threadId}`;

export class LocalExecutorError extends Error {
  constructor(readonly code: "VALIDATION_FAILED" | "STORAGE_FAILED" | "IDEMPOTENCY_CONFLICT" | "JOB_NOT_FOUND" | "JOB_NOT_CANCELLABLE" | "EXECUTOR_OFFLINE" | "EXECUTION_FAILED" | "CAPABILITY_UNAVAILABLE", message: string) {
    super(message);
    this.name = "LocalExecutorError";
  }
}

function emptyState(): JobState {
  return { version: 1, jobs: {}, cancelKeys: {}, nextSequence: {}, events: [], threads: {} };
}

function terminal(job: JobView): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
}

function now(): string {
  return new Date().toISOString();
}

function eventSequence(state: JobState, projectId: string): number {
  const sequence = state.nextSequence[projectId] ?? 1;
  state.nextSequence[projectId] = sequence + 1;
  return sequence;
}

export class LocalJobRuntime {
  private static readonly workspaceTails = new Map<string, Promise<void>>();
  // ponytail: one in-process workspace queue; use durable shared scheduling if cross-process writers become supported.
  private static readonly executionTails = new Map<string, Promise<void>>();
  private started = false;
  private readonly running = new Set<string>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly emitter = new EventEmitter();
  private readonly imports = new Map<string, AuthorizedLocalImport>();
  private readonly reservedImports = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly workspaceRoot: string, private readonly projects: LocalProjectService, private readonly agentModel?: V2AgentModelClient) {}

  async start(): Promise<void> {
    if (this.started) return;
    const result = await this.exclusive(async (state) => {
      const changed: JobEvent[] = [];
      const resume: string[] = [];
      for (const record of Object.values(state.jobs)) {
        if (record.job.state === "cancelling") {
          record.job = JobViewSchema.parse({
            ...record.job, state: "cancelled", cancellable: false, cancellationRequested: false, updatedAt: now(),
          });
          changed.push(this.appendJobEvent(state, record.job));
        } else if (record.job.state === "running") {
          const importFinalizing = record.job.kind === "asset_import" && record.commitFenced;
          record.job = JobViewSchema.parse({
            ...record.job,
            state: "queued",
            stage: "queued",
            progress: undefined,
            cancellable: importFinalizing ? false : true,
            cancellationRequested: false,
            updatedAt: now(),
          });
          changed.push(this.appendJobEvent(state, record.job));
          resume.push(record.job.id);
        } else if (record.job.state === "queued") {
          resume.push(record.job.id);
        }
      }
      if (changed.length) await this.save(state);
      return { changed, resume };
    });
    this.started = true;
    result.changed.forEach((event) => this.publish(event));
    result.resume.forEach((jobId) => this.schedule(jobId));
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    for (const controller of this.abortControllers.values()) controller.abort();
    for (const source of this.imports.values()) await closeAuthorizedLocalImport(source);
    this.imports.clear();
    this.reservedImports.clear();
    await Promise.allSettled([...this.tasks]);
  }

  async registerAuthorizedImport(source: AuthorizedLocalImport): Promise<void> {
    if (!this.started || this.imports.size >= MAX_AUTHORIZED_IMPORTS) {
      await closeAuthorizedLocalImport(source).catch(() => undefined);
      throw new LocalExecutorError(this.started ? "VALIDATION_FAILED" : "EXECUTOR_OFFLINE", this.started
        ? "Too many local files are awaiting import."
        : "The local executor is not running.");
    }
    this.imports.set(source.token, source);
  }

  async submitImportAsset(requestInput: ImportAssetRequest): Promise<JobView> {
    let request: ImportAssetRequest;
    try { request = ImportAssetRequestSchema.parse(requestInput); }
    catch { throw new LocalExecutorError("VALIDATION_FAILED", "The import-asset request is invalid."); }
    if (request.source.kind !== "local_token") throw new LocalExecutorError("VALIDATION_FAILED", "Only local import tokens are supported.");
    if (!this.started) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");
    return this.submitJob(request, "asset_import");
  }

  async submitApplyOperations(requestInput: ApplyOperationsRequest): Promise<JobView> {
    let request: ApplyOperationsRequest;
    try { request = ApplyOperationsRequestSchema.parse(requestInput); }
    catch { throw new LocalExecutorError("VALIDATION_FAILED", "The apply-operations request is invalid."); }
    if (!this.started) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");

    return this.submitJob(request, "apply_operations");
  }

  async submitAgentEdit(requestInput: RequestAgentEditRequest): Promise<JobView> {
    const parsed = RequestAgentEditRequestSchema.safeParse(requestInput);
    if (!parsed.success) throw new LocalExecutorError("VALIDATION_FAILED", "The agent-edit request is invalid.");
    if (!this.agentModel) throw new LocalExecutorError("CAPABILITY_UNAVAILABLE", "No agent model is configured for this local executor.");
    if (!this.started) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");
    return this.submitJob(parsed.data, "agent_edit");
  }

  async submitRecapture(requestInput: RecaptureRequest): Promise<JobView> {
    const parsed = RecaptureRequestSchema.safeParse(requestInput);
    if (!parsed.success) throw new LocalExecutorError("VALIDATION_FAILED", "The recapture request is invalid.");
    if (!this.projects.capabilities().availableCommands.includes("recapture_browser_scene")) {
      throw new LocalExecutorError("CAPABILITY_UNAVAILABLE", "No browser targets are configured for this local executor.");
    }
    if (!this.started) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");
    return this.submitJob(parsed.data, "browser_recapture");
  }

  async submitRender(kind: RenderJobKind, requestInput: RenderPreviewRequest | RenderFinalRequest): Promise<JobView> {
    const parsed = (kind === "render_final" ? RenderFinalRequestSchema : RenderPreviewRequestSchema).safeParse(requestInput);
    if (!parsed.success) throw new LocalExecutorError("VALIDATION_FAILED", "The render request is invalid.");
    if (!this.started) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");
    return this.submitJob(parsed.data, kind);
  }

  private async submitJob(request: JobRequest, kind: JobKind): Promise<JobView> {
    const result = await this.exclusive(async (state) => {
      const fingerprint = digest(canonicalJson(request));
      const jobId = "job-" + digest(request.projectId + "|" + request.idempotencyKey).slice(0, 24);
      const existing = state.jobs[jobId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new LocalExecutorError("IDEMPOTENCY_CONFLICT", "The idempotency key was used for a different request.");
        return { job: existing.job, event: undefined, schedule: false };
      }
      if (kind === "asset_import") {
        const source = "source" in request ? request.source : undefined;
        if (!source || !this.imports.has(source.ref) || this.reservedImports.has(source.ref)) {
          throw new LocalExecutorError("VALIDATION_FAILED", "The local import token is not authorized.");
        }
      }

      const createdAt = now();
      const job = JobViewSchema.parse({
        id: jobId,
        projectId: request.projectId,
        kind,
        ...("baseRevisionId" in request ? { baseRevisionId: request.baseRevisionId } : { revisionId: request.revisionId }),
        state: "queued",
        stage: "queued",
        cancellable: true,
        cancellationRequested: false,
        createdAt,
        updatedAt: createdAt,
      });
      state.jobs[jobId] = { fingerprint, request, job, commitFenced: false };
      const event = this.appendJobEvent(state, job);
      await this.save(state);
      if (kind === "asset_import" && "source" in request) this.reservedImports.add(request.source.ref);
      return { job, event, schedule: true };
    });
    if (result.event) this.publish(result.event);
    if (result.schedule) this.schedule(result.job.id);
    return result.job;
  }

  async getJob(jobId: string): Promise<JobView> {
    if (!IdSchema.safeParse(jobId).success) throw new LocalExecutorError("JOB_NOT_FOUND", "The job does not exist.");
    return this.exclusive((state) => {
      const record = state.jobs[jobId];
      if (!record) throw new LocalExecutorError("JOB_NOT_FOUND", "The job does not exist.");
      return record.job;
    });
  }

  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<JobView> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new LocalExecutorError("VALIDATION_FAILED", "The wait timeout is outside the supported range.");
    }
    const initial = await this.getJob(jobId);
    if (terminal(initial)) return initial;
    return new Promise<JobView>((resolvePromise, rejectPromise) => {
      const finish = (error?: Error, job?: JobView) => {
        clearTimeout(timer);
        this.emitter.off("event", listener);
        if (error) rejectPromise(error);
        else resolvePromise(job!);
      };
      const listener = (event: JobEvent) => {
        if (event.type === "job.updated" && event.job.id === jobId && terminal(event.job)) finish(undefined, event.job);
      };
      const timer = setTimeout(() => {
        void this.getJob(jobId).then((job) => finish(undefined, job), (error: Error) => finish(error));
      }, timeoutMs);
      this.emitter.on("event", listener);
      void this.getJob(jobId).then((job) => { if (terminal(job)) finish(undefined, job); }, (error: Error) => finish(error));
    });
  }

  async cancelJob(requestInput: CancelJobRequest): Promise<CancelJobResponse> {
    let request: CancelJobRequest;
    try { request = CancelJobRequestSchema.parse(requestInput); }
    catch { throw new LocalExecutorError("VALIDATION_FAILED", "The cancel-job request is invalid."); }
    const result = await this.exclusive(async (state) => {
      const cancelKey = "cancel-" + digest(request.projectId + "|" + request.idempotencyKey).slice(0, 24);
      const fingerprint = digest(canonicalJson(request));
      const prior = state.cancelKeys[cancelKey];
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.projectId !== request.projectId || prior.jobId !== request.jobId) {
          throw new LocalExecutorError("IDEMPOTENCY_CONFLICT", "The idempotency key was used for a different cancellation request.");
        }
      }
      const record = state.jobs[request.jobId];
      if (!record || record.job.projectId !== request.projectId) throw new LocalExecutorError("JOB_NOT_FOUND", "The job does not exist.");
      if (terminal(record.job)) {
        state.cancelKeys[cancelKey] ??= { fingerprint, projectId: request.projectId, jobId: request.jobId };
        if (!prior) await this.save(state);
        return { response: CancelJobResponseSchema.parse({ disposition: "already_terminal", job: record.job }), event: undefined };
      }
      if (record.job.state === "cancelling") {
        state.cancelKeys[cancelKey] ??= { fingerprint, projectId: request.projectId, jobId: request.jobId };
        if (!prior) await this.save(state);
        return { response: CancelJobResponseSchema.parse({ disposition: "requested", job: record.job }), event: undefined };
      }
      if (!record.job.cancellable || record.commitFenced) throw new LocalExecutorError("JOB_NOT_CANCELLABLE", "The job can no longer be cancelled.");
      record.job = JobViewSchema.parse({
        ...record.job,
        state: "cancelling",
        stage: "validating_operations",
        cancellable: false,
        cancellationRequested: true,
        updatedAt: now(),
      });
      state.cancelKeys[cancelKey] = { fingerprint, projectId: request.projectId, jobId: request.jobId };
      const event = this.appendJobEvent(state, record.job);
      await this.save(state);
      return { response: CancelJobResponseSchema.parse({ disposition: "requested", job: record.job }), event };
    });
    if (result.event) this.publish(result.event);
    this.abortControllers.get(request.jobId)?.abort();
    if (result.response.disposition === "requested") {
      const record = await this.exclusive((state) => state.jobs[request.jobId]);
      if (record && "source" in record.request && record.request.source.kind === "local_token") {
        const source = this.imports.get(record.request.source.ref);
        if (source && record.job.state === "cancelling") await closeAuthorizedLocalImport(source);
      }
    }
    if (result.response.disposition === "requested") this.schedule(request.jobId);
    return result.response;
  }

  async eventsAfter(projectId: string, afterSequence = 0, limit = 1000): Promise<JobEventPage> {
    if (!IdSchema.safeParse(projectId).success || !Number.isInteger(afterSequence) || afterSequence < 0
      || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new LocalExecutorError("VALIDATION_FAILED", "The event cursor is invalid.");
    }
    return this.exclusive((state) => {
      const projectEvents = state.events.filter((event) => event.projectId === projectId);
      const latestSequence = (state.nextSequence[projectId] ?? 1) - 1;
      if (afterSequence > latestSequence) {
        throw new LocalExecutorError("VALIDATION_FAILED", "The event cursor is ahead of the latest project event.");
      }
      const matching = projectEvents.filter((event) => event.sequence > afterSequence);
      const pageEvents = matching.slice(0, limit);
      return JobEventPageSchema.parse({
        contractVersion: "v1",
        projectId,
        afterSequence,
        latestSequence,
        cursorExpired: afterSequence < latestSequence
          && (projectEvents.length === 0 || afterSequence < projectEvents[0]!.sequence - 1),
        hasMore: matching.length > limit,
        events: pageEvents,
      });
    });
  }

  onEvent(listener: (event: JobEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private schedule(jobId: string): void {
    if (!this.started || this.running.has(jobId) || this.scheduled.has(jobId)) return;
    // ponytail: a 25ms queue window keeps quick semantic jobs cancellable without another queue dependency.
    const timer = setTimeout(() => {
      this.scheduled.delete(jobId);
      const task = this.enqueueRun(jobId);
      this.tasks.add(task);
      void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    }, 25);
    this.scheduled.set(jobId, timer);
  }

  private async enqueueRun(jobId: string): Promise<void> {
    const root = resolve(this.workspaceRoot);
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const previous = LocalJobRuntime.executionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const tail = previous.then(() => held);
    LocalJobRuntime.executionTails.set(key, tail);
    await previous;
    try {
      await this.run(jobId);
    } finally {
      release();
      if (LocalJobRuntime.executionTails.get(key) === tail) LocalJobRuntime.executionTails.delete(key);
    }
  }

  private async run(jobId: string): Promise<void> {
    if (!this.started || this.running.has(jobId)) return;
    this.running.add(jobId);
    let applied = false;
    let importToken: string | undefined;
    try {
      const start = await this.exclusive(async (state) => {
        const record = state.jobs[jobId];
        if (!record) return { event: undefined, cancelled: false as const };
        if (record.job.state === "cancelling") {
          record.job = JobViewSchema.parse({
            ...record.job, state: "cancelled", cancellable: false, cancellationRequested: false, updatedAt: now(),
          });
          const event = this.appendJobEvent(state, record.job);
          await this.save(state);
          return { event, cancelled: true as const, request: record.request, kind: record.job.kind };
        }
        if (record.job.state !== "queued") return { event: undefined, cancelled: false as const };
        const importFinalizing = record.job.kind === "asset_import" && record.commitFenced;
        record.job = JobViewSchema.parse({
          ...record.job,
          state: "running",
          stage: importFinalizing ? "finalizing" : RUNNING_STAGE[record.job.kind as JobKind],
          progress: importFinalizing ? record.job.progress : { completed: 0, total: 1, percent: 0, unit: "batch" },
          cancellable: importFinalizing ? false : record.job.kind === "asset_import",
          cancellationRequested: false,
          updatedAt: now(),
        });
        const event = this.appendJobEvent(state, record.job);
        await this.save(state);
        const thread = record.job.kind === "agent_edit" && "prompt" in record.request
          ? state.threads[threadKey(record.job.projectId, record.request.threadId ?? DEFAULT_AGENT_THREAD_ID)]
          : undefined;
        return { event, cancelled: false as const, request: record.request, kind: record.job.kind, thread };
      });
      if (start.event) this.publish(start.event);
      if (start.request && "source" in start.request && start.request.source.kind === "local_token") {
        importToken = start.request.source.ref;
      }
      if (start.cancelled || !start.request) return;

      const controller = new AbortController();
      this.abortControllers.set(jobId, controller);
      const result = start.kind === "asset_import"
        ? await this.projects.importAsset(start.request as ImportAssetRequest, importToken ? this.imports.get(importToken) : undefined, controller.signal, (apply) => this.prepareImportCommit(jobId, apply))
        : start.kind === "apply_operations"
          ? await this.projects.applyOperations(start.request as ApplyOperationsRequest)
          : start.kind === "agent_edit"
            ? await this.runAgentEdit(start.request as RequestAgentEditRequest, start.thread, controller.signal)
            : start.kind === "browser_recapture"
              ? await this.projects.recaptureScene(start.request as RecaptureRequest, controller.signal)
              : await this.projects.renderRevision(start.request as RenderPreviewRequest | RenderFinalRequest, controller.signal);
      if (!result.ok) {
        await this.finishFailure(jobId, failureFor(result.code));
        return;
      }
      applied = true;
      await this.finishSuccess(jobId, {
        revisionId: result.revisionId,
        ...("revision" in result && result.revision ? { revision: result.revision } : {}),
        ...("assetId" in result && typeof result.assetId === "string" ? { assetId: result.assetId } : {}),
        ...("outputId" in result && result.outputId ? { outputId: result.outputId } : {}),
        ...("artifact" in result && result.artifact ? { artifact: result.artifact } : {}),
        ...("thread" in result && result.thread ? { thread: result.thread } : {}),
      });
    } catch (error) {
      if (!applied) {
        try {
          if (error instanceof Error && "code" in error && error.code === "IMPORT_CANCELLED") await this.finishCancelled(jobId);
          else await this.finishFailure(jobId, failureForError(error));
        }
        catch { /* Keep it nonterminal; recovery can retry the durable request. */ }
      }
    } finally {
      this.abortControllers.delete(jobId);
      this.running.delete(jobId);
      if (importToken) {
        const source = this.imports.get(importToken);
        this.imports.delete(importToken);
        this.reservedImports.delete(importToken);
        if (source) await closeAuthorizedLocalImport(source).catch(() => undefined);
      }
    }
  }

  private runAgentEdit(request: RequestAgentEditRequest, thread: V2ConversationThread | undefined, signal: AbortSignal) {
    if (!this.agentModel) throw new LocalExecutorError("CAPABILITY_UNAVAILABLE", "No agent model is configured for this local executor.");
    return this.projects.agentEdit(request, thread, this.agentModel, signal);
  }

  private async prepareImportCommit(jobId: string, apply: () => Promise<OperationBatchResult>): Promise<OperationBatchResult> {
    const event = await this.exclusive(async (state) => {
      const record = state.jobs[jobId];
      if (!record || record.job.state !== "running") throw new LocalImportError("IMPORT_CANCELLED", "local import was cancelled");
      const fencedAt = now();
      record.commitFenced = true;
      record.job = JobViewSchema.parse({
        ...record.job,
        stage: "finalizing",
        cancellable: false,
        cancellationRequested: false,
        updatedAt: fencedAt,
      });
      const event = this.appendJobEvent(state, record.job);
      await this.save(state);
      return event;
    });
    this.publish(event);
    return apply();
  }

  private async finishSuccess(jobId: string, success: JobSuccess): Promise<void> {
    const { revisionId, revision, assetId, outputId, artifact, thread } = success;
    const events = await this.exclusive(async (state) => {
      const record = state.jobs[jobId];
      if (!record || record.job.state !== "running") return [];
      const completedAt = now();
      const derived: JobEvent[] = [];
      if (revision) derived.push(JobEventSchema.parse({
        projectId: record.job.projectId,
        sequence: eventSequence(state, record.job.projectId),
        occurredAt: completedAt,
        type: "revision.created",
        revision,
      }));
      if (artifact) derived.push(JobEventSchema.parse({
        projectId: record.job.projectId,
        sequence: eventSequence(state, record.job.projectId),
        occurredAt: completedAt,
        type: "render_artifact.created",
        artifact,
      }));
      record.job = JobViewSchema.parse({
        ...record.job,
        state: "succeeded",
        stage: "finalizing",
        progress: { completed: 1, total: 1, percent: 100, unit: "batch" },
        cancellable: false,
        cancellationRequested: false,
        updatedAt: completedAt,
        result: { revisionId, ...(assetId ? { assetId } : {}), ...(outputId ? { outputId } : {}) },
      });
      derived.forEach((event) => this.appendEvent(state, event));
      if (thread) state.threads[threadKey(thread.projectId, thread.threadId)] = thread;
      const jobEvent = this.appendJobEvent(state, record.job);
      await this.save(state);
      return [...derived, jobEvent];
    });
    events.forEach((event) => this.publish(event));
  }

  private async finishFailure(jobId: string, errorInput: ContractError): Promise<void> {
    const event = await this.exclusive(async (state) => {
      const record = state.jobs[jobId];
      if (!record || terminal(record.job)) return undefined;
      record.job = JobViewSchema.parse({
        ...record.job,
        state: "failed",
        stage: "finalizing",
        progress: { completed: 0, total: 1, percent: 0, unit: "batch" },
        cancellable: false,
        cancellationRequested: false,
        updatedAt: now(),
        error: ErrorSchema.parse(errorInput),
      });
      const update = this.appendJobEvent(state, record.job);
      await this.save(state);
      return update;
    });
    if (event) this.publish(event);
  }

  private async finishCancelled(jobId: string): Promise<void> {
    const event = await this.exclusive(async (state) => {
      const record = state.jobs[jobId];
      if (!record || terminal(record.job)) return undefined;
      record.job = JobViewSchema.parse({
        ...record.job,
        state: "cancelled",
        stage: "finalizing",
        progress: { completed: 0, total: 1, percent: 0, unit: "batch" },
        cancellable: false,
        cancellationRequested: false,
        updatedAt: now(),
      });
      const update = this.appendJobEvent(state, record.job);
      await this.save(state);
      return update;
    });
    if (event) this.publish(event);
  }

  private appendJobEvent(state: JobState, job: JobView): JobEvent {
    const event = JobEventSchema.parse({
      projectId: job.projectId,
      sequence: eventSequence(state, job.projectId),
      occurredAt: now(),
      type: "job.updated",
      job,
    });
    this.appendEvent(state, event);
    return event;
  }

  private appendEvent(state: JobState, event: JobEvent): void {
    if (state.events.length >= MAX_JOB_EVENTS) {
      state.events.splice(0, state.events.length - MAX_JOB_EVENTS + 1);
    }
    state.events.push(event);
  }

  private publish(event: JobEvent): void {
    this.emitter.emit("event", event);
  }

  private async exclusive<T>(work: (state: JobState) => Promise<T> | T): Promise<T> {
    const root = await this.root();
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const previous = LocalJobRuntime.workspaceTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const tail = previous.then(() => held);
    LocalJobRuntime.workspaceTails.set(key, tail);
    await previous;
    try {
      const state = await this.readState();
      return await work(state);
    } finally {
      release();
      if (LocalJobRuntime.workspaceTails.get(key) === tail) LocalJobRuntime.workspaceTails.delete(key);
    }
  }

  private async readState(): Promise<JobState> {
    try {
      const path = await this.statePath();
      const info = await lstat(path);
      const real = await realpath(path);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > MAX_JOB_STATE_BYTES) {
        throw new LocalExecutorError("STORAGE_FAILED", "Local executor storage is invalid or too large.");
      }
      const parsed = JobStateSchema.safeParse(JSON.parse(await readFile(real, "utf8")));
      if (!parsed.success) throw new LocalExecutorError("STORAGE_FAILED", "Local executor storage is invalid.");
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      if (error instanceof LocalExecutorError) throw error;
      throw new LocalExecutorError("STORAGE_FAILED", "Local executor storage is unavailable.");
    }
  }

  private async save(state: JobState): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let tempPath: string | undefined;
    try {
      const path = await this.statePath(true);
      const text = canonicalJson(JobStateSchema.parse(state)) + "\n";
      if (Buffer.byteLength(text, "utf8") > MAX_JOB_STATE_BYTES) throw new Error("state too large");
      tempPath = join(dirname(path), ".tmp-" + randomUUID());
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
    } catch {
      await handle?.close().catch(() => undefined);
      if (tempPath) await unlink(tempPath).catch(() => undefined);
      throw new LocalExecutorError("STORAGE_FAILED", "Local executor state could not be saved.");
    }
  }

  private async statePath(create = false): Promise<string> {
    const root = await this.root();
    const directory = join(root, ".replex-service");
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = await lstat(directory);
    const realDirectory = await realpath(directory);
    const relation = relative(root, realDirectory);
    if (info.isSymbolicLink() || !info.isDirectory() || (relation !== "" && (relation === ".." || relation.startsWith(".." + sep) || isAbsolute(relation)))) {
      throw new LocalExecutorError("STORAGE_FAILED", "Local executor storage is invalid.");
    }
    const path = join(realDirectory, "jobs.json");
    if (create) return path;
    return path;
  }

  private async root(): Promise<string> {
    const requested = resolve(this.workspaceRoot);
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const info = await lstat(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new LocalExecutorError("STORAGE_FAILED", "The local workspace root is invalid.");
    return realpath(requested);
  }
}

function failureFor(code: string): ContractError {
  if (code === "STALE_REVISION") return { code: "STALE_JOB_INPUT", message: "The project changed before this edit could be applied.", retryable: false };
  if (code === "VERIFICATION_REQUIRED") return { code: "VERIFICATION_FAILED", message: "A final render requires a passed verification of this revision.", retryable: false };
  if (code === "RENDER_FAILED" || code === "PREVIEW_FAILED") return { code: "RENDER_FAILED", message: "The bounded renderer could not produce a verified output.", retryable: true };
  if (code === "BUDGET_EXCEEDED") return { code: "AGENT_BUDGET_EXCEEDED", message: "The agent exhausted its bounded budget for this request.", retryable: false };
  if (code === "INSPECTION_FAILED") return { code: "INSUFFICIENT_EVIDENCE", message: "The agent could not inspect enough project evidence.", retryable: false };
  if (code === "STALE_THREAD") return { code: "STALE_JOB_INPUT", message: "The conversation no longer matches the project revision.", retryable: false };
  if (code === "MODEL_ERROR" || code === "TIMEOUT" || code === "CANCELLED") return { code: "EXECUTION_FAILED", message: "The agent request could not be completed.", retryable: true };
  if (code === "CAPTURE_FAILED") return { code: "BROWSER_CAPTURE_FAILED", message: "The approved browser flow could not be captured.", retryable: true };
  if (code === "SCENE_INVALID" || code === "SOURCE_NOT_AUTHORIZED" || code === "SOURCE_CHANGED") return { code: "BROWSER_CAPTURE_FAILED", message: "The browser capture did not produce a valid replacement scene.", retryable: false };
  if (code === "FLOW_MISMATCH" || code === "INVALID_REQUEST") return { code: "VALIDATION_FAILED", message: "The selected asset cannot be recaptured from an approved flow.", retryable: false };
  if (code === "BROWSER_TARGET_UNAVAILABLE") return { code: "CAPABILITY_UNAVAILABLE", message: "This host cannot drive the asset's approved browser flow.", retryable: false, requiredCapability: "recapture_browser_scene" };
  if (code === "EVIDENCE_FAILED") return { code: "STORAGE_FAILED", message: "The recapture or its preservation evidence could not be stored.", retryable: true };
  if (code === "UNSUPPORTED_OPERATION") return { code: "CAPABILITY_UNAVAILABLE", message: "This operation is not available in the local executor.", retryable: false, requiredCapability: "apply_operations" };
  return { code: "OPERATION_REJECTED", message: "The canonical reducer rejected the operation batch.", retryable: false };
}

function failureForError(error: unknown): ContractError {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (code === "UPLOAD_INTERRUPTED") return { code, message: "The local import was interrupted before its source could be read.", retryable: false };
    if (code === "SOURCE_NOT_AUTHORIZED") return { code: "UNAUTHORIZED", message: "The local import token is not authorized.", retryable: false };
    if (code === "SOURCE_CHANGED") return { code: "ASSET_CHANGED", message: "The selected media changed before import completed.", retryable: false };
    if (code === "IMPORT_CANCELLED") return { code: "CANCELLATION", message: "The local import was cancelled.", retryable: false };
    if (code === "IMPORT_TIMEOUT") return { code: "EXECUTION_FAILED", message: "The local media import exceeded its time limit.", retryable: true };
    if (code === "MEDIA_PROBE_FAILED" || code === "MEDIA_DECODE_FAILED" || code === "UNSUPPORTED_MEDIA") return { code: "ASSET_UNSUPPORTED", message: "The selected media is unsupported or invalid.", retryable: false };
  }
  if (error instanceof LocalExecutorError) {
    return { code: error.code, message: error.message, retryable: error.code === "STORAGE_FAILED" };
  }
  if (error instanceof LocalProjectStoreError) {
    if (error.code === "PROJECT_NOT_FOUND") return { code: "PROJECT_NOT_FOUND", message: "The project does not exist.", retryable: false };
    if (error.code === "REVISION_NOT_FOUND") return { code: "REVISION_NOT_FOUND", message: "The requested revision does not exist.", retryable: false };
    if (error.code === "IDEMPOTENCY_CONFLICT") return { code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key was used for a different request.", retryable: false };
    return { code: "STORAGE_FAILED", message: "Local project storage failed.", retryable: true };
  }
  return { code: "EXECUTION_FAILED", message: "The local operation could not be completed.", retryable: true };
}
