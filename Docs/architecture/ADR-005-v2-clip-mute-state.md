# ADR-005: Persist clip mute state in Project V2

- **Status:** Accepted
- **Date:** 22 September 2026

## Context

The approved V2 operation vocabulary includes `mute_clip`, but the initial
canonical `Clip` shape had no semantic field in which that operation could
persist its result. Treating mute as renderer-only state would make reducer
replay and revision hashing incomplete.

## Decision

Project V2 includes an optional boolean `Clip.muted` field. The V2 reducer
updates this field for `mute_clip` and includes it in the semantic project
projection and revision hash. Existing V2 clips remain valid because the
field defaults to `false` when absent.

This decision defines canonical intent only. Renderer and backend execution
for mute remain future work; no renderer command, FFmpeg argument, or backend
detail enters Project V2 state.

## Consequences

- Mute edits are attributable, replayable, and preserved across revisions.
- Historical projects without `muted` remain readable.
- Media execution and output verification for mute remain outside this
  milestone and must be implemented behind a later backend contract.
