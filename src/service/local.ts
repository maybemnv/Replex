import { createHash } from "node:crypto";
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
  type ApplyOperationsRequest,
  type CapabilitySet,
  type CreateProjectRequest,
  type OpenProjectRequest,
  type ProjectCreatedResponse,
  type ProjectSnapshot,
  type RevisionView,
} from "../service-contract/index.js";
import { LocalProjectStore } from "./project-store.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export type ApplyOperationsOutcome =
  | { ok: true; revisionId: string; operationIds: string[]; revision: RevisionView }
  | { ok: false; code: "STALE_REVISION" | "INVALID_OPERATION" | "UNSUPPORTED_OPERATION"; detail: string };

export class LocalProjectService {
  private readonly store: LocalProjectStore;

  constructor(options: { workspaceRoot: string }) {
    this.store = new LocalProjectStore(options.workspaceRoot);
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

  capabilities(): CapabilitySet {
    return localCapabilities();
  }
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
    .map(({ outputId, ref, sha256, renderJobHash, probe, sourceRevisionId, revisionId, backendId, backendVersion, verificationRefId }) => ({
      outputId, ref, sha256, renderJobHash, probe, sourceRevisionId, revisionId, backendId, backendVersion, verificationRefId,
    }));

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
    availableCommands: ["create_project", "open_project", "apply_operations", "cancel_job"],
    availableOperations: [
      "remove_asset", "create_clip", "split_clip", "trim_clip", "move_clip",
      "remove_clip", "replace_asset", "set_transform", "set_opacity", "set_speed",
      "set_transition", "add_text_layer", "update_text_layer", "add_image_layer",
      "remove_layer", "set_volume", "mute_clip", "animate_property",
    ],
    assetTypes: [],
    jobKinds: ["apply_operations"],
    cancellationSupported: true,
    credentialActions: [],
  });
}
