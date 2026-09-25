# Replex V2 dependency-ordered implementation plan

**Status:** V2 Core Foundation and the PR-A candidate are implemented. Gate A passed independent validation on `e38b792`; PR-A is ready to open, not merged. Phase 2 has not started and remains gated on PR-A merge and Gate B.

**PR-A validation (25 September 2026):** `npm run build` passed. The serial full suite passed 26 files / 193 tests (10 skipped) with direct FFmpeg/FFprobe 9.0.1 binaries supplied through `REPLEX_FFMPEG_PATH` and `REPLEX_FFPROBE_PATH`. Without those overrides, this environment's inaccessible WinGet links caused 17 FFmpeg-dependent failures across five capture/browser files (166 passed, 10 skipped); rerunning with direct binaries resolved them. Independent validation passed; no GitHub CI result was available during this review.

**Architecture:** [`../architecture/REPLEX_V2.md`](../architecture/REPLEX_V2.md)

**Product gates:** [`../REPLEX_V2_PRD.md`](../REPLEX_V2_PRD.md)

Each task starts with a failing contract/regression check, makes the smallest change through existing boundaries, and records evidence. A checked engineering task never implies product or production approval.

## Phase 0: Freeze V1 and specify migration

### V2-001: Freeze the V1 compatibility contract

**Implementation status:** Implemented and tested.

- **Objective:** Preserve a parseable V1 schema, golden projects, operation replay, render metadata, and recapture lineage as an explicit compatibility boundary.
- **Why:** V2 cannot safely evolve while V1 behavior is implicit in mutable modules.
- **Dependencies:** Backup branch `origin/backup/pre-replex-v2-2026-09-19`; integrated baseline `82b4928`.
- **Likely files:** `src/schema.ts`, new `src/schema-v1.ts`, `src/project.ts`, `tests/golden/project-v1.json`, compatibility tests.
- **Contracts:** `ProjectV1`, `parseProjectV1`, frozen operation names and semantic-hash projection.
- **Migration concerns:** Preserve unknown-version rejection; do not loosen V1 strictness or edit the golden fixture to make tests pass.
- **Tests:** Load/replay golden V1; verify hashes, stable IDs, output references, and lineage; render compatibility fixture when media tools exist.
- **Acceptance:** The frozen parser reads current projects and rejects changed/unknown V1 shapes; current V1 suite remains green.
- **Non-goals:** V2 types, media import, cleanup refactors.
- **Rollback:** Revert extraction; the pre-V2 branch remains executable.

### V2-002: Specify migration fixtures and semantic equivalence

**Implementation status:** Implemented and tested.

- **Objective:** Define V1-to-V2 field mapping and an evidence report before implementing the adapter.
- **Why:** Migration correctness needs a measurable oracle, not visual inspection.
- **Dependencies:** V2-001.
- **Likely files:** `Docs/architecture/REPLEX_V2.md`, `tests/golden/`, new migration fixture manifest.
- **Contracts:** `MigrationReport` with source hash/version, destination hash/version, preserved-ID list, warnings, and semantic comparisons.
- **Migration concerns:** V1 flow becomes optional V2 browser context; captures become browser assets; scenes become clips; overlays become layers.
- **Tests:** Table-driven mapping expectations including predecessor lineage and unrelated edits.
- **Acceptance:** Every V1 field has a destination, deliberate omission, or derived rule; no ambiguous mapping remains.
- **Non-goals:** Writing migrated projects.
- **Rollback:** Documentation/fixtures only.

## Phase 1: Project Schema V2 and one reducer

### V2-101: Introduce strict V2 schemas

**Implementation status:** Implemented and tested.

- **Objective:** Add `MediaAsset`, provenance unions, `Composition`, tracks, clips, layers, keyframes, outputs, verification references, and `ProjectV2`.
- **Why:** Uploaded media must be represented without browser fiction.
- **Dependencies:** V2-002.
- **Likely files:** new `src/schema-v2.ts`; shared scalar schemas extracted only where both versions require them; `tests/schema-v2.test.ts`.
- **Contracts:** Structures in `REPLEX_V2.md`; integer milliseconds; project-relative path or authorized object reference; strict discriminated unions.
- **Migration concerns:** Stable V1 scene IDs become clip IDs when valid. Browser fields remain under browser provenance/context.
- **Tests:** Valid browser/upload/image/audio projects; broken refs, duplicate IDs, invalid timing, invalid provenance, path escape, unsupported property/keyframe rejection.
- **Acceptance:** Strict parsing catches all cross-reference and timing invariants without requiring browser data for uploads.
- **Non-goals:** Persistence, operations, backend execution, multiple arbitrary tracks.
- **Rollback:** V1 parser remains untouched and selectable by version.

### V2-102: Implement read compatibility and explicit migration

**Implementation status:** Implemented and tested.

- **Objective:** Load V1 as an in-memory V2 view and add an explicit non-destructive migration command.
- **Why:** Old projects must remain usable without eager rewrite.
- **Dependencies:** V2-101.
- **Likely files:** `src/project.ts`, new `src/migrate.ts`, `src/cli.ts`, `tests/migrate.test.ts`.
- **Contracts:** `loadProject` version dispatch; pure `adaptV1ToV2`; `migrate-project --to 2 --output <new-root>`; `MigrationReport`.
- **Migration concerns:** Never overwrite source; copy/link immutable assets safely; validate before publish; retain source manifest hash and backup location.
- **Tests:** Golden adaptation, repeatability, interrupted write, destination collision, unsupported version, semantic equivalence, Windows paths.
- **Acceptance:** Opening V1 causes no write; explicit migration produces a valid V2 project and report while leaving every V1 byte unchanged.
- **Non-goals:** V2-to-V1 conversion, dual write.
- **Rollback:** Continue opening the original V1 root with the V1 renderer.

### V2-103: Add the V2 semantic reducer

**Implementation status:** Implemented and tested.

- **Objective:** Implement the initial operation vocabulary through one pure, atomic reducer used by humans and models.
- **Why:** One mutation path is the central safety and replay invariant.
- **Dependencies:** V2-101; V2-102 for migrated fixtures.
- **Likely files:** new `src/operations-v2.ts`; operation schemas in `src/schema-v2.ts`; `tests/operations-v2.test.ts`.
- **Contracts:** Initial operations listed in `REPLEX_V2.md`; batch `{baseRevisionId, actor, intentId, evidenceRefs, operations}`.
- **Migration concerns:** V1 operation history remains historical; migrated state starts with a migration revision linked to the source report.
- **Tests:** One focused case per operation plus stale base, atomic rollback, replay hash, dependent-layer removal, bounds/collision, recapture preservation.
- **Acceptance:** Accepted batches create exactly one revision; rejected batches change no state or log; replay yields the same semantic hash.
- **Non-goals:** Agent changes, UI, arbitrary expressions, renderer details.
- **Rollback:** Keep V1 reducer for V1 roots; no shared write path.

### V2-104: Stabilize the early transport-independent service contract

**Implementation status:** PR-A freezes explicit service-contract v1 projections and boundary tests. Independent validation met Gate A at `e38b792`; see the PR-A validation record above.

- **Objective:** Define versioned, backend-owned schemas for `ProjectSnapshot`, `ProjectSummary`, `CapabilitySet`, asset/revision views, jobs, events, errors, command metadata, agent edits, operation application, render, browser capture, and recapture.
- **Why:** Gurbaaz and later executors need one contract before HTTP, event transport, or worker implementation exists.
- **Dependencies:** V2-101 and V2-103.
- **Likely files:** new `src/service-contract/` or generated schema artifact; contract fixtures and tests; architecture/frontend handoff references.
- **Contracts:** Revision-mutating commands require `baseRevisionId`; derived jobs reference an immutable `revisionId`; every request has an idempotency key and explicit contract version.
- **Version boundary:** Public views and the user-facing semantic-operation snapshot are defined by service-contract v1 schemas, not live `ProjectV2` or reducer unions. Import and recapture use their service commands; all edit operations still pass through the canonical reducer. External shape changes require a deliberate contract version evolution.
- **Migration concerns:** This is a read/contract addition only; V1 command routing remains unchanged and version bumps are explicit.
- **Tests:** Strict request/response parsing, discriminated job/input/error states, stale-revision metadata, unknown-version rejection, deterministic fixture serialization.
- **Acceptance:** Frontend mocks can import or generate these types without inventing project state or transport semantics; no HTTP/SSE/WebSocket or executor is required.
- **Non-goals:** Network transport, process supervision, cloud infrastructure, or runtime job scheduling.
- **Rollback:** Keep the contract artifact versioned and unused; existing CLI behavior is unaffected.

## Phase 1.5: Evaluate ffmpeg-skill before duplicating media plumbing

### V2-150: Run the ffmpeg-skill capability and contract spike

**Implementation status:** Completed and independently reviewed; decision is **PARTIAL-GO**. Evidence and capability recommendations are in [`ffmpeg-skill-spike.md`](ffmpeg-skill-spike.md); no production adapter or dependency was added.

- **Objective:** Evaluate one released, pinned ffmpeg-skill version and contract version in an isolated research harness and produce a GO/NO-GO/PARTIAL-GO report.
- **Why:** Probe, contact sheets, scene measurements, cuts, audio analysis, and delivery checks may be cheaper and safer to delegate than to reimplement.
- **Dependencies:** V2-104 and ADR-004 acceptance rules; no production adapter.
- **Likely files:** research report, capability matrix, contract snapshots, synthetic-media fixtures; no runtime dependency required.
- **Contracts:** Map each candidate capability to input/output/error/verification shape; record raw-FFmpeg leakage, overhead, platform support, cancellation, timeout, path containment, and native parity.
- **Migration concerns:** No canonical state or project migration; do not install/vendor the dependency in this spike.
- **Tests:** Static contract snapshot, version/license provenance, doctor/capability output, dry runs, failure/timeout/cancellation probes, path-containment checks.
- **Acceptance:** Written report names the pinned versions, cleanly mapped capabilities, gaps, ownership split, measured overhead, and whether adoption is cheaper than the native subset.
- **Non-goals:** Full MCP exposure, production adapter, canonical ffmpeg-skill project files, or changing the native backend.
- **Rollback:** Delete isolated spike artifacts; repository runtime remains unchanged.

**Approved future read-only evidence subset:** `probe`, `look`/contact sheets, `scenes`, `silence --list`, `loudness --measure-only`, and `check`. This is an internal Phase 2 provider study, not approval for an agent-facing tool surface or the Phase 4 production adapter.

## Phase 2: Local media ingestion and baseline render

Phase 2 starts only after PR-A passes Gate A. The PARTIAL-GO permits a small internal, read-only `MediaEvidenceProvider` study if it helps V2-202. It may use only the approved V2-150 subset, pinned-version capability checks, authorized asset handles, private Replex staging/evidence roots, strict known-JSON parsing, command-field stripping, and owned deadlines. It never mutates canonical state. Keep a native provider/fallback; ffmpeg-skill availability is not required for product operation. This provider is not `FfmpegSkillBackend` and adds no public service command.

### V2-201: Import immutable local assets

- **Objective:** Import video/image/audio by copy, hash, probe, and atomic asset registration.
- **Why:** Uploaded media is the first new source type and trust boundary.
- **Dependencies:** V2-103; V2-150 for analysis/render capability selection.
- **Likely files:** new `src/ingest.ts`, `src/media-store.ts`; `src/cli.ts`; tests.
- **Contracts:** `ImportAssetRequest`, `ImportResult`, typed import errors; `import_asset` only after file persistence and probe succeed.
- **Migration concerns:** Deduplicate by hash without merging provenance records; never mutate originals.
- **Tests:** video/image/audio, duplicate content, corrupt/unsupported media, changed source during import, path escape, disk failure, cancellation cleanup.
- **Acceptance:** Imported source is immutable, hash-matched, probed, project-scoped, and attributable; failure leaves no canonical asset.
- **Non-goals:** Remote URLs, cloud upload, transcoding on import.
- **Rollback:** Remove unreferenced staged artifact; canonical revision remains unchanged on failure.

### V2-202: Produce deterministic bounded media evidence

- **Objective:** Generate versioned shot ranges, selected frames/contact sheets, motion/audio measurements, and optional transcript references.
- **Why:** Models need compact evidence rather than full video context.
- **Dependencies:** V2-201, the PR-A/Gate A pass, and V2-150's bounded PARTIAL-GO; retain the native path unless the approved read-only provider is measurably cheaper or safer.
- **Likely files:** new `src/analyze.ts`, `src/evidence.ts`, inspection extensions; tests and small media fixtures.
- **Contracts:** Internal `MediaEvidenceProvider` methods `probe`, `contactSheet`, `scenes`, `silence`, `loudness`, and `check`; versioned `MediaEvidenceIndex` with per-artifact hashes, generator/config version, and source hash. The provider returns evidence only; it cannot write operations or revisions.
- **Migration concerns:** Derived evidence is regenerable and must not change asset identity.
- **Tests:** deterministic fixture outputs/tolerances, silent/no-audio media, variable frame rate, invalidation after source mismatch, evidence size limits.
- **Acceptance:** The same source/config produces equivalent indexed evidence; inspection can request bounded subsets.
- **Non-goals:** Full semantic understanding, mandatory transcription, model calls.
- **Rollback:** Delete/rebuild derived evidence index; source and project remain valid.

### V2-203: Render a basic uploaded-video composition

- **Objective:** Extend the native backend to render one uploaded clip with trim, speed, transform/crop, opacity, and audio gain.
- **Why:** Prove V2 state can reach deterministic media before agent or new dependency work.
- **Dependencies:** V2-103, V2-201, and V2-150.
- **Likely files:** new V2 RenderJob planner or versioned extension in `src/render.ts`; `src/verify.ts`; render tests.
- **Contracts:** planner-produced immutable `MediaExecutionJob` from a frozen revision; authorized `AssetHandle`/execution context; `RenderArtifact` output requirements and provenance.
- **Migration concerns:** Keep V1 RenderJob parsing/execution unchanged.
- **Tests:** dry plan hash, real FFmpeg fixture, stale revision, missing asset, duration/probe/decode, unsafe path, cancellation/partial output.
- **Acceptance:** A V2 project renders reproducibly, records backend/tool versions and hashes, and cannot render without successful current-revision verification.
- **Non-goals:** Production ffmpeg-skill adapter, captions, multi-asset, motion; the native path is only a baseline while the capability decision is measured.
- **Rollback:** Native V2 feature flag/command can be disabled without affecting V1.

## Phase 3: Multimodal inspection and conversational edits

### V2-301: Add bounded V2 inspection tools

- **Objective:** Expose project, asset, clip, frames, contact sheet, transcript, audio, browser provenance, and verification views.
- **Why:** Ground planning while controlling privacy, context, and cost.
- **Dependencies:** V2-202.
- **Likely files:** `src/inspect.ts` or `src/inspect-v2.ts`, schemas, tests.
- **Contracts:** scoped requests with pagination/count/byte limits; redacted evidence references.
- **Migration concerns:** Browser inspections work for adapted V1 and native V2 browser assets.
- **Tests:** bounds, missing/stale evidence, redaction, unsupported asset types, deterministic summaries.
- **Acceptance:** No tool returns raw project files, secrets, unrestricted paths, or unbounded frames/transcripts.
- **Non-goals:** Editing and model provider changes.
- **Rollback:** Disable individual inspection capabilities without changing projects.

### V2-302: Extend the agent loop to V2 operations

- **Objective:** Let one model inspect, propose typed V2 operations, verify, preview, and respond to follow-up intent against the current revision.
- **Why:** Conversational editing is useful only if it preserves canonical state and grounding.
- **Dependencies:** V2-103, V2-203, V2-301.
- **Likely files:** `src/agent.ts` or versioned dispatcher, CLI command, tests.
- **Contracts:** provider-neutral model seam; tool allowlist; base revision; intent/thread ID; bounded passes/calls/time/cost.
- **Migration concerns:** V1 agent command remains available for V1 projects during transition.
- **Tests:** recorded tool transcripts, stale follow-up, invalid operation, insufficient evidence, retry budget, same-project revision continuity, no direct state/shell access.
- **Acceptance:** Two prompts produce two attributable revisions on one uploaded project and a valid preview; replay matches.
- **Non-goals:** autonomous long-running agent, multiple agents, unrestricted chat history.
- **Rollback:** Reopen last accepted revision; failed model sessions create no mutation.

## Phase 4: Chosen media backend adapter

### V2-401: Integrate only the approved read-only evidence subset

- **Objective:** If Phase 2 evidence shows an advantage, wrap only the approved V2-150 read-only evidence subset behind authorized handles and Replex-owned staging.
- **Why:** Reuse bounded measurements without ceding editing or verification semantics.
- **Dependencies:** V2-203 baseline and Phase 2 parity evidence. V2-150 PARTIAL-GO alone does not authorize a runtime adapter.
- **Likely files:** a narrow evidence adapter and tests; no general execution registry unless a second backend requires it.
- **Contracts:** `probe`, `look`, `scenes`, `silence --list`, `loudness --measure-only`, and `check`; pinned capability handshake, strict result parsing, safe error mapping.
- **Migration concerns:** Outputs record backend; projects do not.
- **Tests:** read-only native parity, timeout/cancel, missing capability, changed input, malformed JSON, bounded output, path containment, no command-field exposure.
- **Acceptance:** Only approved evidence results pass through the adapter; source/job data remain read-only and the native provider stays available.
- **Non-goals:** Mutating media execution, every ffmpeg-skill tool, canonical MCP, backend access to mutable project state, automatic fallback after partial execution. Any mutating capability requires a separate parity test, architecture review, and allowlist extension.
- **Rollback:** Select native backend; preserve adapter-produced outputs as historical artifacts.

## Phase 5: Richer 2D composition

### V2-501: Add audio, overlays, captions, transitions, reframing, and basic multi-asset

- **Objective:** Support the minimum launch-video composition beyond a single clip.
- **Why:** Prove a useful edit, not a transcoding demo.
- **Dependencies:** V2-401 GO/PARTIAL-GO or explicit native-backend decision.
- **Likely files:** V2 schemas/operations/planner, selected backend adapter, verification and tests.
- **Contracts:** one primary video track, bounded B-roll/video overlay, audio track, typed caption/text/image layers, allowlisted transitions.
- **Migration concerns:** Schema additions must be optional/defaulted or require a schema minor migration policy chosen before release.
- **Tests:** timing overlaps, audio mix/gain, missing fonts/assets, caption bounds, transition duration, portrait/landscape reframing, multi-asset replay.
- **Acceptance:** A two-video, one-audio, captioned project previews and exports with deterministic timing and verified delivery properties.
- **Non-goals:** Unlimited tracks, nested sequences, advanced color/effect graphs.
- **Rollback:** Revert revision; older readers fail explicitly on unsupported schema/capability, never silently drop layers.

## Phase 6: Programmable motion

### V2-601: Evaluate and choose a motion backend

- **Objective:** Spike Remotion and at most one simpler alternative against two representative presets.
- **Why:** Select with evidence while keeping the canonical schema independent.
- **Dependencies:** Phase 5; legal review of Remotion's current special license.
- **Likely files:** isolated prototypes and `Docs/v2/motion-spike-report.md`.
- **Contracts:** `MotionExecutionJob`, preset parameters, deterministic seed/font/asset rules, intermediate output contract.
- **Migration concerns:** None until a backend is selected; preset IDs must be Replex-owned.
- **Tests:** repeat render hash/tolerance, performance, alpha/intermediate compatibility, cancellation, missing assets/fonts, license/cost record.
- **Acceptance:** GO/NO-GO names the backend, supported presets, limits, license obligations, and fallback.
- **Non-goals:** After Effects clone, editor UI, arbitrary React/WebGL code.
- **Rollback:** Spike stays non-canonical.

### V2-602: Implement versioned motion presets

- **Objective:** Deliver a small reusable set, starting with the strongest one or two effects rather than all candidates.
- **Why:** Maximize visible POC evidence per rupee.
- **Dependencies:** V2-601 GO.
- **Likely files:** `src/backends/motion-*`, preset registry/schema, RenderJob compositor, fixtures/tests.
- **Contracts:** `apply_motion_preset`; allowlisted parameters; preset ID/version; expanded canonical keyframes where feasible.
- **Migration concerns:** Existing preset instances retain version; upgrades are explicit operations.
- **Tests:** parameter bounds, repeatability, preview/export agreement, intermediate mux, backend absence, visual regression frames.
- **Acceptance:** Agent applies a preset through the reducer and produces a human-reviewed polished output without backend code in project state.
- **Non-goals:** All eight candidate effects, arbitrary 3D scenes, user scripting.
- **Rollback:** Remove preset operation/revert revision; media-only render remains valid when composition does not require motion.

## Phase 7: Local executor and transport implementation

### V2-701: Implement transport over the early service contract

- **Objective:** Expose the already-stabilized typed commands/jobs/events through a local loopback/service transport without duplicating CLI orchestration.
- **Why:** Frontend and future cloud need stable behavior independent of transport.
- **Dependencies:** V2-104; stable Phases 1-3 contracts; backend interfaces from Phase 4/6 as applicable.
- **Likely files:** new `src/service/`, orchestration extracted from `src/cli.ts`, API schemas and tests.
- **Contracts:** commands in `REPLEX_V2.md`; job states `queued|running|waiting_for_input|succeeded|failed|cancelled`; monotonic events.
- **Migration concerns:** V1 commands remain version-routed or explicitly unsupported per command.
- **Tests:** idempotency, stale revision, duplicate request, progress order, cancellation, restart recovery policy, sanitized errors.
- **Acceptance:** CLI and loopback transport call the same service functions and produce the same revision hashes.
- **Non-goals:** Redesigning domain contracts, public internet API, accounts, cloud queue.
- **Rollback:** CLI can continue calling service functions in-process.

### V2-702: Implement the local executor

- **Objective:** Run analysis, agent, capture, preview, render, and recapture as cancellable local jobs.
- **Why:** Prevent long work from blocking the frontend and establish the cloud contract locally.
- **Dependencies:** V2-701.
- **Likely files:** `src/executors/local.ts`, job store/event stream, tests.
- **Contracts:** immutable job envelope, capability report, artifact/result references, cancellation token.
- **Migration concerns:** Existing CLI outputs remain readable; executor adds job metadata, not new canonical edits.
- **Tests:** concurrent read jobs, serialized project mutations, crash/restart policy, cancellation/cleanup, tool absence, resource limit.
- **Acceptance:** Supported local jobs report progress and terminate in one explicit final state without corrupting projects.
- **Non-goals:** Distributed scheduling, production daemon supervision.
- **Rollback:** Run commands synchronously through existing CLI compatibility path.

## Phase 8: Optional cloud media rendering

### V2-801: Build an isolated media-only cloud spike

- **Objective:** Demonstrate the same RenderJob on an isolated worker with object-backed assets if budget and local gates allow.
- **Why:** Test portability and cost without accepting browser credential risk.
- **Dependencies:** V2-702; local POC evidence complete; explicit spend approval.
- **Likely files:** separate deploy package/IaC, cloud executor adapter, security/cost report.
- **Contracts:** signed/authorized object refs, job envelope, progress/results, quotas, expiry, cancellation.
- **Migration concerns:** No cloud-only canonical fields; local export/import remains possible.
- **Tests:** tenant/path isolation, tampered job/hash, egress denial, timeout/cancel, retry/idempotency, cost cap, result verification.
- **Acceptance:** One uploaded-media job matches local semantics and returns verified output with measured cost/time.
- **Non-goals:** Cloud browser capture, accounts/billing, autoscaling production service.
- **Rollback:** Disable cloud target; local projects and executor remain complete.

## Phase 9: Mixed media and selective recapture

### V2-901: Prove end-to-end mixed composition preservation

- **Objective:** Combine browser and uploaded assets, then selectively recapture one browser asset without changing unrelated clips, layers, audio, keyframes, or uploads.
- **Why:** This is the V2 expression of Replex's differentiated capability.
- **Dependencies:** Phases 1, 2, 5, and stable browser V1 compatibility; Phase 6 only if motion is included in the fixture.
- **Likely files:** capture/reconcile V2 adapter, preservation projection, integration fixtures/tests, evidence report.
- **Contracts:** `recapture_browser_asset` request plus `replace_browser_capture` mutation and lineage; explicit incompatibility result when retained ranges no longer fit.
- **Migration concerns:** Adapted V1 and native V2 browser assets use the same lineage semantics.
- **Tests:** affected asset replacement, unrelated semantic hash, retained upload hash, overlay/audio/motion preservation, incompatible duration, stale base, failed capture.
- **Acceptance:** A verified before/after pair proves only intended browser-derived state changed and no manual manifest repair occurred.
- **Non-goals:** Automatic recapture of arbitrary uploads, cloud authenticated capture.
- **Rollback:** Revert to predecessor revision and immutable predecessor asset.

## Phase 10: Evidence gate before production hardening

### V2-1001: Run the formal V2 POC evaluation

- **Objective:** Measure engineering validity, usefulness, correction time, spend, and intervention against `REPLEX_V2_PRD.md`.
- **Why:** Architecture and demos do not authorize production.
- **Dependencies:** Required local phases and V2-901; optional phases reported separately.
- **Likely files:** versioned evaluation schema/reports under ignored work storage; status update in docs after human review.
- **Contracts:** immutable run rows, artifact completeness validator, `PASS|FAIL|REWORK`, always explicit `productionAuthorized`.
- **Migration concerns:** Include at least one real V1 migration and rollback rehearsal.
- **Tests:** evaluator rejects missing artifacts, contradictory claims, absent human reviews, and threshold editing.
- **Acceptance:** Gate decision links complete technical and human evidence, actual spend, limitations, and next decision.
- **Non-goals:** Production implementation, scaling, deployment, billing.
- **Rollback:** Not applicable; retain failed/rework evidence.

### V2-1002: Write a production proposal only after the gate

- **Objective:** Convert proven constraints into a separately approved production plan.
- **Why:** Avoid carrying speculative POC infrastructure forward.
- **Dependencies:** V2-1001 PASS or a narrowly approved rework scope plus explicit founder authorization.
- **Likely files:** new production ADRs/plans; do not silently reactivate legacy production docs.
- **Contracts:** To be derived from evidence.
- **Migration concerns:** Packaging, recovery, schema upgrades, secret storage, observability, and rollback become mandatory.
- **Tests/acceptance:** Defined only after evidence and approval.
- **Non-goals:** Automatic continuation from this roadmap.
- **Rollback:** Production remains on HOLD.
