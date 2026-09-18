# Replex documentation index

This index separates shipped behavior from historical plans and proposed Replex V2 work. Documentation never proves implementation.

| Status | Document | Purpose |
|---|---|---|
| Current implementation | [`poc/task.md`](poc/task.md) | Latest POC evidence and formal gate status |
| Historical | [`PRD.md`](PRD.md) | Original Release Replay product thesis and POC gates |
| Historical | [`poc/technical_poc.md`](poc/technical_poc.md) | Implemented V1/POC architecture |
| Historical | [`poc/implementation-plan.md`](poc/implementation-plan.md) | Original POC implementation plan |
| Historical | [`Architrure.md`](Architrure.md) | Early architecture sketch |
| Historical research | [`DIFFUSION_STUDIO_TAKEAWAYS.md`](DIFFUSION_STUDIO_TAKEAWAYS.md) | Research that informed the original compiler model |
| Conditional legacy plan | [`production/prod_stack.md`](production/prod_stack.md) | Pre-V2 production direction; not authorized or current architecture |
| Conditional legacy plan | [`production/implementation-plan.md`](production/implementation-plan.md) | Pre-V2 production plan; superseded for sequencing |
| Proposed V2 | [`architecture/REPLEX_V2.md`](architecture/REPLEX_V2.md) | Normative approved architecture; not yet implemented |
| Proposed V2 | [`REPLEX_V2_PRD.md`](REPLEX_V2_PRD.md) | Product definition, POC scope, and evidence gates |
| Proposed V2 decisions | [`architecture/ADR-001-media-composition-core.md`](architecture/ADR-001-media-composition-core.md) | Media composition is canonical |
| Proposed V2 decisions | [`architecture/ADR-002-media-backends.md`](architecture/ADR-002-media-backends.md) | Replaceable execution backends |
| Proposed V2 decisions | [`architecture/ADR-003-local-cloud-execution.md`](architecture/ADR-003-local-cloud-execution.md) | One protocol, local and cloud executors |
| Proposed V2 decisions | [`architecture/ADR-004-ffmpeg-skill.md`](architecture/ADR-004-ffmpeg-skill.md) | ffmpeg-skill adoption boundary |
| Implementation plan | [`v2/implementation-plan.md`](v2/implementation-plan.md) | Dependency-ordered work for future coding agents |
| Roadmap | [`v2/roadmap.md`](v2/roadmap.md) | Budget-aware phases and gates |
| Frontend handoff | [`v2/frontend-handoff.md`](v2/frontend-handoff.md) | Gurbaaz's UX and contract handoff |

## Status vocabulary

- **Implemented:** present in source and covered by repository checks.
- **Technically evidenced:** retained execution evidence exists; this does not imply product usefulness.
- **Architecture-approved:** the intended V2 contract documented here; implementation has not started.
- **Planned:** ordered future work with an acceptance gate.
- **Experimental:** a candidate that requires a spike or legal/technical evaluation.
