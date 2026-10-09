import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import { applyOperationBatch, createProjectV2, type OperationBatchResult } from "../operations-v2.js";
import type { ProjectV2 } from "../schema-v2.js";
import {
  ApplyOperationsRequestSchema,
  CapabilitySetSchema,
  CreateProjectRequestSchema,
  OpenProjectRequestSchema,
  ProjectCreatedResponseSchema,
  ProjectSnapshotSchema,
  ImportAssetRequestSchema,
  type ImportAssetRequest,
  type ApplyOperationsRequest,
  type CapabilitySet,
  type CreateProjectRequest,
  type OpenProjectRequest,
  type ProjectCreatedResponse,
  type ProjectSnapshot,
  type RevisionView,
  type RecaptureRequest,
  type StartBrowserCaptureRequest,
  type RenderArtifactView,
  type RenderFinalRequest,
  type RenderPreviewRequest,
  type RequestAgentEditRequest,
  type VerificationView,
  type VerifyRevisionRequest,
} from "../service-contract/index.js";
import { LocalProjectStore, LocalProjectStoreError } from "./project-store.js";
import { authorizeLocalImport, closeAuthorizedLocalImport, importLocalAssetV2, LocalImportError, type AuthorizedLocalImport } from "../import-v2.js";
import { preflightRevisionV2, renderCurrentRevisionV2, type MediaExecutionAuthorization } from "../render-v2.js";
import { runConversationalEditV2, type V2AgentModelClient, type V2ConversationThread } from "../agent-v2.js";
import { inspectProjectV2 } from "../inspect-v2.js";
import { generateMediaEvidence, type MediaEvidenceIndex } from "../media-evidence.js";
import { semanticHashV2 } from "../operations-v2.js";
import { runCapture, type CaptureResult } from "../capture.js";
import { recaptureBrowserSceneV2, RecaptureV2Error } from "../recapture-v2.js";
import { EnvironmentSchema, FlowSchema, IdSchema } from "../schema.js";
import { MediaAssetSchema } from "../schema-v2.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export type ApplyOperationsOutcome =
  | { ok: true; revisionId: string; operationIds: string[]; revision: RevisionView }
  | { ok: false; code: "STALE_REVISION" | "INVALID_OPERATION" | "UNSUPPORTED_OPERATION"; detail: string };

export type RenderOutcome =
  | { ok: true; revisionId: string; outputId: string; artifact: RenderArtifactView }
  | { ok: false; code: "STALE_REVISION" | "VERIFICATION_REQUIRED" | "RENDER_FAILED"; detail: string };

export type VerifyOutcome =
  | { ok: true; revisionId: string; verification: VerificationView }
  | { ok: false; code: "STALE_REVISION"; detail: string }
  | { ok: false; code: "VERIFICATION_FAILED"; detail: string; verification: VerificationView };

export type CaptureOutcome = RecaptureOutcome;
export type RecaptureOutcome =
  | { ok: true; revisionId: string; revision: RevisionView; assetId: string }
  | { ok: false; code: string; detail: string };

/**
 * Host-owned browser targets keyed by approved flow ID. The flow itself comes from canonical project
 * state; the host supplies only where and how to drive it. Never model or request supplied.
 */
export const BrowserTargetsSchema = z.record(IdSchema, z.object({
  /** Approved flow to register with a project's first capture; a registered project flow always wins and must match. */
  flow: FlowSchema.optional(),
  environment: EnvironmentSchema,
  values: z.record(z.string().min(1).max(128), z.string().max(10_000)).optional(),
  resetUrl: z.string().url().optional(),
}).strict().superRefine((target, context) => {
  if (target.flow?.steps.some((step) => !step.approved)) context.addIssue({ code: "custom", path: ["flow"], message: "browser target flows must be approved" });
  if (target.resetUrl && !target.environment.allowedOrigins.some((origin) => new URL(origin).origin === new URL(target.resetUrl!).origin)) {
    context.addIssue({ code: "custom", path: ["resetUrl"], message: "resetUrl must use an allowed origin" });
  }
}));
export type BrowserTargets = z.infer<typeof BrowserTargetsSchema>;

export type AgentEditOutcome =
  | { ok: true; revisionId: string; revision?: RevisionView; outputId?: string; artifact?: RenderArtifactView; thread?: V2ConversationThread }
  | { ok: false; code: string; detail: string };

/** One default conversation per project when the caller does not name a thread. */
export const DEFAULT_AGENT_THREAD_ID = "thread-default";
const MAX_AGENT_HISTORY = 1_000;

/** Host-owned media tool paths; motion presets require absolute executables. */
export interface MediaToolOptions { ffmpegPath?: string; ffprobePath?: string }

/** Called right before a job's irreversible commit; rejects when the job was cancelled first. */
export type CommitFence = () => Promise<void>;
const noFence: CommitFence = async () => undefined;

export class LocalProjectService {
  private readonly store: LocalProjectStore;
  private readonly media: MediaToolOptions;
  private readonly agentEnabled: boolean;
  private readonly browserTargets: BrowserTargets;

  constructor(options: { workspaceRoot: string; media?: MediaToolOptions; agentEnabled?: boolean; browserTargets?: BrowserTargets }) {
    this.store = new LocalProjectStore(options.workspaceRoot);
    this.media = options.media ?? {};
    this.agentEnabled = options.agentEnabled ?? false;
    this.browserTargets = BrowserTargetsSchema.parse(options.browserTargets ?? {});
  }

  async createProject(requestInput: CreateProjectRequest): Promise<ProjectCreatedResponse> {
    const request = CreateProjectRequestSchema.parse(requestInput);
    const projectId = "project-" + digest(request.idempotencyKey).slice(0, 24);
    const brief = request.brief ?? {};
    const project = createProjectV2({
      projectId,
      brief,
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: brief.targetDurationMs ?? 30_000,
    });
    const fingerprint = digest(canonicalJson({ name: request.name, brief }));
    const initial = await this.store.create(project, fingerprint, request.name);
    return ProjectCreatedResponseSchema.parse({
      contractVersion: "v1",
      projectId,
      revisionId: initial.currentRevisionId,
      summary: summary(initial),
    });
  }

  async openProject(requestInput: OpenProjectRequest): Promise<ProjectSnapshot> {
    const request = OpenProjectRequestSchema.parse(requestInput);
    const { current, selected } = await this.store.currentAndRevision(request.projectId, request.revisionId);
    return snapshot(current, selected, this.capabilities());
  }

  async applyOperations(requestInput: ApplyOperationsRequest): Promise<ApplyOperationsOutcome> {
    const request = ApplyOperationsRequestSchema.parse(requestInput);
    const result = await this.store.applyBatch(request.projectId, {
      baseRevisionId: request.baseRevisionId,
      actor: request.actor,
      intentId: "intent-" + digest(request.idempotencyKey).slice(0, 32),
      evidenceRefs: [],
      operations: request.operations,
      createdAt: new Date().toISOString(),
    });
    return publicOutcome(result);
  }

  async importAsset(requestInput: ImportAssetRequest, source: AuthorizedLocalImport | undefined, signal: AbortSignal, commit?: (apply: () => Promise<OperationBatchResult>) => Promise<OperationBatchResult>): Promise<ApplyOperationsOutcome & { assetId?: string }> {
    const request = ImportAssetRequestSchema.parse(requestInput);
    if (request.source.kind !== "local_token") return { ok: false, code: "UNSUPPORTED_OPERATION", detail: "upload sessions are not available in the local executor" };
    const intentId = "intent-" + digest(request.idempotencyKey).slice(0, 32);
    const currentProject = await this.store.current(request.projectId);
    const committedRevisions = new Set(currentProject.revisions.map(({ id }) => id));
    const prior = (await this.store.operationLog(request.projectId)).filter((record) => record.intentId === intentId && committedRevisions.has(record.resultRevisionId));
    if (prior.length) {
      const operation = prior[0]!.input;
      if (prior.length !== 1 || operation.type !== "import_asset" || prior[0]!.baseRevisionId !== request.baseRevisionId) {
        throw new LocalProjectStoreError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different operation batch");
      }
      const result = publicOutcome({ ok: true, project: currentProject, revisionId: prior[0]!.resultRevisionId, operationLog: prior });
      return { ...result, assetId: operation.asset.id };
    }
    if (currentProject.currentRevisionId !== request.baseRevisionId) return { ok: false, code: "STALE_REVISION", detail: "the project changed before this import could be applied" };
    if (signal.aborted) throw new LocalImportError("IMPORT_CANCELLED", "local import was cancelled");
    if (!source) throw new LocalImportError("UPLOAD_INTERRUPTED", "the authorized source handle was lost during restart");
    let committed: OperationBatchResult | undefined;
    const imported = await importLocalAssetV2(currentProject, await this.store.projectRoot(request.projectId), source, {
      signal,
      commit: async (prepared) => {
        const batch = {
          baseRevisionId: request.baseRevisionId,
          actor: "user" as const,
          intentId,
          evidenceRefs: [],
          operations: [{ type: "import_asset" as const, asset: prepared.asset }],
          createdAt: new Date().toISOString(),
        };
        committed = await (commit ?? (() => this.store.applyBatch(request.projectId, batch)))(() => this.store.applyBatch(request.projectId, batch));
        if (!committed.ok) throw new LocalImportError("IMPORT_REJECTED", `canonical import was rejected: ${committed.detail}`);
      },
    });
    if (!committed) throw new LocalImportError("STORAGE_FAILED", "canonical import did not commit");
    const result = committed;
    if (!result.ok) return result;
    return { ...publicOutcome(result), assetId: imported.asset.id };
  }

  /** Renders a pinned revision; renders register only on the current revision, final renders require a passed verification. */
  async renderRevision(request: RenderPreviewRequest | RenderFinalRequest, signal: AbortSignal, fence: CommitFence = noFence): Promise<RenderOutcome> {
    const { current } = await this.store.currentAndRevision(request.projectId, request.revisionId);
    if (current.currentRevisionId !== request.revisionId) return { ok: false, code: "STALE_REVISION", detail: "renders are registered only on the current revision" };
    if ("verificationRefId" in request && !current.verification.refs.some(({ id, revisionId, status }) =>
      id === request.verificationRefId && revisionId === request.revisionId && status === "passed")) {
      return { ok: false, code: "VERIFICATION_REQUIRED", detail: "final render requires a passed verification of this revision" };
    }
    let rendered: Awaited<ReturnType<typeof renderCurrentRevisionV2>>;
    try {
      rendered = await renderCurrentRevisionV2(current, await this.mediaAuthorization(current), { ...this.media, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, code: "RENDER_FAILED", detail: "the bounded renderer could not produce a verified output" };
    }
    await fence();
    const registered = await this.store.registerRender(request.projectId, rendered.artifact);
    const output = registered.outputs.find(({ outputId }) => outputId === rendered.artifact.outputId)!;
    return { ok: true, revisionId: request.revisionId, outputId: output.outputId, artifact: artifactView(output) };
  }

  /**
   * Verifies a pinned revision without rendering: it must be current, plan under the bounded renderer, and every
   * referenced source must still match its hash. Records a passed or failed verification with its report.
   */
  async verifyRevision(request: VerifyRevisionRequest): Promise<VerifyOutcome> {
    const { current } = await this.store.currentAndRevision(request.projectId, request.revisionId);
    if (current.currentRevisionId !== request.revisionId) return { ok: false, code: "STALE_REVISION", detail: "verification is recorded only on the current revision" };
    const sourceRevisionHash = semanticHashV2(current);
    let preflight: Awaited<ReturnType<typeof preflightRevisionV2>> | undefined;
    try { preflight = await preflightRevisionV2(current, await this.mediaAuthorization(current)); }
    catch { preflight = undefined; }
    const status = preflight ? "passed" as const : "failed" as const;
    const report = {
      schemaVersion: 1,
      kind: "revision_preflight",
      revisionId: request.revisionId,
      sourceRevisionHash,
      status,
      checks: { plan: status === "passed", sourceHashes: status === "passed" },
      ...(preflight ? { planHash: preflight.planHash, assets: preflight.assets } : {}),
    };
    const id = `verification-${digest(canonicalJson(report)).slice(0, 32)}`;
    const project = await this.store.registerVerification(request.projectId, { id, revisionId: request.revisionId, status, evidenceRefs: [] }, report);
    const verification = project.verification;
    return status === "passed"
      ? { ok: true, revisionId: request.revisionId, verification }
      : { ok: false, code: "VERIFICATION_FAILED", detail: "the revision failed plan or source verification", verification };
  }

  /**
   * Runs one bounded conversational edit on the pinned base revision. The agent commits through the
   * store's reducer CAS together with its verified preview; the saved thread is host-owned.
   */
  async agentEdit(request: RequestAgentEditRequest, saved: V2ConversationThread | undefined, model: V2AgentModelClient, signal: AbortSignal, fence: CommitFence = noFence): Promise<AgentEditOutcome> {
    const current = await this.store.current(request.projectId);
    const intentId = "intent-" + digest(request.idempotencyKey).slice(0, 32);
    const history = await this.store.operationLog(request.projectId);
    const prior = history.filter((record) => record.intentId === intentId);
    const threadId = request.threadId ?? DEFAULT_AGENT_THREAD_ID;
    const revisionHash = semanticHashV2(current);
    if (prior.length) {
      // Restart after the agent committed: report the published revision without calling the model again.
      if (prior[0]!.baseRevisionId !== request.baseRevisionId) throw new LocalProjectStoreError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different agent edit");
      // ponytail: the turn's final response id was never durable, so the thread keeps its last completed response and gains the committed operations.
      const known = new Set(saved?.operationIds ?? []);
      const thread: V2ConversationThread = {
        threadId,
        projectId: request.projectId,
        currentRevisionId: current.currentRevisionId,
        currentRevisionHash: revisionHash,
        ...(saved?.previousResponseId ? { previousResponseId: saved.previousResponseId } : {}),
        operationIds: [...known, ...prior.map(({ id }) => id).filter((id) => !known.has(id))],
      };
      return { ok: true, thread, ...publishedRevision(current, prior.at(-1)!.resultRevisionId) };
    }
    if (current.currentRevisionId !== request.baseRevisionId) return { ok: false, code: "STALE_REVISION", detail: "the project changed before this agent edit started" };

    // ponytail: edits made outside this thread rebase it onto the pinned base; the agent sees them via operation_history.
    const threadState = saved && { ...saved, currentRevisionId: current.currentRevisionId, currentRevisionHash: revisionHash };
    const authorization = await this.mediaAuthorization(current);
    const evidenceRoot = join(authorization.projectRoot, "evidence");
    const evidenceIndexes = await this.mediaEvidence(current, authorization, evidenceRoot);
    const selection = [
      request.selectedAssetIds?.length ? `Selected assets: ${request.selectedAssetIds.join(", ")}.` : "",
      request.selectedClipIds?.length ? `Selected clips: ${request.selectedClipIds.join(", ")}.` : "",
    ].filter(Boolean).join(" ");

    const result = await runConversationalEditV2({
      project: current,
      prompt: selection ? `${request.prompt}\n\n${selection}` : request.prompt,
      threadId,
      ...(threadState ? { threadState } : {}),
      inspect: (project, inspectRequest, context) => inspectProjectV2(inspectRequest, {
        project, evidenceIndexes, evidenceRoot, operationLog: context?.operationLog ?? [],
      }),
      model,
      operationLog: history.slice(-MAX_AGENT_HISTORY),
      assetHandles: authorization.resolvedHandles.map(({ assetId, sha256, ref }) => ({ assetId, sha256, ref })),
      renderAuthorization: authorization,
      renderOptions: this.media,
      commitCanonicalRevision: async (candidate) => {
        await fence();
        const committed = await this.store.commitCandidate(request.projectId, candidate);
        return committed.ok ? { ok: true, project: committed.project } : { ok: false, code: committed.code, detail: committed.detail };
      },
      evidenceRoot,
      signal,
      intentId,
    });
    if (!result.ok) return { ok: false, code: result.code, detail: result.detail };
    return { ok: true, thread: result.threadState, ...publishedRevision(result.project, result.project.currentRevisionId, request.baseRevisionId) };
  }

  /**
   * Captures a host-approved browser flow and commits every scene as an immutable `browser_capture` asset in one
   * revision, registering the flow on first use. The result names the first scene's asset.
   */
  async startCapture(request: StartBrowserCaptureRequest, signal: AbortSignal, fence: CommitFence = noFence): Promise<CaptureOutcome> {
    const current = await this.store.current(request.projectId);
    const intentId = "intent-" + digest(request.idempotencyKey).slice(0, 32);
    const prior = (await this.store.operationLog(request.projectId)).filter((record) => record.intentId === intentId);
    if (prior.length) {
      // Restart after the capture committed: report it without driving the browser again.
      const first = prior.find((record) => record.input.type === "import_asset");
      if (prior[0]!.baseRevisionId !== request.baseRevisionId || first?.input.type !== "import_asset") {
        throw new LocalProjectStoreError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different capture");
      }
      return { ok: true, revisionId: first.resultRevisionId, revision: revisionView(current, first.resultRevisionId), assetId: first.input.asset.id };
    }
    if (current.currentRevisionId !== request.baseRevisionId) return { ok: false, code: "STALE_REVISION", detail: "the project changed before this capture started" };
    const target = this.browserTargets[request.flowId];
    const registered = current.browser?.flows[request.flowId];
    const flow = registered ?? target?.flow;
    if (!target || !flow) return { ok: false, code: "BROWSER_TARGET_UNAVAILABLE", detail: "this host has no approved flow and browser target for the request" };
    if (registered && target.flow && canonicalJson(registered) !== canonicalJson(target.flow)) {
      return { ok: false, code: "FLOW_MISMATCH", detail: "the host flow differs from the flow registered in the project" };
    }

    const captureRoot = join(await this.store.projectRoot(request.projectId), "captures");
    await mkdir(captureRoot, { recursive: true, mode: 0o700 });
    let capture: CaptureResult;
    try {
      capture = await runCapture(flow, target.environment, {
        artifactRoot: captureRoot,
        signal,
        ...(target.values ? { values: target.values } : {}),
        ...(target.resetUrl ? { reset: () => resetBrowserTarget(target.resetUrl!, signal) } : {}),
        ...this.media,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, code: "CAPTURE_FAILED", detail: "the approved flow did not complete" };
    }
    await fence();
    const runRoot = dirname(capture.runPath);
    const sources: AuthorizedLocalImport[] = [];
    try {
      for (const scene of capture.captures) sources.push(await authorizeLocalImport(scene.sourcePath, [runRoot]));
      const result = await this.store.applyBatchWithLocalAssets(request.projectId, {
        baseRevisionId: request.baseRevisionId,
        intentId,
        options: this.media,
        sources: capture.captures.map((scene, index) => ({
          source: sources[index]!,
          buildAsset: (facts) => {
            if (facts.sha256 !== scene.sha256 || facts.type !== "uploaded_video" || facts.probe.width !== scene.width
              || facts.probe.height !== scene.height || facts.probe.durationMs !== scene.durationMs) {
              throw new LocalImportError("SOURCE_CHANGED", "capture source differs from its run manifest");
            }
            return MediaAssetSchema.parse({
              id: `asset-${digest(canonicalJson({ projectId: request.projectId, runId: scene.runId, sceneKey: scene.sceneKey, sha256: facts.sha256 })).slice(0, 32)}`,
              type: "browser_capture",
              path: facts.path,
              sha256: facts.sha256,
              probe: facts.probe,
              provenance: {
                kind: "browser", flowId: flow.id, sceneKey: scene.sceneKey, actionIds: scene.actionIds,
                checkpointActionId: scene.checkpointActionId, runId: scene.runId, capturedAt: capture.run.endedAt,
              },
            });
          },
        })),
        buildBatch: (assets) => ({
          baseRevisionId: request.baseRevisionId,
          actor: "user",
          intentId,
          evidenceRefs: [],
          createdAt: capture.run.endedAt,
          operations: [
            ...(registered ? [] : [{ type: "register_browser_flow" as const, flow }]),
            ...assets.map((asset) => ({ type: "import_asset" as const, asset })),
          ],
        }),
      });
      if (!result.ok) return { ok: false, code: result.code, detail: result.detail };
      const firstAsset = result.operationLog.find(({ input }) => input.type === "import_asset")!;
      if (firstAsset.input.type !== "import_asset") throw new Error("capture batch has no imported scene");
      return { ok: true, revisionId: result.revisionId, revision: revisionView(result.project, result.revisionId), assetId: firstAsset.input.asset.id };
    } catch (error) {
      if (error instanceof LocalImportError && error.code === "SOURCE_NOT_AUTHORIZED") return { ok: false, code: "SCENE_INVALID", detail: "a captured scene is outside its run" };
      throw error;
    } finally {
      for (const source of sources) await closeAuthorizedLocalImport(source).catch(() => undefined);
    }
  }

  /**
   * Recaptures the scene behind one browser asset from its approved flow and commits one
   * `replace_browser_capture` revision with preservation evidence. Changed actions are host asserted.
   */
  async recaptureScene(request: RecaptureRequest, signal: AbortSignal, fence: CommitFence = noFence): Promise<RecaptureOutcome> {
    const current = await this.store.current(request.projectId);
    const intentId = "intent-" + digest(request.idempotencyKey).slice(0, 32);
    const prior = (await this.store.operationLog(request.projectId)).find((record) => record.intentId === intentId);
    if (prior) {
      // Restart after the replacement committed: report it without driving the browser again.
      if (prior.baseRevisionId !== request.baseRevisionId || prior.input.type !== "replace_browser_capture") {
        throw new LocalProjectStoreError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different recapture");
      }
      return { ok: true, revisionId: prior.resultRevisionId, revision: revisionView(current, prior.resultRevisionId), assetId: prior.input.replacementAsset.id };
    }
    if (current.currentRevisionId !== request.baseRevisionId) return { ok: false, code: "STALE_REVISION", detail: "the project changed before this recapture started" };
    const asset = current.assets[request.assetId];
    if (!asset || asset.provenance.kind !== "browser") return { ok: false, code: "FLOW_MISMATCH", detail: "the selected asset is not a browser capture" };
    const { flowId, sceneKey } = asset.provenance;
    const flow = current.browser?.flows[flowId];
    const target = this.browserTargets[flowId];
    if (!flow || !target) return { ok: false, code: "BROWSER_TARGET_UNAVAILABLE", detail: "this host has no browser target for the asset's approved flow" };

    // ponytail: run artifacts (trace, logs, raw video) stay under the project as capture evidence; prune if disk use matters.
    const captureRoot = join(await this.store.projectRoot(request.projectId), "captures");
    await mkdir(captureRoot, { recursive: true, mode: 0o700 });
    let capture: CaptureResult;
    try {
      capture = await runCapture(flow, target.environment, {
        artifactRoot: captureRoot,
        signal,
        ...(target.values ? { values: target.values } : {}),
        ...(target.resetUrl ? { reset: () => resetBrowserTarget(target.resetUrl!, signal) } : {}),
        ...this.media,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, code: "CAPTURE_FAILED", detail: "the approved flow did not complete" };
    }
    await fence();
    try {
      const result = await recaptureBrowserSceneV2(this.store, {
        projectId: request.projectId,
        baseRevisionId: request.baseRevisionId,
        previousAssetId: request.assetId,
        capture,
        sceneKey,
        changedActionIds: request.changedActionIds,
        reason: request.reason,
        intentId,
      }, { ...this.media, captureRoots: [captureRoot] });
      return { ok: true, revisionId: result.revisionId, revision: revisionView(result.project, result.revisionId), assetId: result.replacementAsset.id };
    } catch (error) {
      if (error instanceof RecaptureV2Error) return { ok: false, code: error.code, detail: error.message };
      throw error;
    }
  }

  /** Content-addressed per asset and generator config; regenerated per job within its bounded deadline. */
  private async mediaEvidence(project: ProjectV2, authorization: MediaExecutionAuthorization, evidenceRoot: string): Promise<MediaEvidenceIndex[]> {
    const indexes: MediaEvidenceIndex[] = [];
    for (const handle of authorization.resolvedHandles) {
      const type = project.assets[handle.assetId]?.type;
      if (type !== "uploaded_video" && type !== "browser_capture") continue;
      indexes.push(await generateMediaEvidence({
        asset: { assetId: handle.assetId, sha256: handle.sha256, ref: handle.ref },
        resolveSource: async () => handle.path,
        evidenceRoot,
        ...this.media,
      }));
    }
    return indexes;
  }

  /** Resolves every stored asset for one render; the revision check re-reads canonical state. */
  async mediaAuthorization(project: ProjectV2): Promise<MediaExecutionAuthorization> {
    const projectRoot = await this.store.projectRoot(project.projectId);
    return {
      projectRoot,
      resolvedHandles: Object.values(project.assets).filter((asset) => asset.path).map((asset) => ({
        assetId: asset.id, sha256: asset.sha256, ref: asset.path!, path: join(projectRoot, ...asset.path!.split("/")),
      })),
      isRevisionCurrent: async (revisionId, revisionHash) => {
        const latest = await this.store.current(project.projectId);
        return latest.currentRevisionId === revisionId && semanticHashV2(latest) === revisionHash;
      },
    };
  }

  capabilities(): CapabilitySet {
    const targets = Object.values(this.browserTargets);
    return localCapabilities(this.agentEnabled, targets.length > 0, targets.some(({ flow }) => flow !== undefined));
  }
}

async function resetBrowserTarget(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { method: "POST", signal, redirect: "error" });
  if (!response.ok) throw new Error(`browser target reset failed: ${response.status}`);
}

function revisionView(project: ProjectV2, revisionId: string): RevisionView {
  const revision = project.revisions.find(({ id }) => id === revisionId);
  if (!revision) throw new Error("recapture revision is missing from the committed project");
  return { ...revision, isCurrent: project.currentRevisionId === revisionId };
}

/** Describes the revision an agent edit ended on, with its newest preview when one was registered. */
function publishedRevision(project: ProjectV2, revisionId: string, baseRevisionId?: string): Omit<Extract<AgentEditOutcome, { ok: true }>, "ok" | "thread"> {
  const revision = project.revisions.find(({ id }) => id === revisionId);
  if (!revision) throw new Error("agent revision is missing from the committed project");
  if (revisionId === baseRevisionId) return { revisionId };
  const preview = project.outputs.filter((output) => output.sourceRevisionId === revisionId).at(-1);
  return {
    revisionId,
    revision: { ...revision, isCurrent: project.currentRevisionId === revisionId },
    ...(preview ? { outputId: preview.outputId, artifact: artifactView(preview) } : {}),
  };
}

function artifactView({ outputId, ref, sha256, renderJobHash, probe, sourceRevisionId, revisionId, backendId, backendVersion, verificationRefId }: ProjectV2["outputs"][number]): RenderArtifactView {
  return { outputId, ref, sha256, renderJobHash, probe, sourceRevisionId, revisionId, backendId, backendVersion, verificationRefId };
}

function publicOutcome(result: OperationBatchResult): ApplyOperationsOutcome {
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail };
  const revision = result.project.revisions.find(({ id }) => id === result.revisionId);
  if (!revision) throw new Error("committed revision is missing from the operation result");
  return {
    ok: true,
    revisionId: result.revisionId,
    operationIds: result.operationLog.map((record) => record.id),
    revision: { ...revision, isCurrent: result.project.currentRevisionId === revision.id },
  };
}

function summary(project: ProjectV2) {
  const current = project.revisions.find((revision) => revision.id === project.currentRevisionId)!;
  return {
    projectId: project.projectId,
    projectSchemaVersion: 2 as const,
    brief: project.brief,
    currentRevisionId: project.currentRevisionId,
    assetCount: Object.keys(project.assets).length,
    durationMs: project.composition.durationMs,
    verificationStatus: project.verification.revisionId === project.currentRevisionId ? project.verification.status : "stale" as const,
    updatedAt: current.createdAt,
  };
}

function snapshot(current: ProjectV2, selected: ProjectV2, capabilities: CapabilitySet): ProjectSnapshot {
  const selectedRevisionId = selected.currentRevisionId;
  const assets = Object.values(selected.assets).map(({ id, type, sha256, probe, provenance }) => ({ id, type, sha256, probe, provenance }));
  const renderArtifacts = selected.outputs
    .filter((artifact) => artifact.sourceRevisionId === selectedRevisionId)
    .map(artifactView);

  return ProjectSnapshotSchema.parse({
    summary: summary(current),
    revisionId: selectedRevisionId,
    isCurrentRevision: selectedRevisionId === current.currentRevisionId,
    assets,
    composition: selected.composition,
    revisions: current.revisions.map((revision) => ({ ...revision, isCurrent: revision.id === current.currentRevisionId })),
    verification: selected.verification,
    renderArtifacts,
    capabilities,
  });
}

function localCapabilities(agentEnabled: boolean, recaptureEnabled: boolean, captureEnabled: boolean): CapabilitySet {
  return CapabilitySetSchema.parse({
    contractVersion: "v1",
    target: "local",
    availableCommands: ["create_project", "open_project", "import_asset", ...(captureEnabled ? ["start_browser_capture" as const] : []), "apply_operations", ...(agentEnabled ? ["request_agent_edit" as const] : []), ...(recaptureEnabled ? ["recapture_browser_scene" as const] : []), "verify_revision", "render_preview", "render_final", "cancel_job"],
    availableOperations: [
      "remove_asset", "create_clip", "split_clip", "trim_clip", "move_clip",
      "remove_clip", "replace_asset", "set_transform", "set_opacity", "set_speed",
      "set_transition", "add_text_layer", "update_text_layer", "add_image_layer",
      "remove_layer", "set_volume", "mute_clip", "animate_property",
    ],
    assetTypes: ["uploaded_video", "image", "audio"],
    jobKinds: ["asset_import", ...(captureEnabled ? ["browser_capture" as const] : []), "apply_operations", ...(agentEnabled ? ["agent_edit" as const] : []), ...(recaptureEnabled ? ["browser_recapture" as const] : []), "verify_revision", "render_preview", "render_final"],
    cancellationSupported: true,
    credentialActions: [],
  });
}
