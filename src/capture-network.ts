import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, type Socket } from "node:net";
import { CaptureDestinationPolicy, CaptureNetworkError } from "./capture-network-policy.js";

const MAX_CONNECTIONS = 64;
const MAX_REQUESTS = 1000;
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 120_000;

/** Fixed launch policy for the V2 executor; no proxy bypass or nonproxied UDP media channels. */
export const CAPTURE_BROWSER_ARGS = Object.freeze([
  "--proxy-bypass-list=<-loopback>", "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-background-networking", "--disable-features=DnsOverHttps,MediaRouter",
]);

function headers(input: IncomingMessage["headers"], host: string, upgrade = false): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = { ...input, host };
  const nominated = String(input.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...nominated, "proxy-authorization", "proxy-authenticate", "proxy-connection", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]) delete result[name];
  if (upgrade) { result.connection = "Upgrade"; result.upgrade = "websocket"; }
  return result;
}

/** Per-capture authenticated loopback proxy. Upstream sockets always receive policy-validated numeric IPs. */
export class CaptureNetworkGuard {
  private readonly username = "capture";
  private readonly password = randomBytes(32).toString("hex");
  private readonly authorization = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`);
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private requests = 0;
  private bytes = 0;
  private denied = false;
  private closed = false;
  private stopPromise?: Promise<void>;
  private readonly lifetime: AbortSignal;
  private readonly stopOnAbort = () => { this.denied = true; void this.stop(); };

  private constructor(private readonly policy: CaptureDestinationPolicy, signal: AbortSignal) {
    this.lifetime = AbortSignal.any([signal, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]);
    this.server = createServer((request, response) => { void this.forward(request, response); });
    this.server.requestTimeout = SOCKET_TIMEOUT_MS;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.on("connection", (socket) => {
      if (this.closed || this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
      this.track(socket);
    });
    this.server.on("connect", (request, socket, head) => { void this.tunnel(request, socket as Socket, head); });
    this.server.on("upgrade", (request, socket, head) => { void this.upgrade(request, socket as Socket, head); });
    this.server.on("clientError", (_error, socket) => { socket.destroy(); });
  }

  static async start(policy: CaptureDestinationPolicy, signal: AbortSignal): Promise<CaptureNetworkGuard> {
    signal.throwIfAborted();
    const guard = new CaptureNetworkGuard(policy, signal);
    await new Promise<void>((resolve, reject) => {
      guard.server.once("error", reject);
      guard.server.listen(0, "127.0.0.1", () => { guard.server.off("error", reject); resolve(); });
    });
    guard.lifetime.addEventListener("abort", guard.stopOnAbort, { once: true });
    if (guard.lifetime.aborted) { await guard.stop(); signal.throwIfAborted(); throw new CaptureNetworkError(); }
    return guard;
  }

  get proxy(): { server: string; username: string; password: string; bypass: string } {
    const address = this.server.address();
    if (!address || typeof address === "string" || this.closed) throw new CaptureNetworkError();
    return { server: `http://127.0.0.1:${address.port}`, username: this.username, password: this.password, bypass: "<-loopback>" };
  }

  assertSafe(): void {
    if (this.denied || this.closed || this.lifetime.aborted) throw new CaptureNetworkError();
  }

  /** Reset POST uses the same resolver and pinned sockets, never native fetch or ambient proxy variables. */
  async reset(url: string): Promise<void> {
    this.claim();
    const target = await this.policy.destination(url, this.lifetime);
    await new Promise<void>((resolve, reject) => {
      const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)({
        hostname: target.address, family: target.family, port: target.port, method: "POST",
        path: target.url.pathname + target.url.search, headers: { host: target.url.host },
        servername: target.url.hostname.replace(/^\[|\]$/g, ""), agent: false, signal: this.lifetime,
      }, (response) => {
        response.on("data", (chunk: Buffer) => this.transfer(chunk.length));
        response.on("error", reject);
        response.on("end", () => response.statusCode && response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new CaptureNetworkError()));
      });
      request.on("socket", (socket) => this.track(socket));
      request.setTimeout(SOCKET_TIMEOUT_MS, () => request.destroy(new CaptureNetworkError()));
      request.on("error", reject);
      request.end();
    });
    this.assertSafe();
  }

  stop(): Promise<void> {
    this.stopPromise ??= (async () => {
      this.closed = true;
      this.lifetime.removeEventListener("abort", this.stopOnAbort);
      for (const socket of this.sockets) socket.destroy();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    })();
    return this.stopPromise;
  }

  private track(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    if (this.closed || this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private transfer(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > MAX_TRANSFER_BYTES) this.stopOnAbort();
  }

  private claim(): void {
    this.assertSafe();
    if (++this.requests > MAX_REQUESTS) { this.denied = true; throw new CaptureNetworkError(); }
  }

  private authorized(request: IncomingMessage): boolean {
    const count = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "proxy-authorization").length;
    const received = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return count === 1 && received.length === this.authorization.length && timingSafeEqual(received, this.authorization);
  }

  private challenge(socket: Socket): void {
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="replex-capture"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="replex-capture"', "content-length": 0 }); response.end(); return;
    }
    try {
      this.claim();
      const target = await this.policy.destination(request.url ?? "", this.lifetime);
      if (target.url.protocol !== "http:") throw new CaptureNetworkError();
      const upstream = httpRequest({
        hostname: target.address, family: target.family, port: target.port, method: request.method,
        path: target.url.pathname + target.url.search, headers: headers(request.headers, target.url.host),
        agent: false, signal: this.lifetime,
      }, (remote) => {
        const reply = headers(remote.headers, target.url.host);
        delete reply.host;
        response.writeHead(remote.statusCode ?? 502, reply);
        remote.on("data", (chunk: Buffer) => this.transfer(chunk.length));
        remote.on("error", () => response.destroy());
        remote.pipe(response);
      });
      upstream.on("socket", (socket) => this.track(socket));
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on("data", (chunk: Buffer) => this.transfer(chunk.length));
      request.on("error", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      this.denied = true;
      if (!response.headersSent) response.writeHead(403, { "content-length": 0 });
      response.end();
    }
  }

  private bridge(left: Socket, right: Socket, head: Buffer): void {
    this.track(right);
    left.on("data", (chunk: Buffer) => this.transfer(chunk.length));
    right.on("data", (chunk: Buffer) => this.transfer(chunk.length));
    left.once("close", () => right.destroy()); right.once("close", () => left.destroy());
    if (head.length) { this.transfer(head.length); right.write(head); }
    left.pipe(right); right.pipe(left);
  }

  private async tunnel(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (!this.authorized(request)) { this.challenge(socket); return; }
    try {
      this.claim();
      const authority = request.url ?? "";
      // Chromium also tunnels ws:// via CONNECT. Authorize the exact endpoint against either approved scheme.
      const target = await this.policy.destination(`https://${authority}`, this.lifetime)
        .catch(() => this.policy.destination(`http://${authority}`, this.lifetime));
      const defaultPort = target.url.protocol === "https:" ? 443 : 80;
      if (authority !== target.url.host && authority !== `${target.url.hostname}:${defaultPort}`) throw new CaptureNetworkError();
      if (socket.destroyed || this.closed) return;
      const upstream = createConnection({ host: target.address, family: target.family, port: target.port });
      this.track(upstream);
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        this.bridge(socket, upstream, head);
      });
      upstream.once("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
    } catch { this.denied = true; socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); }
  }

  private async upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (!this.authorized(request)) { this.challenge(socket); return; }
    try {
      this.claim();
      const target = await this.policy.destination(request.url ?? "", this.lifetime);
      if (target.url.protocol !== "http:" || request.headers.upgrade?.toLowerCase() !== "websocket") throw new CaptureNetworkError();
      const upstream = httpRequest({
        hostname: target.address, family: target.family, port: target.port, path: target.url.pathname + target.url.search,
        headers: headers(request.headers, target.url.host, true), agent: false, signal: this.lifetime,
      });
      upstream.on("socket", (remote) => this.track(remote));
      upstream.on("error", () => socket.destroy());
      upstream.on("response", (response) => { response.resume(); socket.destroy(); });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        const reply = headers(response.headers, target.url.host, true);
        delete reply.host;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        this.bridge(socket, remote as Socket, head);
      });
      socket.once("close", () => upstream.destroy());
      upstream.end();
    } catch { this.denied = true; socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); }
  }
}
