# ADR-003: One service protocol, separate local and cloud executors

- **Status:** Accepted for V2; cloud implementation deferred
- **Date:** 19 September 2026

## Context

Replex must support local-first use and future hosted execution. Identical infrastructure is neither practical nor required, but divergent APIs or project semantics would create two products.

## Decision

Define one Replex service/job protocol and canonical job envelope. Local and cloud executors implement that protocol and advertise capabilities. The frontend selects a supported target but does not branch on backend internals. Jobs share revision hashes, idempotency, progress events, cancellation semantics, results, and verification contracts.

The POC keeps browser capture, uploaded-media analysis, editing, and rendering local. A later bounded cloud-render spike may accept uploaded media. Authenticated cloud browser capture is deferred.

## Consequences

- Local use does not require cloud accounts or uploads.
- Cloud workers may use queues/object storage while preserving project semantics.
- The service layer must resolve local paths versus object references behind the same asset contract.
- Capability mismatch fails before a job starts.
- Cloud browser capture needs a separate security ADR before implementation.

## Rejected alternatives

- A cloud-only canonical project.
- Frontend-specific local and hosted APIs.
- Pretending local processes and isolated cloud workers are identical infrastructure.
