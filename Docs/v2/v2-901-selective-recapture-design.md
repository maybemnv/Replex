# V2-901 Selective Browser Recapture Core Proof

**Status:** Awaiting written-spec approval

**Base:** `main` at `5950983e5a398421e5855702c5e025e419593cbb`

**Scope:** One local Phase 9 proof PR; no executor, cloud, or Gate D decision.

## Goal

Prove that one selected browser-origin scene can be recaptured from its approved flow, registered as a new immutable content-addressed V2 `browser_capture`, and committed through one `replace_browser_capture` semantic operation while preserving unrelated mixed-media project state.

This is the core domain proof. It does not complete local-executor integration, formal human review, Phase 10 evaluation, or production authorization. The three supplied Gate D reviews remain synthetic and count as zero independent reviewers.

## Existing boundaries to reuse

- `ProjectV2` and `applyOperationBatch` remain canonical. The reducer already validates flow/scene identity, changed action IDs, dimensions, frame rate, retained clip ranges, and browser lineage.
- `LocalProjectStore.applyBatch` remains the persistence boundary for the single `actor: "recapture"` revision and its operation log.
- `runCapture` remains the browser capture mechanism. Its approved `Flow` and local `Environment` drive capture; only the requested `sceneKey` from its result is considered for this replacement.
- V2 assets remain immutable. The new bytes are stored under `media/assets/<sha256>`; the prior asset is retained.
- Credentials, storage state, and arbitrary host paths stay outside canonical project data and the preservation report.

## Recommended approach

Add the smallest browser-specific adapter around the existing capture and import paths. Reuse the import pipeline's source containment, staged copy, hash, probe/decode validation, content-addressed promotion, and cleanup rather than creating a second persistence implementation. The adapter creates a `browser_capture` asset with provenance from the selected `CaptureResult`, including flow, scene, actions, checkpoint, run, capture time, and predecessor asset.

After validating the replacement and preparing preservation evidence, submit exactly one reducer batch with the caller's base revision, actor `recapture`, and one `replace_browser_capture` operation. Persist it through `LocalProjectStore`; do not edit project JSON or use V1 reconciliation. The capture operation may record all scenes, but this PR canonicalizes only the selected scene.

### Approaches considered

1. **Recommended: reuse import staging with browser provenance.** Keeps byte validation and immutable storage in one implementation while leaving replacement semantics in the reducer.
2. **Duplicate a browser-only file pipeline.** Avoids touching import code but duplicates path, hashing, probing, and cleanup rules, creating divergent security behavior.
3. **Wire the local executor and browser job now.** Useful later, but expands this proof into incomplete V2-702 transport/job work and makes it harder to isolate whether recapture semantics preserve state.

## Preservation evidence

Write one versioned JSON report outside canonical semantic state. It records the project ID, base/result revisions, capture run ID, target scene, old/new asset IDs and SHA-256 values, operation ID/type, and preservation checks as canonical before/after hashes. It contains no absolute paths, credentials, browser storage state, or raw traces.

Checks must prove:

- the previous browser asset and every unrelated asset retain their IDs, hashes, provenance, probes, and paths;
- the replacement is the only added asset and its browser provenance points to the previous asset;
- target clip IDs and all timing, trim, speed, transform, crop, opacity, volume, mute, and transition fields remain identical, with only `assetId` changed where clips used the predecessor;
- unrelated clips, tracks, layers/text, audio, motion parameters, browser flows, and prior lineage rows are unchanged;
- the new lineage row identifies the predecessor, replacement, changed actions, reason, and result revision;
- exactly one revision and one operation were added, the new revision's parent is the supplied base revision, and the operation actor is `recapture`.

The report must distinguish expected changes from preserved fields and fail closed if an unexpected semantic difference appears. Verification state may become stale for the new revision; that expected metadata change is reported separately from creative state.

## Failure behavior

Reject a failed capture, missing or ambiguous scene, flow/scene mismatch, capture path outside its run root, source-hash mismatch, invalid media, incompatible dimensions/frame rate/duration, invalid changed-action IDs, or stale base revision. On failure, publish no canonical revision; remove only newly created staging/content files that are not shared by another asset. Existing deduplicated blobs and the predecessor remain untouched. Do not retry against a newer revision automatically.

The report is derived evidence, not canonical state. Its generation failure must be surfaced as an evidence failure and must not trigger a second edit or silently claim preservation.

## Proof fixture and acceptance

Use a local deterministic browser fixture with an approved flow and a small visible product-state change that leaves its stable checkpoint valid. Seed a V2 mixed project with the predecessor browser asset, an uploaded video, image, audio, captions/title, and a selected motion preset. Run the flow, select exactly one scene, persist its new immutable bytes, and apply the single replacement operation.

Acceptance requires a machine-readable report with every preservation check passing; exactly one attributable `replace_browser_capture` revision; the old asset still available; the new asset's bytes matching its SHA-256; semantic replay yielding the same result; and rejection of stale/incompatible attempts without canonical mutation. Keep the fixture small and local. The test does not claim representative human quality or a production browser recapture service.

## PR boundary

This PR contains only the recapture adapter, focused tests/fixtures, preservation report schema/writer, and Phase 9 status/evidence updates. It does not add service commands, executor jobs, UI, cloud execution, hosted credentials, general-purpose recapture inference, or a second project model. The local executor can call the proven domain path in a later bounded PR.

## Self-review

- The operation and lineage remain reducer-owned; no direct JSON mutation is introduced.
- The browser capture is one provenance-rich media source in a mixed V2 project.
- The report separates expected target changes from unrelated preservation and stays outside revision hashing.
- The failure contract leaves canonical state unchanged on rejected capture or stale revision.
- Scope is limited to one scene and one operation; transport and cloud are deferred.
