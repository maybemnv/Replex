# Replex V2 roadmap

**Status (9 October 2026):** Gates A-C have bounded technical evidence. Phase 4 selected native evidence (NO-GO for an ffmpeg-skill runtime adapter), Phase 5 technical validation passed, and the bounded `camera-push.v1` motion treatment is implemented. V2-702 adds local immutable video/image/audio import jobs. V2-901 adds a deterministic mixed-project selective-recapture core proof with machine-readable preservation evidence. V2-703 wires evidence-grounded agent edits and verified preview/final renders through the local executor, HTTP service, and command CLI. V2-704 adds browser capture, selective recapture, and revision verification as local executor jobs, and makes long-running jobs cancellable until they commit. An HTTP-only test captures an approved flow, composes it with an upload, recaptures one scene, verifies, and exports a gated final render. This is bounded technical evidence for Gate E. Gate D remains open and is deferred by owner decision (6 October 2026): the supplied reviews are synthetic (0/3 independent human reviews) and correction times are unmeasured. The agent workflow is proven with a deterministic scripted model only; no live-model quality is claimed. The formal POC result is not established; production is not authorized.

**Funding constraint:** approximately ₹100,000 maximum for the POC, not a spending target

## Invite-only local demo preparation (20 October 2026)

The V2 local POC is technically complete through Gate E. Gate D is **deferred, not waived**: independent human review and correction-time evidence remain required. Demo preparation does not authorize production or establish live-model quality.

Work proceeds in small PRs, each with tests and a status note here:

1. **Live-agent controls:** extend the existing OpenAI adapter behind the existing agent-edit job envelope; enforce durable per-job cost reservations and a workspace request rate limit. Tests retain scripted models and mocked providers.
2. **Local API access:** harden existing bearer-token protection, loopback binding, Host/origin checks, and token lifecycle.
3. **Project discovery/recovery:** add host-side project listing and strengthen existing file-backed project/job restart behavior. No project-list service endpoint or database.
4. **Resource/capture safeguards:** enforce import limits, bound abandoned-job staging cleanup, and block private/internal capture destinations. Resolve the host-owned local-fixture exception before changing approved capture policy.
5. **Local demo command:** add prerequisite checks, deterministic fixtures, persistent workspace, orderly shutdown, and short README instructions. Scripted mode is the default; live mode requires explicit configuration.

No deployment, paid service activation, public exposure, or committed provider keys. Hosting is decided later. The production documents inform recovery, privacy, and cost controls; their dormant production backlog is not activated. Any architecture or frozen service-contract change requires owner approval before implementation.

**PR 1 — implemented on `demo/01-agent-budgets`:** Live requests count complete provider input (including images/tools/linked history), reserve input plus maximum output cost before generation, and persist reservations across retry/restart. SDK retries are disabled. Failed or ambiguous attempts retain their reservation. Host-supplied uncached input/output rates are required; no model price is hard-coded. A workspace sliding-window limit counts both input-count and generation requests. Internal budget failures use the existing `AGENT_BUDGET_EXCEEDED` job error; public schemas are unchanged. Validation: TypeScript and diff checks pass; 53 focused tests pass (including adapter/ledger, core agent, contract, CLI, and job-envelope checks). Two existing preview-render tests fail identically on unchanged `main` with system FFmpeg 6.1; they require the documented FFmpeg 9 toolchain. No live provider calls have been made.

**PR 2 — implemented on `demo/02-local-auth`:** Retains per-start random bearer-token access and loopback binding. Rejects duplicate authorization/Host/origin headers and noncanonical or wrong-port Host values; unauthorized requests receive a Bearer challenge. Tests cover all 15 route categories before payload parsing/side effects, token rotation and nonpersistence, malformed headers, origin rejection, and normal CLI/HTTP behavior. Validation: 30 focused tests pass; TypeScript/diff checks pass. No account system, remote binding, or public contract change.

The roadmap optimizes evidence per rupee. Stop at any failed gate and preserve the evidence; do not fund later phases to hide an earlier failure.

| Order | Phase | Evidence sought | Exit gate | Budget stance |
|---:|---|---|---|---|
| 0 | V1 freeze and migration spec | Old projects remain recoverable | Frozen parser, golden mapping, backup verified | Near-zero; documentation/tests |
| 1 | Schema V2, reducer, and early service contract | One source-agnostic canonical model, mutation path, and frontend-ready domain contract | V1 adapts; V2 replay/atomicity and strict contract fixtures pass | Core engineering priority |
| 1.5 | ffmpeg-skill capability/contract spike | External mechanical capabilities are understood before duplication | Pinned-version GO/NO-GO/PARTIAL-GO report with measured gaps and overhead | Cheap research gate; no production dependency |
| 2 | Local ingestion/analysis/render baseline | Arbitrary media works locally using the spike's ownership map and native fallback where needed | One imported video reaches verified render | Core engineering priority |
| 3 | Agent inspection/edit loop | Model can ground and revise the same project | Initial and follow-up edits replay | Spend on bounded model calls only |
| 4 | Chosen media evidence adapter | Approved read-only measurements reduce evidence work safely | Native path already covers the useful Phase 2 subset; no measurable advantage was established | **NO-GO for this POC; keep the native provider** |
| 5 | Rich 2D composition | Output is useful, not merely valid | Multi-asset/audio/caption demo passes | Limit breadth to demo needs |
| 6 | Motion backend | One or two impressive reusable treatments | Human-reviewed preset demo plus legal gate | V2-602 implements one bounded `camera-push.v1` candidate through a separate motion job and V3 composition job; direct trusted FFmpeg/FFprobe only, wrappers unsupported. Technical sample exists; Gate D is still open pending independent human quality review. Defer `title-reveal`; see [`motion-spike-report.md`](motion-spike-report.md) |
| 7 | Local executor and transport | Early domain contracts become a usable asynchronous local workflow | V2-701 project/operation jobs, V2-702 asset-import jobs, V2-703 agent-edit and preview/final render jobs, and V2-704 browser capture, recapture, and verify jobs with running-job cancellation are implemented. HTTP-only integration tests drive import, two same-thread agent edits, and a gated final render; and capture, composition, recapture, verification, and a gated final render. `submit_job_input` is not implemented because no local job requests input | Continue only as bounded POC work; no multi-process or production claim |
| 8 | Cloud render spike | Same semantics can execute remotely | Measured cost/isolation/result parity | Optional; only with remaining budget |
| 9 | Mixed-media recapture | Differentiation survives V2 | Unrelated upload/edit state preserved | Core proof adapts an approved browser scene into an immutable asset and verifies preservation; V2-704 exercises capture and replacement in the local executor workflow over HTTP. Bounded technical evidence for Gate E |
| 10 | Formal evaluation | Technical and human value | PASS/FAIL/REWORK with spend and evidence | No production work before decision |

## Recommended POC cut line

The minimum credible POC is Phases 0-3, including the Phase 1.5 capability gate, the useful subset of Phase 5, one motion preset from Phase 6, the local path in Phase 7, and the mixed-media preservation proof in Phase 9. Phase 4 selected the existing native evidence provider; no external adapter is planned for this POC. Phase 8 is optional and must not displace local workflow, follow-up editing, motion quality, or human evaluation.

## Decision gates

- **Gate A, model and contract:** V1 migration and V2 reducer preserve identity, replay, and atomicity; service-contract v1 has explicit frozen public views and operation shapes.
- **Gate B, media:** Imported footage produces bounded evidence and a verified deterministic render.
- **Gate C, agent:** PASS on the deterministic fixture: initial and follow-up prompts create grounded, attributable operations on one project with replayable revisions and verified previews. This does not establish live-provider quality or human usefulness.
- **Gate D, quality:** Independent human reviewers judge the edit and selected motion treatment useful; correction time is measured. Current synthetic internal reviews are excluded and do not satisfy this gate.
- **Gate E, differentiation:** Selective browser recapture inside a mixed project preserves unrelated media and edits.
- **Gate F, optional cloud:** Only after A-E, a capped media-only cloud render demonstrates protocol portability.
- **Gate G, production:** A separate human decision after complete technical, usefulness, cost, and risk evidence.

## Deferred until after the POC

Full NLE behavior, After Effects parity, a broad effect library, plugins, collaboration, billing, teams/accounts, cloud browser credentials, arbitrary generated video, multi-agent orchestration, production scaling, and generalized 3D authoring remain out of scope.
