# Replex / Release Replay POC Fixture Catalog

## Purpose

This catalogue defines the fixtures worth building at the current POC stage. It is grounded in `Docs/PRD.md`, `Docs/poc/technical_poc.md`, `Docs/poc/task.md`, the stacked PR ownership boundaries, and the latest review findings.

The current stage is **pre-gate integration hardening**. The stack implements most of the POC surface, but known review blockers still exist in capture, project persistence, delivery, and operator handoff. Therefore:

1. Build and run blocker-regression fixtures first.
2. Build the three PRD adversarial product fixtures in parallel where they do not depend on those blockers.
3. Do **not** count the official six-run adversarial evaluation until the blocker suite is green and the operator can execute the flow from a fresh checkout without undocumented intervention.

The PRD requires three meaningfully different apps, two measured runs each, plus one selective recapture per app. Three trivial CRUD dashboards do not satisfy the gate.

---

## Readiness Map

| Stack layer | PR | POC ownership | Current fixture goal |
|---|---:|---|---|
| Core runtime | #1 | POC-1 | Prove startup/config/CLI behavior is trustworthy across real operator environments. |
| Browser capture | #2 | POC-2, POC-3 | Prove approved-flow execution, evidence retention, privacy boundaries, portable artifact naming, and deterministic failure evidence. |
| Canonical project | #3 | POC-4 | Prove stable identity, project-root containment, revision recovery, and persistence semantics. |
| Delivery stack | #4 | POC-5 through POC-15 | Prove reducer → agent → verify → render → recapture as one closed state machine; then execute Apps A/B/C. |
| Operator handoff | #6 | Gate execution docs | Prove a stranger can start fixtures and go from fresh checkout to evidence without founder-only knowledge. |

---

# Tier 0 — Merge-Blocker Regression Fixtures

These fixtures exist to close known review findings. They are not substitutes for Apps A/B/C and should not be counted as POC gate runs.

## F0.1 — Tool Identity Matrix — PR #1

**Intent:** Exercise the runtime preflight as an operator would see it.

**Cases**
- Real Chromium + real FFmpeg + real ffprobe → preflight passes and records versions.
- `/bin/true` or equivalent exit-0 impostor supplied as a tool → rejected.
- ffprobe supplied as the ffmpeg path and vice versa → rejected by signature.
- Missing executable → typed missing-tool error names the tool.
- Malformed app origin/config JSON → structured config error, not raw exception.
- Unknown CLI flag/command → preserves `CLI_USAGE_ERROR` rather than collapsing to a generic code.

**POC evidence:** stdout/stderr payloads, exit codes, recorded versions.

**Why now:** cheap, deterministic substrate for every later fixture.

---

## F0.2 — Authenticated Trace Canary — PR #2

**Intent:** Prove that supporting a disposable authenticated browser session does not leak credentials into retained artifacts.

**App behavior**
- Login/session state contains unmistakable canaries such as `REPLEX_COOKIE_CANARY_7f9...` and `Bearer REPLEX_AUTH_CANARY_...`.
- One authenticated API request is made during the approved flow.
- Capture retains the exact artifact set the product promises to retain.

**Assertions**
- No secret canary appears in manifest, JSONL logs, screenshots metadata, model-facing inspection output, source control, or any retained trace/archive that the product claims is safe.
- If raw authenticated Playwright traces cannot satisfy this, the supported contract must explicitly disable or bound trace retention for auth-bearing runs.

**Failure injection:** expired auth state must fail as a measured attempt without silently logging in another way.

**POC mapping:** POC-18, POC-19, safety/privacy gate.

---

## F0.3 — Portable Scene-Key Filenames — PR #2

**Intent:** Separate stable IDs from filesystem path components.

Use valid stable IDs containing characters that are problematic on Windows, for example:
- `billing:filter`
- `CON`
- `release?status` if schema permits it
- mixed-case keys that could collide on case-insensitive filesystems

**Assertions**
- Stable `sceneKey` remains unchanged in canonical semantics.
- Artifact filenames use a deterministic portable encoding/safe derived name.
- Before/after screenshots, video, trace metadata, and split captures never use raw unsafe path components.
- Two distinct IDs never encode to the same path.

**POC mapping:** POC-04, POC-07, POC-10.

---

## F0.4 — Real-Path Containment Escape — PR #3

**Intent:** Prove “inside project root” against the actual filesystem, not just lexical `../` checks.

**Setup**
- Create `<project>/captures/link` as a symlink on Unix or junction/symlink on Windows pointing to a directory outside the project.
- Present `captures/link/outside.mp4` as a project-relative capture path.

**Assertions**
- The real resolved target is rejected before verification/render reads it.
- Legitimate in-root files still work.
- Relative `..`, absolute paths, and symlink/junction escapes produce distinct, typed errors where useful.

**POC mapping:** POC-03, POC-10, POC-19.

---

## F0.5 — Revision Durability Fault Matrix — PR #3

**Intent:** Define exactly what persistence guarantees survive process/power interruption.

Inject failures at:
1. temp file opened,
2. temp bytes written,
3. temp file fsync,
4. rename completed,
5. containing-directory durability step,
6. canonical project pointer replacement.

**Assertions**
- After ordinary process interruption, load returns either the previous complete revision or the new complete revision, never a hybrid.
- Identical orphaned revision snapshots are retryable.
- If the implementation promises power-loss durability, the directory entry is durably synced where supported; otherwise rename the contract/helper to claim only atomic replacement rather than pretending stronger durability.

**POC mapping:** POC-04, POC-17.

---

## F0.6 — Atomic Operation Commit Fault Matrix — PR #4

**Intent:** Prove accepted operations, audit records, revision snapshot, and current project pointer represent one logical commit.

Inject a failure before/after each durable write in the accepted-operation path.

**Assertions after restart**
- Never observe “accepted operation” with no corresponding committed revision unless it is explicitly represented as an incomplete transaction that recovery resolves.
- Never observe a new current revision with missing accepted audit records.
- Re-running the same deterministic operation after a recoverable interruption does not create conflicting identities.

**POC mapping:** POC-05, POC-17, replay determinism.

---

## F0.7 — Agent Evidence Session Isolation — PR #4

**Intent:** Prove the model can cite only evidence disclosed during the current invocation.

**Setup**
1. Run agent session A and inspect `capture:alpha`, `verification:v1`, and one screenshot.
2. Persist normal project evidence/logs.
3. Start fresh agent session B without inspecting those handles.
4. Have the model/tool transcript attempt an edit citing A's handles.

**Assertions**
- Session B rejects them as undisclosed even though the artifacts exist on disk.
- Inspecting a handle in B adds it to B's disclosure set and then permits a grounded operation.
- Historical disclosure logs are audit evidence, not authorization state.

**POC mapping:** POC-07, POC-08, POC-09.

---

## F0.8 — Mid-Scene Timed Zoom — PR #4

**Intent:** Test the exact focus behavior that static start/end screenshots cannot prove.

**Media**
- 8-second deterministic clip with an obvious grid/counter.
- Zoom focus active only from 2.0s to 5.0s.

**Assertions**
- 1.5s frame is unzoomed.
- 3.5s frame is zoomed to the expected region.
- 6.0s frame returns to normal framing.
- FFmpeg command completes on the supported version; no unsupported generic `enable` usage on filters lacking timeline support.

**POC mapping:** POC-06, POC-10, POC-12.

---

## F0.9 — Recapture Must Never Overwrite Current Media — PR #4

**Intent:** Protect revision immutability during partial materialization failure.

**Setup**
- Revision R1 references scenes A/B/C with immutable media.
- Start recapture run R2 for the same scene keys.
- Normalize/materialize A successfully.
- Force normalization of B to fail.

**Assertions**
- R1's media bytes and hashes remain unchanged after the failed R2 attempt.
- New media paths are run/content scoped rather than `normalized-${sceneKey}.mp4` shared paths.
- No canonical pointer moves to R2.
- A later successful retry can commit R2 without repairing R1.

**POC mapping:** POC-10, POC-11, POC-12, selective recapture gate.

---

## F0.10 — Fresh-Checkout Bootstrap — PR #4 + PR #6

**Intent:** Kill the circular “capture requires project; project requires captures” workflow.

**Starting state:** fresh clone, dependencies installed, no `work/<project>` directory.

**Operator has only:** feature brief, approved environment/flow fixture, optional values/auth state, and documented commands.

**Pass condition:** there is one supported sequence that reaches the first canonical captured project without fabricated capture metadata or an undocumented custom script.

The fixture should fail if `capture` needs a canonical project that can only be created from already-existing captures.

**POC mapping:** POC-01 through POC-06; prerequisite to a legitimate POC-14 run.

---

## F0.11 — CLI Contract Fixture — PR #4 + PR #6

**Cases**
- `--project foo` and `--project=foo` resolve identically if both syntaxes are advertised.
- `--values '{...}'` and `--values @path` behave as documented.
- Successful machine-readable invocation emits either one authoritative result or a documented JSONL event protocol with explicit event types.
- Startup/preflight metadata cannot masquerade as a second command result.

**POC evidence:** golden stdout/stderr fixtures consumed by a tiny parser rather than string-only snapshots.

---

## F0.12 — Stranger Handoff Test — PR #6

Give `Docs/poc/DEPLOYMENT.md` to someone/process with no repository-history context.

They must be able to determine:
- exact fixture-start commands,
- ports/origins,
- reset/change/failure endpoints,
- where auth state lives,
- how dynamic values/uploads are supplied,
- how a project is initialized,
- how to perform two runs per app,
- how to trigger each changed state,
- where the nine required outputs/evaluation evidence appear.

Any step requiring “look at the integration test and infer it” fails this fixture.

---

# Tier 1 — PRD Adversarial Product Fixtures

These are the actual Apps A/B/C to use for the POC once Tier 0 blockers are green.

## App A — Release Settings Console — Normal SaaS

**PRD role:** App A / normal SaaS.

**Product story:** A small B2B SaaS team is enabling a new public changelog experience for a beta customer segment.

### UI/state
- `/dashboard` with workspace navigation.
- `/release-settings` form with a `Public changelog` toggle.
- Segment select: `Internal`, `Beta customers`, `Everyone`.
- Text field for release headline.
- Save button.
- Result panel showing current publication configuration and a success banner.

### Approved flow / scene plan
1. **scene-a-overview** — open Release Settings; checkpoint heading + current disabled state.
2. **scene-a-configure** — enable Public changelog and choose `Beta customers`; checkpoint selected state visible.
3. **scene-a-copy** — enter `Faster CSV imports`; checkpoint preview reflects exact text.
4. **scene-a-save** — save; checkpoint success banner and result panel show enabled/Beta.

### Changed state for selective recapture
Change only the result panel design/copy from a plain status row to a card with `Live for Beta customers`. The narrative scene identity remains `scene-a-save`; only its capture should change.

### Failure injections
- Wrong checkpoint copy after save.
- Off-origin link in a help menu.
- Prohibited `Delete workspace` button present but never approved.
- Save returns validation error once.

### Why this fixture is useful
It proves the boring happy path: navigation + control interaction + form + visible result without hiding behind unusual browser mechanics.

---

## App B — Incident Analytics Console — Dynamic SaaS

**PRD role:** App B / authenticated dynamic SaaS.

**Product story:** An engineering team uses a new incident analytics view to filter production incidents and open an asynchronously generated root-cause summary.

### Required complexity
- Disposable authentication.
- Async loading/skeleton.
- Dropdown with dynamic options.
- Modal/drawer.
- Toast.
- Delayed backend state.

This exceeds the PRD minimum of auth + async loading + at least two complex UI states.

### UI/state
- `/login` loads from external operator-owned storage state when provided.
- `/incidents` initially renders skeleton cards, then a virtualized list.
- Environment dropdown (`Production`, `Staging`).
- Severity dropdown (`SEV-1`, `SEV-2`, `All`).
- Incident row opens a details drawer.
- `Generate summary` starts delayed backend work; toast says processing, then drawer receives summary.

### Approved flow / scene plan
1. **scene-b-load** — authenticated incidents page reaches loaded state; checkpoint skeleton gone and list visible.
2. **scene-b-filter** — Production + SEV-1 selected; checkpoint result count/value.
3. **scene-b-detail** — open first incident; checkpoint drawer title + incident ID.
4. **scene-b-summary** — generate summary; checkpoint delayed summary text visible after processing toast.

### Changed state for selective recapture
Change only summary backend output/layout for the target incident. Re-run the scene-producing segment and replace `scene-b-summary`; filter/detail captures and edits must remain unchanged.

### Failure injections
- Expired auth state.
- API response deliberately delayed beyond timeout.
- Dropdown option appears after async fetch.
- Summary backend returns error once.
- Auth canary appears in network traffic for the trace-privacy fixture.

---

## App C — Customer Import & Mapping Wizard — Difficult Browser Behavior

**PRD role:** App C / difficult interaction.

**Product story:** A customer-success operator imports a CSV of accounts, maps columns, reviews validation problems, and completes a dry-run import.

### Required complexity
Use **file upload + multi-step wizard + large/dynamic table**. One is enough for the PRD; using three makes this meaningfully different from Apps A/B without needing exotic browser tricks.

### UI/state
- `/imports/new` with drag/drop or file picker.
- Upload `customers.csv` from an explicitly approved upload root.
- Step 2 maps CSV columns to `Company`, `Domain`, `Plan` using selects.
- Step 3 shows a 200-row virtualized preview with validation chips.
- One invalid row opens a correction modal.
- Final step performs a **dry-run** import only and shows counts; no real external side effect.

### Approved flow / scene plan
1. **scene-c-upload** — upload approved fixture; checkpoint filename + row count.
2. **scene-c-map** — map three columns; checkpoint mapping summary.
3. **scene-c-review** — virtualized preview loaded; checkpoint valid/invalid counts.
4. **scene-c-fix** — correct the one invalid row in modal; checkpoint invalid count becomes zero.
5. **scene-c-result** — run dry import; checkpoint `200 ready, 0 rejected`.

### Changed state for selective recapture
Change validation rules so one row now reports `Domain normalized automatically`; replace only `scene-c-review` or `scene-c-fix` according to the changed checkpoint. Other scene IDs/captures/edits must be preserved.

### Failure injections
- Upload outside approved root.
- Wrong MIME/extension.
- Slow upload processing.
- Virtualized row not initially in DOM.
- Modal interrupted/closed.
- Second-scene normalization failure after first new capture is materialized, to exercise immutability.

---

# Tier 2 — Measured POC Gate Matrix

Run only after Tier 0 is green and the handoff works from a clean checkout.

| Measured item | App A | App B | App C |
|---|---:|---:|---:|
| Reset + capture run #1 | required | required | required |
| Reset + capture run #2 | required | required | required |
| Agent draft + verify + final render for accepted run | required | required | required |
| Controlled product-state change | required | required | required |
| Selective recapture + revised render | required | required | required |
| Preservation proof for unaffected scenes/edits | required | required | required |
| Raw attempts/retries retained | required | required | required |

The evaluation dataset must preserve first-attempt failures rather than replacing them with successful reruns.

### Gate evidence per attempt
- flow/run ID and reset identifier,
- ordered checkpoints,
- first-pass/recovered status,
- capture IDs and hashes,
- scene mapping,
- accepted operation IDs,
- verification ID/checks,
- render output/probe/decode result,
- recapture lineage where applicable,
- manual intervention/correction time,
- explicit failure stage and retained evidence paths.

---

# Fixture Design Rules

1. **Fixtures go through product interfaces.** Do not special-case fixture names in capture/project/render code.
2. **Stable IDs are semantic, filenames are encoded.** Never weaken IDs just to make paths convenient.
3. **Changed state is controlled and narrow.** A selective-recapture test is worthless if half the app changes.
4. **Failure injection is explicit.** Use fixture controls such as reset/change/failure endpoints; never hide retries.
5. **No real consequential side effects.** Use dry-run imports, disposable accounts, and deterministic local state.
6. **Secrets use canaries.** A privacy test should contain something unmistakable enough for automated scanning.
7. **Media is deterministic.** Fixed viewport, locale, timezone, reduced motion, data seed, and bounded async timing.
8. **Every fixture has a reason.** If it does not prove a PRD gate, current blocker, or known boundary, do not add it.
9. **Do not rescue POC failures with new product scope.** A failed gate should be classified before adding infrastructure or a larger editor.

---

# What Not to Build at This Stage

The current review feedback is also a warning against fixture-driven overengineering. Do not add:
- a custom graphics/PNG/text rendering stack just to test overlays,
- a second hand-maintained schema universe for provider tools,
- a general provider abstraction or hand-rolled SDK unless explicitly required,
- duplicate raw evaluation records in multiple authoritative files,
- duplicate prose/structured inspection truth surfaces,
- a fourth source of acceptance-policy constants in fixture docs.

Keep the fixture runner boring: deterministic local apps, explicit state controls, standard Playwright/FFmpeg behavior, and one canonical evaluation schema.

---

# Recommended Build Order

1. F0.2 authenticated trace canary + F0.3 portable scene-key path tests.
2. F0.4 real-path containment + F0.5 revision fault matrix.
3. F0.6 atomic operation commit + F0.7 current-session evidence grounding.
4. F0.8 timed zoom + F0.9 immutable recapture media.
5. F0.10 fresh bootstrap + F0.11 CLI contract.
6. F0.12 stranger handoff test.
7. Scaffold App A and make its two runs + recapture green.
8. Scaffold App B and App C in parallel once shared capture/project paths are stable.
9. Freeze fixture behavior and execute the official six measured runs + three selective recaptures.
10. Run usefulness reviews/correction timing and compute the POC PASS / FAIL / bounded REWORK gate without changing thresholds after seeing results.
