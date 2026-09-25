# ADR-007: Freeze service contract v1 and keep local discovery in the host

- **Status:** Accepted for the V2 POC
- **Date:** 25 September 2026

## Context

The transport-independent service contract is consumed by frontend mocks while the canonical V2 project model and reducer continue to evolve. Aliasing live domain schemas lets internal changes silently alter a contract marked `v1`. Local project opening also needs an identity source, but the POC has no database or executor service yet.

## Decision

- Define wire v1 views and the user-facing semantic-operation snapshot explicitly in `src/service-contract/index.ts`. Do not import live ProjectV2 view schemas or the live reducer union there.
- Keep the canonical V2 model and reducer as the only project state and mutation authority. The contract schemas are wire projections; import and recapture use their dedicated service commands, and accepted edits are translated to canonical reducer operations.
- Treat the existing service fixtures as the v1 compatibility examples. A new public field or operation shape requires an intentional contract version evolution.
- Keep project discovery in the local host shell. It lists authorized project roots, validates the selected manifest, and supplies `projectId` plus `revisionId` to `open_project`. `create_project` returns the new project ID. Contract v1 adds no project-list API, database, filesystem path, or local token field.

## Consequences

The frontend can mock against stable v1 types without receiving canonical storage fields by accident. A future local executor must project canonical state into these wire views and apply typed edits through the canonical reducer. Host-owned project selection remains local-first and does not create cloud account semantics.

## Rejected alternatives

- Reuse mutable ProjectV2 and operation schemas as the public v1 contract.
- Add project discovery backed by a database or expose local paths/tokens in service responses.
