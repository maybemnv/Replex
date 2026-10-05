import { createHash } from "node:crypto";
import { join } from "node:path";
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
  type RenderArtifactView,
  type RenderFinalRequest,
  type RenderPreviewRequest,
} from "../service-contract/index.js";
import { LocalProjectStore, LocalProjectStoreError } from "./project-store.js";
import { importLocalAssetV2, LocalImportError, type AuthorizedLocalImport } from "../import-v2.js";
import { renderCurrentRevisionV2, type MediaExecutionAuthorization } from "../render-v2.js";
import { semanticHashV2 } from "../operations-v2.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export type ApplyOperationsOutcome =
  | { ok: true; revisionId: string; operationIds: string[]; revision: RevisionView }
  | { ok: false; code: "STALE_REVISION" | "INVALID_OPERATION" | "UNSUPPORTED_OPERATION"; detail: string };

export type RenderOutcome =
  | { ok: true; revisionId: string; outputId: string; artifact: RenderArtifactView }
  | { ok: false; code: "STALE_REVISION" | "VERIFICATION_REQUIRED" | "RENDER_FAILED"; detail: string };

/** Host-owned media tool paths; motion presets require absolute executables. */
export interface MediaToolOptions { ffmpegPath?: string; ffprobePath?: string }

export class LocalProjectService {
  private readonly store: LocalProjectStore;
  private readonly media: MediaToolOptions;

  constructor(options: { workspaceRoot: string; media?: MediaToolOptions }) {
    this.store = new LocalProjectStore(options.workspaceRoot);
    this.media = options.media ?? {};
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
    return snapshot(current, selected);
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
  async renderRevision(request: RenderPreviewRequest | RenderFinalRequest, signal: AbortSignal): Promise<RenderOutcome> {
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
    const registered = await this.store.registerRender(request.projectId, rendered.artifact);
    const output = registered.outputs.find(({ outputId }) => outputId === rendered.artifact.outputId)!;
    return { ok: true, revisionId: request.revisionId, outputId: output.outputId, artifact: artifactView(output) };
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
    return localCapabilities();
  }
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

function snapshot(current: ProjectV2, selected: ProjectV2): ProjectSnapshot {
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
    capabilities: localCapabilities(),
  });
}

function localCapabilities(): CapabilitySet {
  return CapabilitySetSchema.parse({
    contractVersion: "v1",
    target: "local",
    availableCommands: ["create_project", "open_project", "import_asset", "apply_operations", "render_preview", "render_final", "cancel_job"],
    availableOperations: [
      "remove_asset", "create_clip", "split_clip", "trim_clip", "move_clip",
      "remove_clip", "replace_asset", "set_transform", "set_opacity", "set_speed",
      "set_transition", "add_text_layer", "update_text_layer", "add_image_layer",
      "remove_layer", "set_volume", "mute_clip", "animate_property",
    ],
    assetTypes: ["uploaded_video", "image", "audio"],
    jobKinds: ["asset_import", "apply_operations", "render_preview", "render_final"],
    cancellationSupported: true,
    credentialActions: [],
  });
}
