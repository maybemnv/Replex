# V2-901 Selective Browser Recapture Core Proof

**Status:** Core-proof candidate implemented on PR #20; review and merge remain pending

**Base:** `main` at `5950983e5a398421e5855702c5e025e419593cbb`

**Scope:** One local Phase 9 proof PR; no executor, cloud, or Gate D decision.

## Goal

Prove that one selected browser-origin scene can be recaptured from its approved flow, registered as a new immutable content-addressed V2 `browser_capture`, and committed through one `replace_browser_capture` semantic operation while preserving unrelated mixed-media project state.

This is the core domain proof. It does not complete local-executor integration, formal human review, Phase 10 evaluation, or production authorization. The three supplied Gate D reviews remain synthetic and count as zero independent reviewers.

## Candidate status and trust limits

PR #20 contains the implementation and deterministic mixed-project E2E. The local report records seven passing preservation checks; the branch is not merged, so main-branch Gate E status remains open. Build and full-suite evidence is recorded in the implementation plan. The hosted PR check rollup contains GitGuardian Security Checks success; no GitHub CI test result is claimed.

`captureRoots` is trusted host configuration and must not come from user or model input when this path is wired to a service. On rollback, the project pointer remains canonical; a second filesystem cleanup failure can leave unreferenced staging/blob files for later safe cleanup. The candidate does not wire a service command or executor job.

## Existing boundaries to reuse

- `ProjectV2` and `applyOperationBatch` remain canonical. The reducer already validates flow/scene identity, changed action IDs, dimensions, frame rate, retained clip ranges, and browser lineage.
- `LocalProjectStore.applyBatch` remains the persistence boundary for the single `actor: "recapture"` revision and its operation log.
- `runCapture` remains the browser capture mechanism. Its approved `Flow` and local `Environment` drive capture; only the requested `sceneKey` from its result is considered for this replacement.
- V2 assets remain immutable. The new bytes are stored under `media/assets/<sha256>`; the prior asset is retained.
- Credentials, storage state, and arbitrary host paths stay outside canonical project data and the preservation report.

The existing importer writes under a supplied project root, while `LocalProjectStore` owns a hashed per-project directory and a per-project lock. Do not expose a `projectRoot()` accessor or pass the workspace root to the importer. Add a path-free store operation that owns the full sequence: resolve its private project directory, reuse the importer's authorized-handle staging/hash/probe/decode checks, publish bytes under that project's `media/assets/<sha256>`, build the browser asset and replacement batch, apply one reducer operation, and persist the result. Hold the project lock through this sequence. Keep the content-hash lock through reducer acceptance; on rejection, remove only a blob created by this attempt while it is still unreferenced. The importer must continue to serve upload imports through the same shared validation path.

## Recommended approach

Add the smallest browser-specific adapter around the existing capture and import paths. Reuse the import pipeline's source containment, staged copy, hash, probe/decode validation, content-addressed promotion, and cleanup rather than creating a second persistence implementation. The adapter supplies selected capture provenance; the private store transaction creates a `browser_capture` asset with flow, scene, actions, checkpoint, run, capture time, and predecessor asset.

The store transaction applies exactly one reducer batch with the caller's base revision, actor `recapture`, and one `replace_browser_capture` operation. Do not edit project JSON or use V1 reconciliation. The capture operation may record all scenes, but this PR canonicalizes only the selected scene. `changedActionIds` is an explicit host assertion naming changed actions in that approved scene; this POC does not infer product-state diffs from video pixels or browser events.

### Approaches considered

1. **Recommended: reuse import staging inside a store-owned transaction.** Keeps byte validation and immutable storage in one implementation, keeps paths private, and leaves replacement semantics in the reducer.
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

The report must label `changedActionIds` as asserted input, distinguish expected changes from preserved fields, and fail closed if an unexpected semantic difference appears. Verification state may become stale for the new revision; that expected metadata change is reported separately from creative state.

## Failure behavior

Reject a failed capture, missing or ambiguous scene, flow/scene mismatch, capture path outside its run root, source-hash mismatch, invalid media, incompatible dimensions/frame rate, a replacement too short for a retained clip source range, invalid changed-action IDs, or stale base revision. On failure, publish no canonical revision; remove only newly created staging/content files that are not shared by another asset. Existing deduplicated blobs and the predecessor remain untouched. Do not retry against a newer revision automatically. The internal store call accepts authorized handles and bounded metadata; no absolute project or capture path is returned to the adapter, service contract, or model.

The report is derived evidence, not canonical state. Its generation failure must be surfaced as an evidence failure and must not trigger a second edit or silently claim preservation. The report writer receives no host paths and writes only to a Replex-owned evidence location.

## Proof fixture and acceptance

Use a local deterministic browser fixture with an approved flow and a small visible product-state change that leaves its stable checkpoint valid. Pass the fixture-known changed action ID explicitly and report it as asserted, not detected. Seed a V2 mixed project with the predecessor browser asset, an uploaded video, image, audio, captions/title, and a selected motion preset. Run the flow, select exactly one scene, persist its new immutable bytes, and apply the single replacement operation.

Acceptance requires a machine-readable report with every preservation check passing; exactly one attributable `replace_browser_capture` revision; the old asset still available; the new asset's bytes matching its SHA-256; semantic replay yielding the same result; and rejection of stale/incompatible attempts without canonical mutation. Keep the fixture small and local. The test does not claim representative human quality or a production browser recapture service.

## PR boundary

This PR contains only the recapture adapter, focused tests/fixtures, preservation report schema/writer, and Phase 9 status/evidence updates. It does not add service commands, executor jobs, UI, cloud execution, hosted credentials, general-purpose recapture inference, or a second project model. The local executor can call the proven domain path in a later bounded PR.

## Self-review

- The operation and lineage remain reducer-owned; no direct JSON mutation is introduced.
- The browser capture is one provenance-rich media source in a mixed V2 project.
- The report separates expected target changes from unrelated preservation and stays outside revision hashing.
- Changed actions are explicitly asserted by the local host; no automatic state-diff capability is claimed.
- The failure contract leaves canonical state unchanged on rejected capture or stale revision.
- Scope is limited to one scene and one operation; transport and cloud are deferred.
