import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Server } from "node:http";

const deniedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) deniedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  deniedV6.addSubnet(address, prefix, "ipv6");
}

/** Conservative public-unicast policy. Mapped, translated, and transition IPv6 are deliberately refused. */
export function isPublicCaptureAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, "ipv4");
  return family === 6 && !address.includes("%") && globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
}

export class CaptureNetworkError extends Error {
  constructor() { super("capture destination is unavailable or prohibited by network policy"); this.name = "CaptureNetworkError"; }
}

declare const fixtureBrand: unique symbol;
export interface FixtureNetworkGrant { readonly [fixtureBrand]: true }
const fixtureGrants = new WeakMap<FixtureNetworkGrant, { server: Server; origin: string }>();

/** Trusted fixture launcher/test harness only. Never accepted from config, requests, disk, or model tools. */
export function issueFixtureNetworkGrant(server: Server): FixtureNetworkGrant {
  const address = server.address();
  if (!address || typeof address === "string" || !["127.0.0.1", "::1"].includes(address.address)) throw new CaptureNetworkError();
  const host = address.family === "IPv6" ? "[::1]" : "127.0.0.1";
  const grant = Object.freeze({}) as FixtureNetworkGrant;
  fixtureGrants.set(grant, { server, origin: `http://${host}:${address.port}` });
  return grant;
}

export type CaptureLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export interface CaptureDestination {
  url: URL;
  address: string;
  family: 4 | 6;
  port: number;
}

export class CaptureDestinationPolicy {
  private readonly origins: Set<string>;
  constructor(allowedOrigins: readonly string[], private readonly grants: readonly FixtureNetworkGrant[] = [],
    private readonly resolveHost: CaptureLookup = (host) => lookup(host, { all: true, verbatim: true })) {
    this.origins = new Set(allowedOrigins.map((value) => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new CaptureNetworkError();
      return url.origin;
    }));
    if (!this.origins.size) throw new CaptureNetworkError();
  }

  async destination(value: string, signal: AbortSignal): Promise<CaptureDestination> {
    signal.throwIfAborted();
    let url: URL;
    try { url = new URL(value); } catch { throw new CaptureNetworkError(); }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new CaptureNetworkError();
    url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    if (!this.origins.has(url.origin)) throw new CaptureNetworkError();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (port < 1 || port > 65535) throw new CaptureNetworkError();
    const fixture = this.grants.some((grant) => {
      const entry = fixtureGrants.get(grant);
      const current = entry?.server.address();
      return entry?.origin === url.origin && current && typeof current !== "string"
        && current.port === port && current.address === hostname;
    });
    if (fixture) return { url, address: hostname, family: isIP(hostname) as 4 | 6, port };
    if (!isIP(hostname) && (!hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|onion)\.?$/i.test(hostname))) throw new CaptureNetworkError();

    const timeout = AbortSignal.timeout(5_000);
    const combined = AbortSignal.any([signal, timeout]);
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise((resolve, reject) => {
        const aborted = () => reject(new CaptureNetworkError());
        combined.addEventListener("abort", aborted, { once: true });
        if (combined.aborted) { aborted(); return; }
        this.resolveHost(hostname).then(resolve, reject).finally(() => combined.removeEventListener("abort", aborted));
      });
    } catch { throw new CaptureNetworkError(); }
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicCaptureAddress(address) || isIP(address) !== family)) throw new CaptureNetworkError();
    const selected = addresses[0]!;
    return { url, address: selected.address, family: selected.family as 4 | 6, port };
  }
}
