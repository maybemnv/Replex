# Replex V2 dependency-ordered implementation plan

**Status (27 September 2026):** Core/Foundation PRs #10-#18 are merged; current `main` is `5950983`. Gates A-C have bounded technical evidence. Phase 4 selected the native evidence provider (NO-GO for the ffmpeg-skill adapter), Phase 5 composition technical evidence passed, and PR #15's bounded `camera-push.v1` motion implementation is merged. Gate D remains open: the three supplied internal reviews are synthetic (0/3 independent human reviews) and correction times are unmeasured. V2-701 is merged at `9cfe6cf`. The unmerged `feat/v2-702-local-import-service` candidate adds local asset-import jobs and a host-only authorization bridge; its cancellation follow-up has independent SPEC and security review. The final build and 34 focused import/service tests pass. A full serial suite passed before the final one-line AbortSignal restoration (44 files, 320 passed, 5 skipped); the repeat run slowed sharply and was stopped after four unrelated browser/capture timeout failures. No GitHub CI result is claimed. Local evidence, agent, browser capture/recapture, verification, preview, and render jobs remain absent from the executor. Live-provider behavior, formal human usefulness, mixed-media selective-recapture preservation, and production authorization remain unproven.

**PR-A retrospective Gate A correction (25 September 2026):** A fresh independent review of merged PR #11 found that `JobEventSchema` allowed `job.updated.projectId` to disagree with its nested job and `verification.updated.revisionId` to disagree with its nested verification. PR #16 adds event-level consistency checks and two negative tests. The correction merged at `517b4f40d799cf66c38f7317890ec2ffc9529a69`; `npm run build`, focused tests (2 files/35 tests), and the serial full suite (37 files/272 tests, zero skips) passed using direct FFmpeg/FFprobe 9.0.1 binaries with scoped elevation. Independent corrective review passed. GitHub reported no CI status checks. This supersedes the earlier Gate A claim for PR-A head.

**PR-A validation (25 September 2026):** `npm run build` passed. The serial full suite passed 26/26 files and 193/193 tests with direct FFmpeg/FFprobe 9.0.1 binaries supplied through `REPLEX_FFMPEG_PATH` and `REPLEX_FFPROBE_PATH`. Without those overrides, this environment's inaccessible WinGet links caused 17 FFmpeg-dependent failures across five capture/browser files (166 passed, 10 skipped); rerunning with direct binaries resolved them. Independent validation passed. GitHub reported no CI status checks for PR-A.

**PR-B validation (25 September 2026):** `tsc -p tsconfig.json --noEmit` passed. The final serial full suite passed 30/30 files and 226/226 tests with zero skips in 253.89 seconds using direct FFmpeg/FFprobe 9.0.1 binaries supplied through `REPLEX_FFMPEG_PATH` and `REPLEX_FFPROBE_PATH`. Independent validation reviewed head `fa9f42d`, passed build, 11/11 focused renderer/E2E tests, and `git diff --check`; the render-anchor finding was fixed and retested with actual output pixels. Gate B is met. No GitHub CI result was available during this validation.

**PR-C validation (25 September 2026):** Independent read-only validation passed candidate head `0dd2b2d2074747a0ae40eef179c50b2b612cf833`: `npm run build`; focused V2 agent/inspection/conversation checks passed 5 files/38 tests; full `npx vitest run --maxWorkers=1` passed 35 files/264 tests in 238.67 seconds with direct FFmpeg/FFprobe 9.0.1; `git diff --check 805edbe..HEAD` passed. A provider probe confirmed incomplete responses at the 1,200-token ceiling are rejected. Gate C technical evidence uses a deterministic model client; no live provider call, GitHub CI result, or human-use evaluation is claimed.

**PR-D Phase 4 decision (25 September 2026):** **NO-GO for a runtime ffmpeg-skill evidence adapter in this POC.** The native `src/media-evidence.ts` path already generates the useful approved evidence subset used by bounded V2 inspection. The pinned spike's tiny synthetic samples did not establish a parity or performance advantage, while its dynamic capabilities, command-bearing failure payloads, Windows `drawtext` crash, and process/path constraints would add a second execution boundary. Keep `src/media-evidence.ts` as the selected provider and retain V2-150's `PARTIAL-GO` as research evidence only. See [ADR-008](../architecture/ADR-008-native-v2-evidence-provider.md).

**PR-D Phase 5 validation (25 September 2026, candidate `5b7ec36`):** V2-501 implements a bounded native composition profile: one or two contiguous video clips, optional audio, timed title and picture-in-picture image layers, cut/crossfade, reframing, speed, opacity, and audio controls. A frozen v2 execution job carries authorized asset handles and derived output duration; the backend verifies all inputs and the resulting artifact without mutating canonical state. The agent can propose typed composition operations and render previews through the same reducer. Independent review found no blockers. `npm run build`, the focused composition suite (5/5), `git diff --check origin/main...HEAD`, and the final serial suite (37/37 files, 270/270 tests, zero skips; 252.45 seconds) passed with FFmpeg/FFprobe 9.0.1. The default WinGet links were inaccessible in the sandbox; the final suite used their direct executable paths with scoped elevation. No GitHub CI result is claimed. Phase 5 technical evidence is complete; Gate D remains open pending motion quality and human review.

**V2-701 local-executor slice (26 September 2026, merged at `9cfe6cf`):** Adds a durable local ProjectV2 store, asynchronous `apply_operations` jobs, typed cancellation/idempotency, ordered project events with explicit cursor-expiration pages, and loopback HTTP plus a one-shot command CLI using one service dispatcher. Both modes bind a fixed workspace-derived loopback port; only one supported runtime may own a workspace at a time. The live capability projection is deliberately limited to create/open/apply/cancel and `apply_operations`. Asset import, evidence, agent-edit, browser capture/recapture, verify, preview, and final-render jobs are still absent; this slice does not complete V2-702 or the local end-to-end gate. Build passed; focused validation passed 6 files/48 tests; the serial suite passed 41 files/295 tests in 248.07 seconds with direct FFmpeg/FFprobe 9.0.1 paths. Independent validation found no blocker for this bounded V2-701 slice. No GitHub CI result is claimed. This engineering evidence does not close Gate D.

**V2-702 local-import candidate (26 September 2026, branch `feat/v2-702-local-import-service`, based on `5950983`):** Adds the `asset_import` job path on top of V2-701. A host-only loopback authorization route accepts a selected path only beneath roots configured by the service launcher and returns an opaque, process-bound token; the one-shot CLI accepts `--source-path` and repeated `--import-root` options in its own process. Neither endpoint is a `ServiceCommand` or model-facing tool, and raw paths are not written to job/project state. Mutating jobs are serialized per workspace. A committed import is recovered from its operation log after a crash; an uncommitted job whose file handle was lost fails as `UPLOAD_INTERRUPTED`. This branch does not add evidence, agent, browser capture/recapture, verification, preview, or render service jobs and does not constitute the complete local workflow.

**V2-702 candidate validation (code head `ee527d7`, 26 September 2026):** `npm.cmd run build` passed; the six focused local-executor files passed 30/30 tests; the serial full suite passed 44/44 files and 323/323 tests with zero skips in 243.72 seconds using the direct FFmpeg/FFprobe 9.0.1 executables. The suite includes actual video import through HTTP and one-shot CLI, host-root rejection, token cleanup/limits, restart interruption and committed-import recovery, and job serialization. Independent review and GitHub PR checks are pending; no CI success is claimed.

**V2-702 cancellation-fence follow-up (27 September 2026, still unmerged):** The local import now publishes a durable non-cancellable fence before applying the canonical import batch, emits the finalizing event, and finalizes successful import jobs through the shared revision-success path. Cancellation before the fence aborts staging without a revision; the fence survives executor restart. A private job-state field defaults false when reading older persisted records, leaving service-contract v1 unchanged. An independent SPEC review found no remaining contract/recovery blocker; a security review found and prompted restoration of the source stream's AbortSignal. The final code passed `npm run build` and focused import/service tests (3 files/34 tests), and the cancellation cases cover pre-commit abort, late cancel, and fenced restart. A full serial run on the candidate before that one-line restoration passed 44 files/320 tests with 5 skipped in 325.48 seconds. The exact-final-state rerun was stopped after the POC-13 fixture file passed in 346.5 seconds and four browser/capture timeout failures appeared; these failures are not reported as passes. The crash window after immutable media promotion but before ProjectStore publication can leave an unreferenced content-addressed blob; the project revision remains unchanged, and blob reconciliation is deferred. Process-group escalation beyond the direct trusted FFmpeg/FFprobe child is also deferred. No GitHub CI result is claimed.


**Phase 6 V2-601 decision (25 September 2026):** **PARTIAL-GO** for `camera-push` and `title-reveal` behind ADR-002's separate `MotionBackend` boundary, using FFmpeg as the first replaceable implementation; **NO-GO** for adding Remotion in this POC. A 640 x 360 synthetic render showed same-environment repeat-hash, audio, and ProRes alpha support, but color tags, cancellation, cross-platform repeatability, representative performance, and human quality remain untested. The recorded render timings are anecdotal; hardware and measurement method were not retained. The evidence, current license review, and limits are in the [motion spike report](motion-spike-report.md). V2-602 starts with `camera-push.v1`; Gate D stays open until the implemented treatment receives human review.

**Phase 6 V2-602 implementation (25 September 2026, merged by PR #15 at `5950983`):** Canonical `camera-push.v1` state, a separate frozen `MotionExecutionJobV1`/`MotionBackend`, a V3 composition-job boundary with executor-issued motion handles, and agent proposal/inspection support are on `main`. The real FFmpeg fixture verifies a silent intermediate, visible first-to-last frame change, preserved source SAR, deterministic repeat output, durable motion verification receipt, and final H.264/AAC export. A V3 render over the asymmetric green-marker fixture checks crop placement, 1.25x transform, and 0.75 opacity through tolerant pixel samples; motion, handle, V3-job, verified-final, preview, and committed-output lineage pins/hashes are asserted. The conversation test exercises two grounded same-thread edits with verified previews and replay. The host-facing V2 conversation result carries typed motion execution summaries; model-facing tool output does not expose backend details. The executor assumes trusted host-configured direct FFmpeg/FFprobe binaries; wrappers are unsupported because cancellation drains only the direct child process. Human visual/quality approval remains outstanding, so Gate D stays open.

**PR #15 integration validation (25-26 September 2026):** The motion candidate was integrated against `main` at `504c109`; `npm.cmd run build` passed and the full serial suite passed 38/38 files and 292/292 tests with zero skips using direct FFmpeg/FFprobe 9.0.1 paths. A later review found that one real-media test was unconditional and that PATH-resolved relative tool names could incorrectly satisfy its capability probe even though the executor requires absolute paths. PR #15 gates those real-media tests on configured absolute FFmpeg/FFprobe paths. PR #15 merged at `5950983`; GitHub supplied no CI status result before merge.

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

**Implementation status:** PR-A froze explicit service-contract v1 projections and boundary tests. A retrospective review then found two event identity gaps; PR #16 adds both consistency checks and negative tests and is merged at `517b4f4`. Gate A is closed against corrected main. See the corrective validation record above.

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

Phase 2 started after PR-A passed Gate A. PR-B uses the native FFmpeg/FFprobe path for import checks, bounded evidence, and a single-clip deterministic renderer. The V2-150 ffmpeg-skill PARTIAL-GO remains research only: no runtime dependency, adapter, or public service command was added. Reconsider a read-only adapter only if later evidence demonstrates a measurable advantage over this native path.

### V2-201: Import immutable local assets

**Implementation status:** Complete in `src/import-v2.ts`; the integrated import tests and final PR-B serial suite pass.

- **Objective:** Import video/image/audio by copy, hash, probe, and atomic asset registration.
- **Why:** Uploaded media is the first new source type and trust boundary.
- **Dependencies:** V2-103 and Gate A; installed local FFmpeg/FFprobe for media validation.
- **Files:** `src/import-v2.ts`, `tests/import-v2.test.ts`.
- **Contracts:** `authorizeLocalImport` produces an opaque host-authorized file token; `importLocalAssetV2` stages, hashes, probes, fully decodes, persists, then applies one `import_asset` operation.
- **Migration concerns:** Deduplicate by hash without merging provenance records; never mutate originals.
- **Tests:** video/image/audio, duplicate content, corrupt/truncated media, changed source during import, path/symlink/junction escape, cancellation and cleanup, reducer rollback.
- **Acceptance:** Imported source is immutable, hash-matched, probed, project-scoped, and attributable; failure leaves no canonical asset.
- **Non-goals:** Remote URLs, cloud upload, transcoding on import.
- **Rollback:** Remove unreferenced staged artifact; canonical revision remains unchanged on failure.

**Implemented bounds:** 256 MiB per input; 60 seconds total import, 15 seconds for probe, and 30 seconds for full decode; 10-minute duration, 4096-pixel dimension/16-megapixel frame, 60-fps, 8-channel, and 192-kHz sample-rate caps. Video, image, and audio imports retain separate provenance even when identical bytes deduplicate.

### V2-202: Produce deterministic bounded media evidence

**Implementation status:** Complete in `src/media-evidence.ts`. The native provider writes probe metadata, up to four selected frames, a contact sheet, scene boundaries, and audio peaks/mean, silence, and loudness when audio exists. No transcript, motion proxy, model call, ffmpeg-skill adapter, or canonical mutation is included.

- **Objective:** Generate a versioned evidence index with technical probe, selected frames/contact sheet, scene boundaries, and bounded audio measurements.
- **Why:** Models need compact evidence rather than full video context.
- **Dependencies:** V2-201 and Gate A. The approved ffmpeg-skill PARTIAL-GO remains advisory; PR-B uses native FFmpeg/FFprobe.
- **Files:** `src/media-evidence.ts`, `tests/media-evidence.test.ts`.
- **Contracts:** `generateMediaEvidence` accepts an `AssetHandle`, host resolver, and Replex evidence root; it returns a source-hash-bound `MediaEvidenceIndex` with per-artifact hashes and generator/config versions. It never receives ProjectV2 or writes operations/revisions.
- **Migration concerns:** Derived evidence is regenerable and must not change asset identity.
- **Tests:** deterministic bounded real-media evidence, silent/no-audio media, malformed tool output, source mismatch/change, symlinked evidence roots, and byte/frame limits.
- **Acceptance:** The index is regenerable, source-hash-bound, and each artifact is hash-addressed; bounded inspection consumers are a later Phase 3 task.
- **Non-goals:** Full semantic understanding, mandatory transcription, model calls.
- **Rollback:** Delete/rebuild derived evidence index; source and project remain valid.

Evidence is tied to the asset hash and generator/config versions. Each artifact is capped at 8 MiB, the pack at 32 MiB, and analysis at two minutes. A hostile same-user process that changes and restores a source path during analysis is a residual local concurrency risk; the normal host resolver uses the content-addressed, read-only, single-link import store.

### V2-203: Render a basic uploaded-video composition

**Implementation status:** Complete in `src/render-v2.ts`; the final anchor/rotation pixel regression, renderer tests, and Gate B E2E pass.

- **Objective:** Extend the native backend to render one uploaded clip with trim, speed, transform/crop, opacity, and audio gain.
- **Why:** Prove V2 state can reach deterministic media before agent or new dependency work.
- **Dependencies:** V2-103, V2-201, and Gate A. The baseline uses the native FFmpeg backend.
- **Files:** `src/render-v2.ts`, `tests/render-v2.test.ts`, and the Gate B integration test.
- **Contracts:** `buildMediaExecutionJob` freezes a revision-pinned job; `executeMediaExecutionJob` receives that job and authorized handles but no ProjectV2; `registerRenderArtifactV2` records the verified derived output without changing the semantic hash.
- **Migration concerns:** Keep V1 RenderJob parsing/execution unchanged.
- **Tests:** frozen job hash, real deterministic FFmpeg fixture, anchor/rotation pixels, stale revision, missing asset, duration/probe/decode, unsafe path, cancellation/partial output, and artifact registration.
- **Acceptance:** A V2 project renders reproducibly, records backend/tool versions and hashes, and cannot render without successful current-revision verification.
- **Non-goals:** Production ffmpeg-skill adapter, captions, multi-asset, motion; the native path is only a baseline while the capability decision is measured.
- **Rollback:** Native V2 feature flag/command can be disabled without affecting V1.

The current planner handles one uploaded video clip and supports trim, speed, crop/reframe, scale, rotation, anchor, opacity, gain, and mute on an even-dimension 16–4096-pixel canvas at 1–60 fps and up to two minutes. It emits H.264/AAC, caps outputs at 512 MiB, pins a revision and authorized asset handle, verifies probe/decode/hash, and returns an artifact for host-side registration. Registered outputs and verification refs do not alter the semantic revision hash. V1 renderer files were not changed. Canonical geometry is specified in [ADR-008](../architecture/ADR-008-v2-transform-geometry.md).

## Phase 3: Multimodal inspection and conversational edits

### V2-301: Add bounded V2 inspection tools

**Implementation status:** Implemented and covered by bounded inspection, redaction, evidence-reference, and real-media conversation tests.

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

**Implementation status:** Implemented; deterministic two-prompt E2E creates attributable, replayable revisions and verified previews on one project.
**Budgets enforced:** 8 KiB prompt; at most 4 model calls and 12 tool calls per intent; 1,200 provider-enforced output tokens per model call (4,800 total maximum); 120-second wall time; 64 KiB inspection data; and 4 MiB total image evidence. The output-token limit bounds generated tokens, not a fixed dollar amount across provider/model prices.

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

**Decision:** NO-GO for this POC. The existing native provider covers the useful Phase 2 evidence; the spike did not show an advantage worth a second runtime boundary. V2-150 remains `PARTIAL-GO` as a capability study, not a runtime adoption decision.

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
- **Dependencies:** V2-203 and the explicit native-provider decision in [ADR-008](../architecture/ADR-008-native-v2-evidence-provider.md).
- **Likely files:** V2 schemas/operations/planner, selected backend adapter, verification and tests.
- **Contracts:** at most two contiguous primary-track video clips, one optional audio clip, bounded timed text/image overlays, crop/transform/audio controls, and cut/crossfade. The backend consumes a versioned frozen job with authorized asset handles; `ProjectV2` remains unchanged.
- **Migration concerns:** No canonical schema addition is planned. Render duration is derived from canonical duration minus transition overlaps and is recorded in the frozen job.
- **Tests:** timing overlaps, audio mix/gain, missing fonts/assets, caption bounds, transition duration, portrait/landscape reframing, multi-asset replay.
- **Acceptance:** A two-video, one-audio, title/caption project with an image overlay previews and exports deterministically, replays through semantic operations, and passes independent output verification.
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

- **Objective:** Implement the bounded `camera-push.v1` preset first; keep `title-reveal` deferred unless later evidence justifies a second implementation.
- **Why:** Prove one visible, programmable treatment with the least new motion/rendering machinery.
- **Dependencies:** V2-601's PARTIAL-GO and [ADR-010](../architecture/ADR-010-v2-motion-presets.md). Keep `MotionBackend` replaceable and distinct from `MediaBackend`; using FFmpeg for both does not merge their jobs or semantics.
- **Likely files:** `src/schema-v2.ts`, `src/operations-v2.ts`, `src/motion-v2.ts`, `src/render-v2.ts`, `src/inspect-v2.ts`, `src/agent-v2.ts`, fixtures/tests.
- **Contracts:** Optional canonical `motionPresets`; `camera-push.v1` strength from `0.02` through `0.08`, meaning a linear zoom from `1.0x` to `1.02x`-`1.08x` over clip duration; `MotionExecutionJobV1` and a separate authorized motion-artifact handle; a new composition job version for final use of motion output. Do not modify existing composition job versions or service-contract v1.
- **Migration concerns:** Absent `motionPresets` remains absent so existing semantic hashes remain stable. Stored preset IDs/versions never upgrade implicitly.
- **Tests:** strict target/preset bounds, replay, repeatability, post-trim/post-speed zoom timing, proof that final composition does not apply speed twice, crop/transform/opacity ordering, matching semantic motion inputs/source pins for preview and final, independent motion/final artifact verification, cancellation/cleanup, stale revision/source rejection, missing authorized handles, and existing V1/V2 render regressions.
- **Implementation status:** `camera-push.v1` candidate is present on `feat/v2-602-camera-push`. A separate direct FFmpeg motion job writes only a private intermediate; a durable bounded receipt remains under `.replex-evidence/motion/receipts/` after intermediate cleanup. Agent preview can render at most two active motion presets, matching the composition planner's two-video limit. Only trusted host-configured direct FFmpeg/FFprobe binaries are supported; wrappers are outside the POC cancellation contract. Service-contract v1, existing job versions, V1 render, and media-only semantic hashes remain unchanged.
- **Acceptance:** The agent applies `camera-push.v1` through the shared reducer and returns a verified preview plus final export without backend code in project state. Gate D also requires a human visual review; synthetic/test renders alone do not pass it.
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

**Current implementation boundary:** The V2-702 candidate covers only immutable local asset import, asynchronous job reporting/cancellation, and host-side file authorization. The remaining analysis, agent, browser capture/recapture, verification, preview, render, and motion workflows are not wired through the executor.

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

**Current decision:** Not started. Gate D human review remains open and Gate E selective recapture is unproven, so the roadmap prerequisites for cloud work are not met. Keep the cloud budget unspent.

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
