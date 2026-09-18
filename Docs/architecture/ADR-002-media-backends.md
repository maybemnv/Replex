# ADR-002: Semantic operations over replaceable media and motion backends

- **Status:** Accepted for V2; backend choices remain gated
- **Date:** 19 September 2026

## Context

The V1 renderer translates a verified project into fixed FFmpeg argv. V2 needs broader media processing and polished motion without allowing models or UI code to author shell commands, filtergraphs, or backend-specific canonical state.

## Decision

Replex owns intent, semantic operations, canonical state, revisions, planning, authorization, and verification policy. A revision-frozen `RenderJob` is translated through validated adapters. `MediaBackend` handles conventional media work; `MotionBackend` handles typed presets and keyframes. Either can be replaced without migrating the canonical project.

The model can propose only Replex operations. Adapters accept only structured jobs, validate capabilities, execute without a shell, and return structured results plus evidence. Media output from a motion backend rejoins the final deterministic media pipeline.

## Consequences

- The existing native FFmpeg renderer can remain a V1 compatibility and fallback backend.
- ffmpeg-skill and Remotion can be evaluated without making either project's vocabulary canonical.
- Capability negotiation and backend/version provenance are required in RenderJobs and outputs.
- Preview and authoritative export may use different quality settings, but must share composition semantics.

## Rejected alternatives

- Direct model-authored FFmpeg or shell commands.
- Exposing every backend tool as the permanent Replex agent API.
- Storing Remotion components, FFmpeg filtergraphs, or MCP requests in canonical project state.
- One backend interface that hides the meaningful difference between media processing and programmable motion.
