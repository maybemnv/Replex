# ADR-008: Keep the native V2 media-evidence provider for the POC

- **Status:** Accepted
- **Date:** 25 September 2026

## Context

V2-150 evaluated pinned `ffmpeg-skill` v1.26.0 and returned `PARTIAL-GO` for a bounded read-only subset: probe, contact sheets, scenes, silence, loudness measurement, and delivery checks. That result authorized a future comparison, not a runtime dependency.

Phase 2 now has a native Replex provider in `src/media-evidence.ts`. It writes a source-hash-bound evidence index containing a technical probe, up to four selected frames, a contact sheet, scene boundaries, and bounded audio measurements (peaks, mean, silence, and loudness). The provider uses authorized asset handles and Replex-owned evidence storage; evidence remains regenerable and outside semantic revision hashing.

The ffmpeg-skill spike used one two-second synthetic clip. It did not establish a visual-quality, parity, or throughput advantage over the integrated native path. Its local measurements included roughly 0.8 seconds for a wrapper-inclusive invocation, and its Windows doctor probe found that `drawtext` crashed despite being advertised. The spike also documented command-bearing failure payloads, arbitrary tool paths, incomplete process-tree cancellation, and no project-root containment.

## Decision

Do not add a runtime ffmpeg-skill evidence adapter to the Replex V2 POC. Continue with the existing native provider. Reopen this decision only if a representative fixture shows a measurable evidence-quality, reliability, or cost advantage that the native provider cannot meet.

V2-150 remains `PARTIAL-GO` as historical capability research. It does not authorize MCP model access, raw argv, candidate plans, mutating tools, or a production dependency.

## Consequences

- Phase 4 is closed for this POC with **NO-GO for adapter adoption**.
- Replex continues to own evidence schemas, bounds, handles, storage, sanitization, and interpretation.
- `check`-style delivery rules remain Replex verification policy; an external `ok` result cannot establish Replex acceptance.
- No ffmpeg-skill installation, adapter, capability handshake, or fallback path is added.
- The candidate may be reevaluated after a future representative comparison, with a new decision and parity tests.
