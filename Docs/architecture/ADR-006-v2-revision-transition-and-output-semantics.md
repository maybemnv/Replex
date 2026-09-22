# ADR-006: Define V2 revision, transition, and migrated output semantics

- **Status:** Accepted
- **Date:** 23 September 2026

## Context

The initial implementation mixed transition duration into clip placement while the reducer treated every same-track overlap as invalid. It also hashed derived verification state and treated a V1 render-plan hash as an output-media hash.

## Decisions

- `transitionOut` owns transition duration. Clips on one track remain non-overlapping, and transition duration does not shift the next clip's timeline start. A crossfade requires a following clip on that track and must fit within both clips.
- A semantic revision hash covers canonical creative project state. It excludes verification state, render outputs, revision history/current revision ID, and the operation-log reference.
- `RenderArtifact.sha256` is computed from the output media bytes. V1 `renderJobSha256` maps only to `renderJobHash`. Explicit migration omits missing media outputs and their verification refs, with a `MigrationReport` warning.

## Consequences

- Verification can change without changing the creative revision hash.
- Migration remains deterministic in memory; only explicit migration reads output bytes to populate artifact hashes.
- V2 renderer execution remains out of scope; this decision fixes canonical timing and artifact meaning.
