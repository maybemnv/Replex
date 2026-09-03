# Release Replay Production Implementation Plan

> **Conditional plan only:** No task after `PROD-0` may start until the POC, external product validation, and scope-reconfirmation gates pass.

**Goal:** Evolve validated Release Replay mechanics into a reliable paid product without weakening the boundary `AI reasoning -> typed tools -> validated operations -> canonical project -> deterministic renderer`.

**Spec:** `Docs/PRD.md`, the approved agentic-editing amendment, and evidence captured by `Docs/poc/task.md`.

## Planning Constraints

- Production is a separate engineering state, not a polished POC. Preserve proven concepts and rewrite disposable code where evidence warrants it.
- Entry evidence: technical POC PASS; concierge and five-user validation passed; product scope reconfirmed. Broader production investment remains gated by five recurring customers for two billing periods, positive contribution, and a measured bottleneck.
- P0 product remains an approved-flow, local-first, Chromium, 3-10 scene, 15-60 second compiler with a bounded review editor and 1080p H.264/AAC export.
- Human review remains authoritative for creative quality. Wrong or unverified product state is never silently accepted.
- Credentials, browser state, source captures, projects, and local renders remain local by default. Only explicitly selected model context leaves the device, with disclosure.
- Do not add cloud browsers/renders, general NLE features, multiple models/agents, arbitrary code/FFmpeg, plugins, mobile, enterprise controls, or additional formats without the PRD evidence threshold.

The PRD deliberately does not commit to production implementation. This plan chooses a least-expansive topology and marks evidence-triggered options; it does not promote P1/future features into requirements.

## Product Topology

Choose a **hybrid local desktop application plus a thin hosted control plane**.

- The signed desktop application owns UI, Playwright execution, auth-state access, canonical projects/assets, verification, preview, and authoritative local FFmpeg export.
- A small hosted modular monolith owns product accounts, entitlements/billing, model API mediation, prompt/model policy, consented telemetry ingestion, and signed update metadata.
- Projects and source media are not synchronized. Model requests upload only disclosed, task-scoped evidence and are deleted after provider/request retention permits. Offline manual editing/rendering remains possible; AI and entitlement refresh require network.

This topology follows the privacy/workflow boundary while preventing shipped provider credentials and enabling a paid service. Fully local would force bring-your-own model keys and fragment support; fully hosted would require uploading authenticated product screens and cloud browser state. Do not split the control plane into services.

## Concrete Stack

- **Monorepo:** npm workspaces, TypeScript throughout.
- **Desktop:** Electron, React, Vite, native HTML video controls, Playwright Chromium, system/bundled FFmpeg after license/packaging review, OS keychain via a narrow maintained binding.
- **Local persistence:** SQLite in WAL mode for metadata/revisions/jobs plus content-addressed files in the app data directory. JSON import/export remains the portable project boundary.
- **Hosted control plane:** Node TypeScript modular monolith, Fastify, PostgreSQL, object storage only for short-lived disclosed model inputs and optional crash attachments.
- **Jobs:** durable local SQLite job table and one in-process worker. Hosted background work uses the platform's managed job primitive only when model callbacks/webhooks require it; no queue cluster.
- **Model:** one Claude model behind hosted typed-tool mediation; prompt and model version recorded. No provider abstraction until a measured migration need.
- **Testing:** Vitest, Playwright, deterministic FFmpeg fixtures, packaged-app smoke tests.
- **Deployment:** one managed container/web service, managed Postgres, S3-compatible object storage, Stripe hosted checkout/customer portal, Sentry-compatible error reporting, and a lightweight product analytics service only with consent.

Exact vendors and pinned versions are selected at `PROD-0` against then-current availability, pricing, licenses, and POC evidence.

## Production Repository Structure

```text
apps/
  desktop/                 # Electron main/preload/React UI; no project rules duplicated here
  control-plane/           # account, entitlement, model, billing webhook, telemetry modules
packages/
  project-core/            # schemas, migrations, reducer, revisions, reconciliation, import/export
  capture-runner/          # Playwright policy, flow execution, tracing, recovery
  render-core/             # RenderJob validation, FFmpeg argv, probing, cancellation/cleanup
  agent-tools/             # bounded inspection/edit/verify/render tool registry and loop
  protocol/                # desktop-control-plane request/response schemas only
fixtures/
  projects/ media/ apps/ agent-evals/ migrations/
scripts/                   # release/fixture verification; no general internal platform
infra/                     # one control-plane deployment and storage lifecycle config
```

Packages exist because desktop/background jobs/tests share executable contracts. Do not create repositories per component, abstract ports for single implementations, or a generic SDK.

## Component Contracts

| Component | Responsibility and interface | Dependencies/data flow | Failure behavior and tests |
|---|---|---|---|
| Desktop shell/editor | Capture-plan approval, storyboard, bounded operations, review, job status, whole-revision revert. Calls typed local APIs through a context-isolated preload. | `project-core`, runner, renderer, agent tools; never mutates DB/manifest directly. | Crash leaves durable job/revision state; UI E2E covers create/capture/edit/reopen/recapture/export. |
| Project core | Canonical schema, migrations, operation reducer/log, immutable asset refs, snapshots, reconciliation/recovery. | SQLite transaction + content-addressed asset store. | Reject stale/invalid ops atomically; verify DB/assets on open; fixtures cover every migration and corruption case. |
| Capture runner | Package/version Chromium, enforce origin/action approval, execute flow, record evidence/checkpoints. | Approved plan -> local browser -> immutable captures -> project core. | Stop first unsafe/wrong action; resumable at explicit scene boundary; browser fixtures/failure injection. |
| Render core | Convert verified revision to fixed RenderJob, preview proxy, authoritative local export. | Project core assets -> temp workspace -> FFmpeg -> verified output. | Cancel/retry idempotently; preserve diagnostics; cleanup only after terminal state. Golden jobs and decode tests. |
| Agent tools | Build disclosed context, mediate one model loop, validate tools, create operation revisions. | Selected local evidence -> hosted model request -> typed calls -> local reducer -> verify/render. | Timeout/retry once; invalid/stale call rejected; manual path stays available. Eval corpus and adversarial calls. |
| Control plane | Account/entitlement, model proxy, prompt policy, billing webhook, update channel, consented events. | Minimal metadata; no project authority. | Service outage blocks AI/entitlement refresh but not local review/render; API/contract/webhook tests. |

## Canonical Project and Evolution

- SQLite holds `projects`, `flows`, `actions`, `captures`, `scenes`, `overlays`, `operations`, `revisions`, `render_jobs`, `outputs`, `verification_results`, and `jobs`. Assets are immutable SHA-256-addressed files; DB rows hold relative object keys and probes.
- Every mutation supplies `baseRevisionId`, validates, appends an operation batch, and creates a revision transactionally. Periodic canonical snapshots bound replay time; the operation log remains auditable. Revert creates a new revision pointing to a prior complete semantic state.
- Schema versions use ordered forward migrations, each fixture-tested from every supported prior release. Before migration, make a local backup and free-space check; on failure, reopen read-only and offer restore/export. Support opening projects from the previous two minor app versions; older projects require sequential upgrade or portable export/import.
- Selective recapture preserves stable project/flow/action/scene identities and creates new immutable captures. Reconcile against the latest revision, reject stale base revisions, and compare unaffected semantic projections. Conflicts are explicit: reapply compatible target-scene edits, otherwise ask the user to trim/replace them.
- On open, verify DB integrity, referenced file existence/hash, current-revision reachability, and job/output state. Missing assets block affected operations/render but allow inspection/export of diagnostics. Never “repair” by dropping rows silently.

## Editing Engine Decision

Keep the thin owned scene engine while validated paid requests fit the fixed vocabulary. Reconsider an external core only when, over at least 20 accepted paid revisions, more than 25% cannot be represented; preview/export divergence causes repeated rejection; paid demand requires multitrack/long-form/effect-heavy work; or a candidate measurably reduces maintenance while preserving stable identities, operation validation, deterministic export, license compatibility, and local-first packaging.

Evaluate OpenReel/OpenCut for embeddable web editing only if their stable APIs exist at evaluation time; MLT/Kdenlive only if mature timeline/media semantics are required. Run a time-boxed adapter spike against the regression corpus before migration. The owned manifest and operations remain authority; no preemptive editor-core abstraction.

## Render Architecture

- Generate fast local preview proxies/thumbnails for the UI; label them approximate. The latest verified FFmpeg export is authoritative.
- Persist jobs with input revision/hash, state, progress, attempt, temp path, output path, cancellation flag, and diagnostic path. One local worker serializes authoritative renders initially; parallelize only after measurements.
- Retry once automatically only for classified transient process/I/O failure, visibly. Validation, missing assets, or deterministic FFmpeg errors require correction. Cancellation sends graceful termination, then force-kills after a short bound; canceled output is never promoted.
- Render to a unique temp directory on the same volume, fsync/close, probe and decode, then atomically move output. Cache normalized intermediates by source hash plus transform/version; enforce size/LRU limits. Startup reconciles interrupted jobs and stale temp directories; cleanup retains failed diagnostics for a bounded period.
- Cloud rendering is excluded until users demonstrate inadequate local hardware or paid unattended exports and consent to asset upload. If triggered, reuse signed RenderJob/project bundle; do not move browser credentials to cloud.

## Browser Execution

- Package a tested Playwright/Chromium pair with the desktop release; record versions per run and block unsupported external binaries.
- Store auth profiles encrypted through OS keychain-protected keys, separate from projects/backups/logs. Default to disposable demo accounts and synthetic fixtures.
- Preflight resolves/records allowed app/auth origins, required approvals, reset readiness, browser version, disk space, and selectors. Role/label/test-id locators remain preferred; arbitrary coordinate clicking is not persisted.
- Consequential actions require visible per-plan approval. Malicious pages cannot invoke preload APIs; Electron uses context isolation, sandboxed renderer, no Node integration, strict navigation/window controls, and a CSP.
- Action/checkpoint failure stops with trace/screenshot/URL/console/DOM excerpt. User corrects the declared target/checkpoint and starts a visible new attempt. No automatic selector healing until measured benign drift meets the PRD evidence rule.
- Optional headless/CI mode remains future work and must reuse the same signed flow/policy/checkpoint contracts.

## AI Layer

- Desktop constructs a bounded disclosure manifest: brief, flow summary, current scene/project summary, selected probes/screenshots/contact sheets, verification failures, correction request, prompt/tool versions, and explicit asset hashes. UI previews what will be sent.
- Hosted proxy authenticates entitlement, redacts/rejects forbidden fields, calls one pinned model, streams typed tool requests back; local agent controller validates current revision and executes tools. Neither server nor model obtains filesystem/browser access.
- Use the POC's inspection/operation/verify/render tools. Add an operation only after accepted user corrections repeatedly need it and tests define its render semantics.
- Bound turns, tokens, renders, and wall time. Retry one timeout/transient provider failure with the same prompt/version and a new attempt ID. Invalid call rate and stale revision are visible; ambiguity ends the run.
- Store prompt/tool-schema/model versions with each attempt. Before a model-version change, run the fixed eval set and compare valid-call, render-without-repair, grounding, correction-time proxy, and safety outcomes. Roll back via server policy.

## Verification and Human Review

Pipeline: preflight policy -> action/checkpoint verification -> capture media integrity -> project/revision invariants -> RenderJob validation -> post-render probe/full decode -> targeted visual invariants -> human acceptance. Regression fixtures cover exact job/project semantics; MP4 validation is semantic rather than cross-platform byte equality.

Automation may verify declared UI state, file/hash existence, ranges, mapping completeness, duration, dimensions/fps/codecs/audio, overlay safe areas/intervals, blank/frozen intervals, and reconciliation preservation. Human review owns feature truth beyond declared checkpoints, copy accuracy, pacing, aesthetics, audio acceptability, and permission to publish.

## Persistence and Privacy

| Data | Location / lifetime |
|---|---|
| Project metadata, revisions, captures, screenshots, renders | Local, permanent until user-confirmed project deletion; configurable failed-debug retention. |
| Browser credentials/storage | Local encrypted auth profile; never in project/export/telemetry/model request. |
| Render/model temp files | Local unique temp dirs; removed after success/cancel or bounded diagnostic retention. |
| Account, entitlement, invoices | Hosted, retained for account/legal needs. |
| Selected model evidence | Encrypted transit; hosted only for request execution and shortest configurable provider-compatible retention; disclosure recorded locally. |
| Telemetry | Hosted only with explicit consent; pseudonymous metrics, no URLs/copy/screenshots/traces by default. |
| Crash attachments | Local preview and explicit opt-in upload; scrubbed before transfer. |

Deletion is explicit and recoverable through OS trash where practical; it covers metadata, assets, derived media, local model-context caches, and auth profile only when separately selected. Uploaded temporary objects use lifecycle deletion. Logs redact authorization, cookies, tokens, form secrets, URL query values, and user text unless explicitly attached.

## Security Threats and Controls

- **Auth/session theft:** OS keychain, file permissions, separate profiles, no sync/export, revocation instructions.
- **Sensitive screens/model exposure:** synthetic data default, capture warning, origin allowlist, disclosure preview, per-artifact consent, minimal crops/summaries, local audit.
- **Malicious pages:** isolated browser context and Electron renderer, blocked downloads/popups/new origins unless approved, no shell/preload capability, upload paths restricted to approved fixtures.
- **Tool injection/model misuse:** closed schemas, revision preconditions, operation validation, no arbitrary code/paths/commands, budgets, output-grounding checks.
- **Uploaded assets/control plane:** short-lived signed object access, encryption, tenant authorization, lifecycle deletion, MIME/size validation; no public buckets.
- **Temporary files:** per-job directories, restrictive permissions, startup cleanup, never interpolate untrusted text into shell commands.

## Reliability and Recovery

| Failure | Production behavior |
|---|---|
| Partial capture/UI change | Retain completed immutable scenes and exact failure evidence; resume only from an approved scene boundary after reset/checkpoint validation. |
| Model timeout/invalid tool | One visible retry; reject invalid call atomically; manual bounded editor remains usable. |
| Corrupt/missing scene | Quarantine/block affected render, show provenance, restore from backup or recapture; unrelated scenes remain inspectable. |
| Failed/interrupted render | Durable job becomes failed/interrupted; retry idempotently from immutable revision; never promote partial output. |
| Browser/version mismatch | Block preflight and offer signed app/browser update; do not silently use system Chrome. |
| Stale revision | Reject with current revision and allow user/model to rebase by re-inspection; no last-write-wins. |
| Interrupted desktop process | WAL/transactions and startup job reconciliation restore last complete revision and classify running jobs. |
| Control-plane outage | Local projects/manual edits/render continue; AI and fresh entitlement operations show actionable unavailable state. |

## Performance Budgets

Measure on declared minimum and reference machines with a 10-scene/60-second project.

- Project open <=3 seconds p95; operation commit/UI response <=250 ms p95.
- Storyboard thumbnails visible <=2 seconds p95; local proxy playback starts <=1 second after cached and <=5 seconds uncached.
- Validated flow capture plus first draft <=5 minutes; single-scene recapture plus revised draft <=3 minutes.
- Model plan first tool <=30 seconds after upload; complete bounded agent pass <=2 minutes excluding render.
- Authoritative 30-second render <=90 seconds and 60-second render <=3 minutes on reference hardware.
- In-scope project soft cap: 10 scenes, 60 seconds output, 5 GB local assets. Warn before cap; refuse agent expansion, but allow export/delete.

Optimize only a measured p95 breach. Record stage timings locally and upload aggregates only with consent.

## Testing and CI/CD

- **Unit:** schemas/migrations, reducer/replay, duration/safe area, redaction, policy, retry/cancel state machines.
- **Integration:** SQLite + asset store, capture-to-project, tool-to-revision, RenderJob-to-output, control-plane contracts/webhooks.
- **E2E:** packaged desktop create/approve/capture/agent/manual edit/reopen/recapture/export/revert/delete across supported OS targets.
- **Fixtures:** deterministic media/render jobs, browser Apps A/B/C plus validated customer-like flows, every project migration, agent eval and regression video corpus.
- **Failure injection:** process kill during DB write/render, disk full, missing asset, corrupt media, network/provider outage, stale revision, browser drift, malicious origin/tool call.

Pull requests run lint/typecheck/unit/schema and tiny render fixtures. Nightly runs browser, full render, migration, agent eval (budget-capped), and packaged smoke tests. Release candidates run all tiers on supported OSes, upgrade fixtures from the previous two minor versions, install/update/rollback, signing verification, and fixture-result review. Use one mainline release workflow, signed desktop artifacts, staged update channels, control-plane migrations with expand/migrate/contract ordering, and rollback-compatible API changes. No Kubernetes or custom release platform.

## Observability, Deployment, and Cost

Use hosted error reporting and off-the-shelf privacy-aware analytics. Signals: capture/checkpoint success, first/final render success, recapture/preservation success, correction minutes, invalid/model tool rate, plans rendering without repair, export latency, crashes, update failures, and funnel publication/payment/repeat indicators. Correlate with pseudonymous attempt/release IDs; never collect project content by default.

Deploy one stateless control-plane container in one region, managed Postgres, lifecycle-managed object storage, TLS/custom domain, daily backups, and provider dashboards/alerts. Scale vertically first. Desktop auto-update uses signed stable/alpha channels and an explicit rollback path.

Cost controls: per-account model token/render/tool budgets and context caps; thumbnails/crops before full screenshots; no idle GPU; local render by default; storage TTL/size limits; sampled/redacted logs; compressed uploads; TTS absent unless P1 evidence promotes it and then charged per use. Track variable cost per accepted/exported video and block broader rollout if contribution is negative.

## Production Rollout Gates

1. **Internal:** migration/recovery and regression corpus green; founders complete ten end-to-end projects without undocumented repair; no secret leakage.
2. **Alpha:** five validated users; >=4 export, >=3 correct without founder operation, median correction <10 minutes; support failures attributable.
3. **Pilot:** twenty out-of-network users; >=60% publish/send, >=40% repeat intent/use, selective recapture >=90%, final render >=98%; privacy consent understood.
4. **Paid beta:** at least five recurring customers across two billing periods, positive contribution, billing/recovery/support ready, founder intervention <20%.
5. **Broader availability:** paid-beta targets hold for two releases; crash-free sessions and core reliability budgets meet chosen thresholds; support load fits two founders. Otherwise hold, narrow, or stop.
