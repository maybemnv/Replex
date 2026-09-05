# Release Replay POC Tasks

> Execute only after reading `Docs/PRD.md` and `Docs/poc/implementation-plan.md`. Each task is a reviewable capability; no task authorizes production infrastructure.

> Implementation status — 2026-09-05: POC-1 through POC-5 meet their local implementation and test criteria. POC-6 through POC-13 have substantive implementation and recorded/local evidence, but remain unchecked until their listed acceptance evidence is complete. POC-8, POC-9, and POC-12 specifically still require an operator-configured real Claude run; POC-10, POC-14, and POC-15 are still being completed. A checked item means the entire acceptance criterion is evidenced, not merely that code exists.

- [x] POC-1: Establish the minimal local runtime

  - Goal: Make one TypeScript CLI executable with schema validation, tests, and startup checks for Chromium, FFmpeg, and ffprobe.
  - Depends on: None.
  - Files/modules: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `src/cli.ts`, `src/schema.ts`, `tests/schema.test.ts`.
  - Implementation: Use npm, Node LTS, ESM, TypeScript, Zod, Vitest, and Playwright. Add only the commands required by later tasks and keep generated projects under gitignored `work/`.
  - Acceptance criteria: CLI help lists capture/baseline/agent-draft/verify/render/recapture/report; invalid config fails with a structured error; missing external binaries are named before work begins.
  - Tests: Schema rejects unknown fields/mixed units; CLI smoke test returns success for help and a typed failure for missing tools.
  - Out of scope: Installer, desktop shell, web server, database, monorepo, CI, accounts.

- [x] POC-2: Run one approved Playwright flow safely

  - Goal: Execute one hard-coded App A flow only within approved actions and origins.
  - Depends on: POC-1.
  - Files/modules: `src/capture.ts`, `fixtures/apps/normal/flow.ts`, `fixtures/apps/normal/reset.ts`, `tests/browser/normal.spec.ts`.
  - Implementation: Define stable author-controlled action IDs, semantic targets, checkpoints, allowed origins, prohibited actions, fixed browser settings, and per-attempt fresh contexts. Load optional auth state only from an operator path outside the project.
  - Acceptance criteria: Flow reaches every checkpoint twice from reset state; unapproved consequential action and off-origin navigation fail before execution; retries remain separate attempts.
  - Tests: Playwright success run, checkpoint mismatch, denied origin, denied action, expired-auth simulation.
  - Out of scope: Autonomous exploration, selector healing, multiple browsers, cloud execution.

- [x] POC-3: Capture traceable immutable source scenes

  - Goal: Convert the App A run into 3-5 immutable scene captures with complete action provenance.
  - Depends on: POC-2.
  - Files/modules: `src/capture.ts`, `src/schema.ts`, `tests/capture.test.ts`, `work/<id>/{captures,screenshots,traces,logs}`.
  - Implementation: Instrument action/scene boundaries, record video/trace/screenshots/console/timing/checkpoints, finalize the run, split source clips by monotonic boundaries, probe/fingerprint them, and never overwrite bytes.
  - Acceptance criteria: Every capture links to run/action/checkpoint IDs and has valid duration/dimensions/hash; first failure preserves screenshot, bounded DOM/accessibility excerpt, URL, console, and trace.
  - Tests: Complete capture fixture, interrupted action fixture, immutable-file/hash assertion, no-empty-capture check.
  - Out of scope: Live streaming, custom recorder, production retention.

- [x] POC-4: Materialize stable project and scene identity

  - Goal: Persist the minimum canonical manifest and initial revision without deriving narrative identity from volatile media or selectors.
  - Depends on: POC-3.
  - Files/modules: `src/schema.ts`, `src/project.ts`, `tests/project.test.ts`, `tests/golden/project-v1.json`.
  - Implementation: Embed environment/flow, generate scene IDs from project ID plus approved scene key, store capture records keyed by immutable identity, use milliseconds, reject unknown fields, hash semantic state, and write revisions atomically.
  - Acceptance criteria: Rerunning the unchanged flow retains action/scene IDs while producing new run/capture IDs; a load after interrupted write returns the last complete revision.
  - Tests: Schema round-trip, stable-ID rerun, semantic-hash golden, simulated atomic-write interruption.
  - Out of scope: Database, migrations beyond schema version 1, universal edit graph.

- [x] POC-5: Implement the deterministic operation reducer

  - Goal: Provide the sole mutation boundary shared by baseline controls and the model.
  - Depends on: POC-4.
  - Files/modules: `src/operations.ts`, `src/schema.ts`, `tests/operations.test.ts`.
  - Implementation: Implement `create_scene`, `trim_scene`, `reorder_scene`, `replace_capture`, `set_speed`, `set_focus`, `set_title`, `set_callout`, and `set_transition` as a discriminated union; validate fully before pure mutation; atomically create a revision; audit rejection.
  - Acceptance criteria: Same parent plus ordered inputs yields the same semantic hash; malformed name/ID/range/value/stale parent creates no revision or partial state; source bytes never change.
  - Tests: One valid and boundary-invalid case per operation, stale revision, exact-set reorder, replay determinism, atomic batch rejection.
  - Out of scope: Delete, audio mixing, arbitrary effects, plugins, direct JSON editing.

- [ ] POC-6: Produce the non-AI vertical render baseline

  - Goal: Render a terrible but valid 30-second App A MP4 through manual/hard-coded operations, proving mechanics independently of model quality.
  - Depends on: POC-5.
  - Files/modules: `src/verify.ts`, `src/render.ts`, `src/report.ts`, `tests/render.test.ts`, `fixtures/media/`.
  - Implementation: Verify project invariants, build authoritative RenderJob, generate fixed overlay assets, create known FFmpeg argv, render/ffprobe/decode, and generate a static HTML scene/evidence report.
  - Acceptance criteria: Verified 3-5-scene revision renders 25-35 seconds at 1920x1080/30fps H.264/AAC; silent AAC exists if sources lack audio; report exposes scene order, provenance, operations, checks, and video.
  - Tests: Render-job golden, full tiny-fixture render/probe/decode, overlay-boundary frames, missing/corrupt/blank asset blocks render.
  - Out of scope: Interactive preview, timeline, arbitrary FFmpeg/filtergraph, creative scoring.

- [ ] POC-7: Expose bounded inspection tools

  - Goal: Let a model inspect only relevant structured evidence without filesystem or secret access.
  - Depends on: POC-4, POC-6.
  - Files/modules: `src/inspect.ts`, `src/schema.ts`, `tests/inspect.test.ts`.
  - Implementation: Add `inspect_project`, `inspect_flow`, `inspect_scene`, `inspect_capture`, `inspect_browser_trace`, `inspect_verification_results`, and targeted contact-sheet/screenshot retrieval with response caps and disclosure logging.
  - Acceptance criteria: Default context stays within the plan's 12k-token target; raw storage state, secrets, unrestricted traces, unrelated screens, and path enumeration cannot be requested.
  - Tests: Golden bounded responses, truncation, missing ID, redaction canaries, artifact-disclosure log.
  - Out of scope: Vector search, media transcription, generic query language, MCP server.

- [ ] POC-8: Connect one Claude model to validated tools

  - Goal: Execute a bounded real tool loop without creating a second mutation path.
  - Depends on: POC-5, POC-7.
  - Files/modules: `src/agent.ts`, `src/schema.ts`, `tests/agent.test.ts`.
  - Implementation: Register inspection tools, operation tools, `verify_project`, `render_draft`, and `inspect_render_result`; enforce 20 calls, two edit passes, two renders, timeout, one visible retry, current revision preconditions, and evidence citations for generated copy/choices.
  - Acceptance criteria: Every mutation reaches `operations.ts`; model cannot emit shell/FFmpeg/JS/direct-manifest writes; invalid/repeated/ambiguous requests stop with intact state and audit trail.
  - Tests: Stubbed valid transcript; unknown tool, malformed args, stale revision, invented fact, secret request, shell request, and budget exhaustion transcripts.
  - Out of scope: Chat UI, provider abstraction, model routing, multi-agent loop, dynamic tools.

- [ ] POC-9: Generate and render the first agent-edited draft

  - Goal: Prove agent -> tools -> revision -> verification -> render on App A.
  - Depends on: POC-8.
  - Files/modules: `src/agent.ts`, `src/report.ts`, `tests/integration/agent-draft.test.ts`, `work/<id>/logs/agent.jsonl`.
  - Implementation: Supply the brief/default inspection, let the real model inspect selectively and apply bounded edits, verify, render, target-inspect, and optionally take one second edit pass.
  - Acceptance criteria: A model-created accepted operation sequence produces a valid MP4 without manual JSON repair; every accepted text/order/focus/timing choice records grounding; the sequence replays to the same semantic state.
  - Tests: Recorded tool-sequence replay, valid render/probe, reviewer comparison against deterministic baseline, operation-grounding audit.
  - Out of scope: Claiming creative quality from model self-review, open-ended iteration.

- [ ] POC-10: Complete verification and targeted render inspection

  - Goal: Make explicit correctness failures machine-checkable while leaving taste to humans.
  - Depends on: POC-6, POC-9.
  - Files/modules: `src/verify.ts`, `src/inspect.ts`, `tests/verify.test.ts`, `tests/fixtures/failures/`.
  - Implementation: Check browser completion/checkpoints, mappings, hashes, ranges, unique IDs, total duration, safe overlays, allowed primitives, blank/frozen intervals, streams/codecs/dimensions/fps/end decode, and required overlay frames.
  - Acceptance criteria: Any failed required invariant blocks authoritative render or marks a rendered draft rejected; result names first causal stage and evidence; no result calls output tasteful/publishable.
  - Tests: One fixture per invariant plus a valid end-to-end fixture; render-boundary frame assertions.
  - Out of scope: General computer-vision quality score, LLM-as-judge pass gate.

- [ ] POC-11: Reconcile one selectively recaptured scene

  - Goal: Replace changed source media while retaining scene identity and all unrelated project state.
  - Depends on: POC-5, POC-10.
  - Files/modules: `src/reconcile.ts`, `src/capture.ts`, `tests/reconcile.test.ts`.
  - Implementation: Recapture an approved scene key after a known App A change, create immutable capture/predecessor lineage, validate compatibility, apply `replace_capture` to the current revision, and compare unaffected semantic projections.
  - Acceptance criteria: Target scene ID survives; capture ID changes; unaffected source IDs, edits, overlays, and operations compare equal; incompatible retained ranges fail rather than clamp.
  - Tests: Successful replacement, wrong scene key, short/incompatible capture, preservation mismatch, revised render/probe.
  - Out of scope: Automatic invalidation detection, multi-scene recapture scheduling.

- [ ] POC-12: Prove agent edits survive recapture

  - Goal: Demonstrate that selective recapture preserves the accepted agent-generated edit sequence where unrelated.
  - Depends on: POC-9, POC-11.
  - Files/modules: `src/reconcile.ts`, `src/report.ts`, `tests/integration/agent-recapture.test.ts`.
  - Implementation: Apply recapture to the current agent revision, explicitly revalidate target-scene ranges, render the new revision, and show before/after preservation plus lineage in the report.
  - Acceptance criteria: Unrelated agent title/callout/focus/order/timing edits remain; affected-scene edits remain when valid or fail with a named incompatibility; revised video verifies without manual manifest repair.
  - Tests: Agent transcript replay -> recapture -> semantic diff -> render; affected-range invalidation case.
  - Out of scope: Asking the model to rediscover all edits after every recapture.

- [ ] POC-13: Add dynamic and difficult application fixtures

  - Goal: Exercise identical capture/project/agent/render/reconcile paths against Apps B and C.
  - Depends on: POC-3, POC-12.
  - Files/modules: `fixtures/apps/dynamic/`, `fixtures/apps/difficult/`, `tests/browser/dynamic.spec.ts`, `tests/browser/difficult.spec.ts`.
  - Implementation: App B includes auth, async loading, and at least two complex states; App C includes one PRD difficult interaction. Give each deterministic reset, stable action/scene keys, checkpoints, a controlled changed state, and failure injection.
  - Acceptance criteria: Fixtures satisfy PRD complexity definitions and do not bypass normal interfaces; both can produce baseline and agent drafts plus one selective recapture.
  - Tests: Reset determinism, two capture attempts each, async timeout evidence, difficult-interaction success/failure, agent/reconcile/render checks.
  - Out of scope: Three trivial CRUD apps, broad browser compatibility matrix.

- [ ] POC-14: Run the six-run adversarial evaluation

  - Goal: Collect attributable raw evidence for Apps A/B/C rather than a curated demo.
  - Depends on: POC-13.
  - Files/modules: `tests/adversarial/`, `src/report.ts`, `work/evaluation-<date>/`.
  - Implementation: Reset and run each app twice, retain every attempt/retry/intervention, generate agent draft, verify/render, change one state, recapture/render, inject stage failures, and conduct three target-user usefulness reviews with timed correction.
  - Acceptance criteria: One results row per attempt includes browser/capture/edit/model/verify/render/reconcile status; all nine required final outputs and preservation evidence are retained; no failed first pass is hidden.
  - Tests: Evaluation-schema validation, artifact completeness script, fault-attribution assertions, secret scan.
  - Out of scope: Replacing failed measured runs, production load tests, marketing claims.

- [ ] POC-15: Decide the POC gate

  - Goal: Produce an evidence-backed PASS, FAIL, or narrowly bounded REWORK decision for both technical hypotheses and product usefulness.
  - Depends on: POC-14.
  - Files/modules: `work/evaluation-<date>/summary.json`, `work/evaluation-<date>/decision.md`.
  - Implementation: Calculate every PRD gate and agent metric, separate first-attempt from recovered outcomes, classify failures by causal stage, record founder time/cash, and apply kill/narrow/rework rules without moving thresholds.
  - Acceptance criteria: Decision names each gate with evidence; PASS requires every mandatory gate; REWORK names one bounded defect and rerun set; FAIL blocks production and does not prescribe a larger editor by default.
  - Tests: Recompute metrics from raw rows; decision validator rejects missing gates, contradictory totals, or production recommendation after FAIL.
  - Out of scope: MVP/production implementation, retrospective threshold changes.

## Critical Path

`POC-1 -> POC-2 -> POC-3 -> POC-4 -> POC-5 -> POC-6 -> POC-7 -> POC-8 -> POC-9 -> POC-10 -> POC-11 -> POC-12 -> POC-13 -> POC-14 -> POC-15`.

The first usable artifact is POC-6. The first proof of Hypothesis B is POC-9. The differentiating combined proof is POC-12.

## Parallelizable Work

- After POC-4: inspection response design (POC-7) can begin while render fixtures for POC-6 are prepared, but POC-7 completes only after verification result shapes exist.
- After POC-3: App B/C fixture definitions and deterministic resets may be prepared in parallel with POC-4 through POC-12; measured execution waits for POC-12.
- After POC-6: failure media fixtures for POC-10 and agent adversarial transcripts for POC-8 can be developed independently.
- Keep shared schema/operation edits serialized through POC-5 to avoid inventing competing contracts.

## Exit Criteria

- **PASS:** all POC-15 gates pass for both reproducible compilation and real tool-using AI editing; production remains separately gated by external validation.
- **FAIL:** any mandatory gate fails, including usefulness/privacy; stop and apply PRD kill/narrow criteria.
- **REWORK:** only a bounded existing-scope defect has a specific fix and rerun; no new editor, service, operation family, or infrastructure is added to rescue the result.
