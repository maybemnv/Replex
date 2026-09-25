# ADR-010: Add bounded V2 motion presets through a replaceable backend

- **Status:** Accepted for the V2 POC
- **Date:** 25 September 2026

## Context

V2-601 returned PARTIAL-GO for two candidates: `camera-push` on video clips and `title-reveal` on text layers. The local FFmpeg spike proved repeat hashes and an alpha-capable intermediate for one small synthetic fixture, but it did not establish creative quality, cancellation, cross-platform parity, or representative performance. Replex must keep preset meaning in canonical state and preserve ADR-002's separate `MediaBackend` and `MotionBackend` boundaries.

## Decision

- Add an optional `composition.motionPresets` list. Each entry records a Replex preset ID and version, a stable clip/layer target ID, and only that preset's bounded typed parameters. The field remains absent when unused; existing projects and their semantic hashes do not acquire a default empty value.
- V2-602 implements only `camera-push.v1` for an existing video clip. It uses one `strength` value from `0.02` through `0.08`, interpreted as the fractional zoom increase at the end of the clip (`0.08` means a final `1.08x` zoom). The motion planner trims to canonical `sourceInMs`/`sourceOutMs`, applies canonical speed once, converts to composition fps, then grows zoom linearly by output-frame index across that post-speed timeline duration. The derived visual keeps source dimensions and is created without audio. The final MediaBackend does not reapply trim or speed to that visual; it applies canonical crop, contain-fit, transform, rotation, and opacity once, in that order, before transition/composition. Original source audio continues through the existing canonical trim/speed/gain/mute path. One active motion preset is allowed per target; applying another preset to that target replaces it in the same atomic reducer operation. Unknown presets, versions, parameters, target kinds, and locked targets fail closed. `title-reveal` remains a research-approved candidate but is deferred from this implementation slice.
- The reducer owns application and revision semantics. It removes a preset when its target is removed. Agent proposals pass through the same validated reducer. Internal bounded inspection reports active preset IDs, versions, parameters, and target IDs so follow-up prompts use the same revision state.
- Keep the existing composition job versions unchanged. A separate, strictly parsed and hashed `MotionExecutionJobV1` carries one target clip's authorized source handle, source range, speed, preset values, pinned source revision/hash, and expected output profile. The `MotionBackend` receives this job and scoped authorization only; it never receives `ProjectV2`, host paths, model-authored code, raw argv, or a filtergraph.
- The initial replaceable `MotionBackend` implementation uses the locally installed FFmpeg executable to produce a silent video intermediate. It writes into a private Replex staging directory, owns its deadline and process-tree cancellation, and validates expected frame size, fps, duration, probe, decode, artifact size, and SHA-256 before returning a typed `MotionExecutionResult`. The result records artifact ref and SHA-256; width, height, fps, duration, pixel format, alpha mode (`none`), audio presence (`false`), and reported color metadata; backend and preset IDs/versions; source revision/hash; motion job hash; and verification status/evidence.
- The intermediate is a job-scoped derived artifact, never a `MediaAsset` or canonical `RenderArtifact`. A new frozen media composition job version may reference it only through a distinct `MotionArtifactHandle` created by the motion-job executor; it is not an `AssetHandle` and cannot be supplied as a project asset. The frozen composition job binds the target ID, motion job hash, scoped staging reference, and artifact hash. Authorization resolves only that executor-issued handle, checks that the file is regular, non-symlinked, single-link, contained in its private job staging root, and still matches its hash. The final `MediaBackend` uses that intermediate for the target's visuals and the original immutable source for its canonical audio. The planner explicitly authorizes required scaling, pixel-format conversion, and audio handling. Revision, original source hashes, and motion artifact identity are checked again before final publication; the existing final-render verification remains authoritative.
- The same FFmpeg binary may implement both boundaries, but the motion job contract and adapter remain independent of the conventional media composition job. A future motion engine may replace the adapter without changing preset IDs or canonical state.
- Keep frozen service-contract v1 and its fixtures unchanged. Its existing `apply_motion_preset` request shape can carry the bounded operation. Update the agent proposal schema, operation allowlist, instructions, and bounded inspection together so follow-up prompts see the active motion state. The V1 public project snapshot does not expose preset metadata; this POC has no direct motion-parameter editor. Introduce a deliberate service-contract v2 only if a frontend must inspect or directly manage those fields.

## Consequences

- Existing media-only jobs and projects remain unchanged. Projects with a motion preset gain a normal semantic revision and can be replayed through the reducer.
- Motion output is regenerated as a bounded intermediate before preview/final composition and is never trusted as a canonical project source.
- Preview and final composition must use the same semantic motion inputs, source revision, and pinned source hashes. Each output must pass its own verification; byte-identical preview/final files are not required if render profiles differ.
- Gate D remains open until an implemented `camera-push` sample is visually reviewed. The synthetic spike is not creative-quality evidence.
- `title-reveal`, Remotion, additional presets, arbitrary keyframes, and user-authored backend code remain out of the initial V2-602 scope.

## Rejected alternatives

- Folding motion filter expressions into the mutable canonical project or exposing them to a model.
- Extending `CompositionExecutionJob` v2 in place or letting the conventional media backend interpret canonical preset intent directly.
- Registering motion intermediates as project media assets.
- Adopting Remotion without local performance, licensing eligibility, and reproducibility evidence.
- Adding motion metadata to the frozen service-contract v1 project snapshot.
