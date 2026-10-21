# ADR-012: Guard local demo capture egress

Status: approved by owner on 20 October 2026; implemented for the V2 local executor.

## Context

Invite-only demo preparation requires blocking capture access to private/internal addresses. The approved-origin checks in the historical capture runner do not pin Chromium connections to a validated address. Independent browser DNS resolution would leave a rebinding gap. Bundled demo fixtures intentionally use loopback.

## Decision

V2 capture and recapture create a short-lived authenticated loopback proxy. Its destination policy requires the existing approved origins and public-unicast numeric addresses. It rejects nonpublic IPv4/IPv6, mapped/transition IPv6, URL credentials, internal names, mixed public/private DNS answers, and unsupported schemes. Each upstream connection uses the address returned by validation, preserving the original HTTP Host or browser TLS name. Reset POSTs use the same pinned destination policy and refuse redirects.

Chromium uses that proxy for HTTP(S), CONNECT, and WebSockets. Loopback proxy bypass, QUIC, nonproxied WebRTC UDP, and service workers are disabled in this mode. Chromium may use CONNECT for plain WebSockets, so tunnel authorization checks the exact destination against either approved HTTP or HTTPS origin; it never authorizes a different host, port, or address. This is a bounded browser network policy, not an OS sandbox or a browser-exploit containment claim.

Trusted in-process fixture code can issue an opaque capability for an HTTP server already listening on loopback. The capability authorizes only that exact live server and port. It expires when the server stops, loses authority when serialized, and cannot be supplied through browser config, persisted state, service requests, or model tools. There is no general private-network bypass flag.

The guard caps gateway requests/reset calls at 1,000, total sockets at 64, transferred bytes at 512 MiB, socket inactivity at 15 seconds, and lifetime at 120 seconds. Cancellation closes all tracked sockets. Denied capture traffic invalidates the run before canonical media is published. HTTP CONNECT remains an opaque byte tunnel to its validated numeric endpoint; encrypted inner requests are bounded by bytes, socket count, inactivity, and lifetime rather than independently counted.

## Boundaries retained

- Frozen service-contract v1 is unchanged; this is host-owned execution policy.
- Existing approved flows, action/checkpoint checks, revision CAS, immutable assets, and selective-recapture preservation remain authoritative.
- Historical V1 CLI callers retain their existing origin-only behavior and are not supported invite-demo entry points.
- Ordinary V2 targets cannot capture private LAN or internal staging apps under this policy, even when their origins are configured. Any broader private-target workflow requires a separate decision.
- No public binding, hosting, paid service activation, or production authorization follows from this decision. Gate D remains deferred, not waived.

## Evidence

`tests/capture-network-policy.test.ts` covers public/private address classification, encoded IPs, mixed DNS, rebinding, and fixture capability scope. `tests/capture-network.test.ts` exercises authenticated forwarding, pinned CONNECT, reset redirects, cancellation, and bundled Chromium HTTP/WebSockets/private subresources. V2 executor tests prove prohibited captures publish no revision and guarded capture/recapture still reaches a verified final export.

The [approved proposal](../v2/demo-capture-network-proposal.md) records the requested boundary. Implementation and validation results are tracked in the [roadmap](../v2/roadmap.md). [Playwright's proxy documentation](https://playwright.dev/docs/network#http-proxy) describes the underlying browser proxy configuration; Replex owns destination validation and connection pinning.
