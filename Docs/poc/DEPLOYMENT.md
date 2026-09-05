# Release Replay POC deployment and handoff

## Status

This is a local-only POC handoff, not a production deployment. It is ready for an operator to run the deterministic capture, verification, render, and recorded-agent paths. A PASS gate is not yet authorized: the measured real-Claude runs, six-run adversarial evidence, and three external usefulness reviews remain required by `Docs/PRD.md`.

## Prerequisites

- Node.js 22 or newer.
- FFmpeg and ffprobe available as executable paths.
- Playwright Chromium installed for the current user.
- An application under the approved local/staging fixture origins; do not use a production account or production data.

Install dependencies and the browser:

```powershell
npm ci
npx playwright install chromium
```

Point the POC at the local media tools for the current PowerShell session:

```powershell
$env:REPLEX_FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
$env:REPLEX_FFPROBE_PATH = "C:\path\to\ffprobe.exe"
```

Run the verified local checks:

```powershell
npm run build
npm test -- --maxWorkers=1
npm run cli -- --help
```

`--maxWorkers=1` is intentional for this workstation: browser recording and 1080p FFmpeg tests contend for the same local resources when run concurrently.

## Local operator flow

Keep every project under the ignored `work/` directory. Keep Playwright storage state outside the project and repository, for example `work/auth/operator-state.json`; never commit it or pass its contents to the model.

`capture` is not an initializer: it needs an existing canonical `work/<project-id>/project.json` containing the approved environment and flow. Bootstrap that manifest once through the programmatic `createProject(...)` and `writeRevision(...)` APIs using only an approved fixture flow and immutable capture metadata. There is deliberately no CLI `init` command, because it must not invent an environment, browser flow, or source-capture identity.

```powershell
# Startup checks run before every command.
# Browser capture materializes a new canonical capture revision.
npm run cli -- capture --project work/<project-id> --artifact-root work/<project-id>/captures

# Verify, render the deterministic baseline, then write the report with its authoritative video.
npm run cli -- verify --project work/<project-id>
npm run cli -- baseline --project work/<project-id>
npm run cli -- report --project work/<project-id>

# With a real operator-supplied Claude key, make the bounded draft; then report again.
npm run cli -- agent-draft --project work/<project-id>
npm run cli -- report --project work/<project-id>

# Recapture accepts only an operator-created JSON input for the named scene.
npm run cli -- recapture --project work/<project-id> --input work/<project-id>/recapture.json
npm run cli -- render --project work/<project-id>
```

The CLI emits structured JSON. A render only runs when a successful verification record exists for the exact current revision. Captures, traces, screenshots, operation logs, verification records, FFmpeg argv/stderr, and reports remain under the local project root.

## Optional real-Claude run

The bounded model path has no recorded fallback. To run it, set an Anthropic key only in the operator shell/session, then use the approved project:

```powershell
$env:ANTHROPIC_API_KEY = "<operator-provided key>"
npm run cli -- agent-draft --project work/<project-id>
```

Do not place the key in `.env`, source control, reports, tool inputs, browser storage, or project artifacts. The tool loop is bounded to registered inspection/operation/verification/render tools, 20 calls, two edit passes, and two render attempts. A missing key, invalid tool call, stale revision, secret-shaped request, or incomplete loop must fail with state intact.

## External POC gate handoff

The operator must run and retain, without replacing failed first attempts:

1. Two reset runs each for normal, dynamic, and difficult fixtures.
2. A real-Claude grounded draft and verified render for each measured run.
3. One controlled changed-state selective recapture and verified render per app.
4. Stage-failure evidence, artifact paths, first cause, correction time, and the three target-user usefulness reviews.
5. A purpose-built operator runner must call `runAdversarialEvaluation(["normal", "dynamic", "difficult"], runner)` for attempts 1 and 2, retaining every raw artifact path in each returned `EvaluationRow`, then call `writeEvaluation(...)` into `work/evaluation-<date>/`.

There is no CLI shortcut for step 5: it cannot supply a real Claude run, a controlled changed state, or three independent human reviews. Do not construct passing rows by hand. The evaluator is intentionally fail-closed and will return `REWORK` or `FAIL` when those retained artifacts and review inputs are absent.

Use the fixed `PASS`, `FAIL`, or `REWORK` decision in the generated evaluation evidence. `productionAuthorized` remains false even for a POC PASS: moving beyond the POC requires the separate PRD production gate.

## Handoff checklist

- [ ] Record exact Node, Chromium, FFmpeg, and ffprobe versions in the run evidence.
- [ ] Confirm `npm run build` and `npm test -- --maxWorkers=1` on the operator machine.
- [ ] Confirm no auth state, API key, production customer data, or private trace was committed.
- [ ] Preserve failed first attempts and all retry/intervention evidence.
- [ ] Run the real Claude path with an operator-provided key; do not substitute recorded calls for this acceptance.
- [ ] Collect three independent target-user usefulness reviews and correction time.
- [ ] Read `work/evaluation-<date>/decision.md`; do not make a production recommendation if it is `FAIL` or `REWORK`.
