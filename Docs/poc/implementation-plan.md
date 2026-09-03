# Release Replay POC Implementation Plan

> **For agentic workers:** Execute `Docs/poc/task.md` in dependency order. The POC is disposable evidence, not a production foundation.

**Goal:** Prove that an approved browser flow can produce a reproducible scene project and that one reasoning model can edit it through bounded tools, render it, and preserve unrelated edits during selective recapture.

**Spec:** `Docs/PRD.md`, amended by the approved agentic-editing requirements supplied with this plan.

## Planning Constraints

- **Product hypothesis:** software behavior can become traceable, editable video source material whose affected scenes can be recaptured without rebuilding the rest.
- **Independent POC hypotheses:** (A) deterministic capture/compilation and selective recapture; (B) a real model can inspect evidence and create a useful draft through validated tools.
- **POC pass:** all three adversarial apps complete two measured runs; at least 5/6 flows complete without intervention; every accepted run passes checkpoints; 3/3 selective recaptures preserve unaffected sources and edits; all nine final renders are valid; median correction is under 10 minutes and none exceeds 20; at least 2/3 target reviewers would use the output; no safety/privacy breach; agent measurements below are reported and malformed calls never corrupt state.
- **POC fail:** any PRD gate fails, the agent never causes a real renderable revision, output needs arbitrary manifest repair or undocumented founder editing, or safety depends on model judgment.
- **MVP/P0 later:** reopenable local projects, reviewed capture plans, bounded review editor, recovery, revision revert, local credential protection, selective recapture, and one 1080p export. These are not POC infrastructure.
- **Non-goals:** accounts, billing, teams, cloud capture/render/storage, queues, services, polished timeline, TTS, music, multiple formats, CI/GitHub integration, autonomous browsing, multi-agent/model routing, plugins, general NLE, Motion Canvas, WebGPU, and arbitrary model-authored JSON, code, shell, or FFmpeg.
- **Architecture:** local-only TypeScript CLI plus a static generated HTML review report. Chromium/Playwright captures; an owned JSON manifest and pure reducer hold project state; FFmpeg is the authoritative backend; one Claude model uses typed tools.
- **Privacy:** credentials and Playwright storage state stay outside projects and source control; model context excludes secrets/storage and includes only selected project evidence; every disclosed artifact is logged.
- **Performance:** raw flow <=5 minutes; 3-5 scenes; 25-35 seconds at 1920x1080/30fps H.264/AAC; capture-to-draft <10 minutes; recapture-to-draft <5 minutes; render <3 minutes on the declared reference machine.
- **Validation:** deterministic baseline first, then agent path, then two runs each on Apps A/B/C, changed-state recapture for each, external-use review, and an explicit PASS/FAIL/REWORK decision.
- **Open decisions fixed for POC:** accept existing Playwright tests or precise approved flow definitions; local execution; no narration; thin owned engine; selector failures stop and require explicit correction; release/changelog video remains the job.
- **Kill criteria:** apply PRD section 37. In particular, do not proceed because the demo is impressive if reliability, publication intent, payment/repeat demand, or correction-time evidence fails.

The only tension is that the PRD labels model use optional where reasoning is unnecessary, while the approved amendment requires agentic editing. Least-expansive interpretation: deterministic mechanics remain non-AI, but every measured POC includes one real model-driven edit pass through the same operation boundary.

## Concrete Technical Choices

| Concern | Choice | Material reason |
|---|---|---|
| Runtime | Node.js LTS + TypeScript, ESM | One runtime covers Playwright, schemas, CLI, model tools, and FFmpeg process control. |
| Package manager | npm with committed lockfile | Built in; no workspace or package-manager machinery is needed. |
| App shape | Single local CLI (`capture`, `baseline`, `agent-draft`, `verify`, `render`, `recapture`, `report`) | The POC needs evidence, not an application shell. |
| Browser | `@playwright/test`, bundled Chromium only | Reuses approved tests, tracing, video, screenshots, and semantic locators. |
| Validation/tests | Zod + Vitest | One runtime schema at every disk/model boundary and lightweight deterministic tests. |
| Media | System FFmpeg/ffprobe, checked at startup and version-recorded | No render engine or binary packaging in POC. |
| Model | One Claude tool-use client called from `agent-draft` | No provider interface, router, agents, or fallback model. |
| Review | Generated local HTML report using escaped HTML and native video controls | Avoids a frontend framework while exposing required evidence. |
| Persistence | Atomic JSON revisions plus immutable files on local disk | Enough to inspect, reproduce, and recover the POC. |

Pin exact dependency versions in the lockfile when execution begins. Do not create a monorepo or reusable SDK.

## Repository Structure

```text
package.json / package-lock.json / tsconfig.json
src/
  cli.ts                 # command parsing and orchestration only
  schema.ts              # all persisted/tool-input Zod schemas and inferred types
  project.ts             # load, fingerprint, atomic revision write
  operations.ts          # validated pure reducer; the sole mutation boundary
  capture.ts             # approved-flow execution and capture artifact assembly
  inspect.ts             # bounded inspection views/contact-sheet requests
  agent.ts               # Claude call, typed tool loop, two-pass budget
  verify.ts              # browser/project/render invariant checks
  render.ts              # manifest -> RenderJob -> argv -> FFmpeg/ffprobe
  reconcile.ts           # same-scene recapture and preservation assertions
  report.ts              # static HTML evidence/review report
fixtures/
  apps/{normal,dynamic,difficult}/ # three deterministic test applications/flow adapters
  media/                  # tiny committed render fixtures only
tests/                    # unit, integration, golden, browser, render, adversarial checks
work/                     # gitignored local projects, auth, runs, logs, captures, outputs
```

`src` files are responsibility boundaries, not layers. `work/<projectId>/` contains `project.json`, `revisions/`, `captures/`, `screenshots/`, `traces/`, `renders/`, `logs/`, and `reports/`. Authentication state lives in a sibling `work/auth/` path and is referenced by an operator-supplied path, never copied into a project.

## Minimum Data Model

Use integer milliseconds everywhere. `Environment` and `Flow` are embedded in `Project`; `Overlay`, `BrowserAction`, and captures are records because they carry stable identity/provenance. Do not add separate databases, users, asset tables, or a generic graph.

```ts
type Id = string;
type Sha256 = string;

interface Project {
  schemaVersion: 1; id: Id; brief: { audience: string; message: string; targetMs: 30000 };
  environment: { appOrigin: string; allowedOrigins: string[]; viewport: { width: 1920; height: 1080 };
    locale: string; timezone: string; colorScheme: "light"; reducedMotion: "reduce";
    browserVersion: string; resetCommandLabel?: string };
  flow: { id: Id; approvedAt: string; prohibitedActions: string[]; actions: BrowserAction[] };
  captures: Record<Id, SourceCapture>; scenes: Scene[]; overlays: Record<Id, Overlay>;
  currentRevisionId: Id; revisions: Revision[]; outputs: RenderResult[];
}

interface BrowserAction {
  id: Id; ordinal: number; type: "goto"|"click"|"fill"|"select"|"upload"|"waitFor";
  target?: { kind: "role"|"label"|"testId"|"url"; value: string; name?: string };
  valueRef?: string; consequential: boolean; approved: boolean;
  checkpoint: { kind: "url"|"visible"|"text"|"attribute"; target?: BrowserAction["target"]; expected: string };
  sceneKey?: string;
}

interface CaptureRun { id: Id; flowId: Id; attempt: number; startedAt: string; endedAt: string;
  status: "passed"|"failed"; actionEventsPath: string; tracePath: string; failure?: { actionId: Id; category: string; evidencePaths: string[] } }

interface SourceCapture { id: Id; sceneKey: string; runId: Id; actionIds: Id[]; path: string; sha256: Sha256;
  durationMs: number; width: number; height: number; fps: 30; capturedAt: string; predecessorId?: Id }

interface Scene { id: Id; sceneKey: string; captureId: Id; actionIds: Id[]; checkpointActionId: Id;
  sourceInMs: number; sourceOutMs: number; speed: 0.75|1|1.25|1.5|2; order: number;
  focus?: { preset: "none"|"center"|"target"; x?: number; y?: number; startMs: number; endMs: number };
  transition: { type: "cut"|"crossfade"; durationMs: 0|250|500 } }

interface Overlay { id: Id; sceneId: Id; kind: "title"|"callout"; text: string;
  placement: "top"|"bottom"|"target"; startMs: number; endMs: number }

type EditOperation =
  | { type:"create_scene"; scene: Scene }
  | { type:"trim_scene"; sceneId:Id; sourceInMs:number; sourceOutMs:number }
  | { type:"reorder_scene"; sceneIds:Id[] }
  | { type:"replace_capture"; sceneId:Id; captureId:Id; reason:string }
  | { type:"set_speed"; sceneId:Id; speed:Scene["speed"] }
  | { type:"set_focus"; sceneId:Id; focus:NonNullable<Scene["focus"]> }
  | { type:"set_title"|"set_callout"; overlay:Overlay }
  | { type:"set_transition"; sceneId:Id; transition:Scene["transition"] };

interface Revision { id: Id; parentId?: Id; actor: "baseline"|"model"|"operator"|"recapture";
  createdAt: string; operations: { id:Id; input:EditOperation; accepted:boolean; error?:string }[];
  manifestSha256: Sha256 }
interface RenderJob { id:Id; revisionId:Id; scenes: Array<{sourcePath:string; inMs:number; outMs:number; speed:number;
  focus?:Scene["focus"]; overlays:Overlay[]; transition:Scene["transition"]}>;
  output:{path:string;width:1920;height:1080;fps:30;videoCodec:"libx264";audioCodec:"aac"} }
interface VerificationResult { phase:"capture"|"project"|"render"|"reconcile"; passed:boolean;
  checks:Array<{code:string;passed:boolean;details:string;evidencePaths?:string[]}> }
```

## Identity, Provenance, and Reconciliation

- Author-controlled `flow.id`, action IDs, and `sceneKey` live in the approved flow definition. IDs are opaque slug-or-UUID strings and are never generated from selectors, text, order, timestamps, or media bytes.
- On first materialization, `scene.id = UUIDv5(project.id, sceneKey)`. It represents narrative intent (for example `show-filter-result`) and survives target/selector and media changes.
- `SourceCapture.id = sha256(file bytes + canonical metadata + runId)`. Captures are immutable; recapture adds a record and `predecessorId`.
- “Same scene” means same project plus approved `sceneKey`, with compatible action/checkpoint intent. If intent changes, create a new scene; do not force reconciliation.
- `replace_capture` changes only the target scene's `captureId`, clamps nothing silently, records lineage/reason, and fails if existing trim/focus/overlay ranges do not fit the new media.
- Reconciliation replays the target replacement onto the current revision. A semantic projection of every unaffected scene, overlay, and accepted operation must hash identically before and after. Revision IDs, timestamps, outputs, and the affected capture lineage are excluded from that comparison.
- User/operator/model-controlled fields are operation inputs. Probe metadata, fingerprints, durations, trace paths, verification, revision IDs, and timestamps are generated.

## Deterministic Operation Contract

All operations parse with a discriminated Zod union, validate against the source revision, apply through one pure `applyOperation(project, operation)` reducer, then atomically write a new revision. On failure: return a typed error, append a rejected-call audit event, and leave current state unchanged. Replay from the same revision and ordered operations must yield the same semantic manifest hash.

| Operation | Validation and mutation | Reversible in POC |
|---|---|---|
| `create_scene` | Existing capture, unique scene ID/key, valid action/checkpoint links and positive range; append scene. Used by baseline materialization, not normal agent edits. | Yes, by returning to parent revision. |
| `trim_scene` | Bounds within source, positive derived duration; update range. | Yes. |
| `reorder_scene` | Exact current ID set, no duplicate/omission; replace order. | Yes. |
| `replace_capture` | Successful compatible capture for same scene key, all retained ranges valid, reason non-empty; repoint and add lineage. | Yes. |
| `set_speed` | Enum only and resulting total remains eligible for 25-35 seconds; update speed. | Yes. |
| `set_focus` | Fixed preset, normalized coordinates 0-1, scene-local range; replace focus. | Yes. |
| `set_title` / `set_callout` | Text <=80/120 chars, grounded source recorded by agent audit, allowed placement/range and safe area; upsert stable overlay ID. | Yes. |
| `set_transition` | Cut or 250/500 ms crossfade, valid neighbor, duration shorter than both scenes; replace transition. | Yes. |

Deletion is omitted: three-to-five approved scenes and reorder/trim are sufficient for the POC. If a scene is unwanted, the approved flow/scene map should change visibly rather than leaving an orphaned narrative identity.

## Browser Capture

An approved flow adapter exports data plus a Playwright function that invokes a thin recorder around each declared action. Existing tests wrap their meaningful steps with stable action IDs; written flows map only to the fixed action types above. The runner validates origins and approvals before opening Chromium, creates one fresh context per attempt, optionally loads an external storage-state path, and closes it after trace/video finalization.

Use 1920x1080 viewport, locale/timezone from the environment, reduced motion, fixed color scheme, and bundled Chromium. Record Playwright video for the run, screenshots immediately before/after scene boundaries, trace with screenshots/snapshots, console/page errors, URL, monotonic timing, semantic target, and checkpoint outcome. Split/trim the run recording into 3-5 immutable scene captures after execution so action instrumentation, not recorder start latency, defines boundaries.

Wait only on declared locator/state/network-response conditions. No arbitrary sleeps except an explicitly named fixture delay in App C. Seed/reset demo data before a measured run. Safe reads/navigation can be pre-approved; uploads, writes, deletes, purchases, messages, publishing, account changes, and external navigation require an explicit per-action approval. Any missing approval or origin fails before execution. First action/checkpoint failure stops the run and preserves trace, screenshot, DOM/accessibility excerpt, console, and URL.

## Inspect -> Edit -> Verify -> Render

### Inspect and agent tools

`inspect_project`, `inspect_flow`, `inspect_scene`, `inspect_capture`, `inspect_browser_trace`, and `inspect_verification_results` return capped JSON views. Default context is brief (<=1,000 chars), full flow metadata, scene summary, media probes, and latest verification (target <=12k input tokens). Screenshots/contact sheets or bounded DOM/accessibility excerpts are returned only for named scenes/actions and only when requested; each response lists disclosed local artifacts. Raw traces, cookies, storage state, filesystem enumeration, and unrelated screenshots are unavailable.

### Edit and agent loop

The model receives a system contract, brief, fixed tool schemas, constraints, and default inspection. It may call the operations listed above plus `verify_project`, `render_draft`, and `inspect_render_result`; these execution tools call application code, never shell supplied by the model. Limit each draft to 20 total tool calls, at most two renders, and at most two edit passes. Stop on repeated invalid calls, timeout, missing fact, unsupported edit, or exhausted budget and report the ambiguity. One visible model retry is allowed. Manual/internal commands invoke the identical reducer.

### Verify

Machine checks cover: approved actions/checkpoints; every scene maps to capture/actions/checkpoint; files and fingerprints match; ranges and derived durations are valid; scene IDs/keys are unique; overlays are bounded and safe; target total is 25-35 seconds; render job has only allowed primitives; sampled frames contain non-blank variance; required title/callouts are present during their ranges; output probes to 1920x1080/30fps H.264 with an audio stream (a generated silent AAC track when source has none); decoding reaches the expected end; reconciliation preservation hashes match. Human review alone judges story, pacing, persuasiveness, and publishability.

### Render

`buildRenderJob(verifiedRevision)` is authoritative. It resolves immutable paths and fixed primitives, then `render.ts` generates a known argv array for per-scene normalization/trim/speed/focus/overlay, optional fixed crossfades, concat, silent audio where needed, and H.264/AAC encode. Text overlays are rendered as escaped fixed-style SVG/PNG assets outside FFmpeg to avoid filter-string injection. The model never sees argv. Preserve the job JSON, argv with safe paths, FFmpeg stderr, intermediates on failure, and ffprobe result.

## Subsystem Contracts and Failure Tests

| Subsystem | Responsibility / interface | Failure behavior | Test strategy |
|---|---|---|---|
| Capture | `runCapture(approvedFlow, env, authPath?) -> CaptureRun` | Stop first failure; retain evidence; never mark retry first-pass. | Playwright fixture apps, origin/action denial, async timeout, trace assertions. |
| Project/operations | `applyOperations(revisionId, ops) -> Revision` | Schema/semantic error is atomic and audited. | Reducer unit/property cases, replay golden hashes, stale revision rejection. |
| Inspection/agent | bounded tools -> model tool calls -> reducer | Timeout/repeated invalid/ambiguity stops; project remains valid. | Stubbed transcripts plus real-model measured runs; secret/context leak checks. |
| Verification | `verify*(...) -> VerificationResult` | Failed required check blocks render. | Corrupt/missing media, invalid ranges, blank/frozen fixtures, wrong checkpoint. |
| Render | `buildRenderJob` then `executeRenderJob` | Keep job/stderr/intermediates; one visible retry only. | Tiny golden fixtures, ffprobe/decode, deterministic semantic job snapshots. |
| Reconcile | `replaceSceneCapture(currentRevision, newCapture)` | Reject incompatible capture or preservation mismatch. | Recapture all three apps; hashes prove unrelated state survives. |
| Report | `writeReport(project, results) -> index.html` | Escapes content; missing artifact is shown, not hidden. | HTML snapshot plus link/file existence check. |

## Test Strategy and Attribution

- **Unit:** ID rules, schemas, duration math, safe-area math, reducer atomicity/replay, render-job construction, redaction, preservation projection.
- **Integration:** captured fixture -> manifest -> operations -> verification -> RenderJob; tool call -> reducer -> revision; recapture -> replacement -> revised render.
- **Golden/fixture:** canonical manifest/revision hashes, bounded inspection payloads, render-job JSON and agent transcripts. Do not byte-compare MP4 across platforms.
- **Browser:** two reset runs per App A/B/C, explicit checkpoints, trace completeness, failure evidence, auth isolation, allowlist/consequential-action denial.
- **Render validation:** ffprobe streams/codec/dimensions/fps/duration, full decode, boundary frames, overlay intervals, blank/frozen detection, silent-audio behavior.
- **Adversarial agent:** unknown tool, malformed IDs/ranges, invented claim, request for raw trace/secrets/shell, repeated render, stale revision, unsupported deletion. Validator must reject without manifest change.
- **Fault attribution:** each stage writes a typed result (`browser`, `capture`, `reconcile`, `edit`, `verify`, `render`, `model`) and downstream stages do not overwrite the first causal failure.

## Observability and Measurements

Write JSONL events with `runId`, stage, attempt, revision, tool/operation name, duration, outcome, category, and artifact paths; redact values before write. Store capture plan, action events, trace, screenshots, before/after manifests, accepted/rejected tool calls, model/prompt/version and token usage, RenderJob, sanitized argv, stderr, verification, reviewer correction time, and recapture preservation diff. No collector, dashboard, database, or remote telemetry.

Agent metrics: valid/invalid call counts; prevented malformed mutations; percentage of agent plans rendering without manual manifest repair; correction minutes from first agent render; evidence references for each text/focus/order decision; reproducibility of the accepted operation sequence; and survival of agent edits after recapture.

## Implementation Order

1. Bootstrap only the CLI/runtime/schema/test essentials.
2. Capture one hard-coded approved flow with trace and 3-5 scenes.
3. Materialize stable manifest and pure operations.
4. Produce the earliest ugly deterministic MP4 and report through verification.
5. Expose bounded inspection tools over that same project.
6. Connect Claude tools to the same reducer and produce a real first draft.
7. Add targeted render inspection and the optional second pass.
8. Recapture one scene and prove all unrelated manual/model edits survive.
9. Run the identical harness against Apps A/B/C, collect reviewer evidence, and gate the POC.

## POC Exit Gate

**PASS:** every PRD section 17 gate passes; both hypotheses have evidence; a real model-produced operation sequence renders without manual JSON repair; validation blocks every malformed adversarial mutation; accepted agent decisions cite available evidence; and agent edits survive 3/3 selective recaptures.

**FAIL:** any mandatory reliability, correctness, selective-recapture, render, correction-time, external-use, privacy, or real-agent criterion fails. Stop; do not begin production or expand the editor.

**REWORK:** only when the failure is narrow and measurable: one browser-app class, one operation/verification defect, or bounded model context/tool-schema problem has a credible fix inside existing POC scope. Repeat the failed gate plus regression runs. Demand/output-taste failure triggers product reconsideration, not automatic engineering rework.
