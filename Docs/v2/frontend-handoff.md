# Replex V2 frontend handoff for Gurbaaz

**Status:** Contract draft for parallel frontend planning; no frontend is implemented

**Backend source of truth:** [`../architecture/REPLEX_V2.md`](../architecture/REPLEX_V2.md)

**Stabilization dependency:** Phase 7 of [`implementation-plan.md`](implementation-plan.md)

## Product experience

Build one project workspace, not separate browser-capture and upload products.

```text
Create/Open Project
      |
      +-> Capture product flow
      |
      +-> Upload video/image/audio
      |
      v
Asset workspace
      |
      v
Prompt: "Turn this into a 30-second launch reel"
      |
      v
Agent planning/edit job -> Preview
      |                    |
      |                    +-> follow-up prompt
      |                    +-> bounded manual correction
      |                    +-> revision history
      v
Verify -> Render/export
```

The UI may display storyboard/timeline views, but it is never the canonical project store. It renders server snapshots and sends commands with `baseRevisionId`. Optimistic display must reconcile to the accepted revision event; the frontend does not patch project JSON.

## Ownership

### Frontend owns

- project browsing and selection;
- file selection, upload/import progress, and resumable UX where supported;
- prompt/chat and agent-plan presentation;
- preview playback and bounded review controls;
- storyboard/timeline visualization;
- revision/history navigation and comparison;
- job progress, cancellation, recoverable error, disconnected, and capability-mismatch states;
- browser capture approval/status UX;
- local/cloud target choice only when the backend advertises both.

### Backend/core owns

- canonical project state and revision history;
- file/object storage policy, hashing, probing, and analysis;
- browser execution and credential/session isolation;
- agent orchestration, inspection, grounding, and budgets;
- semantic operation schemas, validation, and reducer;
- RenderJobs, backend translation, ffmpeg-skill integration, and motion execution;
- verification and output authorization;
- local/cloud executor behavior and capability reporting.

## Workspace areas

1. **Project header:** name, current revision, verification state, execution target/capability, save/export status.
2. **Assets:** imported and browser-derived sources, thumbnails/contact sheets, probe summary, provenance badge, analysis state.
3. **Composition:** storyboard first; a constrained timeline only when overlapping tracks are implemented. Show clips/layers and bounded controls, not a fake professional NLE.
4. **Agent panel:** prompt, evidence/plan summary, proposed/accepted operation summary, follow-up thread, actionable errors.
5. **Preview/review:** proxy playback, verification warnings, before/after or revision switch, render controls.
6. **Jobs/activity:** status, progress, target, cancel action, failure reason, and retry rules.

## Draft transport types

These are conceptual wire contracts. Backend schemas are authoritative when Phase 7 stabilizes.

```ts
type ID = string;
type RevisionID = string;
type ExecutionTarget = "local" | "cloud";

interface CommandMeta {
  projectId: ID;
  baseRevisionId?: RevisionID;
  idempotencyKey: string;
}

interface CreateProjectRequest {
  name: string;
  brief?: { audience?: string; message?: string; targetDurationMs?: number };
}

interface ProjectSummary {
  id: ID;
  name: string;
  schemaVersion: 2;
  currentRevisionId: RevisionID;
  assetCount: number;
  durationMs: number;
  verification: "unknown" | "stale" | "passed" | "failed";
  updatedAt: string;
}

interface ImportAssetRequest extends CommandMeta {
  source: { kind: "local_token" | "upload_session"; ref: string };
  declaredFilename: string;
}

interface StartBrowserCaptureRequest extends CommandMeta {
  flowId: ID;
  approved: true;
  executionTarget: "local";
}

interface RequestAgentEditRequest extends CommandMeta {
  prompt: string;
  selectedAssetIds?: ID[];
  selectedClipIds?: ID[];
  threadId?: ID;
  preview: boolean;
}

interface ApplyOperationsRequest extends CommandMeta {
  operations: SemanticOperation[];
  actor: "user";
}

interface RenderRequest extends CommandMeta {
  kind: "preview" | "final";
  presetId: string;
  executionTarget: ExecutionTarget;
}

interface RecaptureRequest extends CommandMeta {
  assetId: ID;
  changedActionIds: ID[];
  reason: string;
  executionTarget: "local";
}

interface CommandAccepted {
  jobId: ID;
  acceptedAt: string;
}

interface ProjectSnapshot {
  project: ProjectView;
  currentRevisionId: RevisionID;
  availableActions: string[];
  capabilities: CapabilitySet;
}
```

Do not define `SemanticOperation` independently in frontend code. Generate or import it from the backend contract once stable. Early mocks may use only the operation summary fields the UI displays.

## Conceptual endpoints

Transport names may change; behavior should not.

| Command/query | Purpose |
|---|---|
| `POST /projects`, `GET /projects`, `GET /projects/:id` | Create, browse, and open projects |
| `POST /projects/:id/import-sessions` | Create a local-token or resumable upload session |
| `POST /projects/:id/assets:import` | Begin hash/probe/import job |
| `GET /projects/:id/assets/:assetId` | Read bounded asset/provenance/analysis view |
| `POST /projects/:id/browser-captures` | Start approved local capture |
| `POST /projects/:id/agent-edits` | Start planning/edit job |
| `POST /projects/:id/operations` | Apply bounded manual operations |
| `POST /projects/:id/verifications` | Verify current revision |
| `POST /projects/:id/renders` | Start preview/final render |
| `POST /projects/:id/recaptures` | Start selective browser recapture |
| `GET /projects/:id/revisions` | List attributable revision summaries |
| `GET /jobs/:jobId`, `DELETE /jobs/:jobId` | Read/cancel a job |
| `GET /events?projectId=...` | SSE/WebSocket event stream; choose one during Phase 7 |

All mutations require an idempotency key. Revision mutations also require `baseRevisionId`; `409 REVISION_CONFLICT` triggers snapshot refresh and a user-visible retry/review, never silent rebase.

## Job and event model

```ts
type JobState =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "succeeded"
  | "failed"
  | "cancelled";

type JobKind =
  | "asset_import"
  | "asset_analysis"
  | "browser_capture"
  | "agent_edit"
  | "verify_revision"
  | "render_preview"
  | "render_final"
  | "browser_recapture";

interface JobView {
  id: ID;
  projectId: ID;
  kind: JobKind;
  state: JobState;
  stage: string;
  progress?: { completed: number; total?: number; unit?: string };
  cancellable: boolean;
  result?: { revisionId?: RevisionID; assetId?: ID; outputId?: ID };
  error?: ReplexError;
  createdAt: string;
  updatedAt: string;
}

type ProjectEvent =
  | { type: "job.updated"; sequence: number; job: JobView }
  | { type: "revision.created"; sequence: number; revision: RevisionSummary }
  | { type: "verification.updated"; sequence: number; revisionId: ID; status: VerificationView }
  | { type: "asset.updated"; sequence: number; asset: AssetView }
  | { type: "output.created"; sequence: number; output: OutputView }
  | { type: "capabilities.updated"; sequence: number; capabilities: CapabilitySet };
```

Events are ordered per project and resumable from the last sequence if the transport supports it. Terminal job states never change. Cancellation is a request: show “cancelling” as presentation state while the canonical job remains `running`, then consume `cancelled` or another terminal result.

### Agent progress UX

Show truthful stages such as `inspecting_assets`, `planning`, `validating_operations`, `applying_revision`, `verifying`, and `rendering_preview`. Do not invent percentage precision when the backend only knows a stage. Surface evidence and accepted/rejected operation summaries after completion, not hidden chain-of-thought.

### Browser capture status UX

Before start, show the approved flow, target origin, local-only requirement, and credential/session warning. During capture, show current safe stage/checkpoint without exposing secrets. Distinguish user input required, app unreachable, checkpoint mismatch, prohibited action, timeout, and cancellation. Recapture UI must name the affected browser asset/scene and preview what remains preserved.

## Error model

```ts
interface ReplexError {
  code:
    | "VALIDATION_FAILED"
    | "REVISION_CONFLICT"
    | "CAPABILITY_UNAVAILABLE"
    | "ASSET_UNSUPPORTED"
    | "ASSET_CHANGED"
    | "UPLOAD_INTERRUPTED"
    | "STORAGE_FAILED"
    | "BROWSER_APPROVAL_REQUIRED"
    | "BROWSER_CAPTURE_FAILED"
    | "INSUFFICIENT_EVIDENCE"
    | "AGENT_BUDGET_EXCEEDED"
    | "OPERATION_REJECTED"
    | "VERIFICATION_FAILED"
    | "RENDER_FAILED"
    | "JOB_NOT_CANCELLABLE"
    | "EXECUTOR_OFFLINE"
    | "UNAUTHORIZED";
  message: string;
  retryable: boolean;
  fieldIssues?: Array<{ path: string; message: string }>;
  evidenceRefs?: string[];
  requiredCapability?: string;
}
```

UI rules:

- Validation errors stay next to the relevant control.
- Revision conflicts refresh and compare; never discard the user's prompt silently.
- Verification failure blocks final render but preserves preview/review access and lists actionable checks.
- Executor offline disables execution while preserving locally cached shell/navigation state.
- Retry only when `retryable` is true and reuse the same idempotency key for the same intent.
- Never display raw argv, stack traces, credentials, cookies, local absolute paths, or unrestricted storage references.

## Upload and local-first behavior

- In a desktop/loopback build, the UI should pass an authorized file token, not upload bytes through JavaScript when the local host can read the selected file safely.
- In hosted mode, use resumable multipart upload with explicit progress, cancellation, size/type preflight, server-side hash/probe, expiry, and orphan cleanup.
- Never trust browser MIME type, filename, duration, or dimensions as canonical.
- Large-file progress should distinguish transfer, hashing, probing, analysis, and import completion.
- A file is not an asset until backend import succeeds. Failed uploads/imports remain retryable sessions, not project state.
- Local projects must remain usable without network for non-agent operations if the local executor and required tools are available.

## Preview strategy

Use two levels:

1. **Immediate structural preview:** project snapshot, thumbnails/contact sheets, storyboard, and approximate playhead derived from canonical timing. Label it non-authoritative.
2. **Rendered proxy preview:** low-cost backend render tied to a revision and RenderJob. This is the review surface for timing/effects. Invalidate it visibly when a later revision is current.

Final export requires current verification and a final render. Do not attempt a second browser-only renderer that could drift from backend semantics.

## Revision/history UX

Each revision row shows actor (`user`, `agent`, `recapture`, `migration`), timestamp, intent summary, operation summary, verification state, and available outputs. Users may inspect or preview an old revision; reverting creates a new attributable revision rather than moving/deleting history. Recapture revisions should show predecessor/replacement provenance and preservation result.

## Mocking plan

Gurbaaz can start immediately with generated fixtures for:

- project list/open and one `ProjectSnapshot`;
- empty/importing/analyzing/ready/failed asset states;
- browser and uploaded asset cards with distinct provenance;
- agent job stages and accepted/rejected operation summaries;
- storyboard, stale/current proxy preview, verification failures;
- revision history and job cancellation states;
- local executor offline/capability missing;
- responsive and keyboard flows.

Mock at the service contract boundary, not inside components. Use deterministic fixtures and a fake event stream with monotonic sequence numbers.

Wait for backend stabilization before:

- generating/importing `SemanticOperation` types;
- wiring real file tokens or resumable upload sessions;
- assuming event transport or reconnect semantics;
- rendering exact manual controls from capability schemas;
- enabling local/cloud selection;
- implementing preview asset URL lifetime/caching rules;
- promising browser capture steps or editable provenance fields.

## Frontend acceptance checklist

- One workspace supports both capture and upload entry points.
- No component writes or persists canonical project JSON.
- Every mutation sends `baseRevisionId` and idempotency key.
- Job, empty, offline, cancelled, conflict, unsupported, verification-failed, and partial-upload states are designed.
- Keyboard/focus/accessibility behavior covers all core actions.
- Large files do not enter global client state and object URLs are released.
- Preview labels clearly distinguish structural, proxy, stale, and final output.
- Browser credentials/session data never appear in client logs or persisted UI state.
- The UI never claims a documented backend capability is implemented until advertised by runtime capabilities.
