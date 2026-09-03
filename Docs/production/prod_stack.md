# Release Replay Production Stack

## 1. Decision status

**Status:** current default production direction, dated 4 September 2026. The repository/application name is **Replex**; “Release Replay” remains the PRD capability name used in this document.

This stack is conditional on the POC and product-validation gates. It refines the older production implementation plan where that plan chose Electron, canonical SQLite project state, Fastify, and a hosted container. The current decision instead uses Tauri 2, portable file projects, and a gated Cloudflare Workers/Hono control plane. It does not change the PRD, authorize production execution, or move P1 features into scope.

Decision priority is recurring cost, operational burden, component count, replaceability, and founder debugging speed. The target is the first hundreds or low thousands of users.

## 2. Architecture goals

- Keep authenticated browsing, capture, project media, deterministic operations, verification, and rendering local by default.
- Keep the canonical project independent of desktop shell, model vendor, hosted database, and renderer implementation.
- Isolate Chromium, FFmpeg, model requests, and the Node worker so a process failure does not kill the UI or corrupt the project.
- Use one TypeScript product core from POC through early production.
- Add cloud only for accounts, entitlements, billing, protected model access, remote configuration, and consented aggregate telemetry.
- Remain operable by two founders without Kubernetes, queues, microservices, or a custom platform.
- Preserve the PRD gate: correctness and recoverability outrank throughput.

## 3. Production architecture

```text
                         Replex desktop

  Tauri 2 WebView (React/Vite/TypeScript, untrusted UI tier)
                              |
                      narrow typed commands
                              |
                 minimal Rust host / job supervisor
                              |
              supervised private Node.js sidecar
                    (TypeScript product core)
                  /             |              \
        Playwright/Chromium   Agent tools    Project core
                  \             |              /
                    validated deterministic operations
                                  |
                        canonical file project
                                  |
                             verification
                                  |
                              RenderJob
                                  |
                         FFmpeg / ffprobe
                                  |
                         local verified output

Optional network path after paid-beta gate:

  Desktop -> Cloudflare Worker/Hono -> model provider
                 |        |
                 |        +-> Stripe webhooks/entitlements
                 +----------> Supabase Auth/Postgres

  R2 is absent unless a validated hosted-file feature is approved.
```

The desktop remains useful during control-plane failure for opening projects, manual bounded edits, verification, and local rendering. Account refresh and managed AI calls require the network.

## 4. Stack summary

| Layer | Default |
|---|---|
| Desktop | Tauri 2, Windows-first NSIS installer |
| UI | React, Vite, TypeScript; React state first |
| Native host | Minimal Rust for lifecycle, scoped filesystem/dialogs, secrets, updater, and process supervision |
| Product core | Node.js LTS private runtime with compiled TypeScript sidecar |
| Package manager | pnpm workspace |
| Validation | Zod at file, IPC payload, tool, operation, RenderJob, and cloud request seams |
| Browser | Playwright with application-managed pinned Chromium download |
| Media | Bundled pinned FFmpeg/ffprobe, Sharp, fixed SVG assets |
| Project persistence | Portable versioned files; no canonical database |
| App metadata | Atomic local JSON/Tauri Store initially; SQLite only on evidence |
| AI | Minimal `AgentModel` seam; one eval-selected provider/model active at a time |
| Paid-beta control plane | One Cloudflare Worker using Hono |
| Hosted identity/data | Supabase Auth and Postgres, activated only for external paid beta |
| Billing | Stripe Checkout/Billing where account availability permits |
| CI/releases | GitHub Actions, Tauri updater, signed artifacts |
| Diagnostics | Local structured logs first; Sentry/PostHog only after external users |

## 5. LOCK NOW decisions

| Technology/decision | Classification | Concrete Release Replay requirement |
|---|---|---|
| Tauri 2 | LOCK NOW | Small local-first shell, native process/secret/update control, and no second bundled Chromium for UI. |
| React + Vite + TypeScript | LOCK NOW | Bounded storyboard/review UI and shared frontend types with low framework overhead. |
| Minimal Rust host | LOCK NOW | Trusted lifecycle, path, secret, native dialog, updater, and sidecar supervision tier. |
| Node.js LTS + TypeScript sidecar | LOCK NOW | Reuse Playwright/project/agent/render orchestration without rewriting the product core in Rust. |
| pnpm | LOCK NOW | One deterministic workspace and lockfile for desktop, core, and control plane. |
| Zod | LOCK NOW | Two-layer validation across persisted data and all untrusted typed inputs. |
| Playwright + pinned Chromium | LOCK NOW | Reproducible approved-flow capture independent of installed browsers. |
| FFmpeg + ffprobe behind RenderJob | LOCK NOW | Required deterministic H.264/AAC export and media validation. |
| Sharp + fixed SVG templates | LOCK NOW | Thumbnails/contact sheets and bounded overlays without a motion engine. |
| Portable file project | LOCK NOW | Inspectable, migratable, recoverable, locally owned canonical state. |
| Minimal `AgentModel` seam | LOCK NOW | Compare vendors without migrating projects or changing tools/operations. |
| GitHub Actions | LOCK NOW | Windows build/test/package/sign/release automation already aligned with the repository. |
| Windows-first NSIS + Tauri updater | LOCK NOW | Lowest-friction first public distribution and signed incremental updates. |

## 6. ADD WHEN NEEDED decisions

| Technology/decision | Classification | Activation trigger |
|---|---|---|
| Cloudflare Workers + Hono | ADD WHEN NEEDED | External paid beta needs authenticated entitlements and a protected model proxy. |
| Supabase Auth + Postgres | ADD WHEN NEEDED | External accounts exist; one system must own users, subscriptions, entitlements, devices, and aggregate usage. |
| Stripe Checkout/Billing | ADD WHEN NEEDED | A validated paid offer is ready and the founders' business/account is eligible. |
| Sentry | ADD WHEN NEEDED | External users produce failures founders cannot reproduce from local diagnostics. |
| PostHog | ADD WHEN NEEDED | External product usage begins and consented aggregate funnel/feature evidence is needed. |
| Cloudflare R2 | ADD WHEN NEEDED | A validated feature explicitly requires shareable renders, opt-in backup, or sync. |
| SQLite | ADD WHEN NEEDED | Atomic JSON app metadata becomes measurably slow, concurrent, or difficult to recover; never canonical project media state. |
| Zustand | ADD WHEN NEEDED | Cross-screen editor/job state becomes awkward with React state/context and a small store measurably simplifies it. |
| Gemini | ADD WHEN NEEDED | Current POC/default eval candidate; production selection requires it to win the frozen eval corpus. |
| OpenAI models | ADD WHEN NEEDED | A GPT model materially improves correction time/reliability/cost on the same eval set. |
| Anthropic models | ADD WHEN NEEDED | A Claude model materially improves the same measured outcomes. |
| Local/open-weight VL models | ADD WHEN NEEDED | Users demand offline/private inference and supported hardware meets quality/latency targets. |
| macOS signing/build | ADD WHEN NEEDED | Qualified demand justifies a maintained second release target. |
| Linux packages | ADD WHEN NEEDED | Measured customer demand justifies fragmented WebView/media support cost. |

## 7. DO NOT USE CURRENTLY

| Technology/decision | Classification | Reason |
|---|---|---|
| Electron | DO NOT USE CURRENTLY | Tauri plus a Node worker meets local/native needs without bundling another UI Chromium. Revisit only on demonstrated WebView incompatibility or Tauri blocker. |
| Docker as desktop/runtime requirement | DO NOT USE CURRENTLY | Adds installation and support burden to a local Windows product. |
| Redis, BullMQ, distributed queues | DO NOT USE CURRENTLY | There is one local machine and one small control-plane process; durable local job files suffice. |
| Kubernetes, service mesh, microservices | DO NOT USE CURRENTLY | No independent scale/failure boundary justifies them. |
| GraphQL, WebSockets | DO NOT USE CURRENTLY | Small request/response APIs and local progress events are sufficient. |
| Remote browser providers | DO NOT USE CURRENTLY | Increase credential exposure, cost, and state/setup complexity. |
| Cloud GPU/render infrastructure | DO NOT USE CURRENTLY | Local FFmpeg is cheaper and privacy-preserving; no measured hardware failure yet. |
| Object storage by default | DO NOT USE CURRENTLY | Videos and projects are local; a database having file metadata is not a reason to upload media. |
| OpenReel/OpenCut/Kdenlive/MLT/Diffusion Studio | DO NOT USE CURRENTLY | Fixed scene vocabulary does not require a general editor core. |
| Motion Canvas/Remotion/WebGPU/Three.js | DO NOT USE CURRENTLY | Fixed overlays/focus/transitions are already covered by SVG/Sharp/FFmpeg. |
| LangChain/LangGraph/vector DB/embeddings | DO NOT USE CURRENTLY | The bounded tool loop and project-scale context need none of them. |
| Model router/fallback tree/custom hosting | DO NOT USE CURRENTLY | One eval-selected model is simpler; failures remain visible. |

## 8. Desktop architecture

Use a pnpm monorepo with `apps/desktop` (React/Vite UI plus `src-tauri`), `apps/control-plane` only when gated, and TypeScript packages for `project-core`, `capture-runner`, `agent-tools`, `render-core`, and protocol schemas. The product packages must run without Tauri so fixture tests and a future shell replacement do not require UI startup.

The desktop opens local projects chosen through native dialogs, displays storyboard/source/trace/revision evidence, submits bounded operations, starts local jobs, and plays the latest authoritative render. It does not own project mutation logic.

## 9. Tauri responsibilities

Tauri is selected, not worshipped. Its concrete value is a low-overhead UI shell plus a trusted native tier for:

- application lifecycle and single-instance handling;
- native open/save/project-directory dialogs;
- capability-scoped IPC and project-root path authorization;
- OS credential-vault access and short-lived auth-profile decryption;
- Node sidecar lifecycle and child-process-tree supervision;
- update checks, signed update application, and restart;
- Windows notifications and crash-safe job status handoff.

Rust must not implement scene semantics, edit operations, model tools, capture plans, or RenderJob construction. Tauri 2 provides scoped capabilities for WebViews and supports embedded external sidecars; those mechanisms are the reason it fits this trust boundary ([capabilities](https://v2.tauri.app/security/capabilities/), [sidecars](https://v2.tauri.app/develop/sidecar/)).

## 10. TypeScript/Node core responsibilities

The Node sidecar owns the Release Replay behavior: project schemas and migrations, immutable assets, revision commits, operation validation/reducer, Playwright capture, model adapter/tool loop, verification, overlay generation, RenderJob construction, FFmpeg/ffprobe orchestration, local diagnostic artifacts, and project import/export.

### Sidecar shipping decision

Ship a **private pinned Node LTS runtime plus compiled JavaScript and production dependencies as Tauri resources**, launched by the Rust host with a fixed entrypoint and fixed environment. Users do not install Node. Tauri registers only the private runtime as an allowed sidecar; arbitrary binaries/arguments are not exposed to the WebView.

This is preferred over a Node single-executable application because Playwright, Sharp/native modules, browser discovery, and support diagnostics behave closest to their tested Node environment. Node's SEA facility remains active-development and has module-format/resource constraints, so saving several dozen megabytes is not worth packaging risk yet ([Node SEA documentation](https://nodejs.org/api/single-executable-applications.html)). It is preferred over using system Node because version drift would make capture/render support irreproducible.

Installer impact is acceptable: Tauri avoids a UI Chromium, while the private Node runtime is much smaller than the separately managed capture Chromium. Startup cost is paid once per app session. The versioned app bundle updates Rust, UI, Node runtime, core code, and FFmpeg together.

## 11. React UI stack

Use React, Vite, TypeScript, native video controls, CSS, and built-in React state/context first. Add Zustand only when cross-screen selected-project, revision, or job-progress state causes demonstrated prop/context churn. Canonical project data is fetched from the sidecar and never treated as durable browser state. Avoid Redux, server-state frameworks, component suites, and a design system until the bounded editor proves they solve repeated work.

Core views are project list/open, capture-plan approval, capture/job status, storyboard and scene inspector, bounded edit controls, verification failures, revision/revert, render review, and disclosure preview for model context. Accessibility basics—keyboard operation, focus visibility, labels, and reduced motion—are required.

## 12. IPC boundaries

There are two local interfaces:

1. **WebView -> Rust:** a narrow set of Tauri commands such as choose/open project, start/cancel job, read sanitized result, store/retrieve account token, and install update. Tauri capabilities allow only the main bundled WebView and only explicit commands/scopes. No raw filesystem, process, shell, or generic “execute” command is exposed.
2. **Rust -> Node:** length-prefixed JSON or NDJSON over private stdin/stdout. Every request contains protocol version, request/job ID, explicit command, project authorization token/root, and Zod-validated payload. Progress/result events contain no secrets.

The UI validates for feedback, Rust validates command/path scope, and Node performs authoritative Zod structural plus semantic validation. This deliberate repeated trust check is small and prevents a compromised WebView from bypassing domain rules. IPC protocol changes remain backward-compatible within an installed bundle; mixed versions cause startup failure and repair, not best-effort execution.

## 13. Process isolation

Start one supervised Node sidecar per desktop session. It serializes project mutations and runs at most one heavy foreground job initially. Playwright/Chromium and FFmpeg are child processes of the sidecar; model calls are cancellable network operations. The Rust job manager records `queued/running/cancelling/succeeded/failed/interrupted` in small atomic job files before dispatch and streams progress to the UI.

- Chromium/Playwright or FFmpeg failure returns a typed result; the sidecar and UI survive.
- Model timeout cancels the request, preserves the last accepted revision, and keeps manual editing available.
- Node crash is detected by Rust; the active job becomes `interrupted`, the process tree is terminated, and the sidecar restarts.
- UI/WebView crash does not kill the host or active job; reopened UI queries job state.
- Project state changes use append/atomic-pointer rules, so no process is trusted to write in place.

On Windows, the host places the sidecar and its descendants in a Job Object so an abrupt host/worker termination does not orphan Chromium or FFmpeg. This is local supervision, not a distributed job system or queue.

## 14. Playwright/Chromium strategy

Choose **application-managed first-run download of the exact Chromium revision expected by the pinned Playwright package**.

| Option | Decision |
|---|---|
| Bundle Chromium in installer | Reject initially: deterministic/offline, but makes every app update and installer much larger. |
| Download pinned Chromium after install | Choose: smaller signed app installer, browser updated independently, still deterministic. |
| Installed Chrome/Edge | Reject: executable/policy/version drift breaks the support contract. |
| Hybrid silent fallback | Reject: two browser paths hide reliability differences. |

The first capture preflight shows required download size/disk space, asks permission, downloads with progress/resume to an app-owned versioned cache, verifies the expected artifact, and records Playwright/browser versions. Capture remains unavailable until the matching browser is installed. Retain the previous known-good revision through one app update for rollback; garbage-collect older revisions after successful capture. Provide an offline browser package only when customer evidence requires it.

Playwright documents hermetic/application-controlled browser locations, which supports this design ([browser management](https://playwright.dev/docs/browsers)). The Tauri WebView2 runtime is unrelated and never used for capture.

## 15. FFmpeg strategy

Choose **a pinned FFmpeg/ffprobe build bundled as separate sidecar executables in the Windows installer**. The media binaries are smaller and change less often than Chromium; bundling gives immediate offline rendering and one tested behavior. Do not use system FFmpeg or a first-run downloader initially.

Only the Node render module invokes fixed binaries with argv and shell disabled. Version/build configuration is recorded per output. The model and WebView never receive executable paths or process arguments.

Commercial distribution has a mandatory pre-beta legal/license review. FFmpeg is LGPL 2.1+ by default, but optional parts—including common `libx264` builds—can make the distributed binary GPL; FFmpeg publishes a compliance checklist and notes that codec/patent questions are separate ([FFmpeg legal guidance](https://ffmpeg.org/legal.html)). Lock the H.264/AAC output contract and bundled-binary delivery, but do not lock the H.264 encoder build until counsel verifies licenses, corresponding-source/notices/build flags, and target-market patent obligations. If `libx264` distribution is unacceptable, test an LGPL-compatible Windows encoder/build behind the unchanged RenderJob interface.

## 16. Project persistence

The portable directory is canonical:

```text
<project>.replex/
├── project.json                 # format version, project ID, current revision pointer, brief summary
├── flow.json                    # approved stable steps/checkpoints/safety contract
├── operations.jsonl             # accepted/rejected operation audit; recoverable final partial line
├── revisions/
│   └── <revision-id>.json       # immutable complete canonical manifest snapshot and operation IDs
├── captures/<capture-id>.mp4    # immutable source bytes
├── screenshots/                 # checkpoint/boundary/context images
├── traces/                      # Playwright traces per attempt
├── overlays/                    # derived fixed SVG/PNG assets
├── verification/               # immutable results by revision/output
├── renders/                     # RenderJob, probe, stderr, and verified outputs
├── logs/                        # local structured diagnostic events
└── .tmp/                        # same-volume uncommitted work, safe to clean
```

`project.json` never contains secrets or absolute machine paths. Relative paths make the directory movable. Each source/derived artifact stores SHA-256, size, media probe, producing version, and creation identity.

### Atomic commit and recovery

1. Validate against the current revision.
2. Write new immutable artifacts and a full revision snapshot under `.tmp/<transaction-id>`.
3. Flush and close files, verify hashes, then atomically rename them into final same-volume locations.
4. Append one checksummed JSONL operation-batch line.
5. Write `project.json.next`, flush it, and atomically replace `project.json` last.

The pointer update is the commit point. A crash before it leaves unreferenced artifacts that recovery can verify and discard/move to `lost+found`; a crash after it has a complete referenced revision. A truncated final JSONL line is ignored and reconstructed from the referenced revision's embedded operation batch. Never edit captures or revision snapshots in place.

`formatVersion` uses integer versions with ordered forward migrators. Migration first copies the small metadata/revision files to `backup/<version-timestamp>`; media is hash-verified and referenced, not duplicated. On failure, open read-only and offer restore/export. `.tmp` cleanup removes only unreferenced directories older than a recorded safe age.

## 17. SQLite decision

**Do not use SQLite initially.** Project files already provide ownership, portability, auditability, and crash recovery. App-level project index, recent paths, preferences, browser-install metadata, and local jobs fit one atomic Tauri Store/JSON file plus per-job files. The Tauri Store plugin is itself a file-backed persistent key-value store ([official Store plugin](https://v2.tauri.app/plugin/store/)).

Add SQLite only when evidence shows one of: project-index scans exceed the load budget, multiple concurrent jobs require transactional querying, usage/cache records become too large for atomic JSON, or corruption/recovery is worse than a single database. If added, it remains a rebuildable local index/job store; `.replex` files remain canonical.

## 18. AI/model architecture

Keep the technical POC seam:

```ts
interface AgentModel {
  run(input: AgentInput): Promise<AgentTurn>;
}
```

Project state records operation inputs, actor, evidence references, prompt/tool-schema/model version, and results, but no vendor-specific response schema. Inspection/edit/verify/render tools remain Release Replay-owned. One adapter/model is enabled at a time; internal frozen evaluations choose it using valid tool-call rate, rendered-without-repair rate, human correction time, grounding, latency, context size, and cost.

Gemini 3.8 Flash is the initial candidate because Google currently lists it as a stable multimodal model with function calling and structured output ([official model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)). It is not a production architecture lock. GPT, Claude, or local Qwen-family VL models are evaluated one at a time through the same seam. No router, silent fallback, or model-authored JSON/shell/FFmpeg/browser control.

## 19. Model API security

### Development/POC

A founder-supplied API key may live in the developer machine's environment or OS credential vault and the local adapter may call the provider. It never enters a project, log, fixture, or repository.

### Production

Do not ship provider secrets. The desktop authenticates to the control plane; the Worker verifies user/device/entitlement and rate/cost limits, accepts only the bounded `AgentInput` contract, rejects secret-shaped/oversized fields, and calls the selected provider using a Worker secret. The response contains only typed model output/tool calls. The desktop remains the only place tools execute and project state changes.

Selected screenshots/contact sheets are relayed in the request and not persisted by Replex by default. Log disclosure hashes and provider request/retention metadata locally. BYOK remains deferred; add it only if privacy/offline procurement demand exceeds the support and billing complexity.

## 20. Hosted control plane

At paid beta, deploy one stateless modular monolith with modules for session verification, device registration, entitlements, Stripe webhooks, model proxy/config, usage/cost ledger, app version policy, and consented telemetry ingestion. It stores no canonical project, browser auth state, raw trace, or render by default.

Interface is versioned HTTPS JSON with bounded request sizes. Long model calls use streaming HTTP only when the selected provider/user experience needs it; there is no WebSocket platform. Stripe webhooks and usage writes are idempotent. Scheduled cleanup uses the hosting platform's basic cron only if temporary records exist.

## 21. Cloudflare Workers/Hono decision

**Preselected, ADD WHEN NEEDED at external paid beta.** Workers solve secure secret-bearing model calls and a small globally reachable account API without a server/OS/container to operate. Hono supplies a small TypeScript router compatible with Workers rather than an application platform. Official Workers pricing currently has a free tier and a paid plan starting at $5/month with 10 million requests included; CPU/request limits are adequate for I/O-bound auth, webhook, and model proxy work, not video processing ([pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/), [Hono Worker setup](https://hono.dev/docs/getting-started/cloudflare-workers)).

Run no FFmpeg, Chromium, project archive, or long CPU work in Workers. Use one Worker deployment, one domain, one schema package, and provider dashboards/alerts. Revisit only if provider streaming/body limits or sustained database access become a measured blocker.

## 22. Supabase decision

**Preselected, ADD WHEN NEEDED at external paid beta.** Supabase combines hosted Auth and Postgres, avoiding separate identity and database services. Auth stores users/sessions; Postgres stores subscription/customer mapping, entitlements, devices, usage/cost records, consent, and small account settings. It never stores browser cookies/auth state, source media, project manifests, screenshots, traces, or local file paths.

The Worker validates Supabase JWTs and performs server-authorized database operations. Desktop receives only public client configuration and user tokens; service-role credentials remain Worker secrets. Use row-level security for any client-readable account records. Supabase Auth uses its project's Postgres under the hood, and its current Pro floor is $25/month; activate Pro for paid users rather than relying on a pausable free project ([Auth](https://supabase.com/docs/guides/auth), [pricing](https://supabase.com/pricing)).

Do not use Supabase Storage, Realtime, Edge Functions, or local project sync without a validated requirement.

## 23. R2/object-storage decision

**Do not provision now.** Model evidence can be relayed through the bounded Worker request for the early cohort, and customer media remains local. R2 becomes the default candidate only for approved share links, opt-in backup/sync, or provider workflows that require temporary object URLs.

If activated, use private buckets, short-lived signed access, tenant-prefixed opaque keys, content/size validation, explicit upload consent, and lifecycle deletion. R2 currently prices storage/operations with free Internet egress and a free allowance, which is attractive but not a reason to upload videos ([official pricing](https://developers.cloudflare.com/r2/pricing/)).

## 24. Authentication

No product account in POC or founder-only alpha unless necessary for model-cost control. External paid beta uses Supabase Auth with email magic link initially; add social OAuth only when requested. Desktop login opens the system browser and uses authorization code with PKCE and a loopback callback on Windows, avoiding an embedded login WebView and static client secret. Store refresh tokens in Windows Credential Manager through the Rust host; provide access tokens to the sidecar only per request.

Use short access-token lifetimes, refresh rotation, explicit logout/device revocation, and a maximum device count tied to entitlement. Application-under-test Playwright auth profiles are a separate local secret domain and never become Replex account credentials.

## 25. Billing

At the paid-offer gate, use Stripe-hosted Checkout and Customer Portal plus signed idempotent webhooks. Do not collect card details in the desktop. Postgres holds Stripe customer/subscription IDs and derived entitlement, not payment instruments. Local project access/rendering survives subscription lapse; managed model calls and new paid capabilities obey a clear grace policy.

Stripe is `ADD WHEN NEEDED`, subject to account availability and Indian business/export requirements at launch. Current India standard pricing is usage-based rather than a fixed platform fee, with separate Billing fees for subscriptions; Stripe also currently states that new India accounts are invite-only, so founder eligibility must be confirmed before commitment ([payments pricing](https://stripe.com/in/pricing), [India account availability](https://support.stripe.com/questions/stripe-accounts-are-invite-only-in-india)). If Stripe onboarding is unavailable, select one alternative at the billing gate; do not build a provider abstraction beforehand.

## 26. CI/CD

Use GitHub Actions with three understandable workflows:

- Pull request: format/lint/typecheck, Vitest, schema/migration fixtures, tiny FFmpeg job, Rust checks.
- Nightly/manual: Apps A/B/C capture fixtures, full render corpus, model eval with a hard spend cap, Windows packaged smoke.
- Tagged release: clean Windows build, NSIS/updater artifacts, checksums, signatures, install/update/rollback smoke, release publication after approval.

Cloudflare Worker and Supabase migrations deploy from a separate manually approved production job after tests. No environment matrix beyond development and production initially. GitHub documents that Actions is free for standard runners on public repositories and metered beyond included quotas for private repositories ([billing](https://docs.github.com/en/actions/concepts/billing-and-usage)).

## 27. Desktop distribution

Windows ships one per-user signed NSIS `setup.exe`; it avoids administrator rights and matches Tauri's supported installer/update path. Do not produce MSI simultaneously. The installer contains Tauri UI/Rust host, private Node runtime/core dependencies, FFmpeg/ffprobe, overlay assets, and no capture Chromium. First launch checks WebView2 and then offers the pinned Chromium download before capture.

Tauri officially supports NSIS setup executables and MSI; its default per-user mode installs under local app data without admin rights ([Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/)). A portable ZIP is deferred because it complicates updates, protocol registration, and support.

## 28. Updates

Use the Tauri updater with signed update artifacts and static update metadata served from the Worker or release hosting. Do not build an updater. App updates are opt-in during alpha and prompted/staged in paid beta; never update during an active capture/render or project migration.

An app bundle update advances the Rust host, UI, Node runtime/core, schemas, and FFmpeg together. Chromium is a separately versioned managed asset; the updated app downloads its matching revision, retains the previous revision until one successful capture, and supports rollback to the previous app installer. Tauri's updater produces signed NSIS/MSI update artifacts ([updater documentation](https://v2.tauri.app/plugin/updater/)).

## 29. Code signing

Founder-internal builds may remain unsigned. Obtain an organization code-signing certificate and sign installer, application binaries, updater artifacts, Node runtime/sidecars where supported, and FFmpeg distribution before external alpha—no later than the first non-founder download. Protect signing keys in GitHub environment secrets or a hardware/cloud signing service with manual release approval.

Signing reduces Windows trust warnings and is required for a credible updater; Tauri notes it is required for Microsoft Store listing and to avoid untrusted SmartScreen warnings ([Windows signing](https://v2.tauri.app/distribute/sign/windows/)). Verify signatures and checksums in CI before publication.

## 30. Logging

Local JSONL logs remain the primary diagnostic record: app/sidecar/browser/FFmpeg versions, job state, capture actions/checkpoints, operation accept/reject, revision hashes, model tool calls/usage/cost, verification results, RenderJob hash, sanitized argv, process exit/stderr, recapture diff, and correction time.

Redact tokens, cookies, auth storage, secret fill values, customer copy, URL queries, and unrelated DOM before write. Rotate by size/age. A user explicitly reviews and exports a support bundle; raw media/traces are excluded unless individually selected.

## 31. Error reporting

Use local diagnostics through founder alpha. Add Sentry at external paid beta only when remote crash visibility becomes necessary. Send app version, OS, module/stage, typed error code, stack, job ID, and breadcrumbs containing no project content. Disable session replay and automatic attachments. Upload logs/traces/screenshots only after user preview and consent.

Sentry outage or quota never affects local work. Reassess provider/cost only after actual event volume.

## 32. Product analytics

Add PostHog at external paid beta, opt-in/consent-aware by applicable law and defaulting to no content capture. Events are capture start/outcome category, verification/render/recapture outcome, model attempt/tool rejection, export, feature use, latency bucket, app version, and explicit publication/repeat/correction answers.

No autocapture, session replay, DOM text, filenames, URLs, screenshots, traces, prompts, operation text, or media. A tiny typed event allowlist in the sidecar is the only emitter. If founder interviews/support already answer the question, do not add an event.

## 33. Testing

- Vitest: project schemas/migrations, reducer/replay, reconciliation, context redaction, tool validation, RenderJob, local job state, control-plane domain logic.
- Playwright library: approved-flow fixture Apps A/B/C and capture/checkpoint failures; no second browser test framework.
- Tauri desktop integration: small Rust command/sidecar protocol tests plus packaged Windows smoke for open/capture/edit/render/restart/update.
- Deterministic fixtures: versioned project directories, migration corpus, tiny media/render cases, corrupted/partial-write cases, browser-version fixtures, frozen model-eval cases.
- Failure injection: kill Node/Chromium/FFmpeg/UI during jobs, disk full, missing capture, stale revision, model/control-plane outage, invalid IPC, malicious page/tool output.

Compare rendered media semantically—probe, full decode, boundary frames, overlays, duration—not byte-for-byte across machines. Human review remains the creative gate.

## 34. Security boundaries

| Boundary | Trust/control |
|---|---|
| Tauri WebView | Untrusted presentation tier. Bundled local content only, CSP, no remote navigation, narrow capability-scoped commands, no filesystem/shell/sidecar access. |
| Rust host | Trusted native authority. Validates command/path scope, owns dialogs/secrets/update/process tree; contains no product semantics. |
| Node sidecar | Trusted product engine but treats IPC, disk, browser, model, and cloud data as untrusted; Zod plus semantic validation before mutation. |
| Playwright browser | Runs potentially malicious customer application content in a dedicated context; no Replex IPC, allowlisted origins/actions/download/upload paths, isolated auth profile. |
| FFmpeg | Parses untrusted media in a separate process with fixed argv, project-scoped paths, no shell/network use, time/resource bounds. |
| Model provider | Receives only disclosed bounded context; has no credentials, filesystem, browser, shell, or direct operation authority. |
| Hosted control plane | Holds Replex identity/entitlement/model secrets, not browser auth or canonical projects; validates auth, tenant, schema, size, rate, and cost. |

Playwright cookies/auth state are encrypted locally with an OS-vault-protected key, decrypted only for an active capture into a restricted temp location/object, and deleted afterward. Project roots are user-approved and represented by opaque host-issued handles; the WebView cannot submit arbitrary paths. Model/provider keys exist only in founder vaults (development) or Worker secrets (production). Logs follow an explicit field allowlist.

## 35. Local-first privacy

Local by default: approved flows, Playwright profiles/cookies, captures, screenshots, traces, manifests, operations, revisions, overlays, RenderJobs, FFmpeg intermediates, and rendered MP4s. Hosted by default after paid-beta activation: Replex user/account, entitlement, device, subscription references, aggregate usage/cost, consent, and remote config.

Before an AI request, show which brief text, structured metadata, screenshots/contact sheets, and verification evidence will leave the device. Never send raw auth state or an entire trace/video by default. Project deletion is local and explicit; cloud account deletion is separate. Optional sync/share/backup requires a future consent/retention design and is not implied by having an account.

## 36. Cost model

Fixed early-production costs are domain/email, Cloudflare paid Worker when required, Supabase Pro when paid users require non-pausing reliability, signing certificate/service, and optional Sentry/PostHog paid tiers only after their free allowances cease to fit. Variable costs are model input/output/media tokens, email delivery, Stripe/payment fees, and any explicitly enabled hosted storage/bandwidth.

The dominant controllable variable is model usage. Enforce per-plan request/token/image/render-inspection budgets, downscale/crop/contact-sheet before richer media, cache only non-sensitive derived evidence locally, and expose usage. Price the product so normal included model usage has positive contribution; unusually expensive model passes, future TTS, hosted share/storage, or remote execution must be capped or passed through. Gemini 3.8 Flash currently has introductory pricing through 31 December 2026 and higher published pricing afterward, so forecasts must use the post-promotion rate rather than treating launch pricing as durable ([official Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)).

Local Playwright/Chromium/capture/FFmpeg/media avoids browser worker hours, upload egress, persistent video storage, render compute, queue/worker operations, and sensitive-session custody. A cloud equivalent would add every one of those plus retries and regional debugging. Keep work local until user hardware failure or paid unattended execution outweighs that cost/privacy advantage.

## 37. Estimated infrastructure by user scale

Directional monthly ranges in USD, excluding founder time, taxes, signing certificate, and payment fees. They are planning bands, not forecasts; model behavior and user activity dominate.

| Active users | Fixed/platform | Usage-dependent | Expected dominant driver |
|---:|---:|---:|---|
| 10 | $30-$75 | $5-$100+ model/email | Supabase Pro ($25) + Worker ($5) once paid beta starts; model experiments. |
| 100 | $30-$150 | $50-$1,000+ model/email/payment | Model calls and correction loops; API/database should remain near base tiers. |
| 1,000 | $75-$500 | $500-$10,000+ model/email/payment | Model context frequency/size; support/error volume. Local render still removes major cloud cost. |

R2 is $0 while absent. If later activated, storage and operations grow with retained media; R2 currently advertises free direct egress, but retention—not egress—is the first cost/privacy control. Stripe is percentage-based. Error reporting/analytics should remain free or low until event volume is meaningful. Email grows with authentication volume. Model cost must be measured per accepted export, not per prompt.

## 38. Deployment stages

### Stage 0: POC

Local TypeScript CLI, local files, local installed FFmpeg/ffprobe, local Playwright/Chromium, founder API key, no Tauri requirement, backend, account, telemetry, or billing.

### Stage 1: Founder alpha

Tauri/React Windows app, private Node sidecar, bundled FFmpeg, managed Chromium download, portable project format, local logs, manual/GitHub release distribution, Tauri updater test channel. No Supabase/Stripe/PostHog; managed AI may still use founder credentials.

### Stage 2: External paid beta

Signed NSIS installer/updater; Cloudflare Worker/Hono; Supabase Auth/Postgres; Stripe-hosted billing; secure managed model proxy; Sentry; minimal PostHog; cost/entitlement limits. Media/browser/render remain local and R2 remains absent.

### Stage 3: Early production

Harden migrations/recovery/rollback, browser/update downloads, consent/telemetry, support bundles, model eval/version policy, and cost controls. Add hosted file capability or other infrastructure only after a validated feature demands it.

## 39. Windows-first rollout

- Target supported 64-bit Windows first; add ARM64 only after hardware/user evidence.
- Build on a Windows GitHub Actions runner; produce one per-user NSIS setup executable and updater artifact.
- Sign before external alpha, verify signature/checksum in CI, and publish through a staged update channel.
- Use installed/current WebView2 through Tauri; installer handles the supported bootstrap path when missing.
- Download pinned Playwright Chromium on first capture with progress, verification, resume, and previous-version rollback.
- Bundle pinned legally reviewed FFmpeg/ffprobe in the installer.
- Store Replex credentials in Windows Credential Manager and project/browser files under scoped user-selected/app-data locations.

Do not add MSI, Store packaging, portable ZIP, ARM64, or enterprise per-machine install until required.

## 40. macOS/Linux strategy

Defer both. Keep TypeScript product packages, RenderJob, project files, model seam, and Rust command shapes platform-neutral, but do not pay for builds, signing, test matrices, browser/media distribution, or support before demand.

macOS is second: add universal or architecture-specific app bundles/DMG, Apple signing/notarization, Keychain, Chromium/FFmpeg builds, updater and fixture matrix. Linux is third and only on strong demand because WebKit/system dependencies, codecs, packaging formats, secret stores, and distro support expand the surface. No simultaneous three-platform launch.

## 41. Operational failure modes

| Failure | Recovery |
|---|---|
| Chromium crash/Playwright failure | Mark capture attempt failed, preserve trace/evidence, kill browser tree, allow explicit measured retry. |
| Node sidecar crash | Rust marks job interrupted, terminates descendants, restarts sidecar, opens last committed revision. |
| FFmpeg crash/corrupt output | Preserve job/stderr/temp, reject output, allow one visible classified retry. |
| Model timeout/invalid tool | Cancel/reject atomically, preserve revision, one visible transport retry, manual controls remain usable. |
| UI crash | Host/job continues; new WebView reads durable job/current revision. |
| Power loss/partial write | Current pointer references last complete snapshot; recovery handles orphan temp/revision/truncated final log line. |
| Missing/corrupt capture | Block affected verification/render, identify hash/provenance, restore or recapture; unrelated scenes remain accessible. |
| Browser/app UI drift | Stop exact step/checkpoint; user explicitly corrects target/flow and reruns; no silent healing. |
| Control-plane/Supabase outage | Local open/manual edit/verify/render continue; login refresh and AI show unavailable state. |
| Update incompatibility | Refuse mixed protocol, retain prior app/browser, restore metadata backup/read-only project, support rollback. |
| Disk full | Preflight estimate; fail before pointer commit; preserve last revision and report cleanup candidates. |

## 42. Upgrade/migration strategy

Version four independent contracts: desktop bundle, IPC protocol, project format, and tool/prompt/model evaluation version. Desktop/sidecar ship atomically and must share one IPC version. Browser and FFmpeg versions are recorded with artifacts.

Project migrators are ordered, deterministic, idempotence-tested transformations of small metadata/revision files. Before migration, verify free space/hashes and create a metadata backup. Never rewrite source captures. Support opening projects created by the previous two minor versions; unsupported newer formats open read-only or refuse safely. Release fixtures cover every supported origin version and rollback opening behavior.

Cloud database changes use additive changes first, backfill, then later removal after old desktop versions age out. Worker accepts at least the current and immediately previous desktop protocol during staged rollout. Model/prompt changes do not migrate projects; they create new attempt metadata and must pass the eval corpus.

## 43. Escape hatches

- **Model provider:** easy. Add one adapter, run the frozen corpus, select it; no project migration.
- **Hosted database/auth:** moderate. Export the small account/entitlement tables; canonical projects/media remain local.
- **Worker/Hono host:** moderate. Hono and protocol logic are portable TypeScript, but Cloudflare bindings remain in a thin adapter.
- **Renderer/codec:** moderate. Implement the same validated RenderJob and verification contract; project state remains stable.
- **Browser revision:** easy within the capture module/cache; stable flow/action/scene identity remains unchanged.
- **Desktop shell:** hard. Keep all product semantics in TypeScript packages and all UI-host calls behind a small interface so replacement does not alter projects.
- **Local metadata store:** easy. Rebuild SQLite or another index from project directories/job records if JSON stops fitting.
- **Object storage:** easy to add because local asset identity already uses hashes; sync semantics are still a separate product decision.

## 44. Architecture decisions intentionally deferred

- Production model/vendor after comparative eval; BYOK; local inference; fallback policy.
- Cloud capture/render, unattended CI mode, remote browser, hosted project/media sync, backup, share links, collaboration.
- R2 provisioning and retention design.
- SQLite activation and schema.
- Full-video model context, narration/TTS, additional formats, richer motion/editor core.
- macOS/Linux/ARM64, Microsoft Store/MSI/portable packages.
- Selector self-healing and automatic changed-scene detection.
- Sentry/PostHog paid tiers or alternative vendors.
- Billing provider fallback and exact pricing model until the paid offer is validated.
- Enterprise identity/compliance/administration.

## 45. Final locked stack

| Layer | Locked choice | Why | Revisit trigger |
|---|---|---|---|
| Product architecture | Local-first desktop + gated minimal control plane | Matches credential/media workflow and removes cloud browser/render/storage cost. | Users reject local execution or paid unattended use dominates. |
| Desktop | Tauri 2 | Small system-WebView shell with native capabilities/sidecars/updater. | Measured WebView/Tauri blocker materially exceeds Electron cost. |
| UI | React + Vite + TypeScript, built-in state first | Small, familiar bounded editor stack without speculative state dependency. | Cross-screen state demonstrably needs Zustand or another store. |
| Native tier | Minimal Rust | Owns privileged lifecycle/path/secret/process/update work only. | A cross-platform capability cannot be implemented safely. |
| Product core | Private pinned Node LTS runtime + compiled TypeScript sidecar | Preserves POC code and Playwright/Sharp compatibility without system Node. | SEA/binary packaging proves reliable across full fixture corpus. |
| Package management | pnpm workspace | One lockfile across desktop/core/control-plane. | Tooling blocks signed/reproducible builds. |
| Validation | Zod structural + semantic validators | One authoritative TypeScript input contract. | None without replacing the TypeScript core. |
| Project state | Versioned portable `.replex` files, immutable captures/revisions, atomic current pointer | Inspectable, recoverable, vendor-independent, no database needed. | Measured local metadata concurrency/search bottleneck; canonical format still remains files. |
| Capture | Playwright + exact application-managed Chromium download | Deterministic browser without huge installer or installed-browser drift. | Offline enterprise demand or download reliability fails. |
| Render | Validated RenderJob -> bundled pinned FFmpeg/ffprobe | Deterministic local authoritative export. | Legal review or fixture evidence requires another backend. |
| Visual assets | Fixed SVG templates + Sharp | Covers required titles/callouts/focus/thumbnails without motion framework. | Paid requests exceed fixed vocabulary threshold. |
| AI seam | One-method `AgentModel`; one eval-selected active model | Vendor can change without project/editor migration. | Reliability evidence justifies explicit fallback/routing. |
| CI/release | GitHub Actions, Windows NSIS, Tauri updater, code signing | Small understandable release chain with signed updates. | Distribution channel evidence favors Microsoft Store or another platform. |

## Not Locked

- Production model vendor/version: Gemini 3.8 Flash is the first candidate, not a permanent choice.
- H.264 encoder/build flags pending FFmpeg and codec/patent legal review.
- Paid-beta vendors: Cloudflare Workers/Hono and Supabase Auth/Postgres are preselected defaults but are not provisioned or irrevocably locked before that gate.
- Billing provider: Stripe is preferred only if founder account eligibility and target-market requirements are confirmed.
- SQLite, R2, cloud rendering/capture, remote browsers, hosted project sync, BYOK, and local model hosting.
- Sentry/PostHog activation, paid tiers, and long-term vendors.
- Billing-provider fallback and final price structure.
- macOS, Linux, ARM64, MSI, Microsoft Store, and portable distribution.
- Any general editor engine, richer motion system, additional export format, or P1 feature.
