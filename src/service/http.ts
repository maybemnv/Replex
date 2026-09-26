import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import {
  JobEventPageSchema,
  ServiceErrorResponseSchema,
  type ContractError,
  type ServiceCommand,
} from "../service-contract/index.js";
import { IdSchema } from "../schema.js";
import { LocalExecutor } from "./executor.js";
import { LocalExecutorError } from "./local-jobs.js";
import { LocalProjectStoreError } from "./project-store.js";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const JobLookupSchema = z.object({ jobId: IdSchema }).strict();

export class LocalExecutorServer {
  private readonly executor: LocalExecutor;
  private workspaceRoot: string;
  private readonly allowedOrigins: Set<string>;
  private configuredPort?: number;
  private token?: string;
  private server?: Server;
  private ready = false;
  private closing = false;
  private activeRequests = 0;
  private idleResolve?: () => void;
  private startPromise?: Promise<{ url: string; token: string }>;
  private stopPromise?: Promise<void>;

  constructor(options: { workspaceRoot: string; allowedOrigins?: string[] }) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.executor = new LocalExecutor({ workspaceRoot: this.workspaceRoot });
    try { this.allowedOrigins = new Set((options.allowedOrigins ?? []).map(localOrigin)); }
    catch { throw new LocalExecutorError("VALIDATION_FAILED", "Only explicit local frontend origins are allowed."); }
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.stopPromise || this.closing) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is stopping.");
    if (this.server && this.token && this.ready) return { url: this.url(), token: this.token };
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    try { return await this.startPromise; }
    finally { this.startPromise = undefined; }
  }

  private async startOnce(): Promise<{ url: string; token: string }> {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.workspaceRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new LocalExecutorError("STORAGE_FAILED", "The local workspace root is invalid.");
    }
    this.workspaceRoot = await realpath(this.workspaceRoot);
    // ponytail: this fixed loopback port is the workspace lease; add an OS lock if non-server writers become supported.
    this.configuredPort = workspacePort(this.workspaceRoot);
    const token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolveListen, reject) => {
      const failed = (error: Error) => {
        server.off("listening", listening);
        reject(error);
      };
      const listening = () => {
        server.off("error", failed);
        resolveListen();
      };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen({ host: "127.0.0.1", port: this.configuredPort!, exclusive: true });
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local service endpoint is already in use.");
      }
      throw new LocalExecutorError("EXECUTION_FAILED", "The local service could not bind its loopback endpoint.");
    });

    this.server = server;
    this.token = token;
    try {
      await this.executor.start();
      this.closing = false;
      this.ready = true;
      return { url: this.url(), token };
    } catch (error) {
      await closeServer(server);
      this.server = undefined;
      this.token = undefined;
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise.finally(() => { this.stopPromise = undefined; });
  }

  private async stopOnce(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    const server = this.server;
    if (!server) return;
    this.closing = true;
    this.ready = false;
    const closed = closeServer(server);
    if (this.activeRequests > 0) await new Promise<void>((resolveIdle) => { this.idleResolve = resolveIdle; });
    await this.executor.stop();
    await closed;
    this.server = undefined;
    this.token = undefined;
    this.closing = false;
  }

  dispatch(command: Extract<ServiceCommand, "create_project" | "open_project" | "import_asset" | "apply_operations" | "cancel_job">, input: unknown): Promise<unknown> {
    if (!this.ready || this.closing) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");
    return this.executor.dispatch(command, input);
  }

  waitForJob(jobId: string, timeoutMs?: number) {
    if (!this.ready || this.closing) throw new LocalExecutorError("EXECUTOR_OFFLINE", "The local executor is not running.");
    return this.executor.waitForJob(jobId, timeoutMs);
  }

  private url(): string {
    const address = this.server?.address();
    const port = address && typeof address !== "string" ? address.port : this.configuredPort!;
    return `http://127.0.0.1:${port}/v1`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closing || !this.ready) {
      response.setHeader("connection", "close");
      sendJson(response, 503, serviceError("EXECUTOR_OFFLINE", "The local executor is stopping.", true));
      return;
    }
    this.activeRequests += 1;
    try {
      await this.route(request, response);
    } catch (error) {
      const result = safeError(error);
      sendJson(response, result.status, result.body);
    } finally {
      this.activeRequests -= 1;
      if (this.activeRequests === 0) {
        this.idleResolve?.();
        this.idleResolve = undefined;
      }
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin) {
      if (!this.allowedOrigins.has(origin)) {
        sendJson(response, 403, serviceError("UNAUTHORIZED", "This local frontend origin is not allowed.", false));
        return;
      }
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (!validHost(request.headers.host, this.serverPort())) {
      sendJson(response, 403, serviceError("UNAUTHORIZED", "The local service host is not allowed.", false));
      return;
    }
    if (request.method === "OPTIONS") {
      if (!origin || !this.allowedOrigins.has(origin)) {
        sendJson(response, 403, serviceError("UNAUTHORIZED", "This local frontend origin is not allowed.", false));
        return;
      }
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "300",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!authorized(request.headers.authorization, this.token!)) {
      sendJson(response, 401, serviceError("UNAUTHORIZED", "A valid local executor token is required.", false));
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      sendJson(response, 200, this.executor.capabilities());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/projects/create") {
      const body = await readJson(request);
      sendJson(response, 201, await this.dispatch("create_project", body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/projects/open") {
      const body = await readJson(request);
      sendJson(response, 200, await this.dispatch("open_project", body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs/apply-operations") {
      const body = await readJson(request);
      sendJson(response, 202, await this.dispatch("apply_operations", body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs/import-asset") {
      const body = await readJson(request);
      sendJson(response, 202, await this.dispatch("import_asset", body));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/jobs/")) {
      const jobId = url.pathname.slice("/v1/jobs/".length);
      const parsed = JobLookupSchema.parse({ jobId });
      sendJson(response, 200, await this.executor.getJob(parsed.jobId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs/cancel") {
      const body = await readJson(request);
      sendJson(response, 200, await this.dispatch("cancel_job", body));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/projects/") && url.pathname.endsWith("/events")) {
      const projectId = url.pathname.slice("/v1/projects/".length, -"/events".length);
      const parsedProjectId = IdSchema.parse(projectId);
      const afterSequence = queryInteger(url.searchParams.get("afterSequence"), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = queryInteger(url.searchParams.get("limit"), 1000, 1, 1000);
      const events = await this.executor.eventsAfter(parsedProjectId, afterSequence, limit);
      sendJson(response, 200, JobEventPageSchema.parse(events));
      return;
    }
    sendJson(response, 404, serviceError("CAPABILITY_UNAVAILABLE", "The local service route is not available.", false));
  }

  private serverPort(): number {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : this.configuredPort!;
  }
}

function workspacePort(workspaceRoot: string): number {
  const hash = createHash("sha256").update(process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot).digest();
  return 45_000 + (hash.readUInt32BE(0) % 10_000);
}

function localOrigin(value: string): string {
  const origin = new URL(value);
  if (!new Set(["http:", "https:"]).has(origin.protocol)
    || !new Set(["localhost", "127.0.0.1"]).has(origin.hostname)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("origin must be local");
  }
  return origin.origin;
}

function validHost(value: string | undefined, port: number): boolean {
  if (!value) return false;
  try {
    const host = new URL(`http://${value}`);
    return new Set(["127.0.0.1", "localhost"]).has(host.hostname.toLowerCase())
      && (!host.port || Number(host.port) === port)
      && !host.username && !host.password;
  } catch {
    return false;
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpInputError(415, "A JSON request body is required.");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
    throw new HttpInputError(413, "The request body exceeds the local service limit.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpInputError(413, "The request body exceeds the local service limit.");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpInputError(400, "The request body is not valid JSON."); }
}

function queryInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HttpInputError(400, "The event cursor is invalid.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new HttpInputError(400, "The event cursor is invalid.");
  return number;
}

class HttpInputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function serviceError(code: ContractError["code"], message: string, retryable: boolean): unknown {
  return ServiceErrorResponseSchema.parse({ contractVersion: "v1", error: { code, message, retryable } });
}

function safeError(error: unknown): { status: number; body: unknown } {
  if (error instanceof HttpInputError) return {
    status: error.status,
    body: serviceError(error.status === 413 ? "VALIDATION_FAILED" : "VALIDATION_FAILED", error.message, false),
  };
  if (error instanceof LocalExecutorError) return {
    status: error.code === "VALIDATION_FAILED" ? 400
      : error.code === "JOB_NOT_FOUND" ? 404
      : error.code === "IDEMPOTENCY_CONFLICT" || error.code === "JOB_NOT_CANCELLABLE" ? 409
      : error.code === "EXECUTOR_OFFLINE" ? 503 : 500,
    body: serviceError(error.code, error.message, error.code === "STORAGE_FAILED"),
  };
  if (error instanceof LocalProjectStoreError) {
    const code: ContractError["code"] = error.code === "PROJECT_NOT_FOUND" ? "PROJECT_NOT_FOUND"
      : error.code === "REVISION_NOT_FOUND" ? "REVISION_NOT_FOUND"
      : error.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT"
      : error.code === "INVALID_OPERATION" ? "OPERATION_REJECTED" : "STORAGE_FAILED";
    return {
      status: code === "PROJECT_NOT_FOUND" || code === "REVISION_NOT_FOUND" ? 404 : code === "IDEMPOTENCY_CONFLICT" ? 409 : 500,
      body: serviceError(code, "The local project request could not be completed.", code === "STORAGE_FAILED"),
    };
  }
  if (error instanceof z.ZodError) return {
    status: 400,
    body: serviceError("VALIDATION_FAILED", "The request does not match service-contract v1.", false),
  };
  return { status: 500, body: serviceError("EXECUTION_FAILED", "The local service request failed.", true) };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  let text: string;
  try { text = JSON.stringify(value); }
  catch { text = ""; }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    status = 500;
    text = JSON.stringify(serviceError("STORAGE_FAILED", "The local service response exceeds its configured limit.", true));
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text, "utf8"),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}
