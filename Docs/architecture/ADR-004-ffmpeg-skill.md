# ADR-004: Evaluate ffmpeg-skill behind a Replex adapter

- **Status:** Accepted evaluation strategy; dependency not adopted
- **Date:** 19 September 2026

## Context

[`kajisho5/ffmpeg-skill`](https://github.com/kajisho5/ffmpeg-skill) exposes typed local FFmpeg/ffprobe tools, a machine-readable contract, structured JSON results, dry-run support, timeouts, and verification guidance. It is a strong candidate for mechanical media execution, but its agent skill and whole-edit project concepts must not replace Replex semantics.

## Decision

Late Phase 1 or the beginning of Phase 2 performs a cheap capability/contract spike before Replex duplicates media plumbing. The spike records the released skill version and contract version under evaluation and produces a GO, NO-GO, or PARTIAL-GO report. It evaluates probe, contact sheets, scene measurements, crop/fit, cuts, audio measurements, captions/overlays, verification/check, export, structured-contract leakage, execution overhead, platform constraints, cancellation, timeouts, path containment, failure semantics, native parity, and whether adoption is cheaper than owning the required subset.

Only after that report does a later phase implement `FfmpegSkillBackend`. The adapter maps a strict subset of Replex `MediaExecutionJob` operations to its structured contract and maps results/errors back into Replex evidence. Adoption requires contract-version checks, `doctor` capability checks, dry-run plan inspection, immutable-input guarantees, deadlines, cancellation behavior, deterministic fixtures, and output verification.

The V2-150 PARTIAL-GO authorizes only a future internal, read-only evidence study: `probe`, `look`/contact sheets, `scenes`, `silence --list`, `loudness --measure-only`, and `check`. It does not authorize model-facing MCP access, mutating tools, or a runtime adapter. Any adapter requires Phase 2 parity evidence and a separate architecture review. Production orchestration calls an approved Replex adapter, not unrestricted MCP.

Pin an actual release and record skill version, contract version, tool capabilities, and FFmpeg version in every job. Never track `main`. Keep the native `FfmpegBackend` until parity and rollback tests pass.

## Ownership boundary

Replex owns project state, operations, revisions, agent planning, inspection policy, authorization, browser provenance, selective recapture, and final verification policy. ffmpeg-skill may own deterministic probe, cut, crop/fit, speed, captions, overlays, audio processing, loudness, scene measurements, contact sheets, transcode, export presets, and delivery checks.

## Acceptance before adoption

- The pinned contract represents every adopted capability without raw command/filter input.
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
