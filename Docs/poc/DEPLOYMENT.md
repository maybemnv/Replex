# Release Replay POC operator handoff

## Status

This is a local-only POC. The commands below produce local fixture evidence; they do not authorize production or establish a POC PASS. The gate remains defined by `Docs/PRD.md`, and `src/evaluation.ts` computes its decision.

## Prepare the checkout

Install Node.js 22 or newer, FFmpeg, ffprobe, and Playwright Chromium. Then run:

```powershell
npm ci
npx playwright install chromium
$env:REPLEX_FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
$env:REPLEX_FFPROBE_PATH = "C:\path\to\ffprobe.exe"
npm run build
npm test -- --maxWorkers=1
```

Keep projects under the ignored `work/` directory. Keep authentication state outside the checkout, such as `$env:TEMP\replex-auth\operator-state.json`; never commit it or pass its contents to the model.

## Start the fixtures

In terminal 1, start the process that owns all fixture endpoints:

```powershell
npm run fixtures -- serve
```

It prints one JSON object and keeps running:

| Fixture | Origin | State controls |
|---|---|---|
| normal | `http://127.0.0.1:4173` | `POST /__reset`, `POST /__change`, `POST /__failure?action=apply-filter` |
| dynamic | `http://127.0.0.1:4174` | `POST /__reset`, `POST /__change`, `POST /__failure?action=dynamic-load-async` |
| difficult | `http://127.0.0.1:4175` | `POST /__reset`, `POST /__change`, `POST /__failure?action=difficult-run-validation` |

Exercise a control from another PowerShell terminal with, for example:

```powershell
Invoke-WebRequest -Method Post http://127.0.0.1:4174/__reset
Invoke-WebRequest -Method Post http://127.0.0.1:4174/__change
Invoke-WebRequest -Method Post "http://127.0.0.1:4174/__failure?action=dynamic-load-async"
```

Stop the fixture process with Ctrl+C.

## Bootstrap a canonical project

With the fixture process running, create the first project directly from a real browser capture:

```powershell
npm run fixtures -- bootstrap normal --project work/normal
npm run fixtures -- bootstrap dynamic --project work/dynamic
npm run fixtures -- bootstrap difficult --project work/difficult
```

Each command captures the approved flow, normalizes its immutable media, and writes the first `project.json` and revision. It does not fabricate capture metadata. The difficult bootstrap creates its disposable upload beneath `work/difficult/uploads` and permits only that upload root.

To repeat a measured attempt, retain the existing project as evidence and bootstrap into a new attempt directory such as `work/dynamic-attempt-2`. Do not overwrite or remove failed attempts.

## Run the project lifecycle

Use the bootstrapped project with the product CLI:

```powershell
npm run cli -- verify --project work/<project-id>
npm run cli -- baseline --project work/<project-id>
npm run cli -- report --project work/<project-id>

$env:ANTHROPIC_API_KEY = "<operator-provided key>"
npm run cli -- agent-draft --project work/<project-id>
npm run cli -- report --project work/<project-id>

npm run cli -- recapture --project work/<project-id> --input work/<project-id>/recapture.json
npm run cli -- render --project work/<project-id>
```

Every successful CLI invocation writes exactly one JSON object to stdout. That object contains the command result and the startup tool versions. Failures write exactly one JSON error object to stderr and return a nonzero exit code.

For an authenticated capture, store Playwright state outside the checkout and pass its path explicitly:

```powershell
npm run cli -- capture --project work/<project-id> --storage-state $env:TEMP\replex-auth\operator-state.json --values '{"filterValue":"release"}'
```

`--values` also accepts `@path`; difficult uploads require `--upload-root`. See `npm run cli -- --help` for the current CLI contract. The model loop limits and failure behavior are authoritative in `src/agent.ts` and its tests.

## Execute the POC gate

Follow the fixture matrix in `Docs/poc/FIXTURE_CATALOG.md` and the acceptance criteria in `Docs/PRD.md`. Feed retained attempt evidence to `runAdversarialEvaluation(...)`, then persist the computed result with `writeEvaluation(...)`. These APIs and `src/evaluation.ts` are the authoritative acceptance protocol; do not construct passing rows or decisions by hand.

Before handing off the result:

- Record Node, Chromium, FFmpeg, and ffprobe versions from command output.
- Retain every initial attempt, retry, intervention, changed-state recapture, verification, render, and report.
- Run the real Claude path with an operator-provided session key.
- Collect the usefulness reviews and correction timing required by the PRD.
- Confirm no authentication state, API key, production data, or private trace was committed.
- Read the generated `decision.md`. Production remains unauthorized regardless of the POC decision.
