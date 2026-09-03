# Release Replay

## Test-Backed Release Video Compiler PRD

## 1. Document status

| Field | Value |
|---|---|
| Status | Final product specification for POC validation and gated MVP planning |
| Last revised | 4 September 2026 |
| Research cutoff | 29 August 2026 |
| Project name | Release Replay; temporary working name, not a permanent brand decision |
| Intended readers | Two technical founders and the agents or engineers later producing an implementation plan |
| Current commitment | POC only |
| Next decision | Approve, reject, or amend this PRD before creating an implementation plan |

This document defines three distinct states: POC, MVP, and Production. Requirements do not move forward automatically. Each state requires evidence from the preceding gate.

## 2. Research basis

This revision is based on the complete contents of:

- The 28 August 2026 AI-native video editor PRD.
- The 29 August 2026 Diffusion Studio takeaways.
- The earlier architecture sketch centered on a creative agent, OpenCut, Motion Canvas, and FFmpeg.

The supported research conclusions retained here are:

1. General conversational video editing is already occupied by products including OpenReel, Adobe Premiere, Descript, Runway, and Captions.
2. Software-demo automation is also competitive. Arcade, Trupeer, Argo, and several newer tools cover browser capture, narration, branding, or release-video generation.
3. OpenReel is a young MIT-licensed editor with an action-oriented architecture, but its public agent completeness and stable embedding boundary remain uncertain.
4. OpenCut's Editor API, MCP, plug-in, scripting, and headless direction is announced rather than a stable current foundation.
5. Kdenlive and MLT are mature but impose desktop, integration, and licensing complexity that does not help test the initial hypothesis.
6. FFmpeg is appropriate for media inspection, deterministic processing, and authoritative export. It is not the project model or user editor.
7. Diffusion Studio demonstrates a useful agent pattern: structured media inspection, editable generated compositions, reconciliation, and verification before render. It also confirms that “an editor agents can drive” is not differentiation.

Primary references supporting those conclusions include [OpenReel](https://openreel.video/), [OpenCut](https://github.com/OpenCut-app/OpenCut), [Kdenlive project files](https://docs.kdenlive.org/en/project_and_asset_management/file_management/project_files.html), [MLT](https://www.mltframework.org/docs/framework/), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Arcade](https://www.arcade.software/lp/agents-enterprise), [Trupeer](https://www.trupeer.ai/tools/product-demo-video-maker), [Diffusion Studio editor](https://github.com/diffusionstudio/editor), and the [Diffusion Studio agent prototype](https://github.com/diffusionstudio/agent).

No new competitive-landscape study was conducted for this revision. Current market claims in the earlier research remain vendor claims unless explicitly identified there as independently verified.

## 3. Research verdict

**NO-GO for a general AI video editor. CONDITIONAL GO for the Release Replay POC.**

The generic concept is weak because natural-language editing, editable AI timelines, captions, basic motion, generation, and agent-controlled editors are increasingly standard capabilities.

The narrow POC is worth testing because it asks a different question:

> Can approved software behavior become reproducible video source material, so a changed product requires recapturing only the affected scenes rather than recording and editing the release video again?

That is not yet proven to be a business. The POC must establish technical reliability and externally usable output before the founders build an MVP.

## 4. Product definition

Release Replay is a test-backed release-video compiler for browser-based software.

It consumes:

- A feature brief.
- An approved browser flow, expressed as an existing Playwright test or a precise user-approved sequence.
- A local or staging application.

It produces:

- Reproducible source captures linked to browser actions.
- A minimal scene manifest linking the flow, captures, edits, overlays, revisions, and output.
- A fixed-format release-video draft.
- A mechanism to recapture and replace only a scene affected by a product change.

It is not a general video editor, autonomous product explorer, video-generation suite, or professional motion-graphics tool.

## 5. Problem

Small software teams often need a release announcement, changelog clip, product update, sales follow-up, or similar product video after shipping a visible feature.

The current workflow combines several fragile jobs:

1. Prepare the correct product state and demo data.
2. Reproduce the intended browser flow cleanly.
3. Record without cursor mistakes, loading stalls, notifications, or accidental state changes.
4. Cut dead time and add enough visual guidance for the feature to be understood.
5. Repeat capture and editing when the UI, data, or flow changes.

Existing editors begin after the product-specific work has happened. Existing demo tools can polish recordings, but the research does not establish that they treat an approved application flow, capture provenance, and selective scene recapture as one durable source model.

The customer-facing problem is not “missing provenance.” It is:

> The product changed, and updating the video should not mean recording and editing it again from the beginning.

This problem is commercially meaningful only if it occurs often enough, the resulting videos are actually published or used, and the saved effort exceeds the switching cost of current tools.

## 6. Primary user

The primary user is a technical founder or member of a small product team at a 2–20 person B2B SaaS or developer-tool company.

The target team:

- Ships visible browser features at least twice per month.
- Owns release communication without a dedicated video-production function.
- Can provide a local or staging application and a disposable demo account.
- Can define an approved feature flow or already has Playwright coverage.
- Currently spends 45–180 minutes producing a usable product video, or skips the video because the workflow is too costly.

Agencies, professional editors, creators, podcasters, mobile-app teams, and enterprise training organizations are not initial target users.

## 7. Product thesis

Software behavior can be captured as structured, reproducible source material rather than an opaque screen recording. If each video scene is linked to an approved browser flow and deterministic edit operations, a product change can invalidate and replace only the affected scene while preserving the rest of the video project.

The commercial bet is that this reduces recurring release-video work enough for small software teams to publish more product updates and pay for the workflow.

## 8. Customer value proposition

Primary value proposition:

> Ship the feature, capture the approved flow, and get an editable release video. When the product changes, update the affected scenes instead of remaking the video.

Secondary outcomes:

- Fewer failed recording takes.
- Less manual cutting of loading and dead time.
- Faster correction of one broken product step.
- A reviewable connection between what the product did and what the video shows.

“Provenance,” “scene graph,” and “deterministic operations” are internal mechanisms. They should not lead customer messaging unless interviews show that technical teams explicitly value those terms.

## 9. Differentiation

Release Replay must differentiate on the lifecycle of a software-derived video, not ordinary AI editing.

| Differentiator | Required behavior | Customer outcome |
|---|---|---|
| Approved-flow capture | The recorded behavior comes from a reviewed test or action sequence | The video shows the intended product path rather than an agent's guess |
| Scene-level traceability | Each scene links to its browser steps, expected state, and source capture | A wrong scene can be diagnosed without reviewing the entire recording |
| Selective recapture | A product-state change replaces the affected scene while preserving unrelated scenes | Updating a release video is materially faster than recreating it |
| Deterministic edit operations | Model and human changes use validated, logged operations | Changes are reproducible, inspectable, and reversible where needed |
| Explicit verification | Browser and output invariants are checked before export | Obvious capture or render failures are caught before human review |
| Editable result | The user can make bounded scene and overlay corrections | Automation is not a dead-end MP4 |

Natural-language editing, captions, basic motion, narration, FFmpeg processing, timeline manipulation, and generic browser recording are supporting capabilities. They are not differentiation.

## 10. Core product principles

1. Software behavior is source material.
2. Capture only an approved flow; do not autonomously explore the product in POC or MVP.
3. Keep source media immutable.
4. Give every scene and browser step a stable identity.
5. Use a minimal owned manifest, not a universal media schema.
6. Apply edits through a small validated operation vocabulary.
7. Make every operation reproducible and inspectable.
8. Follow `INSPECT -> EDIT -> VERIFY -> RENDER`, with targeted re-inspection when useful.
9. Verify explicit invariants; do not pretend automated review can judge creative quality reliably.
10. Preserve human review and bounded manual correction.
11. Prefer local execution for credentials, application state, media, and rendering.
12. Reuse Playwright and FFmpeg rather than recreating browser or media infrastructure.
13. Build only the editor surface required by this workflow.
14. Spend against evidence gates, not available funding.

## 11. Product states

### POC

An internal technical proof that turns one approved feature flow into a fixed 30-second video project and selectively replaces one affected scene after the product changes. An ugly internal review interface is acceptable. There are no external user accounts or production service expectations.

### MVP

A minimum usable local workflow for external target users. It adds capture-plan approval, understandable review, bounded corrections, project persistence, and failure recovery. It begins only after the POC meets every technical gate and produces output target users would actually use.

### Production

A future operational state considered only where current decisions could create a costly dead end. Potential production concerns include packaging, supportability, security hardening, telemetry consent, crash recovery, and possibly remote services. They are not current deliverables.

## 12. POC hypothesis

Given a feature brief and an approved Playwright/browser flow, the system can:

1. Deterministically reach the correct product states.
2. Capture 3–5 traceable scenes.
3. Assemble them using a fixed edit vocabulary into a valid 30-second MP4.
4. Detect a changed product state.
5. Recapture and replace only the affected scene while preserving all unrelated scene sources and edits.
6. Produce an externally usable result with less than ten minutes of human correction.

The POC fails if reliability or output quality depends on undocumented founder intervention.

## 13. POC scope

### Inputs

- One written feature brief with audience and intended message.
- One approved browser flow.
- One URL or localhost application.
- One disposable authenticated session where required.
- One fixed 1920×1080 visual treatment.

### System under test

- A local Playwright runner.
- Capture artifacts and action traces.
- A minimal scene manifest.
- A small validated edit-operation layer.
- Fixed title, callout, focus, cut, speed, and transition treatments.
- FFmpeg-based authoritative export.
- An internal scene review surface or manifest viewer.

### Adversarial application set

The POC must run against three meaningfully different applications:

- **App A — normal SaaS:** a representative authenticated or unauthenticated workflow with navigation, form or control interaction, and a visible result.
- **App B — dynamic SaaS:** authentication plus async loading and at least two of animations, complex component state, modal, dropdown, toast, or delayed backend state.
- **App C — difficult browser behavior:** at least one iframe, large dynamic table, multi-step wizard, file upload, popup/new tab, deliberately slow network state, or similarly difficult interaction.

Three trivial CRUD dashboards do not satisfy the POC.

## 14. POC user/system flow

```text
feature brief + approved browser flow
                |
                v
INSPECT application, expected states, selectors, and safety constraints
                |
                v
execute approved flow and capture browser actions, screenshots, and video
                |
                v
create 3-5 stable scenes in the minimal manifest
                |
                v
EDIT through validated fixed operations
                |
                v
VERIFY browser success, media existence, timing, overlays, and blank-frame rules
                |
                v
RENDER one authoritative 30-second MP4
                |
                v
human reviews result and records correction time
                |
                v
change one product state
                |
                v
recapture and replace only the affected scene
                |
                v
verify unchanged scenes and render the revised MP4
```

## 15. POC requirements

| ID | Requirement | Why required | Pass condition |
|---|---|---|---|
| POC-01 | Accept one feature brief containing audience, message, and target duration | The system needs bounded intent to decide what the flow should communicate | The brief is stored with the project and referenced by the generated scene sequence |
| POC-02 | Accept one explicit approved browser flow as Playwright steps or a precise action sequence | The hypothesis concerns approved, reproducible behavior rather than autonomous exploration | Execution is limited to the supplied flow; unapproved actions are not introduced |
| POC-03 | Declare allowed origins and prohibited consequential actions before execution | Capture must not trade reliability for unsafe autonomy | Navigation outside allowed origins or prohibited actions fail closed and are logged |
| POC-04 | Run with a fixed browser, viewport, locale, time zone, and deterministic demo state where controllable | Comparable captures require a controlled environment | Repeated runs use the recorded environment configuration and reach the same expected checkpoints |
| POC-05 | Record browser action trace, timing, selector or target identity, and expected state checkpoints | Traceability is required to diagnose and selectively repeat a scene | Every captured scene references the actions and checkpoints that produced it |
| POC-06 | Produce 3–5 immutable source captures from one flow | The POC needs enough structure to test scene assembly and partial replacement | Each scene has an existing source asset with recorded duration and origin |
| POC-07 | Assign stable IDs to flow steps, captures, scenes, overlays, operations, outputs, and revisions | Stable identity is required for targeted replacement and comparison | IDs survive a recapture; only the capture and derived output references change |
| POC-08 | Persist a minimal owned scene manifest | The central thesis cannot be tested with only an opaque MP4 | The manifest links the feature flow, trace, captures, scenes, edit operations, overlays, outputs, recapture lineage, and revision |
| POC-09 | Support only the fixed POC edit operations defined in section 25 | Deterministic assembly needs a constrained mutation surface | Invalid operation names, IDs, time ranges, and values are rejected before state changes |
| POC-10 | Keep source captures immutable | Selective recapture and reversibility require source preservation | No edit operation modifies source bytes; replacements create new capture records |
| POC-11 | Assemble one approximately 30-second 16:9 sequence | A fixed target isolates the capture and project hypothesis from format expansion | Output duration is 25–35 seconds at 1920×1080 and 30 fps |
| POC-12 | Apply one fixed title style, callout style, focus treatment, cut style, and optional short cross-dissolve | The output must be understandable without building a motion system | All treatments come from documented bounded parameters and render consistently |
| POC-13 | Verify explicit browser and media invariants before render | A completed command is not proof of a correct capture | Required product state is visible, flow checkpoints passed, assets exist, ranges are valid, required overlays exist, and blank-frame checks pass |
| POC-14 | Render an authoritative H.264/AAC MP4 through FFmpeg | The technical proof requires a usable final artifact | The file probes successfully, matches output constraints, and plays from start to finish |
| POC-15 | Expose a basic internal review surface | Human review and correction-time measurement are part of the hypothesis | A reviewer can inspect scene order, source/trace links, overlays, and the rendered draft |
| POC-16 | Change one application state and replace only its affected scene | Selective recapture is the core technical differentiation | The affected scene receives a new capture lineage while unaffected scene source references and edits remain unchanged |
| POC-17 | Preserve revisions and an inspectable operation log | The revised output must be explainable and recoverable | The initial and revised manifests and renders remain identifiable; every state change identifies its operation and inputs |
| POC-18 | Report failures without silently retrying them away | Reliability cannot be evaluated if recovery attempts are hidden | Every attempt, retry, selector recovery, failure category, and manual intervention is recorded |
| POC-19 | Keep credentials and browser authentication state local | Real SaaS workflows involve sensitive sessions | Secrets are not stored in the manifest, logs, model context, or source control |
| POC-20 | Measure capture success, state correctness, recapture success, render correctness, and human correction time | The POC requires decision evidence rather than a compelling demo | One results record exists for every run and contains all required measurements |

## 16. POC non-goals

The POC does not include:

- A polished timeline or professional editor.
- External user accounts, billing, teams, or collaboration.
- Cloud capture, cloud rendering, or hosted project storage.
- TTS, generated narration, transcription, or music selection.
- Conversational editing UI.
- Full undo/redo UX; manifest revisions are sufficient.
- Multiple aspect ratios, resolutions, durations, or platform variants.
- Brand kits or configurable templates.
- GitHub, Linear, or CI integration.
- Motion Canvas or a separate motion engine.
- General NLE functionality.
- Arbitrary footage import or editing.
- Autonomous application exploration.
- Multi-agent orchestration or model routing.
- A plug-in system, public API, or MCP server.
- Production-grade packaging or UI.
- Generative image or video models.
- Creative-quality scoring by an AI reviewer.

## 17. POC pass/fail criteria

The POC passes only if every required gate passes. Results must include raw attempt counts; retries do not erase first-attempt failures.

| Gate | Pass | Fail |
|---|---|---|
| Adversarial coverage | Apps A, B, and C satisfy the complexity definitions and each completes two measured runs | Any application is substituted with a trivial flow or does not complete two measured runs |
| Browser completion | At least 5 of 6 runs complete the approved flow without manual intervention after execution starts | Fewer than 5 of 6 runs complete without intervention |
| Product-state correctness | All accepted runs satisfy every declared state checkpoint; a run with the wrong state counts as failed even if recording completed | Any accepted output depicts an incorrect or unverified required product state |
| Reproducibility | Both runs for at least 2 of 3 apps produce the same ordered checkpoints and valid scene mapping | Run-to-run behavior cannot be related to the same stable flow and scene identities |
| Selective recapture | The changed scene is correctly replaced for all 3 apps; unaffected scene source references and edits remain unchanged | Any update requires recapturing or rebuilding an unaffected scene |
| Selector/action recovery | Failures stop on the exact action, retain evidence, and allow an explicit corrected target followed by a successful rerun | Recovery guesses silently, loses the failing state, or requires undocumented code edits |
| Render correctness | All 6 final outputs and all 3 selective-recapture outputs probe and play successfully; first-pass render rate is reported separately | Any final artifact is corrupt, violates format constraints, or hides a failed first render |
| Human correction | Median correction time is under 10 minutes and no accepted output requires more than 20 minutes | Median exceeds 10 minutes or output quality depends on undocumented founder editing |
| External usefulness | At least 2 of 3 target users say they would publish or send the result in a real workflow | Fewer than 2 would use the output externally |
| Safety/privacy | No prohibited action occurs and no credential or authenticated storage state leaves the local machine | Any prohibited action or credential exposure occurs |

If the POC fails, the founders must classify the cause as browser reliability, state control, project/recapture design, render fidelity, output taste, or absent user value. Building a larger editor is not the default response.

## 18. MVP scope

The MVP begins only after the POC passes.

It converts the internal proof into a minimum usable local workflow for the primary user:

- Create and reopen a project.
- Supply a brief, application, and approved flow.
- Review and approve the capture plan and consequential actions.
- Capture, assemble, verify, and render a draft.
- Understand which product steps produced each scene.
- Correct scene order, timing, focus, and text through a small review editor.
- Recapture one affected scene after a product change.
- Revert a complete revision.
- Export one 1080p MP4.

The MVP still does not attempt general editing, unattended CI generation, or production-scale cloud operation.

## 19. MVP user journey

1. The user creates a local project.
2. The user enters the feature brief, target audience, URL or localhost address, and an approved browser flow.
3. The user authenticates locally with a disposable demo account where required.
4. The system inspects the flow and shows planned actions, expected checkpoints, allowed origins, and consequential actions.
5. The user approves or corrects the plan.
6. The local runner executes the flow and captures source media, screenshots, timing, and trace data.
7. The system creates scenes, applies bounded edits, verifies explicit invariants, and renders a draft.
8. The user reviews a storyboard, scene list, trace links, and authoritative draft.
9. The user trims, reorders, replaces, or adjusts bounded overlays and focus treatments.
10. The system creates a new revision, verifies it, and renders the accepted 1080p MP4.
11. When the product changes, the user reruns the affected flow segment and replaces only the invalidated scene.

## 20. MVP requirements

### P0

- Local project creation, persistence, reopen, and deletion.
- Feature brief, target audience, URL/localhost, and explicit browser-flow input.
- Existing Playwright flow support plus a precise manually defined flow.
- Capture-plan review with allowed origins, expected checkpoints, and explicit approval for consequential actions.
- Local Chromium execution with controlled viewport, locale, time zone, and recorded environment.
- Action-level failure reporting and explicit selector/target correction.
- Immutable source captures and the owned scene manifest defined in section 24.
- Stable IDs and recapture lineage across revisions.
- Scene creation, trim, reorder, replace capture, focus, callout, title, speed, transition, source-audio control, and whole-revision revert.
- Storyboard and scene-list review with source/trace inspection.
- Bounded manual editing for P0 operations.
- Automatic checks for declared browser and render invariants.
- Selective recapture and replacement of an affected scene without rebuilding unaffected scenes.
- One approximately 30-second 1920×1080, 30 fps H.264/AAC MP4 output.
- Visible render status, validation failures, and retry history.
- Local credential and browser-state protection.
- Measurement of completion, correctness, recapture, correction time, export, publication, payment, and repeat use.

### P1

- Conversational revision using exactly the same validated operations as the manual UI.
- Optional TTS from a user-approved script.
- Saved visual treatment or lightweight brand preset.
- 9:16 and 1:1 derived outputs.
- Additional fixed durations.
- Music selection and simple mixing.
- Captions when narration or source speech creates demonstrated demand.
- Changed-scene suggestion based on a flow or checkpoint difference.
- Direct GitHub or Linear context import.
- CI-triggered draft generation.
- Shareable review link.
- Subtitle-file export.

### OUT

- General footage editing.
- Multi-camera editing, long-form editing, or professional audio mixing.
- Color grading, masks, tracking, arbitrary effects, or keyframe graphs.
- Full motion-graphics composition.
- Generative video or image creation.
- Autonomous product exploration.
- Mobile applications.
- Live collaboration or multiplayer editing.
- Stock-media marketplace.
- Social publishing or scheduling.
- Plug-in marketplace, public workflow builder, or general MCP platform.
- Provider-neutral model architecture, fine-tuning, or custom foundation models.
- Cloud GPU fleet or proprietary codec/render engine.
- Enterprise identity, policy, or administration suite.

## 21. MVP non-goals

The MVP is not intended to:

- Replace CapCut, Premiere, Resolve, Kdenlive, OpenReel, OpenCut, or Diffusion Studio.
- Support arbitrary video projects unrelated to browser software.
- Guarantee creative quality through automated scoring.
- Discover what a product does without an approved flow.
- Produce every launch asset or publish to every channel.
- Maintain a permanent synchronized copy of a customer's application.
- Run fully unattended against production accounts.
- Serve as a generic browser-testing product.

## 22. AI/model responsibilities

Use one capable reasoning model initially. Claude is the default first model; no provider abstraction is required.

### Model context

The model may receive:

- Feature brief and target audience.
- Approved browser flow and safety constraints.
- Relevant DOM or accessibility summaries.
- Selected screenshots and contact sheets.
- Action trace and declared state checkpoints.
- Current scene manifest and revision history.
- Source-media metadata.
- Current title, callouts, timings, and user correction request.

It must not receive passwords, cookies, raw browser storage state, unrelated application data, or unrestricted filesystem access.

### Permitted responsibilities

- Propose how approved flow steps map to scenes.
- Identify dead time within captured material.
- Propose scene order and bounded timing changes.
- Draft concise titles and callouts grounded in the feature brief or observed product state.
- Select from the fixed focus and transition vocabulary.
- Request validated edit operations.
- Explain ambiguity or a failed verification result.

### Prohibited responsibilities

- Mutate arbitrary project JSON.
- Emit and execute uncontrolled FFmpeg commands or browser JavaScript as the product interface.
- Invent a product state, feature claim, or successful browser action.
- Perform unapproved destructive, financial, publishing, messaging, or account-management actions.
- Decide that sampled frames prove overall creative quality.
- Add tools or agents dynamically.

The POC may use scripted rules for operations that do not require model reasoning. Model use is justified only where interpretation materially improves the output.

## 23. Browser capture architecture

```text
approved flow + environment contract
                 |
                 v
        local Playwright runner
                 |
     +-----------+------------+
     |           |            |
 action trace  screenshots  source video
     |           |            |
     +-----------+------------+
                 |
        checkpoint validation
                 |
                 v
          scene manifest
```

### Execution contract

- Chromium only for POC and MVP.
- Fixed viewport, locale, time zone, color scheme, and reduced-motion preference.
- Explicit allowlist for application and authentication origins.
- Disposable demo account and deterministic fixture/reset path where available.
- Expected checkpoint after every scene-producing action group.
- Clear start and end boundaries for each scene.

### Reliability behavior

- Prefer role, label, test ID, or other stable semantic targets over coordinate clicks.
- Wait for declared conditions rather than arbitrary sleep durations.
- Treat action completion and state correctness as separate checks.
- Stop at the first failed action or checkpoint.
- Preserve screenshot, trace, console information, and current URL for the failure.
- Permit an explicit corrected selector/target and a new measured attempt.
- Record every retry. The product must not report a recovered attempt as a first-pass success.
- Do not silently fall back to manual capture while reporting automation success.

Playwright supplies browser automation and raw recording infrastructure. Release Replay owns the mapping from approved flow steps to stable scenes and recapture lineage.

## 24. Scene manifest/project representation

Release Replay owns a minimal manifest because no selected editor project format natively connects application behavior to selective scene recapture.

The manifest models only current product concepts:

| Entity | Required information |
|---|---|
| Project | Project ID, feature brief, audience, created time, current revision, output constraint |
| Environment | Application origin, allowed origins, viewport, locale, time zone, browser version, fixture/reset identifier where available |
| Flow | Flow ID, ordered step IDs, approval record, prohibited actions, expected checkpoints |
| Browser step | Stable step ID, action type, semantic target, expected state, scene boundary membership |
| Capture | Capture ID, source path, immutable content fingerprint, timing, dimensions, producing step IDs, attempt ID, success state |
| Scene | Stable scene ID, source capture ID, source in/out, sequence order, expected product state, derived duration |
| Operation | Operation ID, operation type, validated inputs, actor, timestamp, source and resulting revision |
| Overlay | Stable overlay ID, scene ID, type, bounded content, placement preset, active range |
| Render output | Output ID, revision ID, render parameters, file path, media probe result, verification result |
| Recapture lineage | Scene ID, previous capture ID, replacement capture ID, reason, changed steps/checkpoints |
| Revision | Revision ID, parent revision, ordered operation IDs, manifest fingerprint, review state |

### Identity and mutation rules

- A scene ID represents the narrative role of that scene and survives recapture.
- A capture ID represents immutable source bytes and never survives replacement.
- A flow-step ID survives reruns while the intended action remains the same.
- Replacing a capture updates the scene's source reference in a new revision.
- Unaffected scene records and operations remain byte-for-byte or semantically unchanged, excluding revision metadata.
- All times use one canonical unit selected during implementation; mixed time units are prohibited.
- Unknown fields are rejected in POC rather than stored “for later.”

This is not a universal `EditGraph`, interchange format, or abstraction over future editor engines.

## 25. Structured edit operations

The model and UI use the same validated operation boundary. Operation names are conceptual; they do not imply a plug-in framework.

| Operation | State changed | Required constraints | State |
|---|---|---|---|
| `create_scene` | Adds a scene referencing an existing capture | Valid capture; valid in/out; unique stable scene ID | POC |
| `trim_scene` | Changes source in/out | Within immutable source duration; positive resulting duration | POC |
| `reorder_scene` | Changes sequence order | Existing scene IDs; no duplicates or omissions | POC |
| `replace_capture` | Repoints one scene to a new capture and records lineage | New successful capture; compatible dimensions/time range; reason recorded | POC |
| `set_focus` | Applies a fixed focus/pan/zoom preset | Named preset; bounded coordinates; scene-local range | POC |
| `set_callout` | Adds or updates a bounded callout | Grounded text; allowed placement; safe-area and duration checks | POC |
| `set_title` | Adds or updates the fixed title treatment | Bounded text length; fixed style; valid range | POC |
| `set_speed` | Changes playback speed for a scene range | Allowed speed range; resulting duration recalculated | POC |
| `set_transition` | Selects hard cut or fixed short cross-dissolve | Allowed type and maximum duration; valid neighboring scenes | POC |
| `set_audio` | Mutes or changes simple source-audio gain | Bounded gain; no multitrack mixing semantics | MVP P0 |
| `revert_revision` | Restores a prior complete revision as a new revision | Existing reviewed revision; source assets still available | MVP P0 |

Every operation must:

- Validate before mutation.
- Address stable IDs.
- Produce the same result from the same source revision and inputs.
- Leave source media immutable.
- Record actor, input, result, and failure.
- Be reversible where the operation affects user-visible project state.
- Fail atomically without partially changing the manifest.

The model never writes the manifest directly.

## 26. Inspect → Edit → Verify → Render loop

### INSPECT

Inspect only the context required for the current decision:

- Browser state and current URL.
- Relevant DOM/accessibility summary.
- Screenshots around scene boundaries.
- Action trace and checkpoint results.
- Scene manifest and current revision.
- Source-media metadata and selected contact sheets.

### EDIT

Apply only validated structured operations. Each group of accepted operations creates a revision. Invalid inputs leave the current revision unchanged.

### VERIFY

Verification evaluates explicit invariants:

- Approved browser flow completed.
- Required application state is visible at declared checkpoints.
- Every scene references existing immutable media.
- All source and overlay ranges are valid.
- Output duration and dimensions satisfy the project constraint.
- Required title and callouts exist and remain inside defined safe areas.
- No scene contains disallowed blank-frame intervals.
- Selective recapture preserved unaffected scene references and operations.
- Render parameters are valid.

Verification does not claim that pacing is tasteful, the story is persuasive, or the video is publishable. A model may flag suspected visual problems, but human review decides creative acceptability.

### RENDER

Render only a verified revision. The render result records its revision, parameters, file identity, media probe result, and verification outcome.

### OPTIONAL RE-INSPECT

After render, inspect targeted output evidence such as first/last frames, scene boundaries, required overlay intervals, media metadata, and suspected blank frames. This is a bounded correctness check, not creative approval.

## 27. Rendering architecture

### POC and MVP decision

Use a thin project-specific rendering layer around FFmpeg. Do not fork OpenReel, OpenCut, Kdenlive, or Diffusion Studio for the POC or MVP.

### FFmpeg responsibilities

- Probe source and output media.
- Normalize required source properties when necessary.
- Trim and concatenate scene ranges.
- Apply fixed speed changes.
- Apply fixed overlays and transitions or combine pre-rendered overlay assets.
- Control simple source audio in MVP.
- Encode H.264/AAC MP4.
- Validate that the output can be probed and decoded.

### Responsibilities outside FFmpeg

- The scene manifest is canonical project state.
- The operation layer constructs a validated render description.
- The browser review surface presents an approximate interactive view.
- Final FFmpeg output is authoritative.

### Explicit exclusions

- No arbitrary model-generated filtergraph or shell command.
- No proprietary codec or rendering engine.
- No Motion Canvas in POC or MVP.
- No WebGPU requirement.
- No editor-engine abstraction until a measured requirement exceeds the fixed vocabulary.

## 28. Preview/review model

### POC

An internal review surface may be visually rough. It must show:

- Ordered scenes.
- Scene duration and source range.
- Source capture and browser-step references.
- Applied overlays and focus treatment.
- Verification results.
- Initial and selectively recaptured renders.

Editing may occur through basic controls or a validated internal form. A timeline is not required.

### MVP

Provide:

- Storyboard and ordered scene list.
- Video playback of the latest authoritative draft.
- Scene trim and reorder controls.
- Replace/recapture action.
- Text editing for title and callouts.
- Selection from fixed focus and transition presets.
- Source/trace inspection for each scene.
- Revision status and whole-revision revert.
- Clear distinction between approximate interactive preview and authoritative render.

A polished multi-track timeline, frame-accurate professional tooling, and arbitrary direct manipulation remain out.

## 29. Data/privacy model

- Browser sessions, credentials, source media, project manifests, intermediate assets, and rendered outputs remain local by default.
- Use disposable demo accounts and synthetic or non-sensitive fixtures.
- Store Playwright authentication state outside the repository and project manifest.
- Never send passwords, cookies, tokens, or raw browser storage to the model.
- Allowlist application and authentication origins.
- Warn before capturing pages likely to contain customer, financial, health, employee, or other sensitive data.
- Send a model only the selected screenshots and DOM/context required for the active task.
- Record which project artifacts were sent to a remote model provider.
- Project deletion removes generated intermediates and local model-context artifacts as well as the manifest and outputs, subject to an explicit confirmation.
- Logs redact secrets and must not contain raw authenticated storage.

Production compliance programs, SSO, organizational policy, retention administration, and audit exports are not MVP requirements.

## 30. Failure handling

| Failure | Required behavior | Recovery |
|---|---|---|
| Approved action target missing | Stop on the exact step; capture URL, screenshot, DOM summary, and trace | User supplies or approves a corrected semantic target; rerun is counted |
| Async state never reaches checkpoint | Mark the attempt failed rather than recording the wrong state | User corrects fixture, expected state, or flow; rerun is counted |
| Authentication expired | Stop without exposing credentials | User refreshes the local session and restarts the affected capture |
| Unexpected navigation or origin | Block execution | User explicitly changes the origin allowlist and re-approves |
| Consequential action not approved | Block immediately | User removes the action or explicitly approves it |
| Wrong product state captured | Reject the scene during verification | Correct flow or fixture and recapture the scene |
| Invalid edit operation | Reject atomically and preserve current revision | Correct inputs or choose an allowed operation |
| Missing/corrupt source asset | Block verification and render | Restore or recapture the referenced asset |
| Unsupported source media | Attempt only a documented normalization path | Report unsupported input if normalization fails |
| Render failure | Preserve manifest, intermediates, command inputs, and error category | Correct the failing render description or source and retry; retry remains visible |
| Preview/render mismatch | Treat final render as authoritative and flag the differing scene | Simplify the treatment or correct preview implementation |
| Blank or frozen interval | Fail explicit output verification | Recapture, trim, or replace the affected scene |
| Model timeout or invalid tool request | Preserve project and reject invalid request | Retry once visibly or continue through manual bounded controls |
| Ambiguous feature claim | Do not invent copy | User clarifies the brief or removes the claim |
| Large project exceeds bounds | Refuse expansion | Keep within documented scene and duration limits |

## 31. Performance targets

Targets are measured on the founders' declared reference machine and are not production service-level guarantees.

| Measure | POC target | MVP target |
|---|---:|---:|
| Raw browser flow duration | At most 5 minutes | At most 5 minutes |
| Final output | 25–35 seconds | 15–60 seconds, optimized for 30 |
| Scene count | 3–5 | At most 10 |
| Output format | 1920×1080, 30 fps, H.264/AAC MP4 | Same |
| Browser plan/inspection | Recorded, no fixed latency gate | Under 30 seconds after local context is ready |
| Stable-flow capture and first draft | Under 10 minutes | Under 5 minutes for a previously validated flow |
| Single-scene recapture and revised draft | Under 5 minutes | Under 3 minutes for a previously validated flow |
| Manifest operation | Functionally correct; no UI target | Visible state response under 250 ms |
| Authoritative 30-second render | Under 3 minutes | Under 90 seconds on the reference machine |
| Project open | Not applicable | Under 3 seconds for an in-scope project |
| Human correction | Median under 10 minutes | Median under 10 minutes |

Reliability outranks speed. A faster run that captures the wrong state fails.

## 32. Validation strategy

| Stage | Work | Gate to continue | Stop condition |
|---|---|---|---|
| 0. Problem research | Interview 10 target teams using recent real examples | At least 6 made or wanted a product video in the prior 30 days; at least 4 spent over 45 minutes or skipped it due to effort | Fewer than 4 experience recurring pain or most videos are one-off |
| 1. Adversarial POC | Run the complete POC against Apps A, B, and C | Every criterion in section 17 passes | Any core reliability, selective-recapture, safety, or usefulness gate fails |
| 2. Concierge validation | Produce 10 videos with founder-operated tooling and ask for payment | At least 5 outputs are published/sent and at least 3 customers pay | Praise without publication or payment |
| 3. Five-user MVP | Let five external users operate the local product | At least 4 export successfully, 3 correct without founder operation, and 2 request another video in 30 days | Most sessions require founder intervention or correction remains above 20 minutes |
| 4. Twenty-user validation | Recruit outside the founders' immediate network | At least 12 publish/send, 8 request another, and 5 pay recurring; median correction remains under 10 minutes | Repeat use below 25% or the workflow remains bespoke service work |
| 5. Production decision | Test a recurring paid offer for two billing periods | At least 5 recurring customers, positive contribution after variable costs, and a measured bottleneck that production investment will remove | One-release churn, negative contribution, or demand dominated by generic editing |

An implementation plan may be created for the POC after this PRD is approved. MVP planning waits for the POC gate.

## 33. Target-user research

Interview the narrow ICP, but investigate the full job surrounding changing product content. Adjacent jobs are research probes, not committed features.

Ask for the most recent real example of:

- Release announcement.
- Changelog video.
- Product update.
- Investor update.
- Sales demo.
- Onboarding walkthrough.
- Help-center tutorial.
- Social launch.
- Customer update.

For each example, establish:

| Question | Evidence sought |
|---|---|
| What triggered the content? | Whether demand follows frequent product changes or occasional launches |
| Who produced it and with what tools? | Actual workflow and switching surface |
| How long did capture, editing, review, and rework take? | Baseline cost by stage |
| What broke when the UI changed? | Frequency and severity of staleness |
| Was the output published, sent privately, or abandoned? | Real value rather than stated interest |
| Which parts were reused? | Whether selective recapture could matter |
| Would they trust an approved automated flow? | Adoption and safety concerns |
| Would they pay for the completed result today? | Willingness to pay |
| Did they need an editor or merely corrections? | Whether a minimal review surface is enough |

Two competing problem hypotheses must be compared:

1. **Product video creation:** teams do not create enough product video because capture and editing take too long.
2. **Product-content staleness:** teams already maintain product content, but UI changes repeatedly invalidate it.

The second remains a hypothesis. Do not broaden the product until interviews show it is more frequent, painful, and payable than release-video creation.

## 34. Success metrics

| Metric | Definition | POC gate | MVP/validation gate |
|---|---|---:|---:|
| Browser completion rate | Approved flows reaching their final action without human intervention after start | At least 5/6 measured runs | At least 90% across supported validated flows |
| Product-state correctness | Completed runs satisfying every declared checkpoint | 100% of accepted runs | At least 95%; wrong-state output is never silently accepted |
| Scene mapping completeness | Scenes with valid source, step, checkpoint, and capture references | 100% | 100% |
| Selective-recapture success | Changed scenes replaced without recapturing or changing unaffected scene sources/edits | 3/3 applications | At least 90% of eligible recapture attempts |
| First-pass render success | Renders completing correctly without retry | Reported; no minimum hides small sample | At least 90% |
| Final render success | Valid output after no more than one visible retry | 9/9 required outputs | At least 98% |
| Human correction time | Active minutes from first draft to accepted output | Median under 10; none above 20 | Median under 10 |
| External-use rate | Delivered outputs actually published or sent | At least 2/3 POC users would use | At least 60% of pilots used |
| Paid conversion | Users paying for an accepted output or recurring plan | Measured in concierge stage | At least 3/10 concierge; later 5 recurring users |
| Thirty-day repeat rate | Users requesting or creating another output in 30 days | Not a technical POC gate | At least 40% before scope expansion |
| Founder intervention rate | Sessions needing undocumented founder operation or editing | Zero during measured automated POC runs; corrections documented | Below 20% during five-user MVP |

Prompt count, total generations, watch time on internal drafts, and waitlist size are not success metrics.

## 35. Business-model hypothesis

### First test: paid completed output

Charge ₹2,500–₹7,500 for one accepted 15–60 second release video with one bounded revision. This exposes willingness to pay and the true founder-assisted cost before software packaging obscures either.

### Second test: monthly release allowance

If repeat behavior exists, test ₹7,500–₹15,000 per month for up to four in-scope release videos, with output-based overage.

### Deferred option: usage-based product

A future product may separate ordinary local editing from expensive remote model, TTS, storage, or render usage. Do not invent credits before variable costs and user behavior are measured.

The business model fails if customers pay only for founder editing taste or one-off service work that cannot be captured in the product's bounded operations.

## 36. Funding/budget gates

Possible access to ₹5–10 lakh is runway, not authorization to spend it.

| Gate | Maximum sensible cash commitment | Permitted spending | Evidence required for next gate |
|---|---:|---|---|
| Problem research | ₹10,000–₹25,000 | Interview incentives, small tool costs | Section 32 stage-0 gate |
| POC | Cumulative ₹25,000–₹75,000 | Model/API usage, disposable infrastructure, test assets, limited user incentives | Every POC pass criterion |
| Concierge and five-user MVP | Cumulative ₹1.5–₹3 lakh | Focused design help if needed, model/TTS use if promoted to MVP, hosting only where required, license/privacy review, cross-device testing | Publication, payment, repeat use, and correction-time gates |
| Production investment | More than ₹3 lakh only with approval | Packaging, supportability, security hardening, measured operational bottlenecks | At least 5 recurring customers for 2 billing periods and positive contribution after variable costs |

Unnecessary early expenses:

- Employees or agencies before founders prove the workflow.
- GPU reservations or custom model training.
- Large editor forks.
- Native mobile applications.
- Enterprise compliance programs.
- Paid acquisition before organic or direct paid validation.
- Design systems, plug-in infrastructure, or broad integrations.

Track founder time separately even when it is not treated as cash spend. A “cheap” POC that consumes persistent manual editing labor has failed economically.

## 37. Kill criteria

### Abandon the concept

- Fewer than 4 of 10 interviewed teams experience the problem at least monthly.
- Fewer than 3 of 10 concierge customers pay for an accepted result.
- Fewer than 30% of delivered pilots are published or sent.
- No meaningful repeat demand appears within 30 days.
- Existing products solve the workflow with lower switching cost.
- Product-state correctness cannot be made trustworthy without extensive manual supervision.
- Browser capture remains below the POC reliability gate across supported, approved flows.
- Founder editing taste remains the primary reason outputs are usable.

### Narrow the concept

- One application category has materially better completion, publication, payment, or repeat usage.
- Existing Playwright tests significantly outperform manually defined flows.
- Customers value selective recapture but not AI assembly or conversational correction.
- Only one content type or fixed output treatment generates repeat demand.

### Change the customer/job wedge

- Interviews show that release videos are too episodic but onboarding, sales, help-center, or customer-update content becomes stale frequently and commands payment.
- The recurring value is product-state evidence rather than video output.
- Users need maintained product-content artifacts rather than launch videos.

### Change the technical foundation

- More than 25% of accepted paid edit requests cannot be represented by the fixed operation vocabulary.
- Preview/render divergence repeatedly causes output rejection.
- Final export reliability remains below 98% after one visible retry in MVP validation.
- Proven paid demand requires long-form, complex multitrack, or effect-heavy output.
- A stable external editor engine materially reduces measured maintenance without compromising the manifest and operation boundaries.

### Reject scope pressure

If users primarily request a generic editor, do not slowly expand Release Replay into one. Either retain the narrow product or stop.

## 38. Open decisions

| Decision | Current recommendation | Alternative | Evidence required to change |
|---|---|---|---|
| Required capture input | Support existing Playwright flows and precise approved manual flows; prefer existing tests where available | Require Playwright tests exclusively | Existing tests improve completion or correction time by more than 25 percentage points and the requirement does not exclude most qualified users |
| Capture execution location | Local runner for POC and MVP | Cloud browser execution | Qualified users reject local execution, unattended operation becomes a paid requirement, and a safe credential/data design is demonstrated |
| Narration | Exclude from POC; keep optional TTS in MVP P1 | Promote one TTS voice to MVP P0 or exclude narration entirely | External-use tests show narration materially changes acceptance or users consistently provide their own voice workflow |
| MVP editor foundation | Thin project-specific review editor over the owned manifest and FFmpeg | Integrate or fork OpenReel, OpenCut, Kdenlive/MLT, or Diffusion Studio | Paid requests repeatedly exceed the fixed vocabulary and a candidate provides a stable tested boundary with acceptable license and maintenance cost |
| Selector recovery | Fail closed, preserve evidence, and require explicit target correction | Automated self-healing selectors | Measured failures are predominantly benign selector drift and self-healing can be verified against declared state checkpoints without masking wrong-state captures |
| Primary recurring job | Release/changelog video creation | Maintaining stale onboarding, help-center, sales, or customer-update content | Interviews and paid pilots show the alternative job occurs more frequently, creates greater rework, and has stronger repeat payment |

## 39. Future possibilities, explicitly non-committed

The following are not promised, scheduled, or included in POC/MVP scope:

- CI-triggered draft generation after a passing browser test.
- Automatic identification of scenes invalidated by a changed flow or UI checkpoint.
- Maintained onboarding, help-center, sales-demo, or customer-update collections.
- Direct GitHub, Linear, or changelog context import.
- Shareable review and approval links.
- Multiple aspect ratios, durations, languages, and branded variants.
- Optional narration, captions, music, or localization.
- An open-source Playwright video reporter as a distribution channel.
- Cloud capture for unattended workflows.
- Integration with an external editor engine if paid requirements exceed the fixed vocabulary.
- Aggregate learning from accepted corrections, subject to explicit privacy consent.

None should be designed into the POC through generic abstractions. Add one only when a completed validation stage produces evidence for it.

## PRD Change Summary

### Major sections changed

- Renamed the document to **Release Replay — Test-Backed Release Video Compiler PRD** and marked the name temporary.
- Reorganized the document into the required 39-section product specification.
- Separated POC, MVP, and Production into evidence-gated states.
- Replaced the generic creative-agent architecture with a local approved-flow capture, scene-manifest, structured-operation, verification, and FFmpeg-render architecture.
- Added adversarial application classes, explicit capture reliability behavior, scene-manifest rules, structured operations, verification invariants, and stage-specific performance targets.
- Reframed provenance from customer messaging into the mechanism enabling selective scene updates.

### Decisions preserved

- No general AI video editor.
- Narrow 2–20 person B2B SaaS/developer-tool ICP.
- Approved browser flow plus feature brief as primary input.
- Local-first handling of authentication, media, and projects.
- Minimal owned scene manifest rather than a universal edit graph.
- Stable IDs, immutable source media, deterministic operations, revisions, and editable output.
- Playwright for browser execution and FFmpeg for authoritative export.
- One capable reasoning model rather than multi-agent orchestration or provider abstraction.
- No OpenReel, OpenCut, Kdenlive, Motion Canvas, or Diffusion Studio fork for POC/MVP.
- Strict staged validation, budget discipline, and kill criteria.

### Decisions narrowed

- The first output is one approximately 30-second 16:9 1080p MP4.
- Browser support is Chromium only.
- Capture follows an explicit approved flow; autonomous exploration is out.
- Motion is limited to one fixed title, callout, focus, cut, speed, and short transition vocabulary.
- POC review may be an ugly internal scene/manifest interface rather than a timeline.
- Automated verification is limited to explicit correctness invariants; human review owns creative acceptance.

### Requirements removed from P0

- TTS and generated narration.
- Conversational editing UI.
- Polished timeline and sophisticated interactive preview.
- Full undo/redo UX; POC keeps inspectable revisions.
- Multiple output formats, aspect ratios, and durations.
- Brand systems and saved templates.
- User accounts, billing, collaboration, and cloud rendering.
- Captions, music selection, direct GitHub/Linear integration, and CI triggers.
- Motion Canvas, general NLE functions, arbitrary footage editing, and broad motion graphics.

### Requirements added

- POC-specific requirement table with justification and pass condition for every item.
- Three adversarial web-application classes and two measured runs per application.
- Explicit expected product-state checkpoints distinct from action completion.
- Stable browser-step, capture, scene, operation, output, and revision identities.
- Selective recapture as a POC gate rather than a later feature.
- Preservation of unaffected scene sources and edits during replacement.
- Visible attempt, retry, recovery, and intervention accounting.
- Explicit verification invariants and targeted post-render inspection.
- Stage-specific capital gates and founder-time accounting.
- Interview research across adjacent product-video jobs without adding those jobs to scope.

### Unresolved questions

- Whether existing Playwright coverage should eventually be mandatory.
- Whether qualified users accept a local runner or require cloud execution.
- Whether narration materially affects publication and willingness to pay.
- Whether selector self-healing can improve reliability without concealing incorrect state.
- Whether the recurring paid job is release-video creation or maintaining product content that becomes stale after UI changes.
- Whether a thin editor remains sufficient after paid usage.

### Contradictions resolved from the previous PRD

- The previous document called itself an AI-native video editor while rejecting the generic editor market. The new definition is a release-video compiler.
- The previous document blended a technical spike with an externally usable MVP. They now have separate gates and requirements.
- Selective affected-scene regeneration appeared as P1 even though it was the claimed differentiation. It is now mandatory in the POC.
- TTS, conversational revision, full undo/redo, and an editor-like preview were P0 despite not being necessary to test the core hypothesis. They have been deferred.
- The earlier architecture sketch prescribed OpenCut and Motion Canvas, conflicting with the later build-vs-fork decision. Both are now explicitly excluded from POC/MVP.
- Earlier reliability thresholds mixed 70%, 80%, and 5-of-6 criteria. The POC now uses one explicit small-sample gate and requires raw attempt reporting.
- Earlier visual review language risked implying that sampled frames could judge overall quality. Verification is now limited to explicit invariants, with human creative review retained.
