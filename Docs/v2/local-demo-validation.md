# Local demo validation — 21 October 2026

The final stacked branch passed its build and full suite: **64 files, 455 tests**, exit code 0. The one-command demo exported a valid video and left its project discoverable after shutdown. PR #23's validation blocker is repaired: its build and default `npm test` command now pass **55 files, 375 tests**, exit code 0. No PRs were merged or retargeted during this validation.

These results apply to the commits below, before this documentation update. The #23 row records the repaired commit; its earlier failing commit was `e3bd067b62f1f1893be874c6a4f5ba56539cf867`. The original checklist and follow-up report are in the [Notion validation note](https://app.notion.com/p/3ff46794579c8107b299fa298f0e78c4).

## Commits and checks

| PR | Branch | Tested commit | Observed result |
|---|---|---|---|
| #23 | `demo/01-agent-budgets` | `b3134e6b634b3543d49b3560d504910d5e2e2f6f` | Build and default `npm test` passed: 55 files, 375 tests. The repaired fixture and worker limit match those already present on #28. |
| #24 | `demo/02-local-auth` | `7f0810f5fe21f5a0ccf59ff2878ecfa908000cde` | Build and four auth tests passed: auth before body parsing, token rotation/non-persistence, duplicate Authorization, and Host/Origin checks. |
| #25 | `demo/03-project-discovery` | `59f8ce7a45f56c1cb4c735d2da21d5dcec454db0` | Build and five discovery tests passed, covering restart, corrupt/linked entries, identity mismatch, and incomplete projects. |
| #27 | `demo/04-resource-capture-guards` | `bd7fdfccea46725f81f4beb2c66a723c83a24b77` | Build and all eight changed test files passed: 72/72 tests, including both Chromium proxy tests with no skips. |
| #28 | `demo/05-local-launcher` | `941f57ce7af98d2f4d4bf915601ea09335910877` | Clean dependency install, build, full suite, demo preflight, demo export, and post-shutdown project discovery passed. |

The initial local branches matched the local `origin/*` refs when checked. Remote refs were freshly fetched before the #23 repair. Initial earlier-branch checks used `git archive` exports; the repaired #23 used an isolated Git worktree and the installed dependency tree. Full suites were run on #23 and #28; #24, #25, and #27 received the focused checks listed above. Full branch suites for #24, #25, and #27 remain outstanding under the literal checklist.

## Toolchain and reproduction

- Node.js `22.23.3`, npm `10.9.9`.
- FFmpeg and FFprobe `N-127790-g56dbd4cd37-20261020`.
- Bundled Playwright Chromium; tests ran with permission to open loopback services and launch browser/media processes.
- Explicit `REPLEX_FFMPEG_PATH` and `REPLEX_FFPROBE_PATH` pointed at trusted direct binaries. The final branch's `vitest.config.ts` bounds file concurrency to one worker.

With the compatible binaries installed:

```bash
npm ci
npm run build
REPLEX_FFMPEG_PATH=/absolute/path/to/ffmpeg \
REPLEX_FFPROBE_PATH=/absolute/path/to/ffprobe \
npx vitest run
npm run demo -- --check
npm run demo -- --once
npm run service:v2:projects -- --workspace work/invite-demo
```

Set the media variables for the demo commands too if those binaries are not on `PATH`. Node 18 and the system FFmpeg 6.1.1 could not complete the initial validation; those results are superseded by the compatible-toolchain run.

## Demo and contract evidence

`--check` reported ready with Chromium installed. `--once` used the scripted model despite a placeholder provider key being present; the key did not appear in output. The run reported preservation passed and executor stopped. FFprobe reported H.264, 1920×1080, and duration `6.000000`. A frame was visually inspected; this does not constitute independent human review.

After shutdown, project discovery returned `Replex local demo`, project ID `project-d00db1c6726fc848795779f9`, revision `revision-0ec65050d200dcd7`, and `unavailableCount: 0`. The full suite also passed cancellation cleanup and restart recovery tests. A standalone interactive Ctrl+C check was not performed.

The diff from `main` to the final branch contained no contract/schema file changes. The service-contract and V2 schema tests passed 36/36. ADR-012 retains the approved capture boundary and frozen service-contract v1. Live-provider behavior and quality remain untested; startup with missing pricing was rejected as required.

## Failures retained and merge status

The first final-branch run finished with 454 passes and one 30-second timeout in `tests/browser/normal.spec.ts`. That test passed alone, then the unchanged final branch passed the entire suite in a fresh run. Both full-suite logs are retained.

PR #23's original default suite timed out in the dynamic and difficult browser tests under file concurrency. A serial rerun passed those browser suites and finished at 374/375 tests. Its remaining failure was `tests/capture-project.test.ts`: a fixture used Windows-style paths, and the expected relative `tracePath` differed on Linux. The same assertion failed on unchanged `main` at `65b6a3f65931ad40ebbaf36d245b7a5220deae0e`.

Commit `b3134e6b634b3543d49b3560d504910d5e2e2f6f` repairs #23 by reusing the final stack's native temporary paths and `vitest.config.ts` worker limit. The provenance and relative-path assertions remain intact, and test timeout budgets are unchanged. Its build passed, followed by the default `npm test` command with no worker overrides: 55 files and 375 tests passed in 780.02 seconds. The log is `pr23-fixed.log`; the earlier failures remain available as historical evidence.

PR #23's reported blocker is resolved. The remaining merge-order checklist still calls for the outstanding full branch suites and the post-merge clean install, build, and full suite on `main`. Any further changed branch head needs validation tied to its new commit. Gate D stays deferred, not waived: independent human reviews and correction-time evidence are still required.

## Retained artifacts

Raw logs and retained test workspaces are under ignored `work/test-evidence/validation-2026-10-21/`; the demo workspace is `work/invite-demo/`. These local files are not committed and will not exist in a fresh clone. The Notion note has an attached validation summary and SHA-256 manifest; raw logs remain local.

| Log | Result |
|---|---|
| `final-suite.log` | First final-branch run: 454 passed, one timeout |
| `final-suite-rerun.log` | Final-branch clean pass: 455/455 |
| `normal-rerun.log` | Isolated normal browser test passed |
| `pr23-full.log` | Default concurrency attempt; interrupted after browser timeouts |
| `pr23-serial.log` | 374 passed, one inherited fixture assertion failure |
| `pr23-fixed.log` | Repaired #23 default command: 375/375 passed |
| `pr24-auth.log` | Four auth tests passed |
| `pr25-discovery.log` | Five discovery tests passed |
| `pr27-changed.log` | 72 changed tests passed |
| `demo-once.log` | Completed scripted demo and shutdown |

SHA-256 of the clean final-suite log: `2d8c0bf567b8790a4829505804822d2062ceb829a1b77d1d4b22772db6ae7753`.

SHA-256 of the repaired #23 suite log: `8b94d1f1ffd6bfa32698ed3a844bd273c7995be1546a102cb9aa43c5d023d28c`.

SHA-256 of the final demo MP4: `03a2368f89123f3a993674919231c63b920f5ef99c9f0b14bed896f2ed8de71d`. Its workspace-relative path is `projects/faf153dc4ca93ff5bfa6dda72532faa96b70043001876f7850fd2a4e9120b633/renders/b57bda6c461d61e9d3219a9850c05073508a579e348bcba1709b702812c486ed.mp4`.
