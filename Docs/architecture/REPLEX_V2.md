# Replex V2 architecture

**Status:** Architecture-approved, not implemented

**Date:** 19 September 2026

**Source/content baseline:** `b9b383692b7829ef9ce15e244ae65ba6e8591681` via
`origin/backup/pre-replex-v2-2026-09-19`. This recovery branch preserves the
pre-V2 filesystem content and remains unchanged.

**Integrated historical baseline:** `82b492858565980f80b323e05a2a58feaced93c2`.
It has the same Git tree (`b034a5611f207cfd30c87e10d0c3216eef1142e0`) as the
source/content baseline, but includes the later integrated pre-V2 ancestry. Do
not treat the two commit histories as interchangeable.

No additional integrated recovery ref is created by this documentation pass;
the immutable integrated commit remains directly recoverable by SHA and the
existing recovery branch is not modified.

This is the normative architecture for V2. The historical POC remains documented in [`../poc/technical_poc.md`](../poc/technical_poc.md) and its formal status remains in [`../poc/task.md`](../poc/task.md). The implementation sequence is in [`../v2/implementation-plan.md`](../v2/implementation-plan.md).

## 1. Product thesis

Replex is an agentic video composition system that can ingest browser-generated product footage, user-uploaded media, or both. A user expresses editing intent conversationally. Replex understands the available media, converts intent into validated semantic operations, maintains canonical editable project state, renders through deterministic media backends, verifies outputs, and preserves browser provenance where applicable.

The architectural change is precise:

- V1: browser capture is the project.
- V2: media composition is the project; browser capture is one intelligent media source.

This does not create a generic AI editor or a second editing engine. Browser captures and uploaded assets enter one project model, one operation reducer, one revision history, and one render protocol. Replex's advantage remains the combination of media understanding with reproducible software provenance and selective recapture.

Positioning:

> Give Replex your product, your footage, or both. Tell the agent what video you want. Replex edits the footage, applies programmable motion, and, when footage originates from your product, retains enough provenance to reproduce or selectively recapture it later.

## 2. Current baseline and retained foundations

The integrated V1 code implements strict project validation, immutable capture files, stable scene identity, atomic canonical revisions, a single validated reducer, bounded model tools, explicit inspection, verification-gated rendering, FFmpeg execution, and selective recapture with preservation checks. The official six-run evidence recorded 6/6 browser completions, 9/9 valid final outputs, and 3/3 selective-recapture preservation proofs.

The formal POC decision remains **REWORK**, with `productionAuthorized: false`, because target-user usefulness reviews and correction-time evidence are incomplete. This is a product-validation gap, not a claim that the engineering POC failed.

V2 retains:

- deterministic Playwright capture and immutable evidence;
- stable IDs and browser provenance;
- validated operations as the sole mutation path;
- bounded model inspection and tools;
- atomic revisions and attributable operation records;
- verification before authoritative render;
- deterministic FFmpeg execution;
- selective recapture that preserves unrelated edits.

V2 supersedes these V1 assumptions:

- every project has one approved browser flow;
- every source is a `Capture` tied to action IDs and a checkpoint;
- every scene must carry browser identity;
- a fixed 30-second, 1080p browser release video is the only output;
- browser capture must occur before composition.

## 3. Non-negotiable invariants

1. Canonical project state is Replex-owned.
2. Source media is immutable and content-addressed by SHA-256.
3. Stable IDs survive edits and recapture.
4. Every accepted mutation creates attributable revision history.
5. AI and manual editing use the same semantic mutation system.
6. The model cannot directly mutate canonical state.
7. The model cannot execute arbitrary shell commands.
8. Renderer-specific commands are not canonical project state.
9. FFmpeg remains behind validated execution boundaries.
10. Browser credentials and sensitive session state remain isolated from projects and model evidence.
11. Local-first is a first-class execution model.
12. Cloud is an execution target, not a separate product architecture.
13. Browser provenance is retained where applicable.
14. Selective recapture remains a core differentiator.
15. Verification is separate from creative judgement.
16. Human review remains part of quality evaluation.
17. Motion and media backends remain replaceable.
18. The POC does not attempt full NLE or After Effects parity.
19. Architecture decisions are evidence-driven.
20. Documented features are not implemented features.

## 4. Canonical Project Schema V2

The structures below are design contracts, not source code added by this change. Exact Zod syntax belongs in Phase 1.

```ts
type AssetType =
  | "browser_capture"
  | "uploaded_video"
  | "image"
  | "audio"
  | "generated_graphic";

interface MediaProbe {
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  channels?: number;
  sampleRateHz?: number;
}

interface BrowserProvenance {
  kind: "browser";
  flowId: string;
  sceneKey: string;
  actionIds: string[];
  checkpointActionId: string;
  runId: string;
  capturedAt: string;
  predecessorAssetId?: string;
}

interface UploadProvenance {
  kind: "upload";
  originalFilename: string;
  importedAt: string;
  sourceSha256: string;
  importMethod: "file_picker" | "path" | "upload";
  originalProbe: MediaProbe;
}

interface GeneratedProvenance {
  kind: "generated";
  generator: string;
  generatedAt: string;
  inputRefs: string[];
}

interface MediaAsset {
  id: string;
  type: AssetType;
  path?: string;
  objectRef?: string;
  sha256: string;
  probe: MediaProbe;
  provenance: BrowserProvenance | UploadProvenance | GeneratedProvenance;
}

// Immutable source access is authorized by the planner/executor boundary.
interface AssetHandle {
  assetId: string;
  sha256: string;
  ref: string; // scoped path/object reference, never an arbitrary filesystem path
}

interface RenderArtifact {
  outputId: string;
  ref: string;
  sha256: string;
  probe: MediaProbe;
  sourceRevisionId: string;
  renderJobHash: string;
}

interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  timelineStartMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  speed: number;
  transform: Transform;
  crop?: Crop;
  opacity: number;
  audioGainDb: number;
  transitionOut?: Transition;
}

interface Layer {
  id: string;
  trackId: string;
  kind: "text" | "image" | "graphic";
  timelineStartMs: number;
  durationMs: number;
  properties: TextProperties | ImageProperties | GraphicProperties;
  keyframes: Keyframe[];
}

interface Track {
  id: string;
  kind: "video" | "audio" | "overlay";
  order: number;
  muted: boolean;
  locked: boolean;
}

interface Composition {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  tracks: Track[];
  clips: Clip[];
  layers: Layer[];
}

interface ProjectV2 {
  schemaVersion: 2;
  projectId: string;
  brief: ProjectBrief;
  assets: Record<string, MediaAsset>;
  composition: Composition;
  revisions: Revision[];
  operationLogRef: string;
  outputs: RenderOutput[];
  verification: VerificationState;
  browser?: {
    flows: Record<string, BrowserFlow>;
    recaptureLineage: RecaptureLineage[];
  };
  currentRevisionId: string;
}
```

### Why tracks exist

Three fixed track kinds are the minimum needed to express overlapping video, independent audio, and visual overlays. They are ordering containers, not an unrestricted NLE graph. Phase 1 supports one primary video track and one overlay track; additional video/audio tracks arrive only with the multi-asset phase.

### Timing and keyframes

All canonical time values remain integer milliseconds. Clip source ranges are half-open `[sourceInMs, sourceOutMs)`. Timeline position is explicit. Initial keyframes support only an allowlist of numeric properties: position, scale, rotation, opacity, crop, blur, and selected camera properties. Interpolation is an enum such as `linear`, `ease_in`, `ease_out`, or `ease_in_out`; arbitrary expressions and renderer code are forbidden.

### Render outputs and verification

A render output references the exact revision, RenderJob hash, backend identity/version, output hash, probe, and verification result. It is a derived `RenderArtifact`, not a new immutable source `MediaAsset`. Verification state is derived evidence, not creative approval, and is invalidated by any accepted mutation affecting the revision.

## 5. V1 compatibility and migration

Use a **read compatibility layer with explicit command-driven persistence**:

1. `loadProject` detects `schemaVersion`.
2. V1 parses with the frozen V1 schema.
3. `adaptV1ToV2` creates an in-memory V2 view: each `Capture` becomes a `browser_capture` asset; each scene becomes a clip; overlays become layers; flow and recapture lineage move under `browser`.
4. Normal reads, inspection, preview, and compatibility tests may use the adapted view without changing disk.
5. `migrate-project --to 2` writes a new revision and migration report only after validation, semantic comparison, and backup. It never overwrites the V1 file in place.
6. Once saved as V2, the project remains V2. Exporting a general V2 project back to V1 is unsupported; the preserved V1 project and renderer remain the rollback path.

This is safer than eager migration because opening an old project cannot irreversibly rewrite it. It is simpler than indefinite dual writes, which would create two canonical states. The migration must preserve stable scene/clip IDs where valid, capture hashes, action/checkpoint identity, revision ancestry, outputs, and recapture lineage. Golden V1 fixtures and an end-to-end recapture fixture are release gates.

## 6. Canonical mutation vocabulary

Every accepted mutation follows:

`intent -> bounded inspection -> proposed typed operations -> schema and semantic validation -> reducer -> revision -> verification -> render`

The initial V2 vocabulary is intentionally small:

| Initial operation | Meaning |
|---|---|
| `import_asset` | Register an immutable, probed asset after ingestion succeeds |
| `remove_asset` | Remove only an unreferenced asset record; source deletion is separate and never implicit |
| `create_clip` | Place an asset range on an allowed track |
| `split_clip` | Split one clip while preserving source continuity and identity lineage |
| `trim_clip` | Change source in/out within asset bounds |
| `move_clip` | Change timeline position or track within collision rules |
| `remove_clip` | Remove a clip and dependent clip-scoped layers by explicit policy |
| `replace_asset` | Repoint a clip while validating duration-dependent properties |
| `set_transform` | Set position, scale, rotation, anchor, and optional crop in one unambiguous visual operation |
| `set_opacity` | Set clip or layer opacity |
| `set_speed` | Set bounded playback speed and recompute duration |
| `set_transition` | Apply an allowlisted transition at a clip boundary |
| `add_text_layer` / `update_text_layer` | Create or update typed text content and style |
| `add_image_layer` / `remove_layer` | Add an asset-backed overlay or remove an overlay layer |
| `set_volume` / `mute_clip` | Change clip audio without rewriting source |
| `animate_property` | Add validated keyframes to an allowlisted property |
| `apply_motion_preset` | Expand a versioned preset into canonical keyframes/parameters through the reducer |
| `recapture_browser_asset` | Request capture; it does not mutate until evidence exists |
| `replace_browser_capture` | Add a new immutable browser asset, lineage, and clip replacement |

Deferred until their phases: `add_audio` and `replace_audio` are expressed initially by `import_asset` plus `create_clip` or `replace_asset`; `reorder_clip` is unnecessary because timeline position and stable tie-breaking define order; separate `set_crop` is folded into `set_transform` to avoid overlapping mutation semantics. Complex masks, arbitrary effect graphs, nested compositions, scripting, and renderer-specific filters are out of scope.

Manual controls call the same operations. Batch application is atomic against one `baseRevisionId`; stale bases fail. Operation records include actor, intent/job ID, evidence references, acceptance result, and resulting revision.

## 7. Ingestion and media understanding

```text
IMPORT -> HASH/PROBE -> ANALYZE -> INSPECT -> PLAN -> EDIT -> VERIFY -> RENDER
```

Ingestion copies or uploads source into immutable storage, computes SHA-256, probes streams, and records provenance before the asset is accepted. Analysis produces derived, regenerable evidence rather than modifying the source:

- FFprobe metadata and stream inventory;
- shot boundaries and duration ranges;
- contact sheets plus selected keyframes;
- per-shot motion/activity measurements;
- audio levels, silence ranges, waveform summary, and clipping indicators;
- optional timestamped transcript when speech exists;
- targeted multimodal inspection of selected frames, never naive full-video context.

Bounded tools expose `inspect_project`, `inspect_asset`, `inspect_clip`, `inspect_frames`, `inspect_contact_sheet`, `inspect_transcript`, `inspect_audio_analysis`, `inspect_browser_provenance`, and `inspect_verification`. Each request has asset/clip scope, evidence limits, redaction, and cost limits. Evidence carries hashes and analysis-version metadata so stale analysis is detectable.

## 8. Rendering backends

Canonical state describes composition intent. A planner freezes one revision into a validated `RenderJob`/`MediaExecutionJob`; adapters translate that immutable plan into backend contracts. Backends do not receive the mutable project or decide what should be rendered.

```ts
interface MediaReadContext {
  resolve(handle: AssetHandle): Promise<ReadableStream>;
  authorization: string;
  analysisVersion?: string;
}

interface MediaExecutionContext {
  resolve(handle: AssetHandle): Promise<ReadableStream>;
  outputDirectory: string;
  cancellation: AbortSignal;
  authorization: string;
}

interface MediaBackend {
  probe(input: AssetHandle, context: MediaReadContext): Promise<MediaProbe>;
  inspect(input: AssetHandle, request: MediaInspectionRequest, context: MediaReadContext): Promise<MediaEvidence>;
  execute(job: MediaExecutionJob, context: MediaExecutionContext): Promise<MediaExecutionResult>;
  verify(artifact: RenderArtifact, requirements: OutputRequirements, context: MediaReadContext): Promise<VerificationResult>;
}

interface MotionBackend {
  execute(job: MotionExecutionJob, context: MediaExecutionContext): Promise<MotionExecutionResult>;
}

interface MotionExecutionResult {
  artifact: RenderArtifact;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  pixelFormat?: string;
  alpha?: "none" | "straight" | "premultiplied";
  audio: "present" | "absent";
  colorSpace?: string;
  backendId: string;
  backendVersion: string;
  presetId: string;
  presetVersion: string;
  sourceRevisionId: string;
  renderJobHash: string;
  verification: VerificationResult;
}
```

The planner owns conversion from a frozen Replex revision to the execution
job. Asset handles and resolver contexts are narrow, immutable, and authorized.
Backends cannot mutate revisions, invent semantic operations, inspect canonical
state to choose work, or persist renderer-specific commands as project state.
The final media pipeline rejects motion artifacts whose declared dimensions,
timing, pixel/alpha/audio, or color-space contract is incompatible with the
RenderJob unless that transformation is explicitly authorized by the job.

```text
Canonical Replex Composition
            |
        RenderJob
        /       \
Media Backend   Motion Backend
      |              |
ffmpeg-skill or   programmable motion
native FFmpeg         |
      +-------+-------+
              |
      final media pipeline
```

The existing native FFmpeg renderer remains the compatibility backend. A cheap
ffmpeg-skill capability/contract spike runs at the Phase 1/2 boundary before
new media plumbing is duplicated. The later `FfmpegSkillBackend` implementation
is conditional on that GO or PARTIAL-GO result. See [`ADR-004`](ADR-004-ffmpeg-skill.md).

Ordinary media processing stays separate from motion composition. A motion backend consumes typed presets and keyframes, emits an intermediate or final visual stream, and cannot mutate project state. Remotion is a candidate because it supports programmatic React-based video and server rendering, but the adapter must prove determinism, performance, cancellation, and licensing suitability before adoption. Its current special license can require a company license, so legal/commercial review is an explicit gate rather than an assumption.

The first motion POC proves a small preset set: 3D device/screen tilt, camera push/pan, 2.5D parallax, kinetic title reveal, masked reveal, spotlight/focus, glow/blur/light sweep, and perspective card stack. A later WebGL/React Three Fiber layer is optional. No arbitrary user code, arbitrary shader code, or After Effects parity.

## 9. Local and cloud execution

One service/job protocol supports separate execution targets. Its
transport-independent domain contracts are stabilized early, after the V2
schema/reducer, so the frontend can mock against backend-owned types. HTTP,
SSE/WebSocket, process supervision, and executors remain later implementation
work:

```text
Frontend -> Replex Service API -> Job orchestration -> Local executor
                                             \-----> Cloud executor
```

The protocol exposes conceptual commands `createProject`, `importAsset`, `startBrowserCapture`, `requestAgentEdit`, `applyOperations`, `verifyRevision`, `renderPreview`, `renderRevision`, `recaptureBrowserScene`, and `cancelJob`. Revision-mutating requests include a required base revision and idempotency key; derived jobs reference an explicit immutable revision and do not mutate canonical state.

Executors receive the same immutable job envelope and return the same status/events/results. Infrastructure differs: local jobs use local files and processes; cloud jobs use object storage, queues, and isolated workers. Canonical semantics do not differ.

The early POC keeps browser capture and uploaded-media editing local. Cloud rendering may follow if budget permits. Authenticated cloud browser capture is deferred because it adds credential/cookie custody, private network and staging access, tenant isolation, session cleanup, audit, and breach-impact risks that media-only rendering does not.

## 10. Security and failure model

- Paths/object references are validated and scoped to the project or authorized storage namespace.
- Source assets are immutable; derived artifacts are separately addressed.
- Backends receive structured jobs, never model-authored commands.
- Process execution uses argv without a shell, allowlisted binaries/tools, deadlines, cancellation, resource limits, and sanitized logs.
- Browser credentials stay in an executor-owned secret/session boundary and never enter project JSON, model context, or operation logs.
- A failed batch produces no revision. A failed render cannot become authoritative output. Partial backend outputs are quarantined or removed.
- Jobs are idempotent by request key and revision hash. Cancellation is best-effort but final states are explicit.
- Verification checks structural/media requirements; a human judges story, taste, and publishability.

## 11. Explicitly deferred

The POC excludes a professional NLE, unrestricted After Effects parity, large effect libraries, plugin marketplaces, collaboration, billing, team/account systems, cloud browser credential handling, arbitrary generated-video models, multi-agent orchestration, production-scale infrastructure, arbitrary filters/scripts, and unrestricted timelines.

## 12. Open questions requiring evidence

1. Does the early ffmpeg-skill capability spike produce a GO, NO-GO, or PARTIAL-GO without semantic leakage or excessive multi-step overhead?
2. Can Remotion produce the selected motion presets deterministically within local preview and render budgets, and what license applies to the intended company/use case?
3. What analysis thresholds give useful shot/motion/silence evidence across screen recordings and camera footage without expensive full-video model inspection?
4. Should V2 store derived evidence references inside the manifest or in a revision-addressed evidence index? Phase 1 must choose one canonical reference pattern.
5. Which cloud executor and object store meet isolation, cancellation, egress, and cost limits? This is deliberately deferred until local evidence exists.
