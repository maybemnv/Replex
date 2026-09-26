# ADR-011: Keep the local executor single-owner and transport-bounded

- **Status:** Accepted for the V2 POC
- **Date:** 26 September 2026

## Context

The service contract and canonical V2 reducer predate a running local service. The POC needs a usable transport without adding a database, allowing multiple writers to race over file-backed revisions, or exposing backend commands to the frontend.

## Decision

- Use loopback HTTP/JSON for the local daemon. Bind only `127.0.0.1`, require a random bearer token, allow only explicit local origins, validate `Host`, and bound request/response sizes and HTTP timeouts.
- Derive one fixed port from the canonical workspace path. The daemon and one-shot command CLI acquire the same listener before starting the runtime, so only one supported service process owns a workspace. Process-local project/job locks are sufficient for that boundary. Direct store/runtime modules remain internal; this is not a general multi-process lock.
- Route HTTP commands and the one-shot CLI through the same typed executor dispatcher. The CLI and daemon are mutually exclusive for one workspace while both use the fixed listener.
- Keep local file selection as a separately versioned host-only bridge outside `ServiceCommand` and agent tools. `LocalImportAuthorizationRequestV1Schema`/`ResponseV1Schema` describe the loopback route; it accepts one selected path only beneath startup-configured import roots, holds an authorized file handle behind an opaque process-bound token, and returns only token, filename, and byte count. The one-shot CLI authorizes and imports within the same process. Paths and session credentials never enter canonical project state or model-facing messages.
- Persist project snapshots, revision history, operation records, jobs, idempotency keys, and ordered events under the local workspace using atomic file replacement. Apply jobs consume only typed operations and call the canonical reducer.
- Serialize import and mutation jobs per workspace. On restart, reconcile a queued import against the committed operation log; recover a published canonical import, or fail an uncommitted import as `UPLOAD_INTERRUPTED` when its process-bound source handle is gone.
- Export explicit v1 transport response schemas for service errors and event pages. Event pages carry `latestSequence`, `hasMore`, and `cursorExpired`; callers reopen a snapshot when their retained event cursor expired. Existing project, operation, job, and event shapes remain unchanged.
- Advertise only supported capabilities: project create/open, `apply_operations`, `asset_import`, and cancellation. Local import supports uploaded video, image, and audio. Evidence, agent, browser, verification, and render jobs are not available through this runtime yet.

## Consequences

The local command and HTTP paths share semantics while preserving the frozen canonical model and reducer. Restart recovery is valid only after the previous supported owner releases the workspace port. A second runtime for the same workspace fails closed. Import handles cannot survive process restart: a committed import is reconciled through its revision operation; an import that had not committed requires the host to reselect the file and submit a new attempt. Fixed-port collisions between different workspaces are reported as executor-offline and require selecting a different workspace path; configurable port overrides are intentionally absent from the supported interface.

Queued jobs can be cancelled before dispatch. A running semantic edit or import is non-cancellable through the job API after dispatch; orderly runtime shutdown aborts the active import and cleans staging data. This POC slice does not claim multiple-process safety, evidence/agent/render orchestration, or production daemon supervision.

## Rejected alternatives

- Add SQLite or a hosted database for local project discovery and job state.
- Allow independent processes to write the same workspace under only process-local locks.
- Expose arbitrary shell, FFmpeg arguments, filesystem paths, or mutable project JSON through the service.
- Add SSE/WebSocket delivery before event polling/replay has proven sufficient.
