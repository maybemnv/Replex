import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json.js";
import {
  ApplyOperationsRequestSchema,
  AssetViewSchema,
  CancelJobRequestSchema,
  CancelJobResponseSchema,
  CapabilitySetSchema,
  ContractVersionSchema,
  CreateProjectRequestSchema,
  ProjectCreatedResponseSchema,
  ErrorSchema,
  ImportAssetRequestSchema,
  JobInputRequestSchema,
  JobInputSubmissionResultSchema,
  JobProgressSchema,
  JobEventSchema,
  JobSchema,
  JobStateSchema,
  JobViewSchema,
  OpenProjectRequestSchema,
  ProjectSnapshotSchema,
  ProjectSummarySchema,
  ProjectEventSchema,
  RecaptureRequestSchema,
  RenderFinalRequestSchema,
  RenderPreviewRequestSchema,
  RequestAgentEditSchema,
  StartBrowserCaptureRequestSchema,
  SubmitJobInputRequestSchema,
  VerifyRevisionRequestSchema,
} from "../src/service-contract/index.js";
import {
  mockCancelledJob,
  mockCapabilitySet,
  mockFailedStaleInputJob,
  mockProjectEvents,
  mockProjectSnapshot,
  mockWaitingInputJob,
} from "../src/service-contract/fixtures.js";

const meta = {
  contractVersion: "v1" as const,
  projectId: "project-1",
  idempotencyKey: "request-1",
};

const jobKinds = [
  "asset_import", "browser_capture", "browser_recapture", "agent_edit", "apply_operations",
  "verify_revision", "render_preview", "render_final",
] as const;
const jobStates = ["queued", "running", "waiting_for_input", "cancelling", "succeeded", "failed", "cancelled"] as const;

function jobPayload(kind: string, state: string, pins: Record<string, string>) {
  const inputRequest = {
    id: "input-1",
    jobId: "job-1",
    expectedRevisionId: pins.baseRevisionId ?? pins.revisionId ?? "revision-1",
    kind: "clarification",
    title: "Clarify edit",
    message: "Choose a title",
  };
  const result = {
    revisionId: pins.revisionId ?? "revision-result",
    ...(kind === "asset_import" || kind === "browser_capture" || kind === "browser_recapture" ? { assetId: "asset-1" } : {}),
    ...(kind === "render_preview" || kind === "render_final" ? { outputId: "output-1" } : {}),
  };
  const stateFields = {
    queued: { cancellable: true, cancellationRequested: false },
    running: { cancellable: true, cancellationRequested: false },
    waiting_for_input: { cancellable: true, cancellationRequested: false, inputRequest },
    cancelling: { cancellable: false, cancellationRequested: true },
    succeeded: { cancellable: false, cancellationRequested: false, result },
    failed: {
      cancellable: false,
      cancellationRequested: false,
      error: { code: "EXECUTION_FAILED", message: "Execution failed", retryable: false },
    },
    cancelled: { cancellable: false, cancellationRequested: false },
  } as const;
  return {
    id: "job-1",
    projectId: "project-1",
    kind,
    ...pins,
    state,
    stage: state === "queued" ? "queued" : state === "waiting_for_input" ? "awaiting_user_input" : "finalizing",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:01.000Z",
    ...stateFields[state as keyof typeof stateFields],
  };
}

describe("transport-independent service contract", () => {
  it("parses shaped snapshots and rejects canonical ProjectV2 payloads", () => {
    expect(ProjectSummarySchema.parse(mockProjectSnapshot.summary)).toEqual(mockProjectSnapshot.summary);
    expect(ProjectSnapshotSchema.parse(mockProjectSnapshot)).toEqual(mockProjectSnapshot);
    expect(ProjectSnapshotSchema.safeParse({ ...mockProjectSnapshot, project: {} }).success).toBe(false);
    expect(ProjectSnapshotSchema.safeParse({ ...mockProjectSnapshot, extra: true }).success).toBe(false);
    expect(ProjectSnapshotSchema.safeParse({ ...mockProjectSnapshot, assets: [{ ...mockProjectSnapshot.assets[0], path: "assets/private.mp4" }, ...mockProjectSnapshot.assets.slice(1)] }).success).toBe(false);
    const historical = structuredClone(mockProjectSnapshot);
    historical.revisionId = "revision-1";
    historical.isCurrentRevision = false;
    historical.summary.assetCount = 7;
    historical.summary.durationMs = 9000;
    historical.verification = { revisionId: "revision-1", status: "unknown", refs: [] };
    historical.renderArtifacts = [];
    expect(ProjectSnapshotSchema.safeParse(historical).success).toBe(true);
  });

  it("keeps local upload paths out of public asset views", () => {
    const asset = mockProjectSnapshot.assets[1];
    expect(AssetViewSchema.safeParse({
      ...asset,
      provenance: { ...asset.provenance, originalFilename: "C:\\Users\\Manav\\secret\\logo.png" },
    }).success).toBe(false);
  });

  it("accepts all command and revision read/write request shapes", () => {
    expect(ContractVersionSchema.parse("v1")).toBe("v1");
    expect(CreateProjectRequestSchema.safeParse({ contractVersion: "v1", idempotencyKey: "create-1", name: "Launch", brief: {} }).success).toBe(true);
    expect(CreateProjectRequestSchema.safeParse({ contractVersion: "v1", name: "Launch" }).success).toBe(false);
    expect(OpenProjectRequestSchema.safeParse({ ...meta, revisionId: "revision-1" }).success).toBe(true);
    expect(ProjectCreatedResponseSchema.safeParse({
      contractVersion: "v1",
      projectId: "project-1",
      revisionId: "revision-1",
      summary: { ...mockProjectSnapshot.summary, projectId: "project-1", currentRevisionId: "revision-1" },
    }).success).toBe(true);
    expect(ImportAssetRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", source: { kind: "upload_session", ref: "session-1" }, declaredFilename: "launch.mp4" }).success).toBe(true);
    expect(StartBrowserCaptureRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", flowId: "flow-1", approved: true, executionTarget: "local" }).success).toBe(true);
    expect(RecaptureRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", assetId: "asset-1", changedActionIds: ["action-1"], reason: "Update hero", executionTarget: "local" }).success).toBe(true);
    expect(RequestAgentEditSchema.safeParse({ ...meta, baseRevisionId: "revision-1", prompt: "Make the title larger", preview: true }).success).toBe(true);
    expect(ApplyOperationsRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", actor: "user", operations: [{ type: "set_opacity", clipId: "clip-1", opacity: 0.5 }] }).success).toBe(true);
    expect(VerifyRevisionRequestSchema.safeParse({ ...meta, revisionId: "revision-1" }).success).toBe(true);
    expect(RenderPreviewRequestSchema.safeParse({ ...meta, revisionId: "revision-1" }).success).toBe(true);
    expect(RenderFinalRequestSchema.safeParse({ ...meta, revisionId: "revision-1", verificationRefId: "verification-1" }).success).toBe(true);
    expect(CancelJobRequestSchema.safeParse({ ...meta, jobId: "job-1" }).success).toBe(true);
  });

  it("requires explicit supported contract versions and rejects extra request fields", () => {
    expect(ContractVersionSchema.safeParse("v2").success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ contractVersion: "v2", idempotencyKey: "create-1", name: "Launch" }).success).toBe(false);
    expect(OpenProjectRequestSchema.safeParse({ ...meta, revisionId: "revision-1", accidental: true }).success).toBe(false);
    expect(CapabilitySetSchema.safeParse({ ...mockCapabilitySet, backendInternals: {} }).success).toBe(false);
  });

  it("requires base revision metadata for mutations and revision IDs for derived reads", () => {
    const mutation = { ...meta, operations: [{ type: "set_opacity", clipId: "clip-1", opacity: 1 }] };
    const derived = { ...meta };
    expect(ApplyOperationsRequestSchema.safeParse(mutation).success).toBe(false);
    expect(OpenProjectRequestSchema.safeParse(meta).success).toBe(false);
    expect(ImportAssetRequestSchema.safeParse({ ...meta, source: { kind: "upload_session", ref: "session-1" }, declaredFilename: "launch.mp4" }).success).toBe(false);
    expect(VerifyRevisionRequestSchema.safeParse(derived).success).toBe(false);
    expect(RenderPreviewRequestSchema.safeParse(derived).success).toBe(false);
    expect(RenderFinalRequestSchema.safeParse({ ...derived, verificationRefId: "verification-1" }).success).toBe(false);
  });

  it("makes waiting input explicit and turns stale input into a terminal job failure", () => {
    expect(JobViewSchema.parse(mockWaitingInputJob)).toEqual(mockWaitingInputJob);
    expect(JobViewSchema.safeParse({ ...mockWaitingInputJob, inputRequest: undefined }).success).toBe(false);
    expect(JobViewSchema.parse(mockFailedStaleInputJob).state).toBe("failed");
    expect(JobInputSubmissionResultSchema.safeParse({ disposition: "stale", job: mockFailedStaleInputJob }).success).toBe(true);
    expect(JobInputSubmissionResultSchema.safeParse({ disposition: "accepted", job: mockFailedStaleInputJob }).success).toBe(false);
    expect(JobInputSubmissionResultSchema.safeParse({ disposition: "accepted", job: jobPayload("browser_capture", "running", {}) }).success).toBe(false);
    const staleUnpinnedJob = {
      ...jobPayload("browser_capture", "failed", {}),
      error: { code: "STALE_JOB_INPUT", message: "The project changed.", retryable: false },
    };
    expect(JobInputSubmissionResultSchema.safeParse({ disposition: "stale", job: staleUnpinnedJob }).success).toBe(false);
    for (const state of ["succeeded", "failed", "cancelled"] as const) {
      const terminal = jobPayload("browser_capture", state, { baseRevisionId: "revision-1" });
      expect(JobInputSubmissionResultSchema.safeParse({ disposition: "accepted", job: terminal }).success).toBe(false);
    }
    const inputRequest = "inputRequest" in mockWaitingInputJob ? mockWaitingInputJob.inputRequest : undefined;
    expect(JobInputSubmissionResultSchema.safeParse({ disposition: "stale", job: { ...mockFailedStaleInputJob, inputRequest } }).success).toBe(false);
    expect(JobInputRequestSchema.safeParse(inputRequest).success).toBe(true);
    const approval = inputRequest!;
    expect(JobInputRequestSchema.safeParse({ ...approval, targetOrigin: "https://user:password@example.test" }).success).toBe(false);
    expect(JobInputRequestSchema.safeParse({ ...approval, targetOrigin: "https://example.test/login?token=secret" }).success).toBe(false);
    expect(SubmitJobInputRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", jobId: "job-1", inputRequestId: "input-1", response: { type: "credential_action", secureFlowId: "secure-flow-1", action: "open_secure_flow" } }).success).toBe(true);
    expect(SubmitJobInputRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", jobId: "job-1", inputRequestId: "input-1", response: { type: "credential_action", secureFlowId: "secure-flow-1", action: "open_secure_flow", password: "secret" } }).success).toBe(false);
  });

  it("validates cancellation as a request and a terminal cancelled state", () => {
    expect(CancelJobRequestSchema.parse({ ...meta, jobId: "job-1" })).toMatchObject({ jobId: "job-1" });
    expect(JobViewSchema.parse(mockCancelledJob).state).toBe("cancelled");
    expect(JobStateSchema.parse("cancelling")).toBe("cancelling");
    const cancellingJob = { ...mockCancelledJob, state: "cancelling" as const, cancellationRequested: true };
    expect(JobSchema.parse(cancellingJob).state).toBe("cancelling");
    expect(CancelJobResponseSchema.safeParse({ disposition: "requested", job: jobPayload("browser_capture", "cancelling", {}) }).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...cancellingJob, cancellable: true }).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...mockWaitingInputJob, cancellationRequested: true }).success).toBe(false);
    const inputRequest = "inputRequest" in mockWaitingInputJob ? mockWaitingInputJob.inputRequest : undefined;
    expect(CancelJobResponseSchema.safeParse({ disposition: "already_terminal", job: mockCancelledJob }).success).toBe(true);
    expect(CancelJobResponseSchema.safeParse({ disposition: "requested", job: cancellingJob }).success).toBe(true);
    expect(CancelJobResponseSchema.safeParse({ disposition: "requested", job: { ...mockWaitingInputJob, cancellationRequested: true } }).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...mockCancelledJob, inputRequest }).success).toBe(false);
    for (const state of ["succeeded", "failed", "cancelled"] as const) {
      expect(JobViewSchema.safeParse({ ...jobPayload("browser_capture", state, { baseRevisionId: "revision-1" }), inputRequest }).success).toBe(false);
    }
    expect(JobViewSchema.safeParse({ ...mockCancelledJob, stage: "unbounded-stage" }).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...jobPayload("browser_capture", "running", { baseRevisionId: "revision-1" }), stage: "queued" }).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...jobPayload("browser_capture", "queued", { baseRevisionId: "revision-1" }), stage: "finalizing" }).success).toBe(false);
    expect(JobProgressSchema.safeParse({ completed: 4, total: 3, percent: 120 }).success).toBe(false);
  });

  it("requires exactly the job-kind revision pin in every state", () => {
    for (const kind of jobKinds) {
      const pinField = ["asset_import", "browser_capture", "browser_recapture", "agent_edit", "apply_operations"].includes(kind)
        ? "baseRevisionId"
        : "revisionId";
      const correctPin = { [pinField]: "revision-1" };
      for (const state of jobStates) {
        expect(JobViewSchema.safeParse(jobPayload(kind, state, correctPin)).success, `${kind}/${state} with ${pinField}`).toBe(true);
        expect(JobViewSchema.safeParse(jobPayload(kind, state, {})).success, `${kind}/${state} without a pin`).toBe(false);
        expect(JobViewSchema.safeParse(jobPayload(kind, state, { ...correctPin, [pinField === "baseRevisionId" ? "revisionId" : "baseRevisionId"]: "revision-1" })).success, `${kind}/${state} with both pins`).toBe(false);
      }
    }
  });

  it("binds verification and render results to the job's pinned revision", () => {
    for (const kind of ["verify_revision", "render_preview", "render_final"] as const) {
      const job = JobViewSchema.parse(jobPayload(kind, "succeeded", { revisionId: "revision-pinned" }));
      if (job.state !== "succeeded") throw new Error("expected successful job fixture");
      expect(JobViewSchema.safeParse(job).success, kind).toBe(true);
      expect(JobViewSchema.safeParse({ ...job, result: { ...job.result, revisionId: "revision-other" } }).success, kind).toBe(false);
    }
  });

  it("accepts structured known errors and rejects unknown codes", () => {
    const error = { code: "REVISION_CONFLICT", message: "Refresh the project", retryable: true, fieldIssues: [] };
    expect(ErrorSchema.parse(error)).toEqual(error);
    const codes = [
      "PROJECT_NOT_FOUND", "ASSET_NOT_FOUND", "REVISION_NOT_FOUND", "REVISION_CONFLICT", "INVALID_OPERATION",
      "INVALID_JOB_STATE", "MEDIA_UNAVAILABLE", "EXECUTION_FAILED", "CANCELLATION", "PATH_FAILURE",
      "CONTRACT_VERSION_UNSUPPORTED", "CAPABILITY_UNAVAILABLE", "BROWSER_APPROVAL_REQUIRED", "VERIFICATION_FAILED", "STORAGE_FAILED",
    ];
    for (const code of codes) {
      expect(ErrorSchema.safeParse({ code, message: `${code} fixture`, retryable: false }).success, code).toBe(true);
    }
    expect(ErrorSchema.safeParse({ ...error, code: "WHATEVER" }).success).toBe(false);
    expect(ErrorSchema.safeParse({ ...error, trace: "internal" }).success).toBe(false);
  });

  it("keeps capabilities bounded, unique, and honest about target-specific commands", () => {
    expect(CapabilitySetSchema.parse(mockCapabilitySet)).toEqual(mockCapabilitySet);
    expect(CapabilitySetSchema.safeParse({ ...mockCapabilitySet, availableCommands: [...mockCapabilitySet.availableCommands, "unknown_command"] }).success).toBe(false);
    expect(CapabilitySetSchema.safeParse({ ...mockCapabilitySet, target: "cloud", availableCommands: ["start_browser_capture"] }).success).toBe(false);
    expect(CapabilitySetSchema.safeParse({ ...mockCapabilitySet, availableCommands: ["open_project", "open_project"] }).success).toBe(false);
  });

  it("serializes fixture snapshots deterministically", () => {
    const parsed = ProjectSnapshotSchema.parse(mockProjectSnapshot);
    expect(canonicalJson(parsed)).toBe(canonicalJson(mockProjectSnapshot));
    expect(canonicalJson(parsed)).toBe(canonicalJson(ProjectSnapshotSchema.parse(mockProjectSnapshot)));
    expect(mockProjectEvents.map((event) => ProjectEventSchema.parse(event))).toEqual(mockProjectEvents);
    expect(mockProjectEvents.map((event) => JobEventSchema.parse(event))).toEqual(mockProjectEvents);
  });
});
