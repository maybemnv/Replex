import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureDestinationPolicy, isPublicCaptureAddress, issueFixtureNetworkGrant, type FixtureNetworkGrant } from "../src/capture-network-policy.js";

const signal = new AbortController().signal;
describe("capture destination policy", () => {
  let server: Server | undefined;
  afterEach(async () => { if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve())); });
  it.each(["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.1.2", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "not-an-ip"])("blocks nonpublic address %s", (address) => {
    expect(isPublicCaptureAddress(address)).toBe(false);
  });
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])("recognizes public unicast %s", (address) => {
    expect(isPublicCaptureAddress(address)).toBe(true);
  });
  it.each(["http://2130706433", "http://0x7f000001", "http://127.1", "http://[::ffff:127.0.0.1]", "http://169.254.169.254"])("normalizes encoded numeric targets before blocking %s", async (value) => {
    await expect(new CaptureDestinationPolicy([new URL(value).origin]).destination(value, signal)).rejects.toThrow();
  });
  it("rejects mixed DNS answers, internal names, credentials, unsupported schemes, and unapproved origins", async () => {
    const dns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    const policy = new CaptureDestinationPolicy(["https://product.example", "http://metadata.internal"], [], dns);
    for (const target of ["https://product.example", "http://metadata.internal", "https://user:password@product.example", "file:///etc/passwd", "https://other.example"]) {
      await expect(policy.destination(target, signal)).rejects.toThrow();
    }
    expect(dns).toHaveBeenCalledTimes(1);
  });
  it("returns a numeric socket destination and revalidates on each request to prevent DNS rebinding", async () => {
    const dns = vi.fn().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const policy = new CaptureDestinationPolicy(["https://product.example"], [], dns);
    expect(await policy.destination("https://product.example/path", signal)).toMatchObject({ address: "8.8.8.8", port: 443, family: 4 });
    await expect(policy.destination("https://product.example/path", signal)).rejects.toThrow();
  });
  it("scopes a nonserializable fixture grant to the exact live loopback server and port", async () => {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture failed");
    const origin = `http://127.0.0.1:${address.port}`;
    const grant = issueFixtureNetworkGrant(server);
    const policy = new CaptureDestinationPolicy([origin, "http://127.0.0.1:1"], [grant]);
    expect(await policy.destination(origin, signal)).toMatchObject({ address: "127.0.0.1", port: address.port });
    await expect(policy.destination("http://127.0.0.1:1", signal)).rejects.toThrow();
    await expect(new CaptureDestinationPolicy([origin], [JSON.parse(JSON.stringify(grant)) as FixtureNetworkGrant]).destination(origin, signal)).rejects.toThrow();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await expect(policy.destination(origin, signal)).rejects.toThrow();
  });
  it("fails closed on DNS failure and cancellation", async () => {
    const policy = new CaptureDestinationPolicy(["https://product.example"], [], async () => { throw new Error("private resolver detail"); });
    await expect(policy.destination("https://product.example", signal)).rejects.toThrow("network policy");
    await expect(policy.destination("https://product.example", AbortSignal.abort())).rejects.toThrow();
  });
});
