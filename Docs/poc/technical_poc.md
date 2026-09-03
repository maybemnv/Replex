# Release Replay Technical POC

## 1. Purpose

Define the smallest local architecture that can prove:

> approved browser flow + feature brief -> reproducible, editable release-video project

The proof ends at a reviewable 25-35 second MP4, an inspectable scene project, a real model-driven edit revision, and a selective-recapture revision. It is not an MVP foundation exercise or a general video editor.

The approved PRD is normative for product scope and gates. The POC implementation plan supplies dependency order and operating detail. This document resolves their technical mechanics. Where the later approved technical direction differs from those documents, it intentionally uses pnpm and a one-method vendor seam with Gemini 3.8 Flash as the initial model; neither choice changes canonical project semantics.

## 2. POC hypotheses

### Hypothesis A: reproducible video compilation

An approved browser flow can deterministically reach declared product states, produce 3-5 immutable captures, map them to stable scenes, accept validated edits, verify explicit invariants, render through FFmpeg, and replace one affected capture without changing unrelated scene state.

### Hypothesis B: agentic editing

One configured multimodal model can inspect bounded brief/browser/media/project evidence, invoke only typed tools, create a valid project revision, request verification and render, and produce a useful first draft. Textual advice alone does not count; accepted tool calls and a rendered artifact are required.

The hypotheses are measured independently. Slice 1 proves A without AI. Slice 2 uses exactly the same project core to prove B.

## 3. Scope

- One local CLI-driven POC on founder laptops.
- Node.js 22+, TypeScript, pnpm, and `tsx`.
- Chromium-only approved Playwright flows, fixed environment, explicit checkpoints, and 3-5 scenes.
- Filesystem project persistence, immutable source captures, JSON manifest, JSONL operation/event logs, and revisions.
- Fixed operations: scene creation, trim, reorder, capture replacement, speed, focus, title, callout, and transition.
- One active model adapter, initially Gemini 3.8 Flash, with typed inspection/edit/verify/render tools.
- Static `report.html` for founder review.
- Local FFmpeg/ffprobe authoritative 1920x1080, 30 fps, H.264/AAC export.
- Two measured runs against each of Apps A, B, and C, plus one selective recapture per app.

## 4. Explicit non-goals

No user authentication, billing, teams, collaboration, cloud browser/render/storage, database, queue, microservice, Docker requirement, hosted infrastructure, remote browser, autonomous browsing, computer use, full video upload to the model by default, model routing/fallback, multi-agent design, LangChain/LangGraph, embeddings/vector database, custom model hosting, polished React editor, timeline, plugin system, public API, arbitrary footage editing, general NLE, narration/TTS, music, captions, multiple formats, CI/GitHub integration, Motion Canvas, Remotion, WebGPU, Three.js, arbitrary keyframes, OpenReel/OpenCut/Kdenlive/MLT/Diffusion Studio dependency, or arbitrary model-authored JSON/code/shell/FFmpeg.

## 5. Architecture summary

```text
approved flow + brief
        |
        v
Playwright capture -> immutable evidence/captures
        |
        v
canonical scene manifest <--------+
        ^                           |
        |                           |
manual baseline --------+          |
                        v          |
model -> typed tools -> validated operation reducer
                                   |
                                   v
                              verification
                                   |
                                   v
                               RenderJob
                                   |
                                   v
                                 FFmpeg
                                   |
                                   v
                         MP4 + targeted inspection
```

The manifest revision is authoritative. The model proposes actions; tools validate them. The reducer alone changes project state. Verification alone authorizes a render job. The renderer alone translates that job to fixed FFmpeg arguments.

## 6. Technology choices

| Concern | Choice | POC reason |
|---|---|---|
| Runtime | Node.js 22+ and TypeScript | One language for browser, schemas, tools, project state, and rendering orchestration. |
| Package/tooling | pnpm, `tsx`, TypeScript compiler | Small local workflow and locked dependencies. |
| Browser | Playwright with bundled Chromium | Approved-flow execution, video, screenshots, traces, and metadata in one library. |
| Schemas | Zod | Structural parsing at disk/tool/render seams; inferred TypeScript types. |
| Tests | Vitest | One test framework for pure and integration tests; Playwright is invoked by fixtures rather than added as a second assertion framework. |
| Processes | `execa` | Safe argv-based FFmpeg/ffprobe invocation without shell interpolation. |
| Media | Installed FFmpeg and ffprobe | Mature local primitives; versions recorded during preflight. |
| Overlays | Fixed SVG templates; Sharp only for rasterization/contact sheets | No motion engine. |
| Logs | JSON/JSONL; Pino only if plain JSONL writing becomes noisy | Inspectable artifacts without an observability stack. |
| Review | Generated static HTML with native video controls | Enough to assess provenance, output, and correction time. |
| Model | One `AgentModel` adapter, initially configured for Gemini 3.8 Flash | Vendor choice can be evaluated without touching project/edit/render semantics. |

No Python is introduced. If a concrete codec/tooling blocker appears, first use FFmpeg rather than adding another runtime.

## 7. Repository structure

```text
release-replay/
├── src/
│   ├── cli/                 # command parsing and top-level orchestration
│   ├── capture/             # approved-flow runner and evidence collection
│   ├── project/             # schemas, loading, atomic revisions, stable IDs
│   ├── operations/          # structural/semantic validation and pure reducer
│   ├── agent/               # one-method model seam, context, tools, bounded loop
│   ├── verify/              # browser, scene, recapture, render checks
│   ├── render/              # RenderJob construction and fixed FFmpeg execution
│   └── report/              # static review report generation
├── assets/overlays/         # title.svg, callout.svg, focus-box.svg
├── fixtures/
│   ├── app-a/               # normal SaaS app contract and approved flow
│   ├── app-b/               # authenticated asynchronous SaaS flow
│   ├── app-c/               # difficult interaction flow
│   └── media/               # tiny deterministic render/failure inputs
├── projects/                # gitignored POC projects and evidence
├── tests/                   # Vitest tests through public module interfaces
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

- `cli` depends on all modules only to compose commands; domain rules and FFmpeg logic must not live there.
- `capture` depends on Playwright and project schemas; it must not create scenes, choose edits, or call the model.
- `project` owns canonical types/identity/disk commits; it must not know Playwright, model vendors, HTML, or FFmpeg.
- `operations` depends only on project schemas; it is the sole mutation interface and must not perform file/media mutation.
- `agent` depends on inspection views and operation/verification/render interfaces; provider-specific request mapping stays in one adapter file and must not leak into project state.
- `verify` reads artifacts and invokes ffprobe where needed; it reports facts and must not repair state.
- `render` consumes only a verified revision/RenderJob; it must not accept model text or arbitrary filtergraphs.
- `report` reads stored artifacts; it must not mutate the project or define an editing engine.
- `fixtures` define deterministic apps/media; product modules must not special-case fixture names.
- `projects` contains runtime evidence, never source code or committed credentials.

## 8. Runtime/data flow

1. Preflight validates FFmpeg/ffprobe, Playwright Chromium, disk paths, fixed browser environment, origins, approvals, and optional external auth-state location.
2. `runCapture` resets the fixture/app, opens a fresh browser context, executes only approved steps, checks each declared state, and persists trace/screenshot/video/action evidence.
3. Successful scene boundaries are cut from the raw recording into immutable captures and probed.
4. `createProject` maps approved `sceneKey` values to stable scenes and commits revision 0.
5. Manual inputs or model tool calls submit `EditOperation` values to the same reducer. An accepted group becomes a new revision.
6. `verifyProject` returns explicit results. Failure blocks rendering without changing state.
7. `buildRenderJob` converts one verified revision to a bounded description; `render` converts that to argv and runs FFmpeg.
8. Post-render checks and targeted frames are persisted. The model may inspect them once and make an optional second edit pass.
9. Recapture repeats only an approved scene-producing flow segment and commits `replace_capture` against the current revision.

## 9. Canonical project model

All time values are integer milliseconds. Unknown persisted/tool fields are rejected.

```ts
type Id = string;
type Sha256 = string;

interface Project {
  schemaVersion: 1;
  id: Id;
  brief: { audience: string; message: string; targetDurationMs: 30000 };
  environment: Environment;
  flow: Flow;
  manifest: Manifest;
  createdAt: string;
}

interface Manifest {
  projectId: Id;
  currentRevisionId: Id;
  captures: Record<Id, Capture>;
  scenes: Scene[];
  overlays: Record<Id, Overlay>;
  revisions: Revision[];
  outputs: RenderOutput[];
  recaptureLineage: RecaptureLineage[];
}

interface Environment {
  appOrigin: string;
  allowedOrigins: string[];
  viewport: { width: 1920; height: 1080 };
  locale: string;
  timezone: string;
  browserVersion: string;
  reducedMotion: "reduce";
  colorScheme: "light";
  resetLabel?: string;
}

interface Flow {
  id: Id;
  approvedAt: string;
  prohibitedActions: string[];
  steps: BrowserStep[];
}

interface BrowserStep {
  id: Id;
  order: number;
  action: "goto" | "click" | "fill" | "select" | "upload" | "waitFor";
  target?: { kind: "role" | "label" | "testId" | "url"; value: string; name?: string };
  valueRef?: string;
  consequential: boolean;
  approved: boolean;
  checkpoint: { kind: "url" | "visible" | "text" | "attribute"; expected: string; target?: BrowserStep["target"] };
  sceneKey?: string;
}

interface Capture {
  id: Id;
  sceneKey: string;
  runId: Id;
  stepIds: Id[];
  path: string;
  sha256: Sha256;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  createdAt: string;
}

interface Scene {
  id: Id;
  sceneKey: string;
  captureId: Id;
  stepIds: Id[];
  checkpointStepId: Id;
  sourceInMs: number;
  sourceOutMs: number;
  speed: 0.75 | 1 | 1.25 | 1.5 | 2;
  order: number;
  focus?: Focus;
  transition: { type: "cut" | "crossfade"; durationMs: 0 | 250 | 500 };
}

interface Focus {
  preset: "none" | "box" | "zoom";
  bounds?: { x: number; y: number; width: number; height: number };
  startMs: number;
  endMs: number;
}

interface Overlay {
  id: Id;
  sceneId: Id;
  kind: "title" | "callout";
  text: string;
  placement: "top" | "bottom" | "target";
  startMs: number;
  endMs: number;
}

type EditOperation =
  | { type: "create_scene"; scene: Scene }
  | { type: "trim_scene"; sceneId: Id; sourceInMs: number; sourceOutMs: number }
  | { type: "reorder_scene"; sceneIds: Id[] }
  | { type: "replace_capture"; sceneId: Id; captureId: Id; reason: string }
  | { type: "set_focus"; sceneId: Id; focus: Focus }
  | { type: "set_callout" | "set_title"; overlay: Overlay }
  | { type: "set_speed"; sceneId: Id; speed: Scene["speed"] }
  | { type: "set_transition"; sceneId: Id; transition: Scene["transition"] };

interface OperationRecord {
  id: Id;
  baseRevisionId: Id;
  resultRevisionId?: Id;
  actor: "baseline" | "model" | "operator" | "recapture";
  input: EditOperation;
  accepted: boolean;
  error?: { code: string; detail: string };
  evidenceRefs: string[];
  createdAt: string;
}

interface Revision {
  id: Id;
  parentId?: Id;
  actor: "baseline" | "model" | "operator" | "recapture";
  operationIds: Id[];
  manifestSha256: Sha256;
  createdAt: string;
}

interface RenderOutput {
  id: Id;
  revisionId: Id;
  renderJobSha256: Sha256;
  path: string;
  ffprobe: MediaProbe;
  verificationId: Id;
}

interface RecaptureLineage {
  id: Id;
  sceneId: Id;
  previousCaptureId: Id;
  replacementCaptureId: Id;
  changedStepIds: Id[];
  reason: string;
  revisionId: Id;
}

interface VerificationResult {
  id: Id;
  phase: "browser" | "scene" | "recapture" | "render";
  passed: boolean;
  checks: Array<{ code: string; passed: boolean; detail: string; evidencePaths?: string[] }>;
}
```

`Project` is the in-memory aggregate assembled from `brief.json`, `environment.json`, `flow.json`, and authoritative `manifest.json`; those files are not competing sources. `operations.jsonl` stores `OperationRecord` entries and each revision snapshot stores the resulting manifest. `CaptureRun` and `ModelAttempt` are evidence records, not canonical editing entities. They live in run logs. `RenderJob` is an execution description derived from a revision, not canonical project state.

## 10. Stable identity model

- **Flow step:** the flow author assigns an opaque ID to intended behavior, such as `open-billing-filter`. It remains the same while intent remains the same, even if selector text changes. A materially different action/checkpoint receives a new ID.
- **Capture:** `captureId` identifies immutable bytes plus canonical probe metadata and run identity. Recapture always creates a new file and ID; filenames are never identity.
- **Scene:** the approved flow assigns a durable narrative `sceneKey`. `sceneId` is deterministically derived from project ID plus scene key. It survives capture, selector, timing, and product-style changes while the narrative role remains the same.
- **Overlay:** a stable ID is created when first added and subsequent `set_*` operations update that entity in new revisions.
- **Operation:** every submitted operation receives an ID and records base/result revision, actor, validated input, acceptance/error, and evidence references. Operations address stable IDs.
- **Revision:** an accepted atomic operation group creates a new revision ID and semantic manifest hash. Rejected groups create audit events, not revisions.

No identity derives solely from order, timestamp, UI text, selector, or file path.

## 11. Browser capture subsystem

**Responsibility:** execute a declared flow and produce trustworthy evidence/captures.

**Interface:** `runCapture(flow, environment, options) -> CaptureRunResult`; `recaptureSegment(sceneKey, ...) -> CaptureRunResult`.

**Input:** parsed approved flow, fixed environment, reset hook label/function, optional external storage-state path, project artifact root.

**Output:** attempt record, action events, checkpoints, trace, screenshots, raw browser video, console/page errors, scene boundary timings, and successful immutable captures.

**Dependencies:** Playwright Chromium, filesystem, ffprobe after finalization.

Use a fresh context per attempt. Prefer role, label, and test ID locators; wait for declared locator/response/state conditions, not arbitrary sleep. Validate allowed app/auth origins and all consequential approvals before navigation. Stop on the first failed action/checkpoint and retain URL, screenshot, bounded DOM/accessibility excerpt, console, and trace. Never report a retry as first-pass success.

**Tests:** successful reruns, wrong checkpoint, missing target, async timeout, expired auth, prohibited action, off-origin navigation, trace/artifact completeness, and recapture segment boundaries.

## 12. Scene construction

Scene boundaries come from approved `sceneKey` markers around action groups, not visual scene detection. After Playwright closes and finalizes its run video, boundary timings cut 3-5 source captures with FFmpeg stream processing/re-encode as needed to guarantee seekable, independently probeable files. Each scene links to all producing step IDs and one final expected-state checkpoint.

Initial scene order follows flow order. Default ranges use the full successful capture after removing only instrumented pre/post padding. Scene construction does not choose titles, focus, pacing, or creative ordering. If a boundary yields empty/unprobeable media, capture fails rather than inventing a scene.

## 13. Deterministic operation system

**Responsibility:** make every project mutation structural, semantic, atomic, reproducible, and auditable.

**Interface:** `applyOperations(baseRevisionId, operations, actor) -> AcceptedRevision | OperationRejection`.

Structural Zod validation checks discriminants, required/unknown fields, ID syntax, enums, string lengths, finite integer milliseconds, normalized coordinates, and numeric ranges. Semantic validation then loads the base revision and checks entity existence, capture success/probe, source bounds, positive derived duration, exact-set reorder, overlay/focus range and safe area, transition neighbors/duration, 25-35 second result, and current-revision precondition. Only after both pass does the pure reducer compute the next manifest and the project writer atomically commit it.

Operation semantics:

- `create_scene`: valid existing capture, unique scene ID/key, valid steps/checkpoint/range; used only by deterministic initial materialization in this POC.
- `trim_scene`: replaces source in/out within immutable duration.
- `reorder_scene`: accepts the exact current scene ID set with no duplication/omission.
- `replace_capture`: repoints one scene to a successful compatible capture and records lineage/reason.
- `set_speed`: selects the fixed enum and recalculates duration.
- `set_focus`: replaces one fixed scene-local focus treatment within normalized bounds.
- `set_title`/`set_callout`: upserts a stable overlay with grounded text, fixed placement, safe area, and active range.
- `set_transition`: selects hard cut or 250/500 ms cross-dissolve valid for adjacent scenes.

Every accepted change is reversible by selecting its parent revision; the POC does not need an undo UI. Delete is omitted because 3-5 approved scenes are the test subject; changing the approved scene mapping is more honest than hiding one.

**Failure:** return a typed rejection, append the rejected attempt to `operations.jsonl`, and preserve current files/revision byte-for-byte.

**Tests:** valid/boundary-invalid cases per operation, stale revisions, atomic multi-operation failure, deterministic replay/hash, immutable capture hashes.

## 14. Agent model abstraction

```ts
interface AgentModel {
  run(input: AgentInput): Promise<AgentTurn>;
}
```

`AgentInput` contains messages, allowed tool schemas, bounded evidence parts, and remaining budgets. `AgentTurn` contains tool calls, optional explanation, provider attempt metadata, usage, and stop reason. The first adapter maps this contract to Gemini 3.8 Flash. Later one-at-a-time evaluations may provide GPT, Claude, or local Qwen-family VL adapters.

This is the only vendor seam. There is no provider registry, capability negotiation, router, fallback, common lowest-denominator media platform, or model name in the manifest. Provider/model/version belong in `ModelAttempt` evidence. An adapter failure cannot mutate the project.

## 15. Agent tool surface

Inspection tools return capped structured views:

- `inspect_project`: brief, constraints, revision, ordered scene summary, operation/verification summary.
- `inspect_flow`: approved steps, scene keys, checkpoints, safety flags, run outcomes.
- `inspect_scene`: one scene, overlays/focus, timing, source and provenance references.
- `inspect_capture`: probe, duration/timing, step links, and requested frame/contact-sheet handles.
- `inspect_browser_trace`: bounded events around named steps; never raw trace/DOM dump.
- `inspect_verification_results`: failed/all checks for a named revision/output.
- `inspect_render_result`: probe and targeted boundary/overlay/blank-frame evidence.

Editing tools are direct typed wrappers around `trim_scene`, `reorder_scene`, `replace_capture`, `set_focus`, `set_callout`, `set_title`, `set_speed`, and `set_transition`. `create_scene` remains an internal deterministic operation because capture materialization creates all 3-5 approved scenes before the agent runs; exposing it would add no hypothesis coverage and could duplicate scene identity. Execution tools are `verify_project(revisionId)` and `render_draft(revisionId)`. They call the verifier/renderer; they accept no command/filtergraph arguments.

Tool responses include current/result revision IDs, success/error code, concise detail, and evidence handles. Unknown tools, fields, IDs, paths, or operations reject.

## 16. Model context strategy

The initial context contains the brief/audience, output constraints, flow/checkpoint summary, current scene metadata, capture probes, operation summary, and latest verification. Target a maximum of 12,000 input tokens before model output, excluding provider image accounting.

The context builder chooses evidence by current task and scene IDs. Default visual evidence is start/middle/end frames per scene, downscaled contact sheets, plus frames at action/checkpoint boundaries. DOM/accessibility summaries include only the relevant locator subtree and visible labels. A tool can request one named scene/capture/trace window; response size and image count are capped.

Exclude passwords, cookies, storage state, authorization headers, form secret values, unrelated screenshots, raw full DOM/trace, customer identifiers, filesystem enumeration, and URL query secrets. Redact before disk/model request, record every disclosed artifact/hash, and use synthetic/disposable data. Full video input is disabled unless a separately recorded comparison proves material quality improvement.

## 17. Agent execution loop

```text
inspect -> model turn -> typed tool call -> validate/apply
        -> verify -> render -> targeted inspect -> optional second pass
```

Limits per agent attempt: at most 2 model edit passes, 20 total tool calls, 2 renders, 1 retry for a transient model transport failure, and 2 minutes of model wall time excluding local render. The controller, not the model, enforces limits.

The model may call several inspections, submit an operation group, verify, render, inspect targeted output evidence, and optionally submit one correction group. It stops immediately on unavailable product fact, ambiguous brief/grounding, unsupported operation, repeated invalid call, failed required verification it cannot address with allowed tools, or exhausted budget. The stop result names the ambiguity and preserves the last accepted revision.

## 18. Deterministic non-AI baseline

Slice 1 is built first:

```text
approved flow -> captures -> manifest -> manual fixed operations
-> verification -> RenderJob -> FFmpeg -> valid MP4
```

One App A flow produces 3-5 scenes. A checked-in fixture decision record supplies exact trims/order/title/callout/focus/speed/transition through `applyOperations`. This proves capture, IDs, reducer, verification, render description, FFmpeg, probing, and review artifacts without attributing failure to a model. The result may look poor; it must be correct and inspectable.

## 19. Agent-driven editing slice

Slice 2 starts from the same pre-edit revision:

```text
AgentModel -> inspection tools -> editing tools -> applyOperations
-> verifyProject -> buildRenderJob -> FFmpeg
```

The hard-coded decisions are removed from orchestration, not replaced by another engine. The agent selects trims/order/fixed treatments and grounded text. Success requires accepted tool calls, a model-authored revision, successful verification/render, replayable operations, and recorded human correction time. Manual correction also uses the same operation interface.

## 20. Selective recapture/reconciliation

Lifecycle:

```text
scene-03 -> capture-A -> accepted operations -> product change
-> rerun approved scene segment -> capture-B
-> replace_capture(scene-03, capture-B) -> revised verification/render
```

Allowed changes are the target scene's `captureId`, capture probe/path/hash, target-valid timing if explicitly edited, lineage, revision metadata, verification, RenderJob, and output. Unchanged are every other scene's identity/source/ranges/order/focus/transition, unrelated overlays, and accepted unrelated operation records.

`RecaptureLineage` records scene, old/new capture, changed steps, reason, and resulting revision. Before replacement, compute a canonical semantic projection of all unaffected scenes/overlays/accepted operations. After replacement, recompute and require identical hashes. Target-scene trims/focus/overlays survive only if valid against capture B; otherwise replacement rejects with exact incompatible ranges rather than clamping or dropping edits. This proves agent edits survive recapture.

## 21. Render-job model

```ts
interface RenderJob {
  id: Id;
  revisionId: Id;
  revisionSha256: Sha256;
  scenes: Array<{
    sceneId: Id;
    sourcePath: string;
    sourceSha256: Sha256;
    inMs: number;
    outMs: number;
    speed: number;
    focus?: Focus;
    overlays: Array<{ imagePath: string; startMs: number; endMs: number; x: number; y: number }>;
    transition: Scene["transition"];
  }>;
  output: { path: string; width: 1920; height: 1080; fps: 30; videoCodec: "libx264"; audioCodec: "aac" };
}
```

**Responsibility:** freeze a verified revision into the complete bounded input for rendering.

**Interface:** `buildRenderJob(revisionId, verificationId) -> RenderJob`.

It rejects failed/stale verification, unresolved assets, unsupported primitives, unsafe output paths, or hash mismatch. Canonical JSON is hashed and stored beside the render. The model never supplies this object directly.

## 22. FFmpeg rendering

**Interface:** `executeRenderJob(job) -> RenderExecutionResult`.

For each scene, FFmpeg trims video/audio, resets timestamps, applies fixed speed (`setpts` and bounded `atempo` where source audio exists), scales/pads to 1920x1080, applies the fixed crop/scale focus preset, and overlays pre-rendered images. Scenes use hard concat or the known 250/500 ms cross-dissolve construction. The final pass outputs 30 fps H.264/AAC MP4; sources without usable audio receive a silent AAC track so the stream requirement is deterministic.

Build argv arrays from trusted templates and validated numbers/paths. Invoke with `execa` and shell disabled. Never concatenate model/user text into a shell/filter string. Render into a unique project temp directory, retain RenderJob/argv/stderr on failure, probe/decode before atomically promoting the MP4, and record first/retry attempts separately.

**Tests:** golden RenderJob-to-argv descriptions, tiny real renders, trim/speed/overlay/transition boundary frames, missing audio, corrupt input, nonzero exit, probe and full decode.

## 23. Overlay implementation

Keep three fixed templates: `title.svg`, `callout.svg`, and `focus-box.svg`. Parameters are escaped text, approved placement, size preset, normalized focus bounds, colors fixed by the POC treatment, and active milliseconds. Render SVG to transparent PNG with Sharp only when FFmpeg overlay needs raster input. Cursor emphasis, if App C proves it necessary, is one fixed ring asset tied to captured cursor coordinates; otherwise omit it.

No animation abstraction exists. Title/callout may use fixed fade timing encoded by the renderer; focus is one box or one bounded pan/zoom preset. Template rendering validates text length, safe area, dimensions, and font availability before a RenderJob is built.

## 24. Verification subsystem

**Interface:** `verifyBrowser(runId)`, `verifyProject(revisionId)`, `verifyRecapture(previousRevisionId, revisionId)`, and `verifyRender(outputId)` each return `VerificationResult` without mutation.

- **Browser:** approved flow completed; every expected checkpoint reached; origin allowed; expected UI state exists; no prohibited/unapproved action occurred.
- **Scene:** captures exist, hashes match, ffprobe succeeds, IDs/provenance resolve, ranges are within duration, derived duration is positive, scene keys/IDs are unique, overlays/focus resolve and fit.
- **Recapture:** target scene points to new capture; lineage matches old/new IDs; unaffected source references and semantic operation/overlay projections are unchanged.
- **Render:** output exists; ffprobe reports H.264, AAC, 1920x1080, 30 fps, and 25-35 seconds; full decode reaches the end; sampled boundary/interval analysis finds no continuous obvious blank/frozen interval above the documented threshold.

The blank detector uses FFmpeg black/freeze detection with fixed recorded thresholds and reports evidence; it is not a creative judge. Human review decides pacing, persuasiveness, copy, aesthetics, and publishability.

## 25. Local persistence/artifacts

```text
projects/<project-id>/
├── brief.json             # audience, message, fixed target
├── environment.json       # reproducible non-secret browser settings
├── flow.json              # approved steps/checkpoints/safety contract
├── manifest.json          # current canonical revision pointer/state
├── operations.jsonl       # accepted and rejected mutation attempts
├── revisions/             # immutable canonical manifest snapshot per revision
├── captures/              # immutable scene media named by capture ID
├── screenshots/           # boundary/checkpoint/model-disclosed frames
├── traces/                # Playwright trace per attempt
├── renders/               # RenderJobs, stderr, probes, MP4 outputs
├── verification/          # immutable results by phase/revision/output
├── logs/                  # run/model/stage JSONL events
└── report.html            # regenerated read-only review surface
```

Browser storage state lives outside `projects/` in a gitignored operator-selected auth directory. Writes use temp file plus atomic rename; captures/revisions/results are append-only. `manifest.json` is regenerated/committed only after an accepted operation group. The POC does not implement deletion UX, retention policy, backups, or migrations beyond rejecting unsupported `schemaVersion`.

## 26. Internal review report

`generateReport(projectId) -> report.html` reads but never mutates state. It shows brief, environment/run status, ordered scene cards, thumbnails, source capture/step/checkpoint links, timing/focus/overlay/transition values, accepted/rejected operations with actor, verification checks, model attempt/grounding metrics, initial baseline render, agent render, and selective-recapture render/diff.

Use escaped HTML, CSS, native `<video controls>`, and local relative links. Optional bounded correction forms may invoke existing CLI commands through copyable JSON; do not add a server/framework merely for buttons. A timeline is absent.

## 27. Failure handling

| Failure | Behavior |
|---|---|
| Missing action/checkpoint or async timeout | Stop exact step; preserve evidence; corrected target/state creates a new measured attempt. |
| Unexpected origin/unapproved consequential action | Block before action; require flow reapproval. |
| Expired authentication | Stop without logging secrets; operator refreshes external local session. |
| Empty/corrupt capture | Do not create/replace scene; retain raw run evidence. |
| Invalid/stale operation | Reject atomically; retain current revision and audit error. |
| Model timeout/invalid call/ambiguity | One visible transport retry only; stop with last accepted revision. |
| Verification failure | Block render or reject output; never auto-repair state. |
| FFmpeg failure | Retain job, argv, stderr, intermediates; one visible retry only for classified transient I/O/process failure. |
| Recapture incompatibility | Reject replacement; name invalid target-scene ranges/edits; preserve both captures. |
| Interrupted write | Atomic rename leaves last complete manifest; orphan temp is diagnostic. |

Every result carries a first-cause category: `browser_automation`, `checkpoint_state`, `capture`, `scene_mapping`, `operation`, `recapture`, `model_decision`, `verification`, or `rendering`. Downstream failures do not overwrite it.

## 28. Testing strategy

- **Unit:** Zod parsing, stable IDs, duration/safe-area math, operation semantics/atomicity/replay, context redaction/caps, RenderJob creation, preservation projections.
- **Integration:** flow evidence -> captures -> manifest; operation -> revision; verified revision -> real FFmpeg output; typed model call -> reducer; recapture -> replacement -> render.
- **Golden:** canonical project/revision hashes, inspection responses, RenderJobs, tool transcripts. Do not byte-compare MP4 across machines.
- **Browser:** App A/B/C resets, two measured executions, checkpoints, origins/approvals, failure evidence, auth-state isolation.
- **Media:** ffprobe/decode, boundaries, blank/frozen fixtures, overlays, silent audio, corrupt/missing media.
- **Agent adversarial:** unknown/dynamic tool, malformed/stale operation, invented product claim, secret/raw trace/full filesystem/shell/FFmpeg request, budget exhaustion.

Vitest is the assertion runner for all suites. Browser helpers call Playwright programmatically. Tests exercise module interfaces rather than internal helpers.

## 29. Three-application adversarial setup

Each fixture directory contains `README.md` describing complexity, `flow.ts` with stable approved IDs/checkpoints, `reset.ts`, `change.ts` for the selective-recapture state change, and expected fixture metadata. The applications may be existing controllable apps or tiny purpose-built fixtures; measured product-use review must still use representative flows.

- **App A:** normal navigation plus form/control and visible result.
- **App B:** disposable auth, async backend state, and at least two of modal/dropdown/toast/animation/complex state.
- **App C:** one iframe, upload, popup/new tab, large dynamic table, wizard, deliberate slow state, or equivalent difficult interaction.

The common harness resets, runs twice, builds baseline and agent draft, changes one target state, recaptures one scene, verifies, renders, and emits the same result schema. Stage-specific records make failure attribution independent of the fixture.

## 30. Model evaluation strategy

For every real attempt record provider/model/version, prompt/tool schema version, input/output tokens, disclosed artifact hashes, tool calls, structural/semantic rejections, edit passes, renders, latency, estimated API cost, accepted operation sequence, grounding references, render-without-manual-repair outcome, correction minutes, and recapture preservation result.

Primary metrics are tool-call validity rate, invalid operation count/rate, validator preventions, iterations, latency, cost, first/final render success, correction time, grounded-decision rate, replay success, and agent-edit survival after recapture. Human usefulness remains the PRD question “would publish/send,” not model self-scoring.

The same frozen cases and evidence bundles can be run one model at a time through another `AgentModel` adapter. Comparisons never alter project/tool/render contracts. No automatic routing or fallback is built.

## 31. Logging/debuggability

Each JSONL event includes timestamp, project/run/attempt/revision IDs, stage, operation/tool, duration, outcome, first-cause category, and artifact paths. Store capture plan, action/checkpoint events, retries/interventions, browser trace/screenshots, before/after manifest hashes, accepted/rejected operations, bounded model inputs/tool outputs, model usage/cost, verification, RenderJob, sanitized argv, FFmpeg stderr, correction time, and recapture diff.

Redaction happens before persistence. Logs contain no raw auth storage, cookies, tokens, secret fill values, or unrelated DOM. There is no remote collector or dashboard.

## 32. Security/privacy

- Use disposable accounts and synthetic/non-sensitive fixtures.
- Keep credentials/storage state outside project/source control; pass only its local path to Playwright.
- Preflight allowed application/auth origins and explicit consequential actions; fail closed.
- Do not grant the model browser, filesystem, process, shell, JavaScript, or FFmpeg access.
- Permit model evidence only through bounded inspection tools; log disclosed artifacts and redact secrets/identifiers first.
- Use argv execution with shell disabled, validated project-relative output paths, escaped SVG/HTML text, and immutable source permissions where practical.
- Warn before sensitive screens; a sensitive-data warning stops measured capture until operator confirmation.

The POC does not claim enterprise isolation/compliance. Any credential disclosure or prohibited action is an immediate POC failure.

## 33. Performance targets

On the declared founder reference machine: raw flow <=5 minutes; 3-5 scenes; stable-flow capture to first draft <10 minutes; single-scene recapture to revised draft <5 minutes; authoritative 30-second render <3 minutes; output 25-35 seconds at 1920x1080/30 fps H.264/AAC. Model inspection latency is recorded, not given a PRD pass threshold. Reliability and correct state outrank speed.

## 34. Cost model

Technical infrastructure cost is approximately ₹0: founder laptop, local Chromium, installed FFmpeg, local files, and open-source libraries. Variable model cost equals measured Gemini requests; context/image/tool budgets keep it near zero to a few thousand rupees for all POC runs. No paid hosting, database, storage, browser, render, GPU, queue, logging, or analytics service is required.

Track founder engineering/review/correction time separately. Interview incentives and concierge/pilot production are market-validation costs, not technical POC costs and remain under the PRD's separate gates.

## 35. POC execution sequence

1. Bootstrap only Node 22+, TypeScript, pnpm, `tsx`, Zod, Vitest, Playwright, execa, and tool preflight.
2. Execute one hard-coded approved App A Playwright flow.
3. Record source video, screenshots, trace, action timing, and checkpoints.
4. Cut/probe immutable captures and create the minimal manifest with stable identities.
5. Implement structural/semantic operation validation and the pure atomic reducer.
6. Apply one deterministic manual edit set through that reducer.
7. Add the minimum explicit browser and scene/project verification required to authorize rendering.
8. Generate a bounded RenderJob only from that verified revision.
9. Produce the first ugly MP4 through FFmpeg, then add post-render probe/decode/blank-frame verification before accepting it as valid.
10. Add bounded inspection tools and context/redaction rules.
11. Implement the one-method adapter and configure Gemini 3.8 Flash.
12. Let the model create real edits through the existing tools/reducer.
13. Verify and render the agent-edited draft; optionally allow one targeted second pass.
14. Change App A, recapture one approved scene, and apply `replace_capture`.
15. Verify unrelated and agent-generated edits survive; render the revised output.
16. Generate `report.html` from stored artifacts.
17. Run the identical path twice for Apps A/B/C with one recapture each.
18. Record technical, agent, correction-time, usefulness, privacy, and cost metrics.
19. Apply every POC pass/fail gate without changing thresholds.

No framework, UI polish, or production hardening precedes the first MP4.

## 36. POC pass/fail mapping

| PRD gate | Architectural evidence |
|---|---|
| Adversarial coverage | Common harness; two measured runs for each qualifying App A/B/C. |
| Browser completion >=5/6 | Immutable attempt records distinguish first pass, retry, recovery, intervention. |
| Product-state correctness | Declared checkpoint results; wrong state cannot be accepted. |
| Reproducibility | Stable step/scene identities and ordered checkpoint/scene maps across reruns. |
| Selective recapture 3/3 | New capture/lineage plus unchanged unaffected semantic hashes. |
| Selector/action recovery | Exact failure evidence and explicitly corrected new attempt; no guessing. |
| Nine valid final renders | Six run outputs plus three recapture outputs pass probe/full decode/format rules. |
| Correction time | Report records active minutes; median <10 and none >20. |
| External usefulness | Three target reviewers; at least two would publish/send. |
| Safety/privacy | Secret scans/disclosure logs/origin/action records show no violation. |
| Agentic editing | Real accepted tool sequence creates a revision/render; validity, grounding, repair, cost, and recapture-survival metrics recorded. |

**PASS:** every PRD gate passes and both hypotheses have direct artifacts. **FAIL:** any mandatory gate fails, including model-only text, manual manifest repair, unsafe behavior, or absent usefulness. **REWORK:** only a bounded existing-scope defect has a specific correction and rerun; output/demand failure does not justify more infrastructure or a larger editor.

## 37. Technical risks

| Risk | POC mitigation / decision signal |
|---|---|
| Playwright video timing does not align with action markers | Record monotonic boundaries and calibration padding; fail scene mapping if drift exceeds measured tolerance. |
| Dynamic apps are nondeterministic | Explicit reset and state checkpoints; wrong state fails even if action succeeds. |
| Fixed FFmpeg graph becomes brittle | Keep RenderJob primitives closed and golden-test each combination; do not accept arbitrary graphs. |
| Model tool calling is malformed or poorly grounded | Two-layer validation, evidence handles, strict budgets, frozen eval cases; failure informs Hypothesis B. |
| Recapture invalidates target-scene timing | Reject incompatible retained edits and report exact ranges; never silently drop/clamp. |
| Preview/report differs from final | Report uses authoritative MP4; thumbnails are evidence only. |
| Sensitive content reaches the model | Synthetic data, bounded context builder, redaction canaries, disclosure log, no raw trace/video default. |
| Model name/capability/price changes | Single tiny adapter and recorded model version; evaluate another adapter manually without changing project architecture. |

## 38. Deferred decisions

Defer until evidence: mandatory existing Playwright tests versus written flows; selector self-healing; narration/TTS; additional formats/durations; conversational UI; richer preview/editor core; automatic invalidation detection; CI/GitHub/Linear; full-video model input; local model execution; cloud browser/render/storage; collaboration; accounts/billing; model routing/fallback; production packaging, persistence, telemetry, updates, or compliance.

The current decisions are local runner, Chromium, explicit corrected selectors, no narration, one fixed format/treatment, static report, thin owned manifest/reducer, one active model adapter, and local FFmpeg.

## 39. Production implications, without designing production

The POC should preserve only the expensive-to-lose truths: stable semantic identities, immutable source media, canonical validated operations, revision provenance, bounded model tools, explicit verification, and RenderJob separation from FFmpeg. Filesystem layouts, CLI shape, adapter request details, report markup, and most implementation code may be discarded.

Production is not authorized by this document. It begins only after the technical POC passes, external usefulness/payment/repeat validation passes, and scope is reconfirmed. No production account, cloud, database, queue, deployment, packaging, or editor architecture is included here.
