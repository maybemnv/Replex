# Replex V2 frontend handoff for Gurbaaz

**Status:** PR-A through PR-D are merged to `main` at `2dc4035`. Frozen V2-104 service-contract v1 types and mock fixtures remain unchanged. PR-C adds a bounded V2 agent library and injected-client OpenAI Responses adapter; deterministic Gate C passed, but no live model call was made and the agent is not wired into a frontend transport or runtime service. PR-D's bounded local composition preview passed technical validation without changing service-contract v1. V2-150 remains PARTIAL-GO research; Phase 4 did not adopt ffmpeg-skill. Phase 6 V2-601 selected FFmpeg behind a separate `MotionBackend` boundary for two candidates; V2-602 has an unmerged `camera-push.v1` implementation candidate with a verified local motion-to-composition preview and same-thread follow-up. Gate D remains open pending independent review and human visual/quality approval. See the [motion spike report](motion-spike-report.md).

**Backend source of truth:** [`../architecture/REPLEX_V2.md`](../architecture/REPLEX_V2.md) for architecture and [`../../src/service-contract/index.ts`](../../src/service-contract/index.ts) for transport-independent schemas/types

**Contract/discovery decision:** [`../architecture/ADR-007-service-contract-v1.md`](../architecture/ADR-007-service-contract-v1.md)

**Contract timing:** Gurbaaz can mock against the frozen V2-104 wire v1 types and fixtures. HTTP/SSE/WebSocket, job scheduling, executors, and runtime capability reporting remain later work (Phase 7).

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

The UI may display storyboard/timeline views, but it is never the canonical project store. It renders server snapshots and sends revision mutations with `baseRevisionId`. Optimistic display must reconcile to the accepted revision event; the frontend does not patch project JSON.

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


## Stable service contract (V2-104)

The transport-independent request, response, view, capability, job, event, and error schemas with inferred TypeScript types are maintained in [`src/service-contract/index.ts`](../../src/service-contract/index.ts). These are explicit wire v1 projections, independent of the evolving V2 domain schemas; new external shapes require a deliberate service-contract version evolution. Deterministic Gurbaaz examples are in [`src/service-contract/fixtures.ts`](../../src/service-contract/fixtures.ts). Import these sources instead of declaring parallel frontend contract types.

Create requests carry contract version and idempotency metadata before a project ID exists. Open requests use the host-supplied project ID and pin snapshots to a concrete revision. Mock capability values are examples for frontend states; only a live runtime capability response describes backend support.

### Project identity and local discovery

Contract v1 has no `list_projects`/`attach_project` command and introduces no database. The local host shell lists only authorized project roots, validates the selected project manifest, and supplies its `projectId` and current `revisionId` to `open_project`; `create_project` returns the new ID. The service contract receives IDs, not host paths or local tokens. A mocked project list is host-shell fixture data, not a service endpoint.

HTTP endpoints, event delivery/reconnect behavior, executors, and process supervision remain later implementation work (Phase 7).

## Agent progress UX

Show truthful stages such as `inspecting_assets`, `planning`, `validating_operations`, `applying_revision`, `verifying`, and `rendering_preview`. Do not invent percentage precision when the backend only knows a stage. Surface evidence and accepted/rejected operation summaries after completion, not hidden chain-of-thought.

## Browser capture status UX

Before start, show the approved flow, target origin, local-only requirement, and credential/session warning. During capture, show current safe stage/checkpoint without exposing secrets. Distinguish user input required, app unreachable, checkpoint mismatch, prohibited action, timeout, and cancellation. Recapture UI must name the affected browser asset/scene and preview what remains preserved.


## Job, input, and error UX

Use the typed job, input, and error views from the service contract. A waiting job includes its input request; stale input ends as a failed terminal job and clears the pending request. Credential actions refer to an executor-owned secure flow and contain no secret values.

UI rules:

- Validation errors stay next to the relevant control.
- Revision conflicts refresh and compare; do not discard the prompt silently.
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

## Frontend work sequencing

### Stable enough to mock now

Gurbaaz can start immediately with generated fixtures for:

- host-provided project selection/open and one `ProjectSnapshot`;
- empty/importing/analyzing/ready/failed asset states;
- browser and uploaded asset cards with distinct provenance;
- agent job stages and accepted/rejected operation summaries;
- storyboard, stale/current proxy preview, verification failures;
- revision history and job cancellation states;
- local executor offline/capability missing;
- responsive and keyboard flows.

This includes the project shell, asset browser, browser/upload source cards,
prompt/agent panel, job state UI, storyboard, revision history, verification
states, preview lifecycle, conflict handling, capability/offline states, and a
typed mock event stream. Mock at the backend-owned service-contract boundary,
not inside components. Use deterministic fixtures and a fake event stream with
monotonic sequence numbers.

### Frozen wire v1 snapshot in this milestone

- [Service contract schemas and types](../../src/service-contract/index.ts)
- [Deterministic service contract fixtures](../../src/service-contract/fixtures.ts)
- [Service contract tests](../../tests/service-contract.test.ts)
- [ffmpeg-skill spike and PARTIAL-GO decision](ffmpeg-skill-spike.md) (research only; no runtime dependency or backend adapter)


### Requires backend implementation later

Use the finalized contract types now; wait for a live backend before:

- wiring commands to a live service;
- wiring real file tokens or resumable upload sessions;
- assuming event transport or reconnect semantics;
- rendering exact manual controls from capability schemas;
- enabling local/cloud selection;
- implementing preview asset URL lifetime/caching rules;
- promising browser capture steps or editable provenance fields.

Also defer real asynchronous transport, process supervision, local executor
restart/recovery, cloud targets, real upload tokens, and backend-specific
motion controls until those services advertise the corresponding capabilities.

### Do not assume yet

- that ffmpeg-skill has been adopted rather than evaluated;
- that any motion preset is implemented or advertised by the current runtime;
- that Remotion has been adopted;
- that cloud rendering or authenticated cloud browser capture exists;
- that an operation or capability in schemas or mock fixtures is implemented merely
  because it appears in a schema or fixture; read capabilities from the live runtime.

## Frontend acceptance checklist

- One workspace supports both capture and upload entry points.
- No component writes or persists canonical project JSON.
- Every revision mutation sends `baseRevisionId`; every command sends an idempotency key.
- Job, empty, offline, cancelled, conflict, unsupported, verification-failed, and partial-upload states are designed.
- Keyboard/focus/accessibility behavior covers all core actions.
- Large files do not enter global client state and object URLs are released.
- Preview labels clearly distinguish structural, proxy, stale, and final output.
- Browser credentials/session data never appear in client logs or persisted UI state.
- The UI never claims a documented backend capability is implemented until advertised by runtime capabilities.
