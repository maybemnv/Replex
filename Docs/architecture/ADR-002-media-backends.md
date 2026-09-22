# ADR-002: Semantic operations over replaceable media and motion backends

- **Status:** Accepted for V2; backend choices remain gated
- **Date:** 19 September 2026

## Context

The V1 renderer translates a verified project into fixed FFmpeg argv. V2 needs broader media processing and polished motion without allowing models or UI code to author shell commands, filtergraphs, or backend-specific canonical state.

## Decision

Replex owns intent, semantic operations, canonical state, revisions, planning, authorization, and verification policy. A planner converts a frozen revision into an immutable `RenderJob`/`MediaExecutionJob`, then passes only that planned job and narrowly scoped authorized asset handles to validated adapters. `MediaBackend` handles conventional media work; `MotionBackend` handles typed presets and keyframes. Either can be replaced without migrating the canonical project.

The model can propose only Replex operations. Adapters accept only structured jobs, validate capabilities, execute without a shell, and return structured results plus evidence. They do not inspect mutable canonical project state to decide what to render, mutate revisions, invent semantic operations, or persist renderer-specific commands. Media output from a motion backend rejoins the final deterministic media pipeline as a derived artifact.

The source/output boundary is explicit: `MediaAsset` is an immutable project source, while `RenderArtifact`/`OutputArtifact` is derived evidence addressed by output hash, source revision, and RenderJob hash. A backend receives an `AssetHandle` through an authorized read/execution context rather than arbitrary project filesystem access. It does not own the project manifest.

Conceptually:

```ts
interface MediaBackend {
  probe(input: AssetHandle, context: MediaReadContext): Promise<MediaProbe>;
  inspect(input: AssetHandle, request: MediaInspectionRequest, context: MediaReadContext): Promise<MediaEvidence>;
  execute(job: MediaExecutionJob, context: MediaExecutionContext): Promise<MediaExecutionResult>;
  verify(artifact: RenderArtifact, requirements: OutputRequirements, context: MediaReadContext): Promise<VerificationResult>;
}
```

The exact runtime names remain implementation work; the narrow ownership boundary is normative.

`MotionExecutionResult` must expose an artifact reference/hash, duration, width,
height, fps, pixel/alpha/audio/color-space metadata where applicable,
backend/preset IDs and versions, source revision, RenderJob hash, and verification
results. The final pipeline rejects incompatible output unless the RenderJob
explicitly authorizes a conversion.

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
