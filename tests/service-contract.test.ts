import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json.js";
import {
  ApplyOperationsRequestSchema,
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
    const inputRequest = "inputRequest" in mockWaitingInputJob ? mockWaitingInputJob.inputRequest : undefined;
    expect(JobInputSubmissionResultSchema.safeParse({ disposition: "stale", job: { ...mockFailedStaleInputJob, inputRequest } }).success).toBe(false);
    expect(JobInputRequestSchema.safeParse(inputRequest).success).toBe(true);
    expect(SubmitJobInputRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", jobId: "job-1", inputRequestId: "input-1", response: { type: "credential_action", secureFlowId: "secure-flow-1", action: "open_secure_flow" } }).success).toBe(true);
    expect(SubmitJobInputRequestSchema.safeParse({ ...meta, baseRevisionId: "revision-1", jobId: "job-1", inputRequestId: "input-1", response: { type: "credential_action", secureFlowId: "secure-flow-1", action: "open_secure_flow", password: "secret" } }).success).toBe(false);
  });

  it("validates cancellation as a request and a terminal cancelled state", () => {
    expect(CancelJobRequestSchema.parse({ ...meta, jobId: "job-1" })).toMatchObject({ jobId: "job-1" });
    expect(JobViewSchema.parse(mockCancelledJob).state).toBe("cancelled");
    const inputRequest = "inputRequest" in mockWaitingInputJob ? mockWaitingInputJob.inputRequest : undefined;
    expect(CancelJobResponseSchema.safeParse({ disposition: "already_terminal", job: mockCancelledJob }).success).toBe(true);
    expect(CancelJobResponseSchema.safeParse({ disposition: "requested", job: { ...mockWaitingInputJob, cancellationRequested: true } }).success).toBe(true);
    expect(JobViewSchema.safeParse({ ...mockCancelledJob, inputRequest }).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...mockCancelledJob, stage: "unbounded-stage" }).success).toBe(false);
    expect(JobProgressSchema.safeParse({ completed: 4, total: 3, percent: 120 }).success).toBe(false);
  });

  it("accepts structured known errors and rejects unknown codes", () => {
    const error = { code: "REVISION_CONFLICT", message: "Refresh the project", retryable: true, fieldIssues: [] };
    expect(ErrorSchema.parse(error)).toEqual(error);
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
  });
});
