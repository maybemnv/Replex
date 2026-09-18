# ADR-004: Evaluate ffmpeg-skill behind a Replex adapter

- **Status:** Accepted evaluation strategy; dependency not adopted
- **Date:** 19 September 2026

## Context

[`kajisho5/ffmpeg-skill`](https://github.com/kajisho5/ffmpeg-skill) exposes typed local FFmpeg/ffprobe tools, a machine-readable contract, structured JSON results, dry-run support, timeouts, and verification guidance. It is a strong candidate for mechanical media execution, but its agent skill and whole-edit project concepts must not replace Replex semantics.

## Decision

Phase 4 evaluates a released, pinned ffmpeg-skill version through `FfmpegSkillBackend`. The adapter maps a strict subset of Replex `MediaExecutionJob` operations to its structured contract and maps results/errors back into Replex evidence. Adoption requires contract-version checks, `doctor` capability checks, dry-run plan inspection, immutable-input guarantees, deadlines, cancellation behavior, deterministic fixtures, and output verification.

A restricted MCP spike may expose only probe, scene/contact-sheet analysis, cut/fit, audio measurement, and check tools to an internal research harness. It is experimental and never becomes the model's canonical editing surface. Production orchestration calls the adapter, not unrestricted MCP.

Pin an actual release and record skill version, contract version, tool capabilities, and FFmpeg version in every job. Never track `main`. Keep the native `FfmpegBackend` until parity and rollback tests pass.

## Ownership boundary

Replex owns project state, operations, revisions, agent planning, inspection policy, authorization, browser provenance, selective recapture, and final verification policy. ffmpeg-skill may own deterministic probe, cut, crop/fit, speed, captions, overlays, audio processing, loudness, scene measurements, contact sheets, transcode, export presets, and delivery checks.

## Acceptance before adoption

- The pinned contract represents every Phase 4 capability without raw command/filter input.
- Dry-run translation is stable and auditable.
- Inputs are never mutated and outputs remain within an authorized job directory.
- Timeout, cancellation, missing capability, partial output, and verification failures map to stable Replex errors.
- Golden jobs match or intentionally supersede native backend output requirements.
- License and supply-chain review passes; current repository licensing is MIT, but it must be rechecked at pin time.

## Rejected alternatives

- Vendor the repository during architecture work.
- Adopt ffmpeg-skill's project file as canonical state.
- Give the model all tools or arbitrary FFmpeg arguments.
- Remove the native backend before measured parity.
