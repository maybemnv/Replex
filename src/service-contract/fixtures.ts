import { CapabilitySetSchema, JobViewSchema, ProjectEventSchema, ProjectSnapshotSchema } from "./index.js";

export const mockCapabilitySet = CapabilitySetSchema.parse({
  contractVersion: "v1",
  target: "local",
  availableCommands: [
    "create_project", "open_project", "import_asset", "start_browser_capture", "recapture_browser_scene",
    "request_agent_edit", "apply_operations", "verify_revision", "render_preview", "render_final",
    "cancel_job", "submit_job_input",
  ],
  availableOperations: ["set_opacity", "mute_clip", "trim_clip", "move_clip"],
  assetTypes: ["browser_capture", "uploaded_video", "image", "audio", "generated_graphic"],
  jobKinds: ["asset_import", "browser_capture", "browser_recapture", "agent_edit", "apply_operations", "verify_revision", "render_preview", "render_final"],
  cancellationSupported: true,
  credentialActions: ["secure_browser_flow"],
});

const revision = "revision-2";
const verificationRef = "verification-2";

export const mockProjectSnapshot = ProjectSnapshotSchema.parse({
  summary: {
    projectId: "project-launch",
    projectSchemaVersion: 2,
    brief: { audience: "Founders", message: "Show the product launch", targetDurationMs: 4000 },
    currentRevisionId: revision,
    assetCount: 2,
    durationMs: 4000,
    verificationStatus: "passed",
    updatedAt: "2026-09-23T00:00:00.000Z",
  },
  revisionId: revision,
  isCurrentRevision: true,
  assets: [
    {
      id: "asset-browser",
      type: "browser_capture",
      sha256: "a".repeat(64),
      probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30, videoCodec: "h264" },
      provenance: {
        kind: "browser",
        flowId: "flow-launch",
        sceneKey: "hero",
        actionIds: ["open-hero"],
        checkpointActionId: "open-hero",
        runId: "capture-1",
        capturedAt: "2026-09-23T00:00:00.000Z",
      },
    },
    {
      id: "asset-logo",
      type: "image",
      sha256: "b".repeat(64),
      probe: { width: 800, height: 600 },
      provenance: {
        kind: "upload",
        originalFilename: "logo.png",
        importedAt: "2026-09-23T00:00:00.000Z",
        sourceSha256: "b".repeat(64),
        importMethod: "upload",
        originalProbe: { width: 800, height: 600 },
      },
    },
  ],
  composition: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 4000,
    tracks: [
      { id: "track-video", kind: "video", order: 0, muted: false, locked: false },
      { id: "track-overlay", kind: "overlay", order: 1, muted: false, locked: false },
    ],
    clips: [{
      id: "clip-hero",
      assetId: "asset-browser",
      trackId: "track-video",
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 4000,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      audioGainDb: 0,
      muted: false,
    }],
    layers: [{
      id: "layer-logo",
      trackId: "track-overlay",
      kind: "image",
      timelineStartMs: 0,
      durationMs: 3000,
      properties: { assetId: "asset-logo" },
      keyframes: [],
    }],
  },
  revisions: [
    { id: "revision-1", actor: "user", operationIds: [], manifestSha256: "c".repeat(64), createdAt: "2026-09-22T00:00:00.000Z", isCurrent: false },
    { id: revision, parentId: "revision-1", actor: "agent", operationIds: ["operation-1"], manifestSha256: "d".repeat(64), createdAt: "2026-09-23T00:00:00.000Z", isCurrent: true },
  ],
  verification: {
    revisionId: revision,
    status: "passed",
    refs: [{ id: verificationRef, revisionId: revision, status: "passed", evidenceRefs: ["evidence/verification-2.json"] }],
  },
  renderArtifacts: [{
    outputId: "output-2",
    ref: "renders/revision-2.mp4",
    sha256: "e".repeat(64),
    probe: { durationMs: 4000, width: 1920, height: 1080, fps: 30, videoCodec: "h264" },
    sourceRevisionId: revision,
    revisionId: revision,
    renderJobHash: "f".repeat(64),
    backendId: "native-media",
    backendVersion: "1",
    verificationRefId: verificationRef,
  }],
  capabilities: mockCapabilitySet,
});

export const mockWaitingInputJob = JobViewSchema.parse({
  id: "job-capture-1",
  projectId: "project-launch",
  kind: "browser_capture",
  baseRevisionId: revision,
  state: "waiting_for_input",
  stage: "awaiting_user_input",
  progress: { completed: 1, total: 3, unit: "checkpoint" },
  cancellable: true,
  cancellationRequested: false,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:01.000Z",
  inputRequest: {
    id: "input-approval-1",
    jobId: "job-capture-1",
    expectedRevisionId: revision,
    kind: "browser_approval",
    title: "Approve browser sign-in",
    message: "Continue in the secure local browser window.",
    flowId: "flow-launch",
    targetOrigin: "https://example.test",
    expiresAt: "2026-09-23T00:10:00.000Z",
  },
});

export const mockCancelledJob = JobViewSchema.parse({
  id: "job-preview-1",
  projectId: "project-launch",
  kind: "render_preview",
  revisionId: revision,
  state: "cancelled",
  stage: "rendering_preview",
  cancellable: false,
  cancellationRequested: false,
  createdAt: "2026-09-23T00:01:00.000Z",
  updatedAt: "2026-09-23T00:01:02.000Z",
});

export const mockFailedStaleInputJob = JobViewSchema.parse({
  id: mockWaitingInputJob.id,
  projectId: mockWaitingInputJob.projectId,
  kind: mockWaitingInputJob.kind,
  baseRevisionId: revision,
  state: "failed",
  stage: "finalizing",
  cancellable: false,
  cancellationRequested: false,
  createdAt: mockWaitingInputJob.createdAt,
  updatedAt: "2026-09-23T00:00:02.000Z",
  error: {
    code: "STALE_JOB_INPUT",
    message: "The project changed while input was pending.",
    retryable: false,
  },
});

export const mockProjectEvents = [
  ProjectEventSchema.parse({
    type: "job.updated",
    projectId: "project-launch",
    sequence: 1,
    occurredAt: "2026-09-23T00:00:01.000Z",
    job: mockWaitingInputJob,
  }),
  ProjectEventSchema.parse({
    type: "capabilities.updated",
    projectId: "project-launch",
    sequence: 2,
    occurredAt: "2026-09-23T00:00:02.000Z",
    capabilities: mockCapabilitySet,
  }),
];
