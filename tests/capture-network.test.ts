import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type RequestListener } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_BROWSER_ARGS, CaptureNetworkGuard } from "../src/capture-network.js";
import { CaptureDestinationPolicy, issueFixtureNetworkGrant } from "../src/capture-network-policy.js";

describe("capture network guard", () => {
  const closers: Array<() => Promise<void>> = [];
  let browser: Browser | undefined;
  afterEach(async () => { await browser?.close(); browser = undefined; for (const close of closers.splice(0).reverse()) await close(); });

  async function fixture(handler: RequestListener = (_request, response) => response.end("fixture")) {
    const server = createServer(handler);
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture failed");
    closers.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
    return { server, origin: `http://127.0.0.1:${address.port}`, grant: issueFixtureNetworkGrant(server) };
  }
  async function guard(policy: CaptureDestinationPolicy, signal = new AbortController().signal) {
    const value = await CaptureNetworkGuard.start(policy, signal);
    closers.push(() => value.stop());
    return value;
  }
  const auth = (value: CaptureNetworkGuard) => `Basic ${Buffer.from(`${value.proxy.username}:${value.proxy.password}`).toString("base64")}`;
  const through = (value: CaptureNetworkGuard, target: string, authorization?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = httpRequest(value.proxy.server, { path: target, headers: authorization ? { "proxy-authorization": authorization } : {} }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, text })); response.on("error", reject);
    });
    request.on("error", reject); request.end();
  });

  it("requires a per-capture secret and forwards only to the granted numeric socket without leaking proxy credentials", async () => {
    let upstreamHeaders: Record<string, unknown> = {};
    const target = await fixture((request, response) => { upstreamHeaders = request.headers; response.end("fixture"); });
    const proxy = await guard(new CaptureDestinationPolicy([target.origin], [target.grant]));
    expect(await through(proxy, target.origin)).toMatchObject({ status: 407 });
    expect(await through(proxy, target.origin, "Basic invalid")).toMatchObject({ status: 407 });
    expect(await through(proxy, target.origin + "/path?x=1", auth(proxy))).toEqual({ status: 200, text: "fixture" });
    expect(upstreamHeaders.host).toBe(new URL(target.origin).host);
    expect(upstreamHeaders["proxy-authorization"]).toBeUndefined();
    proxy.assertSafe();
  });

  it("blocks internal targets even when their origins were approved, and closes the proxy on abort", async () => {
    let hits = 0;
    const target = await fixture((_request, response) => { hits++; response.end("must not be reached"); });
    const controller = new AbortController();
    const proxy = await guard(new CaptureDestinationPolicy([target.origin]), controller.signal);
    const url = proxy.proxy.server;
    expect(await through(proxy, target.origin, auth(proxy))).toMatchObject({ status: 403 });
    expect(hits).toBe(0);
    expect(() => proxy.assertSafe()).toThrow();
    controller.abort();
    await proxy.stop();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("pins reset POST connections and refuses reset redirects", async () => {
    let redirected = 0;
    const other = await fixture((_request, response) => { redirected++; response.end(); });
    const target = await fixture((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: other.origin }).end();
      else { expect(request.method).toBe("POST"); response.writeHead(204).end(); }
    });
    const proxy = await guard(new CaptureDestinationPolicy([target.origin, other.origin], [target.grant]));
    await proxy.reset(target.origin + "/reset");
    await expect(proxy.reset(target.origin + "/redirect")).rejects.toThrow();
    expect(redirected).toBe(0);
  });

  it("aborts and drains destination work when the capture proxy is closed", async () => {
    const policy = new CaptureDestinationPolicy(["http://product.example"]);
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = false;
    vi.spyOn(policy, "destination").mockImplementation((_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled lookup")); }, { once: true });
      started();
    }));
    const proxy = await guard(policy);
    const pending = through(proxy, "http://product.example", auth(proxy)).then(() => "response", () => "closed");
    await resolving;
    await proxy.stop();
    expect(cancelled).toBe(true);
    expect(await pending).toBe("closed");
  });

  it("authenticates CONNECT and pins the selected socket rather than resolving the original hostname again", async () => {
    const sockets = new Set<Socket>();
    const target = createTcpServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.pipe(socket); });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("fixture failed");
    closers.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); target.close(() => resolve()); }));
    const policy = new CaptureDestinationPolicy(["https://product.example"]);
    // Transport seam only: address-policy tests separately reject loopback. No internet connection occurs.
    const destination = vi.spyOn(policy, "destination").mockResolvedValue({ url: new URL("https://product.example"), address: "127.0.0.1", family: 4, port: address.port });
    const proxy = await guard(policy);
    const connect = (authorization?: string) => new Promise<{ status: number; echo?: string }>((resolve, reject) => {
      const request = httpRequest(proxy.proxy.server, { method: "CONNECT", path: "product.example:443", headers: authorization ? { "proxy-authorization": authorization } : {} });
      request.on("error", reject);
      request.on("connect", (response, socket) => {
        socket.on("error", reject);
        if (response.statusCode !== 200) { socket.destroy(); resolve({ status: response.statusCode! }); return; }
        socket.once("data", (chunk) => { socket.destroy(); resolve({ status: 200, echo: chunk.toString() }); });
        socket.write("pinned");
      }); request.end();
    });
    expect(await connect()).toMatchObject({ status: 407 });
    expect(await connect(auth(proxy))).toEqual({ status: 200, echo: "pinned" });
    expect(destination).toHaveBeenCalledWith("https://product.example:443", expect.any(AbortSignal));
  });

  it("blocks prohibited CONNECT and WebSocket destinations before an upstream connection", async () => {
    const proxy = await guard(new CaptureDestinationPolicy(["https://127.0.0.1", "http://127.0.0.1"]));
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(proxy.proxy.server, { method: "CONNECT", path: "127.0.0.1:443", headers: { "proxy-authorization": auth(proxy) } });
      request.on("error", reject); request.on("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode!); }); request.end();
    });
    expect(status).toBe(403);
    const wsProxy = await guard(new CaptureDestinationPolicy(["http://127.0.0.1"]));
    const websocketStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(wsProxy.proxy.server, { path: "ws://127.0.0.1/socket", headers: {
        "proxy-authorization": auth(wsProxy), connection: "Upgrade", upgrade: "websocket",
      } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      request.on("error", reject); request.end();
    });
    expect(websocketStatus).toBe(403);
  });

  it("forwards an authenticated HTTP WebSocket upgrade without proxy credentials reaching the fixture", async () => {
    let authenticatedAtTarget = false;
    const target = await fixture();
    target.server.on("upgrade", (request, socket) => {
      authenticatedAtTarget = "proxy-authorization" in request.headers;
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nupgraded");
    });
    const proxy = await guard(new CaptureDestinationPolicy([target.origin], [target.grant]));
    const received = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(proxy.proxy.server, { path: target.origin.replace("http:", "ws:") + "/socket", headers: {
        "proxy-authorization": auth(proxy), connection: "Upgrade", upgrade: "websocket",
      } });
      request.on("error", reject);
      request.on("upgrade", (response, socket, head) => {
        expect(response.statusCode).toBe(101);
        socket.on("error", reject);
        if (head.length) { socket.destroy(); resolve(head.toString()); }
        else socket.once("data", (chunk) => { socket.destroy(); resolve(chunk.toString()); });
      });
      request.end();
    });
    expect(received).toBe("upgraded");
    expect(authenticatedAtTarget).toBe(false);
    proxy.assertSafe();
  });

  it("routes bundled Chromium HTTP and WebSockets through the authenticated proxy with loopback bypass disabled", async () => {
    let wsConnections = 0;
    const target = await fixture((_request, response) => response.end('<!doctype html><body>fixture</body>'));
    target.server.on("upgrade", (request, socket) => {
      wsConnections++;
      const accepted = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.on("error", () => undefined);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accepted}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 2, 111, 107]));
      socket.on("data", () => socket.end());
    });
    const proxy = await guard(new CaptureDestinationPolicy([target.origin], [target.grant]));
    browser = await chromium.launch({ proxy: proxy.proxy, args: [...CAPTURE_BROWSER_ARGS] });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(target.origin);
    expect(await page.locator("body").textContent()).toBe("fixture");
    expect(await page.evaluate((url) => new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(url); socket.onmessage = (event) => { resolve(String(event.data)); socket.close(); }; socket.onerror = () => reject(new Error("WebSocket blocked"));
    }), target.origin.replace("http:", "ws:") + "/socket")).toBe("ok");
    expect(wsConnections).toBe(1);
    proxy.assertSafe();
  }, 30_000);

  it("prevents Chromium redirects and subresources from reaching another private port", async () => {
    let hits = 0;
    const other = await fixture((_request, response) => { hits++; response.end("internal"); });
    const target = await fixture((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: other.origin }).end();
      else response.end(`<!doctype html><img src="${other.origin}/internal">`);
    });
    const proxy = await guard(new CaptureDestinationPolicy([target.origin, other.origin], [target.grant]));
    browser = await chromium.launch({ proxy: proxy.proxy, args: [...CAPTURE_BROWSER_ARGS] });
    const page = await browser.newPage({ serviceWorkers: "block" });
    await page.goto(target.origin, { waitUntil: "networkidle" });
    expect(hits).toBe(0);
    expect(() => proxy.assertSafe()).toThrow();
    await page.goto(target.origin + "/redirect").catch(() => undefined);
    expect(hits).toBe(0);
  }, 30_000);
});
