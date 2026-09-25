# ADR-009: Bound the native V2 composition render profile

- **Status:** Accepted
- **Date:** 25 September 2026

## Context

The Phase 2 native renderer proves a verified export for one uploaded video clip. Phase 5 needs a small launch-video composition without changing canonical ProjectV2 semantics or passing mutable project state to FFmpeg. ProjectV2 already represents clips, transitions, audio, text layers, and image layers, but its model intentionally does not encode renderer-specific filter graphs or fixed title placement.

## Decision

- Keep the existing version 1 `MediaExecutionJob` payload and its single-clip planning behavior for the Phase 2 baseline. Add a version 2 `CompositionExecutionJob` for this bounded profile; both use the same staging, authorization, verification, and publication path.
- Support one or two distinct video assets on one video track, beginning at timeline zero and placed contiguously. Video inputs may be uploaded footage or browser captures. Support at most one audio clip and one static text layer plus one static image layer. Only the image and text layers need handles when active; muted overlay tracks are omitted.
- Preserve canonical clip starts and composition duration. The frozen job records `outputDurationMs`, calculated as canonical duration minus the outgoing crossfade duration when there is a crossfade. A cut adds no overlap. Gaps, unsupported transitions, extra video clips, animated layers, graphics, and layers extending beyond the rendered duration fail planning.
- Require authorized, project-contained source handles for every used asset. The job contains asset identity, SHA-256, media facts, and typed edit values; it contains no host paths, ProjectV2 object, command strings, or filter graph. Source hashes and revision identity are checked before execution and again at publication. Hard-linked sources are rejected.
- Render one timed image layer as a picture-in-picture at one-third canvas size in the upper-right corner with a fixed inset. Render one timed text layer centered near the bottom. Accept only the Replex Sans preset, a bounded TrueType font, bounded text, integer font size, and a hex color. The selected font hash is part of the frozen job; text is staged as UTF-8 and passed to FFmpeg through `textfile` with expansion disabled.
- Mix active video audio and the optional audio clip with canonical gain/mute state. For a crossfade, fade the outgoing and incoming video audio over the same interval. If every source is silent or muted, generate a silent AAC track.
- Register only an MP4 that passes independent probe, decode, size, output-hash, revision, and source checks. Composition jobs record backend version 2 and their own job hash. Render verification remains separate from creative approval.
- Leave the canonical schema, semantic reducer, service-contract v1, and V1 render path unchanged. This is a backend execution profile; unsupported valid ProjectV2 shapes remain canonical and fail closed at planning time.

## Consequences

- The profile can render a small multi-asset product demo while preserving operation replay and source identity.
- Fixed image placement and approximate title fitting are deliberate limits of the POC. Human review must determine whether the result is useful before adding richer layer geometry or typography controls.
- Motion presets, additional tracks, arbitrary effects, generated graphics, and broader timeline support require separate evidence and architecture decisions.
