# Replex V2 product requirements

**Status:** Architecture-approved POC definition; features are not implemented

**Normative architecture:** [`architecture/REPLEX_V2.md`](architecture/REPLEX_V2.md)

## Product definition

Replex turns product flows, uploaded footage, or both into an editable video composition controlled through conversation and bounded manual corrections. It understands selected evidence, converts intent into typed semantic operations, preserves revision history, renders deterministically, and retains reproducible browser provenance when the source came from a product.

It is differentiated from a generic AI video editor by understanding both media and the software behavior that produced browser-derived footage.

## Primary POC user and job

A technical founder or small product team needs a credible launch, release, or product video without repeatedly recapturing and rebuilding it. They can start from an approved browser flow, existing footage, or a mixture, then ask for a concise edit and refine the same project through follow-up prompts.

## POC hypotheses

Within an approximate, non-mandatory ceiling of ₹100,000, prove the smallest coherent loop:

1. Existing browser capture still produces provenance-rich immutable assets.
2. Arbitrary video imports as an immutable, probed asset.
3. Bounded evidence lets an agent understand enough footage to propose a useful edit.
4. All accepted edits are Replex semantic operations applied by one reducer.
5. A media backend renders deterministically and verification gates the output.
6. Follow-up prompts revise the same canonical project rather than starting over.
7. At least one reusable programmable motion treatment produces a visibly polished result.
8. The full workflow runs locally.
9. Cloud rendering is demonstrated only if the local proof is complete and budget remains.
10. The schema and tests allow browser and uploaded assets in one composition; the POC need not ship every mixed-media UX.

## Required user journey

```text
create/open project
  -> capture product flow and/or import media
  -> inspect asset evidence
  -> request an edit
  -> review plan and resulting revision
  -> preview
  -> follow-up prompt or bounded manual correction
  -> verify
  -> render/export
```

## POC acceptance gates

### Engineering evidence

- V1 golden project loads and migrates without losing browser identity, lineage, edits, or outputs.
- One uploaded video completes import, hash, probe, analysis, inspection, agent edit, revision, verification, and render.
- A second prompt changes the same project through attributable operations.
- Invalid, stale, ambiguous, or unsupported operations are rejected without partial mutation.
- A render can be reproduced from its project revision, RenderJob, backend/version record, and immutable assets.
- At least one browser selective recapture replaces the intended asset while preserving unrelated V2 edits.
- At least one motion preset is agent-directed, parameter-bounded, reusable, and verified.
- Local execution completes without cloud infrastructure.

### Human/product evidence

- Reviewers can identify the intended story and accept or correct it using prompts/bounded controls.
- Correction time is recorded rather than inferred.
- Usefulness and willingness-to-publish/send are recorded separately from technical validity.
- Spend, render time, agent cost, and manual intervention are measured per run.

Passing engineering checks alone does not authorize production. A gate report must state `productionAuthorized: false` until a separate explicit decision.

## Scope control

The POC uses one project workspace, one primary composition, a small semantic operation set, selected evidence rather than full-video context, local files, existing browser capture, one media adapter candidate, and one motion backend candidate. Spend follows evidence needs; ₹100,000 is a ceiling, not a target.

Explicitly deferred: professional NLE breadth, After Effects parity, large effect libraries, plugins, collaboration, billing, team/accounts, authenticated cloud browser capture, arbitrary generative-video models, multi-agent systems, production autoscaling, and unrestricted user/backend code.

## Product states

| State | Meaning |
|---|---|
| Implemented V1 | Current browser-first POC code and retained evidence |
| Architecture-approved V2 | Contracts and decisions in the V2 docs |
| Experimental | ffmpeg-skill adapter, Remotion/motion backend, and cloud render spikes until gated |
| Planned | Dependency-ordered work in [`v2/implementation-plan.md`](v2/implementation-plan.md) |
| Production | Not authorized |
