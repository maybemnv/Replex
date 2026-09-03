# Release Replay Production Tasks

> This backlog is dormant until `PROD-0` passes. Execute milestones in order and retain the POC's single validated operation boundary.

- [ ] PROD-0: Confirm production gate

  - Goal: Prove that production engineering is authorized by technical and market evidence.
  - Depends on: Completed POC and external validation program.
  - Files/modules: `Docs/PRD.md`, POC evaluation decision, concierge/five-user evidence, `Docs/production/gate-decision.md`.
  - Implementation: Audit every POC PASS criterion, external publication/payment/repeat/correction evidence, reconfirm product scope, select supported OSes/reference hardware, and record current vendor/version/license/cost choices. Do not change PRD thresholds retrospectively.
  - Acceptance criteria: POC passed; concierge and five-user gates passed; founders explicitly approve production scope/spend; unresolved evidence-triggered choices are decided from current data; otherwise record HOLD/STOP and execute nothing below.
  - Tests: Independent recomputation of metrics from raw evidence; checklist rejects missing evidence, threshold changes, or unsupported production feature promotion.
  - Out of scope: Treating this plan itself as authorization, implementation after a failed gate.

- [ ] PROD-1: Harden the canonical project core

  - Goal: Create durable, migratable, recoverable project state while preserving proven POC semantics.
  - Depends on: PROD-0.
  - Files/modules: `packages/project-core/`, `fixtures/projects/`, `fixtures/migrations/`, desktop app-data project store.
  - Implementation: Port schemas/reducer/reconciliation to versioned SQLite plus content-addressed immutable assets; add transactions, base-revision checks, operation batches, snapshots, import/export, previous-two-minor migrations, backup/read-only recovery, and integrity checks.
  - Acceptance criteria: Operations remain deterministic/atomic; stale writes reject; crash cannot expose partial revision; every referenced asset/hash is checked; failed migration restores/opens read-only; POC projects import without semantic change.
  - Tests: Unit/replay, migration matrix, corrupted DB/missing asset, disk-full/process-kill, import/export semantic hashes.
  - Out of scope: Cloud project sync, collaborative conflict resolution, generic asset database.

- [ ] PROD-2: Package the safe local capture runner

  - Goal: Reliably execute approved flows with a supported Playwright/Chromium pair and protected auth state.
  - Depends on: PROD-1.
  - Files/modules: `packages/capture-runner/`, `fixtures/apps/`, `apps/desktop/src/main/capture/`.
  - Implementation: Package browser versions, preflight origin/action/reset/disk checks, encrypt auth profiles via OS keychain, isolate contexts, persist checkpoints/evidence, support explicit target correction and scene-boundary resume, and reconcile interrupted runs.
  - Acceptance criteria: Unsupported browser blocks; prohibited/off-origin actions never execute; auth never enters project/log/model context; partial capture is diagnosable and resumable only after explicit reset/checkpoint approval.
  - Tests: Apps A/B/C, expired auth, malicious popup/download/origin, UI drift, process kill, packaged runner smoke on each supported OS.
  - Out of scope: Cloud browsers, silent self-healing selectors, unattended production accounts, CI mode.

- [ ] PROD-3: Build the usable local review editor

  - Goal: Let an external user approve capture and make every MVP P0 bounded correction without a professional timeline.
  - Depends on: PROD-1, PROD-2.
  - Files/modules: `apps/desktop/src/{main,preload,renderer}/`, editor UI tests.
  - Implementation: Use Electron context isolation and a typed preload API; add project create/open/delete, capture-plan approval, storyboard/scene list, authoritative playback, trace/source inspection, trim/reorder/replace/focus/title/callout/speed/transition/source-audio controls, revision status, and whole-revision revert.
  - Acceptance criteria: UI never writes project state directly; all edits create validated revisions; approximate preview is labeled; keyboard access and visible focus cover core flow; app reopens the last complete state after forced exit.
  - Tests: Component accessibility, typed IPC contract, packaged E2E create-to-edit/reopen/revert/delete, stale-revision conflict.
  - Out of scope: Multitrack timeline, arbitrary direct manipulation, design system, collaboration, P1 formats/features.

- [ ] PROD-4: Make local rendering durable and cancellable

  - Goal: Deliver trustworthy preview and authoritative export from immutable revisions.
  - Depends on: PROD-1.
  - Files/modules: `packages/render-core/`, `apps/desktop/src/main/render/`, `fixtures/media/`, `fixtures/projects/`.
  - Implementation: Persist a SQLite job state machine, serialize authoritative jobs initially, build validated RenderJobs/argv, use same-volume temp output and atomic promotion, implement graceful cancel, classified one-retry policy, content-keyed normalization cache, ffprobe/full decode, startup reconciliation, and bounded cleanup.
  - Acceptance criteria: Cancel/retry never promotes partial output; interrupted jobs recover to explicit terminal/retryable state; identical revision/settings yields identical semantic job; 30-second reference render meets <=90 seconds.
  - Tests: Golden jobs, probe/decode/boundary fixtures, process kill, disk full, corrupt/missing source, cancel race, cleanup/cache eviction, supported-OS packaged FFmpeg smoke.
  - Out of scope: Cloud rendering, parallel render fleet, custom codec/render engine.

- [ ] PROD-5: Implement the production verification pipeline

  - Goal: Block wrong browser/project/render states and present human-review boundaries honestly.
  - Depends on: PROD-2, PROD-4.
  - Files/modules: `packages/project-core/src/verify/`, `packages/capture-runner/src/checkpoints/`, `packages/render-core/src/verify/`, `fixtures/regression-videos/`.
  - Implementation: Chain policy/preflight, action/checkpoint, capture integrity, project/revision, RenderJob, probe/decode, targeted visual, and reconciliation checks; store first causal failure and evidence; surface creative-review checklist separately.
  - Acceptance criteria: Failed required invariant cannot become accepted export; wrong-state capture is never silently accepted; automated results make no creative-quality claim; every failure maps to a recovery action.
  - Tests: One positive/negative fixture per invariant, blank/frozen/overlay boundary corpus, wrong checkpoint, preservation mismatch, end-to-end verified export.
  - Out of scope: General AI quality judge, publication automation.

- [ ] PROD-6: Deploy the minimal hosted control plane

  - Goal: Support paid identity/entitlement and protected model access without hosting projects or browser sessions.
  - Depends on: PROD-0; may run in parallel with PROD-1 through PROD-5, but integration waits for their contracts.
  - Files/modules: `apps/control-plane/`, `packages/protocol/`, `infra/`, API contract tests.
  - Implementation: Build one Fastify modular monolith with account/session, entitlement, model-request, prompt-policy, billing-webhook, telemetry-ingest, and update-metadata modules; use managed Postgres and short-lived object storage; implement desktop API schemas and outage behavior.
  - Acceptance criteria: Tenant authorization protects every route/object; no project/media persistence except disclosed short-lived model inputs; control-plane outage leaves local manual edit/render usable; database migration and rollback paths are rehearsed.
  - Tests: API/authz/contracts, webhook signatures/idempotency, storage lifecycle, forbidden-field/redaction, outage/timeout, migration rollback.
  - Out of scope: Microservices, Kubernetes, project sync, cloud capture/render, enterprise SSO.

- [ ] PROD-7: Ship the safe AI revision workflow

  - Goal: Preserve model -> typed tools -> local operations -> verify -> render with disclosure and reproducibility.
  - Depends on: PROD-3, PROD-5, PROD-6.
  - Files/modules: `packages/agent-tools/`, `apps/desktop/src/renderer/agent/`, `apps/control-plane/src/model/`, `fixtures/agent-evals/`.
  - Implementation: Port bounded tools, add disclosure preview/log, hosted one-model mediation, turn/token/render/time budgets, grounding records, current-revision checks, one visible transient retry, prompt/tool/model versioning, manual fallback, and eval-gated model rollout/rollback.
  - Acceptance criteria: Model has no filesystem/browser/shell/FFmpeg/JSON authority; invalid/stale calls are atomic; accepted sequence replays; selected evidence only is transmitted; provider outage does not corrupt/block manual project work.
  - Tests: POC eval replay plus malicious prompt/page, secret canaries, invalid/unknown/stale tool calls, timeout/outage, model-version comparison, agent edit -> recapture preservation -> render.
  - Out of scope: Multiple agents/models, provider abstraction, open-ended loop, dynamic operations, conversational P1 unless separately promoted by evidence.

- [ ] PROD-8: Complete privacy, security, and deletion hardening

  - Goal: Address the actual sensitive-browser and local-media threat model before alpha.
  - Depends on: PROD-2, PROD-3, PROD-6, PROD-7.
  - Files/modules: Electron security config, auth profile store, redaction/disclosure modules, control-plane object policy, deletion/recovery UI, threat-model document.
  - Implementation: Enforce sandbox/context isolation/CSP/navigation policy; keychain-encrypt auth; restrict fixture uploads; scrub URLs/logs/crashes; preview model/crash uploads; lifecycle-delete hosted temp objects; implement confirmed project/auth deletion separately and retention controls.
  - Acceptance criteria: No cookie/token/storage secret appears in projects, exports, logs, telemetry, crash attachments, or model requests; malicious content cannot reach Node/shell; deletion covers declared data and reports failures.
  - Tests: Secret-canary E2E, Electron security assertions, path traversal/symlink/upload abuse, cross-account object access, deletion/retention, dependency/license/security scan.
  - Out of scope: Generic enterprise compliance, audit export, organization policy suite.

- [ ] PROD-9: Add recovery and performance budgets

  - Goal: Make common failures recoverable and prove the local workflow meets measured budgets.
  - Depends on: PROD-4, PROD-5, PROD-7, PROD-8.
  - Files/modules: desktop startup/job reconciliation, performance harness, failure-injection suite, support diagnostics export.
  - Implementation: Cover partial capture, model failure, corrupt/missing media, failed render, UI drift, browser mismatch, stale revision, process interruption, and control-plane outage; measure project load/preview/capture/model/operation/render/recapture and 5 GB cap behavior.
  - Acceptance criteria: Each failure preserves last complete revision and gives a bounded recovery; p95 budgets in the production plan pass on minimum/reference hardware or the gate records a scoped measured fix; diagnostics export is scrubbed and user-reviewed.
  - Tests: Automated failure injection and benchmark corpus on supported OSes; restart/recovery E2E; diagnostics secret scan.
  - Out of scope: Premature caching/distribution beyond measured breaches, high-scale load testing.

- [ ] PROD-10: Establish lean CI, signed releases, and safe updates

  - Goal: Release the desktop and control plane repeatably with migration and fixture protection.
  - Depends on: PROD-5, PROD-6, PROD-8, PROD-9.
  - Files/modules: CI workflows, `scripts/`, signing/notarization configuration, desktop updater, control-plane deployment configuration.
  - Implementation: Add PR fast tier, nightly browser/render/migration/eval tier, release-candidate packaged E2E on supported OSes, signed artifacts/update metadata, alpha/stable channels, install/update/rollback smoke tests, and expand/migrate/contract server migrations.
  - Acceptance criteria: Required checks gate merge/release; released binaries verify signatures; previous-two-minor projects upgrade; bad desktop/model/server release can roll back without project loss; fixture changes require explicit review.
  - Tests: Clean-machine install, upgrade/rollback, signature verification, migration compatibility, deployment health/rollback, full regression corpus.
  - Out of scope: Custom CI platform, Kubernetes, many environments, per-service pipelines.

- [ ] PROD-11: Add consented operational signals

  - Goal: Observe reliability/value without collecting customer project content by default.
  - Depends on: PROD-6, PROD-8.
  - Files/modules: desktop telemetry consent/settings, control-plane telemetry module, error-reporting integration, operational dashboards/alerts.
  - Implementation: Emit pseudonymous capture/checkpoint/render/recapture/model-tool/export/crash/update outcomes and durations; keep correction/publication/repeat inputs explicit; sample logs; gate crash attachments behind preview/consent.
  - Acceptance criteria: Opt-out is default where required and respected; payload schema excludes URLs/copy/screens/traces/secrets; founders can answer core gate metrics using vendor dashboards; ingestion outage never blocks local work.
  - Tests: Payload allowlist/redaction, consent transitions, offline buffering bounds/drop, cross-account access, dashboard metric reconciliation.
  - Out of scope: Custom analytics platform, session replay, content collection.

- [ ] PROD-12: Enable paid beta billing and cost controls

  - Goal: Charge validated customers and keep contribution economics visible without inventing credits.
  - Depends on: PROD-6, PROD-7, PROD-11; execute only when rollout reaches paid beta.
  - Files/modules: control-plane billing/entitlement modules, desktop entitlement UI, Stripe-hosted checkout/portal configuration, cost reports.
  - Implementation: Implement the validated completed-output or monthly offer, signed idempotent webhooks, entitlement grace/offline rules, model/context/request caps, temp-storage TTLs, and variable cost per accepted/exported video.
  - Acceptance criteria: Payment/refund/cancel/renewal updates entitlement correctly; local projects remain accessible after lapse; costs and margins reconcile; broader rollout blocks on negative contribution.
  - Tests: Webhook replay/order/signature, checkout/portal sandbox, grace/lapse/offline clock cases, usage cap, cost reconciliation.
  - Out of scope: Custom invoicing, usage-credit economy, multiple price architectures, TTS charges before feature promotion.

- [ ] PROD-13: Run staged release gates

  - Goal: Progress internal -> alpha -> pilot -> paid beta -> broader availability only on evidence.
  - Depends on: PROD-10, PROD-11; PROD-12 before paid-beta completion.
  - Files/modules: release runbooks, cohort scorecards, support issue taxonomy, gate decisions.
  - Implementation: Enroll one cohort at a time, measure exact production-plan thresholds, review privacy/support incidents, classify failure causes, hold/narrow/stop when gates fail, and record feature requests against fixed-vocabulary thresholds.
  - Acceptance criteria: Each transition has signed evidence; paid beta shows five recurring customers for two billing periods and positive contribution; broader availability requires two stable releases and two-founder-operable support/reliability.
  - Tests: Metric recomputation, cohort completeness, gate-decision validation, rollback/support drill.
  - Out of scope: Date-driven launch, paid acquisition, scope expansion to rescue weak demand.

## Critical Path

`PROD-0 -> PROD-1 -> PROD-2 -> PROD-3 -> PROD-4 -> PROD-5 -> PROD-7 -> PROD-8 -> PROD-9 -> PROD-10 -> PROD-13`.

`PROD-6` starts after PROD-0 and must complete before PROD-7. `PROD-11` and `PROD-12` join the path before pilot/paid-beta gates respectively.

## Parallelizable Work

- After PROD-0, control-plane/protocol work (PROD-6) can proceed independently of local project/capture/render hardening, using agreed schemas.
- After PROD-1, PROD-2 and PROD-4 can proceed in parallel; PROD-3 can build project screens while capture/render integration stabilizes.
- After PROD-8, operational signals (PROD-11) can proceed alongside recovery/performance (PROD-9).
- Billing (PROD-12) can be prepared during pilot only after the offer is validated; it must not delay internal/alpha technical learning.
- Schema, operation, migration, and protocol ownership must be serialized through their owning packages; parallel work consumes contracts rather than duplicating them.

## Exit Criteria

- Production gate evidence remains valid and no PRD kill criterion has fired.
- Signed desktop releases complete approved flow -> agent/manual revision -> verification -> local export -> selective recapture on supported OSes, with recovery and privacy tests passing.
- Paid beta has at least five recurring customers for two billing periods, positive contribution after variable costs, median correction under 10 minutes, final render >=98%, selective recapture >=90%, and founder intervention below 20%.
- Broader availability begins only after those targets hold for two releases and operational/support load is sustainable for two founders. Otherwise hold, narrow, or stop.
