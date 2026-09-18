# Replex POC Completion and Minimal PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Release Replay POC with attributable live evidence, record a production-readiness handoff without deploying production, then add a minimal installable PWA on a dependent branch from PR #8.

**Architecture:** The TypeScript core owns canonical projects, validated operations, bounded agent tools, verification, RenderJob, and FFmpeg output. OpenAI `gpt-5.6-luna` is the requested agent LLM; its API availability must be verified during execution. The root `.env` supplies the key to the Node process. After CLI completion, an installable PWA submits typed commands to a loopback Node service using the same core functions. Project state and credentials stay in Node.

**Tech Stack:** Node.js LTS, TypeScript ESM, npm, Zod, Vitest, Playwright/Chromium, OpenAI JavaScript SDK Responses API custom function tools, FFmpeg/ffprobe, and a minimal Vite/React PWA only after the POC gate.

**Spec:** `Docs/PRD.md`, `Docs/poc/task.md`, `Docs/poc/implementation-plan.md`, `Docs/poc/technical_poc.md`, `Docs/production/implementation-plan.md`, `Docs/production/prod_stack.md`.

## Global Constraints

- A checked task means its complete acceptance criterion has retained evidence; passing unit tests alone does not check POC-9 through POC-15.
- Every measured POC run must include one real model-driven edit through the existing typed tool boundary; recorded transcripts are regression evidence only.
- The model cannot access shell, filesystem enumeration, browser control, JavaScript, FFmpeg arguments, secrets, or direct manifest writes.
- The reducer in `src/operations.ts` remains the sole mutation boundary for manual and model edits.
- The agent LLM is exactly `gpt-5.6-luna`; model availability errors are recorded as failed evidence, never hidden by substituting another model or environment override.
- Model limits remain 20 total tool calls, two edit passes, two renders, one transport retry, and a two-minute model wall-time budget excluding local render.
- Credentials and storage state remain outside projects and source control; never print or persist the API key.
- POC PASS does not authorize production. Production work starts only after every POC-15 gate is evidenced, a human explicitly approves the production gate, and the production checklist is signed.
- The PWA wraps project selection, approved capture, agent draft, bounded correction, verification, selective recapture, and video export. One project workspace is sufficient; accounts, cloud storage, billing, and a general timeline are excluded.

---

## Phase A: Finish the POC before any PWA work

### Task 0: Establish the execution base and audit existing claims

- [x] Refresh PR #7 and #8 heads and ancestry. Continue CLI completion on PR #8's branch above #7; create the PWA branch only after CLI completion. If the stack was merged meanwhile, use its verified integrated descendant and document the changed base.
- [x] Preserve the root `.env` and unrelated changes. Execution was authorized on 2026-09-09.
- [ ] Audit POC-1 through POC-8 against actual tests and retained artifacts. Earlier checkmarks and the 130-test result are historical evidence, not proof of all specified acceptance cases.
- [ ] In particular, inspect overlay text injection, boundary-frame verification, real image disclosure, cumulative model timeout/retry limits, and invalidation of verification after each edit. Add missing work to the relevant task below before marking it complete.
- [ ] Select an OpenAI SDK release whose declared peers support the project's Zod version. OpenAI 7.10.0 supports Node 22 and Zod 4; complete this item after a clean `npm ci` without forced resolution.

### Task 1: Migrate the live agent adapter to OpenAI

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`, `package-lock.json`
- Modify: `Docs/poc/implementation-plan.md`, `Docs/poc/technical_poc.md`, `Docs/poc/DEPLOYMENT.md`, `Docs/poc/task.md`
- Test: `tests/agent.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Preserve `runRecordedAgentDraft(project, root, calls)` and the dispatcher contract unchanged.
- Replace the provider-specific live seam with `runOpenAIDraft(project, root)` and an `OpenAIClient` adapter that returns the existing `RecordedToolCall` shape.
- Use the Responses API custom function-tool shape `{ type: "function", name, parameters, strict: true }`; map `function_call` output items to tool calls and send `function_call_output` items back by `call_id`.
- Load only `OPENAI_API_KEY` from the root `.env`; keep `gpt-5.6-luna` fixed and redact values in errors and audit logs.

- [x] Add an adapter test asserting the request uses model `gpt-5.6-luna`, Responses API tools, and Responses continuation output.
- [x] Add a `.env` loading test that proves a key is consumed without creating output artifacts.
- [x] Install the official `openai` package and remove the Anthropic dependency after the new tests identify all imports.
- [x] Implement the adapter and preserve the existing retry, budget, evidence-grounding, verification, and render dispatch behavior.
- [ ] Run `npm run build` and `npx vitest run tests/agent.test.ts tests/cli.test.ts --maxWorkers=1`; expected result is zero failures.
- [x] Run a harmless OpenAI Responses API capability probe using the configured key and exact model `gpt-5.6-luna` without printing the key; it completed successfully on 2026-09-09.

### Task 2: Produce the real App A agent draft (POC-9)

**Files:**
- Modify: `Docs/poc/task.md`
- Create: `work/evaluation-<date>/normal-attempt-1/`
- Use: `fixtures/operator.ts`, `src/cli.ts`, `src/agent.ts`, `src/report.ts`

- [ ] Start App A with `npm run fixtures -- serve` and verify health before capture.
- [ ] Bootstrap a fresh project under `work/evaluation-<date>/normal-attempt-1` from reset state; retain all capture, trace, screenshot, action, and manifest artifacts.
- [ ] Run `verify`, `baseline`, and `report` to retain the deterministic comparison artifact.
- [ ] Run `agent-draft` with the OpenAI adapter and retain `logs/agent.jsonl`, accepted operations, grounding references, usage metadata, RenderJob, sanitized argv, verification, and final MP4.
- [ ] Re-run the accepted operation sequence from its parent revision and compare semantic hashes; no manual manifest repair is allowed.
- [ ] Check POC-9 only after a model-created accepted sequence, verified MP4, grounding records, and replay hash are all present.

### Task 3: Close verification and targeted render evidence (POC-10)

**Files:**
- Modify: `src/verify.ts`, `src/inspect.ts` only if a proven invariant is missing
- Test: `tests/verify.test.ts`, `tests/render.test.ts`
- Create: `tests/fixtures/failures/` only for missing acceptance cases
- Modify: `Docs/poc/task.md`

- [ ] Enumerate POC-10 invariants against `verifyProject`, `buildRenderJob`, and persisted verification output.
- [ ] Add the smallest failing fixtures for missing/corrupt media, blank/frozen media, invalid overlay ranges, wrong streams, stale hashes, and overlay-boundary frames.
- [ ] Implement only missing guards; failed required checks must block authoritative render and preserve the first causal stage/evidence.
- [ ] Run the focused verification/render suites with real FFmpeg/ffprobe paths and inspect retained evidence files.
- [ ] Check POC-10 only when each required invariant has a test and a persisted failure result.

### Task 4: Execute App A selective recapture (POC-11)

**Files:**
- Use/modify: `src/reconcile.ts`, `src/capture.ts`, `tests/reconcile.test.ts`
- Create: `work/evaluation-<date>/normal-recapture/`
- Modify: `Docs/poc/task.md`

- [ ] Apply the fixture's controlled App A change without changing approved scene keys or flow intent.
- [ ] Recapture only the affected scene into a new attempt directory; preserve predecessor bytes and evidence.
- [ ] Apply `replace_capture` to the current verified revision and retain lineage/audit records.
- [ ] Compare unaffected source IDs, overlays, operations, timing, focus, and order before/after; reject incompatible retained ranges without clamping.
- [ ] Render and probe the revised revision; check POC-11 only when preservation and lineage evidence are retained.

### Task 5: Prove live agent edits survive recapture (POC-12)

**Files:**
- Use/modify: `src/reconcile.ts`, `src/report.ts`, `tests/integration/agent-recapture.test.ts`
- Create: `work/evaluation-<date>/normal-agent-recapture/`
- Modify: `Docs/poc/task.md`

- [ ] Start from the real OpenAI agent revision from Task 2, not a hand-authored transcript.
- [ ] Apply the controlled recapture from Task 4 to that current revision.
- [ ] Retain semantic before/after preservation output and recapture lineage in the report.
- [ ] Render/probe the revised video and verify that unrelated title/callout/focus/order/timing edits survive without manifest repair.
- [ ] Check POC-12 only after the real agent sequence and revised render are both retained.

### Task 6: Run Apps B and C through the same live path (POC-13)

**Files:**
- Use: `fixtures/apps/dynamic/`, `fixtures/apps/difficult/`, `fixtures/operator.ts`
- Test: `tests/browser/dynamic.spec.ts`, `tests/browser/difficult.spec.ts`, `tests/integration/fixture-poc13.test.ts`
- Create: `work/evaluation-<date>/{dynamic,difficult}-attempt-{1,2}/`
- Modify: `Docs/poc/task.md`

- [ ] Confirm deterministic reset, auth isolation, async/difficult interaction, changed state, and named failure injection for each fixture.
- [ ] Execute two fresh attempts per app, retaining first-pass failures and retries.
- [ ] For every successful measured attempt, run the OpenAI agent, verification, render, controlled recapture, and revised render through the existing boundaries.
- [ ] Confirm no fixture bypasses its normal interface and all capture/scene IDs remain stable across the changed state.
- [ ] Check POC-13 only after both apps have baseline, live agent draft, and selective-recapture evidence.

### Task 7: Collect the six-run adversarial evaluation (POC-14)

**Files:**
- Use/modify: `src/evaluation.ts`, `src/report.ts`, `tests/evaluation.test.ts`
- Create: `tests/adversarial/`, `work/evaluation-<date>/rows.json`
- Modify: `Docs/poc/task.md`

- [ ] Run Apps A/B/C twice from reset; record browser, capture, edit, model, verify, render, and recapture status for every attempt.
- [ ] Retain all nine required final outputs, preservation evidence, failed attempts, interventions, retries, and fault-attribution artifacts.
- [ ] Record provider/model/version, tool validity, grounding rate, latency/cost, correction minutes, replay success, and manual-repair outcome.
- [ ] Conduct three target-user usefulness reviews with timed correction and “would publish/send” answers; retain consented review records without secrets.
- [ ] Run the evaluation schema, artifact-completeness, contradiction, and secret-scan checks.
- [ ] Check POC-14 only when raw rows and required artifacts exist for all six attempts.

### Task 8: Make and retain the POC gate decision (POC-15)

**Files:**
- Use/modify: `src/evaluation.ts`, `tests/evaluation.test.ts`
- Create: `work/evaluation-<date>/summary.json`, `work/evaluation-<date>/decision.md`
- Modify: `Docs/poc/task.md`

- [ ] Recompute every PRD threshold from raw rows; do not edit thresholds to obtain a pass.
- [ ] Separate first-attempt, recovered, and final outcomes; classify each failure by first causal stage.
- [ ] Persist exactly one `PASS`, `FAIL`, or narrowly bounded `REWORK` decision with evidence links.
- [ ] Ensure the decision explicitly states `productionAuthorized: false` until the separate production gate is approved.
- [ ] Check POC-15 only after the validator rejects missing/contradictory evidence and the decision names every gate.

### Task 9: Production handoff gate (no implementation yet)

**Files:**
- Create: `Docs/poc/PRODUCTION_HANDOFF.md`
- Read: `Docs/production/implementation-plan.md`, `Docs/production/prod_stack.md`

- [ ] Record the POC decision, evidence root, exact commit/PR ancestry, model/provider version, local tool versions, and known residual risks.
- [ ] Apply `Docs/production/task.md` PROD-0 exactly: POC PASS, concierge and five-user gates passed, founder approval of production scope/spend, and decisions supported by current evidence. Ten founder projects and production recovery tests belong to later release readiness, not permission to start production implementation.
- [ ] Define the first production slice as the documented Tauri 2 + React/Vite + Node sidecar direction; do not build it in this plan.
- [ ] State that POC PASS alone never enables cloud accounts, billing, hosted model proxy, telemetry, or automatic deployment.
- [ ] Record production as HOLD until PROD-0 passes. Continue the separately requested PWA phase after POC completion; production approval is not a prerequisite for that POC wrapper.
- [ ] Map reusable contracts to production: project schema/version and assets, reducer/replay tests, capture provenance, agent tools, verification results, and RenderJob. Retain a portable project fixture that the future Node sidecar must reopen without semantic drift.
- [ ] Map remaining production work to the existing backlog: crash recovery, migrations/revert, bundled tool versions, Tauri supervision, OS secret storage, signed installer/updater, and release rollback. A signed checklist alone cannot prove these capabilities.
- [ ] Demonstrate the local CLI from a fresh checkout: documented install, external-tool preflight, root environment loading, real capture, draft, reopen, recapture, and export with no undocumented manifest edits. Record commands, versions, output hashes, and known platform limits.

## Phase B: Minimal PWA after PR #8 and after the POC gate

### Task 10: Create the dependent PWA branch

- [ ] Confirm PR #8 is merged or explicitly use its head commit as the dependent base; do not branch from `main`.
- [ ] Create `feat/poc-pwa` from `feat/poc-render-assets`/PR #8 head and keep the PR stacked on #8.
- [ ] Read and announce the `hallmark` and `design-taste-frontend` skills before making UI changes.

### Task 11: Build the smallest useful PWA shell

**Files:**
- Create: `pwa/package.json`, `pwa/index.html`, `pwa/src/main.tsx`, `pwa/src/App.tsx`, `pwa/src/styles.css`, `pwa/public/manifest.webmanifest`, `pwa/public/sw.js`, `pwa/public/icons/`
- Modify: root `package.json` only if one root command is needed
- Test: `pwa/src/App.test.tsx` or a browser smoke test

- [ ] Implement one workspace: select a server-authorized project, review and approve its declared flow, capture, request an agent draft, correct a scene using existing operations, verify, recapture a selected scene, and play/download the authoritative video.
- [ ] Add `src/server.ts` and `tests/server.test.ts` for a same-origin loopback bridge. Serve the built PWA and accept only named typed commands; reject arbitrary paths, shell text, unauthorized origins, stale revisions, and duplicate mutation requests. Serialize writes per project and return a job ID for capture/model/render work so requests do not block the interface.
- [ ] Extract shared orchestration from `src/cli.ts` only where needed so CLI and HTTP call the same functions. Keep the server out of the core import graph. Return bounded job status and sanitized errors; never return the key or raw storage state.
- [ ] Reuse existing report/evidence JSON shapes; do not reimplement project mutation, model calls, recapture, or FFmpeg in the browser.
- [ ] Add installable manifest with 192/512 pixel icons, service worker, and offline shell. Cache versioned shell assets only; exclude credentials, API responses, project media, and mutations. When Node is unavailable, show a disconnected state and disable execution. Internet loss additionally disables agent calls; local operations may continue while Node is reachable.
- [ ] Use the hallmark/taste direction to establish a deliberate visual system with clear hierarchy and non-template spacing; avoid gradients, generic dashboard cards, and decorative UI without evidence value.
- [ ] Add only the assets and dependencies required for the shell; no auth, cloud sync, billing, or remote APIs.

### Task 12: Verify and publish the PWA PR

- [ ] Run PWA typecheck/build and browser smoke tests from a clean install.
- [ ] Verify installability, offline reload, keyboard navigation, mobile layout, report/video loading, and missing-evidence states.
- [ ] Prove UI edits pass through the same reducer as CLI edits and produce identical semantic hashes. Prove the browser cannot invoke arbitrary processes or bypass project authorization. Test duplicate clicks, stale revisions, server restart, failed jobs, and service-worker updates.
- [ ] Verify an end-to-end PWA flow from approved capture through agent draft, correction, selective recapture, and export. Run viewport checks at 320, 375, 414, 768, and 1440 pixels, keyboard-only navigation, contrast checks, and reduced-motion checks.
- [ ] Capture a screenshot/evidence directory for review and scan staged files for secrets.
- [ ] Create a concise PR targeting PR #8's branch, report the dependency chain `#7 -> #8 -> PWA`, and leave production deployment unchanged.

## Completion definition

POC completion requires all POC acceptance criteria and a retained PASS decision. REWORK/FAIL records an outcome without satisfying completion. PWA completion requires an installable workspace that executes the existing workflow through the local service, with browser evidence and a dependent PR. Production implementation starts after PROD-0; production release requires the subsequent packaging, recovery, security, and rollout evidence in the production backlog.

## Evaluation accounting and execution handoff

Tasks 2 through 6 are development rehearsals. Freeze the implementation and fixture definitions before Task 7. The official evaluation is exactly six initial runs (A1, A2, B1, B2, C1, C2), plus one selective recapture per application: six initial final videos and three revised videos. Additional baselines are comparison artifacts, not extra counted successes. Keep failed first attempts and every retry under distinct IDs; if code changes during evaluation, preserve that batch and start a separately identified batch.

The gate requires at least 5/6 unattended browser completions, all accepted checkpoints passing, 3/3 preservation proofs, nine valid final videos, median correction below ten minutes with none above twenty, at least 2/3 target reviewers willing to use the output, and no safety/privacy breach. Apply the remaining PRD section 17 criteria and recorded performance/model metrics as written. Missing reviewer evidence stays pending; agents cannot supply human reviews.

Each implementation task follows: reproduce the uncovered behavior, add its regression check, implement, run the focused checks, inspect evidence, then update the checklist. Run the full suite on the final CLI tree and again only when later changes affect that scope. The release rehearsal must demonstrate a clean install, not merely reuse this workstation's installed dependencies.

Hallmark owns token consistency, hierarchy, genuine capture imagery, interaction states, and viewport review. `design-taste-frontend` section 13 excludes dense product interfaces: apply its relevant typography, restraint, and entry-surface guidance without adding a marketing page or decorative motion. Select and record actual design tokens during the PWA task after reading the applicable skill references.

Execution resumed by explicit user instruction on 2026-09-09. Continue task-by-task; do not begin the PWA before the POC gate.
