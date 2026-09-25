# Replex V2 roadmap

**Status:** PR-A / Gate A passed and merged at `a8feca9`. PR-B Phase 2 met Gate B on candidate head `fa9f42d` after independent review and final serial validation. Phase 3 has not started.

**Funding constraint:** approximately ₹100,000 maximum for the POC, not a spending target

The roadmap optimizes evidence per rupee. Stop at any failed gate and preserve the evidence; do not fund later phases to hide an earlier failure.

| Order | Phase | Evidence sought | Exit gate | Budget stance |
|---:|---|---|---|---|
| 0 | V1 freeze and migration spec | Old projects remain recoverable | Frozen parser, golden mapping, backup verified | Near-zero; documentation/tests |
| 1 | Schema V2, reducer, and early service contract | One source-agnostic canonical model, mutation path, and frontend-ready domain contract | V1 adapts; V2 replay/atomicity and strict contract fixtures pass | Core engineering priority |
| 1.5 | ffmpeg-skill capability/contract spike | External mechanical capabilities are understood before duplication | Pinned-version GO/NO-GO/PARTIAL-GO report with measured gaps and overhead | Cheap research gate; no production dependency |
| 2 | Local ingestion/analysis/render baseline | Arbitrary media works locally using the spike's ownership map and native fallback where needed | One imported video reaches verified render | Core engineering priority |
| 3 | Agent inspection/edit loop | Model can ground and revise the same project | Initial and follow-up edits replay | Spend on bounded model calls only |
| 4 | Chosen media evidence adapter | Approved read-only measurements reduce evidence work safely | Phase 2 advantage plus pinned capability and native-parity/failure tests; mutation requires another review | Adopt only if measurably better than native |
| 5 | Rich 2D composition | Output is useful, not merely valid | Multi-asset/audio/caption demo passes | Limit breadth to demo needs |
| 6 | Motion backend | One or two impressive reusable treatments | Human-reviewed preset demo plus legal gate | Prioritize one strong effect |
| 7 | Local executor and transport | Early domain contracts become a usable asynchronous local workflow | Same hashes through CLI/service; cancellation works | Implement after frontend can already mock |
| 8 | Cloud render spike | Same semantics can execute remotely | Measured cost/isolation/result parity | Optional; only with remaining budget |
| 9 | Mixed-media recapture | Differentiation survives V2 | Unrelated upload/edit state preserved | Required architectural proof |
| 10 | Formal evaluation | Technical and human value | PASS/FAIL/REWORK with spend and evidence | No production work before decision |

## Recommended POC cut line

The minimum credible POC is Phases 0-3, including the Phase 1.5 capability gate, the useful subset of Phase 5, one motion preset from Phase 6, the local path in Phase 7, and the mixed-media preservation proof in Phase 9. Phase 4 is implemented only after a cheap contract spike. Phase 8 is optional and must not displace local workflow, follow-up editing, motion quality, or human evaluation.

## Decision gates

- **Gate A, model and contract:** V1 migration and V2 reducer preserve identity, replay, and atomicity; service-contract v1 has explicit frozen public views and operation shapes.
- **Gate B, media:** Imported footage produces bounded evidence and a verified deterministic render.
- **Gate C, agent:** Initial and follow-up prompts create grounded operations on one project.
- **Gate D, quality:** Human reviewers judge the edit and selected motion treatment useful; correction time is measured.
- **Gate E, differentiation:** Selective browser recapture inside a mixed project preserves unrelated media and edits.
- **Gate F, optional cloud:** Only after A-E, a capped media-only cloud render demonstrates protocol portability.
- **Gate G, production:** A separate human decision after complete technical, usefulness, cost, and risk evidence.

## Deferred until after the POC

Full NLE behavior, After Effects parity, a broad effect library, plugins, collaboration, billing, teams/accounts, cloud browser credentials, arbitrary generated video, multi-agent orchestration, production scaling, and generalized 3D authoring remain out of scope.
