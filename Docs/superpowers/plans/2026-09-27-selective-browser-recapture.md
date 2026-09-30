# V2-901 Selective Browser Recapture Implementation Plan

> **Execution:** Keep each implementation boundary independently tested and committed. Run an independent read-only branch review before opening the PR.

**Goal:** Replace one selected browser capture in a mixed V2 project with one immutable browser asset and one attributable semantic revision, backed by machine-readable preservation evidence.

**Architecture:** Keep `ProjectV2` and `applyOperationBatch` canonical. Reuse the secure local-import staging and content-addressed promotion path. `LocalProjectStore` keeps project paths private and holds its per-project lock while publishing the asset, applying one reducer batch, and persisting the revision. The recapture adapter emits a report from the before/after canonical projections.

**Tech Stack:** TypeScript, Zod, Node.js filesystem APIs, FFprobe/FFmpeg, Playwright, Vitest.

**Spec:** `Docs/v2/v2-901-selective-recapture-design.md`

## Global Constraints

- ProjectV2 is canonical; the reducer owns semantics and revision history.
- Source assets are immutable; browser captures use `media/assets/<sha256>` and retain predecessor assets.
- Backends consume frozen jobs and authorized handles, not mutable ProjectV2.
- Models never receive arbitrary paths, browser credentials, shell, FFmpeg argv, or filtergraphs.
- Failed or stale replacement attempts publish no canonical revision.
- Absolute project paths stay private inside `LocalProjectStore`; no root accessor is added.
- The preservation report remains outside semantic revision hashing.
- This PR implements one selected local browser scene only; no executor, cloud, UI, or production claim.

## Review Focus

1. A forged capture result or path outside the run root must be rejected before reading source bytes.
2. Missing, duplicate, failed, or wrong-flow scene results must not create an asset or revision.
3. Media source changes, corrupt bytes, and failed probe/decode must clean staging and leave canonical state unchanged.
4. A stale base revision, incompatible dimensions/frame rate, or retained clip source range longer than the replacement must not leave a new asset referenced or an extra revision committed.
5. Any unrelated asset, clip, audio, track, layer/text, motion preset, flow, or prior lineage change must fail the preservation check; reports must contain no host paths or secrets.

---

### Task 1: Extract the shared validated-media publication callback

**Files:**
- Modify: `src/import-v2.ts`
- Modify: `tests/import-v2.test.ts`

**Interfaces:**
- Produces: one shared internal helper that stages, hashes, probes, decodes, and promotes authorized media, then awaits a caller-supplied publication callback while the content lock is held.
- The callback receives only validated facts and an immutable `MediaAsset`; no absolute source or project path is returned.
- `importLocalAssetV2` keeps its existing upload provenance and one `import_asset` revision.

- [ ] **Step 1: Write a failing test**

Add tests that a rejected publication callback removes a newly promoted blob and staging directory, while a rejected callback never deletes a deduplicated existing blob. Retain current source-change, hash, probe, decode, and upload-import assertions.

- [ ] **Step 2: Run the focused test and confirm it fails because the method is absent**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/import-v2.test.ts`

Expected: the rollback cases fail before the helper exists; existing tests remain green.

- [ ] **Step 3: Extract the current import transaction**

Keep the existing limits, authorized open-file handle, source snapshots, staging, hash checks, FFprobe/FFmpeg validation, content-hash lock, immutable promotion, and cleanup in one helper. The helper owns the absolute paths. Await the publication callback before releasing the content lock; remove the blob only when this attempt created it and the callback rejects.

- [ ] **Step 4: Run focused tests**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/import-v2.test.ts`

Expected: PASS; the ordinary upload import still creates exactly one `import_asset` revision.

- [ ] **Step 5: Commit**

```bash
git add src/import-v2.ts tests/import-v2.test.ts
git commit -m "refactor(media): share validated asset publication"
```

### Task 2: Publish one media-backed operation through the private project store

**Files:**
- Modify: `src/service/project-store.ts`
- Modify: `tests/local-service.test.ts`

**Interfaces:**
- Consumes: an `AuthorizedLocalImport`, a base revision, bounded asset metadata, and a callback that builds the `MediaAsset` and single operation from validated media facts.
- Produces: an internal `applyBatchWithLocalAsset` path that owns the project directory and project lock, uses the Task 1 helper, applies the reducer, and persists only an accepted batch.
- Add a path-free `writeEvidence` method that writes bounded immutable JSON under the existing project evidence directory and returns a project-relative reference.

- [ ] **Step 1: Write failing tests**

Add tests proving that browser capture asset persistence:

1. holds the project lock across import, reducer application, and durable revision publication;
2. returns a stale-revision result before consuming or storing media;
3. leaves project state unchanged and cleans newly created media after reducer rejection;
4. preserves a deduplicated blob after rejection;
5. stores validated content under the private project directory as `media/assets/<sha256>`;
6. writes evidence by opaque ID without exposing project paths or allowing overwrite.

- [ ] **Step 2: Run focused tests and confirm the new browser cases fail**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/local-service.test.ts tests/import-v2.test.ts`

Expected: the new transactional-store and evidence cases fail before implementation; existing tests pass.

- [ ] **Step 3: Implement the private store transaction**

Keep the project-directory resolver private. Under the project lock, reject a stale base before consuming the source, invoke the Task 1 helper, apply the single batch, and reuse the existing persistence sequence only after reducer acceptance. The importer keeps the content lock through reducer acceptance so a rejected batch can remove only a blob created by this attempt.

- [ ] **Step 4: Run import tests**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/local-service.test.ts tests/import-v2.test.ts`

Expected: PASS, including unchanged upload import behavior and immutable evidence output.

- [ ] **Step 5: Commit**

```bash
git add src/service/project-store.ts tests/local-service.test.ts
git commit -m "feat(service): commit local media with one semantic batch"
```

### Task 3: Build the selected-scene recapture adapter and report

**Files:**
- Create: `src/recapture-v2.ts`
- Create: `tests/recapture-v2.test.ts`

**Interfaces:**
- Produces: `recaptureBrowserSceneV2(store, request, options)` where `request` contains `projectId`, `baseRevisionId`, `previousAssetId`, `CaptureResult`, `sceneKey`, non-empty asserted `changedActionIds`, `reason`, and stable `intentId`.
- Returns: committed revision, operation log, and a parsed versioned preservation report, then persists the report with `writeEvidence`.
- The request uses an already-completed `runCapture`; transport/job orchestration remains deferred.

- [ ] **Step 1: Write failing tests for the one-revision behavior**

Seed a persisted mixed V2 project and a valid authorized scene capture. Assert that the call adds one browser asset, retargets only predecessor clips through `replace_browser_capture`, preserves the predecessor, commits exactly one `actor: "recapture"` operation/revision through `LocalProjectStore`, and writes a report under the project evidence directory.

- [ ] **Step 2: Write failing tests for rejected inputs and rollback**

Cover failed capture status, no/duplicate matching scene, wrong flow/scene, forged capture path outside its run root, changed source hash, corrupt/unsupported media, invalid changed-action IDs, incompatible dimensions/frame rate, retained clip source range longer than replacement, stale revision, and injected store/publish failure. For each rejected attempt assert the project revision and operation log are unchanged, staging is empty, and a new unreferenced blob created by this attempt is removed. Keep focused unit cases; the integration fixture covers the complete browser flow once.

- [ ] **Step 3: Write failing preservation-report assertions**

Require versioned JSON with project/base/result revision IDs, run ID, target scene, old/new asset IDs and hashes, operation ID/type, and named check hashes/results. Assert all unrelated assets, clips, tracks, layers/text, audio, motion presets, browser flows, and prior lineage match exactly; target clips may differ only in `assetId`; lineage has exactly one expected appended row; report labels `changedActionIds` as host-asserted input, not automatically detected; report has no absolute host paths or secret/session fields.

- [ ] **Step 4: Run the focused tests and confirm the recapture API/report are absent**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/recapture-v2.test.ts tests/local-service.test.ts`

Expected: the new behavior tests fail before implementation.

- [ ] **Step 5: Implement `src/recapture-v2.ts`**

Select exactly one successful scene from a `CaptureResult`; validate it against the stored approved browser flow and predecessor provenance; authorize its source only beneath that run's root; accept `changedActionIds` only as an explicit host assertion over the selected flow scene; call the store transaction once; compare the committed project to the expected preservation projection; validate and persist the report under the project evidence directory. No root accessor, project JSON mutation, or V1 reconciliation is added.

Do not modify project JSON directly, call V1 `reconcileCapture`, silently retry on a new revision, or expose capture paths in the report.

- [ ] **Step 6: Run the focused tests**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/recapture-v2.test.ts tests/import-v2.test.ts tests/local-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/recapture-v2.ts tests/recapture-v2.test.ts
git commit -m "feat(v2): preserve mixed project state on browser recapture"
```

### Task 4: Prove one real local capture-to-revision workflow

**Files:**
- Create: `tests/integration/recapture-v2.test.ts`
- Modify: `Docs/v2/roadmap.md`
- Produce: one ignored local report at `work/v2-901/preservation-report.json`; do not commit run-specific hashes, IDs, timestamps, or host paths

**Interfaces:**
- Consumes: `runCapture`, `recaptureBrowserSceneV2`, and the report schema from earlier tasks.
- Produces: reproducible local evidence for one selected scene; no new public service command.

- [ ] **Step 1: Write the failing end-to-end test**

Run the existing approved local browser fixture twice with one visible product-state change that leaves its stable checkpoint valid. Seed a mixed project with old browser capture, upload video, image, audio, text, and motion preset. Replace one fixed scene, pass fixture-known changed action IDs explicitly, then assert source SHA changed, the selected clip now uses the new asset, every preservation check passes, history contains one new recapture revision, and `LocalProjectStore` replay reproduces the result. Write the run-specific report beneath ignored `work/v2-901/` for review.

- [ ] **Step 2: Run the end-to-end test and confirm the workflow fails before integration**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/integration/recapture-v2.test.ts`

Expected: FAIL because the recapture adapter is not yet integrated with a real `CaptureResult`.

- [ ] **Step 3: Implement the smallest fixture change and integration**

Use only a local deterministic HTTP fixture and the existing approved flow. Do not commit large media or use real browser credentials. The test must verify that only one selected scene is added to canonical state even though `runCapture` may emit more scene files.

- [ ] **Step 4: Run integration and adjacent regression tests**

Run: `npm.cmd exec -- vitest run --maxWorkers=1 tests/integration/recapture-v2.test.ts tests/browser/normal.spec.ts tests/operations-v2.test.ts tests/import-v2.test.ts tests/local-service.test.ts`

Expected: PASS; report the exact test counts and environment limitations.

- [ ] **Step 5: Run build and full serial suite**

Run: `npm.cmd run build`

Expected: PASS.

Run: `npm.cmd exec -- vitest run --maxWorkers=1`

Expected: PASS or enumerate exact pre-existing/environment-limited failures; do not claim full-suite success if any fail.

- [ ] **Step 6: Update Phase 9 status from actual evidence**

Change `Docs/v2/roadmap.md` only to record what the current branch proves, list remaining executor and human-review work, and retain Gate D as open. Do not mark Phase 9 or Gate E passed until the preservation evidence is independently reviewed.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/recapture-v2.test.ts Docs/v2/roadmap.md
git commit -m "test(v2): prove selective browser recapture preservation"
```

## Final validation and PR boundary

- Run `git diff --check origin/main...HEAD` and inspect the full diff.
- Run focused import/store/reducer/recapture/browser tests, build, and full serial suite; record exact output.
- Use an independent reviewer for the final branch, with extra attention to source containment, cleanup after stale operations, report truthfulness, and V1/service-contract regressions.
- Create a separate Phase 9 PR from current validated `main`; do not merge automatically.
- Keep Gate D, local executor integration, optional cloud, and Phase 10 evaluation separate.
