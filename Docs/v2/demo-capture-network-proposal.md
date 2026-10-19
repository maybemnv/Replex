# Proposed local demo capture network policy

Status: **owner approval required before implementation**. This proposal changes the browser network execution boundary; it does not change the frozen service contract. It is not an implemented protection or an approved ADR.

## Existing behavior and gap

`src/capture.ts` routes browser HTTP requests and WebSockets against host-approved origins. Chromium resolves and connects after that check. `src/service/local.ts` separately performs reset POSTs with redirects disabled. An approved hostname can resolve to a private/internal address, including after a DNS change. Checking a hostname before allowing Chromium to resolve it independently leaves a race. Existing fixture apps intentionally run on loopback.

## Proposed boundary

Add a short-lived, host-owned network guard for each capture/recapture:

- Bind its forwarding proxy only to an ephemeral loopback port and close it with the capture job. It is not part of the executor's public HTTP API and must reject clients without a per-capture secret.
- Require the existing approved origin allowlist for every destination. Accept HTTP(S) and their WebSocket equivalents only. Reject URL credentials and malformed/ambiguous hosts.
- Resolve destinations inside the guard, reject non-public IPv4/IPv6 answers (including mapped addresses, loopback, unspecified, link-local/metadata, private, multicast, reserved, and carrier-grade NAT ranges), and connect to the validated numeric address. Preserve the original Host/TLS name. Fail closed on resolution failures or mixed public/private answers.
- Send browser navigation, redirects, subresources, HTTP CONNECT, and WebSocket traffic through the same guard. Disable Chromium proxy bypass, QUIC, non-proxied WebRTC UDP, and service workers for this bounded capture mode. Verify these controls against bundled Chromium rather than assuming route interception covers every network channel.
- Route reset POSTs through the same destination policy; retain redirect rejection. Never put proxy credentials in canonical state, model evidence, or logs.
- Preserve cancellation, fresh browser contexts, approved actions, immutable captures, selective-recapture checks, and existing job/error envelopes. Do not allow a failed or blocked capture to publish a revision.

## Narrow fixture exception requiring approval

Ordinary user capture targets remain subject to the public-address rule, even when their origins appear in a host browser config. Permit only the local demo launcher to register the exact origin of a bundled fixture it started, scoped to that capture and port. The exception permits loopback only; it does not permit private LAN, metadata, link-local, wildcard origins, redirects to other loopback ports, or a general "allow private networks" flag. It is not a service request field, persisted project field, or model tool.

This preserves the local capture demonstration while keeping ordinary targets blocked from internal addresses. The owner must approve both the new network guard and this exception before implementation.

## Acceptance tests

Cover numeric/encoded IPv4, IPv6 and mapped IPv4, internal hostname resolution, mixed DNS answers, DNS changes between requests, numeric socket pinning, HTTP redirects/subresources/CONNECT/WebSockets, reset URLs, malformed targets, proxy authentication/bypass, exact fixture port scoping, cancellation/process cleanup, and no canonical revision on failure. Run fixture capture and mixed-media recapture/export regression tests with the documented Chromium and FFmpeg toolchain. Use local servers and injected DNS; tests must not contact a live provider or arbitrary internet targets.

## Unchanged scope

No deployment, remote binding of the executor, paid service, account system, database, provider-key distribution, or hosting decision. Gate D remains deferred, not waived. PR 4 also covers import/resource bounds and abandoned staging cleanup; PR 5 adds the local launcher and README instructions after the capture policy decision.
