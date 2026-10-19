import { request as httpRequest } from "node:http";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutorServer } from "../src/service/http.js";

describe("local demo token access", () => {
  let root: string;
  let server: LocalExecutorServer;
  let session: { url: string; token: string };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "replex-auth-"));
    server = new LocalExecutorServer({ workspaceRoot: root, allowedOrigins: ["http://localhost:5173"] });
    session = await server.start();
  });
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); });

  it("authenticates every API route before reading a body or performing a side effect", async () => {
    const before = await readdir(root, { recursive: true });
    const routes = [
      ["GET", "/capabilities"], ["POST", "/projects/create"], ["POST", "/projects/open"],
      ["POST", "/local/imports/authorize"], ["POST", "/jobs/apply-operations"],
      ["POST", "/jobs/import-asset"], ["POST", "/jobs/agent-edit"], ["POST", "/jobs/start-browser-capture"],
      ["POST", "/jobs/recapture-browser-scene"], ["POST", "/jobs/verify-revision"],
      ["POST", "/jobs/render-preview"], ["POST", "/jobs/render-final"], ["POST", "/jobs/cancel"],
      ["GET", "/jobs/job-absent"], ["GET", "/projects/project-absent/events"],
    ];
    for (const [method, path] of routes) {
      for (const token of [undefined, "invalid-token"]) {
        const response = await fetch(session.url + path, {
          method,
          headers: token ? { authorization: `Bearer ${token}` } : {},
          ...(method === "POST" ? { body: "invalid JSON must never be parsed" } : {}),
        });
        expect(response.status, path).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe('Bearer realm="replex-local"');
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toMatchObject({ contractVersion: "v1", error: { code: "UNAUTHORIZED" } });
      }
    }
    expect(await readdir(root, { recursive: true })).toEqual(before);
  });

  it("rotates tokens on restart and never persists them in the workspace", async () => {
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(session.token).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    const previous = session;
    await server.stop();
    session = await server.start();
    expect(session.token).not.toBe(previous.token);
    const old = await fetch(session.url + "/capabilities", { headers: { authorization: `Bearer ${previous.token}` } });
    expect(old.status).toBe(401);
    await old.arrayBuffer();
    const current = await fetch(session.url + "/capabilities", { headers: { authorization: `Bearer ${session.token}` } });
    expect(current.status).toBe(200);
    expect(JSON.stringify(await current.json())).not.toContain(session.token);
    for (const entry of await readdir(root, { recursive: true })) {
      const path = join(root, entry);
      if ((await lstat(path)).isFile()) {
        const contents = await readFile(path, "utf8");
        expect(contents).not.toContain(previous.token);
        expect(contents).not.toContain(session.token);
      }
    }
  });

  const raw = (url: string, headers: Record<string, string | string[]>) => new Promise<number>((resolve, reject) => {
    const request = httpRequest(url + "/capabilities", { headers }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode!));
    });
    request.on("error", reject); request.end();
  });

  it("rejects duplicate authorization headers even when the first token is valid", async () => {
    expect(await raw(session.url, { authorization: [`Bearer ${session.token}`, "Bearer invalid"] })).toBe(403);
    expect(await raw(session.url, { authorization: [`Bearer ${session.token}`, `Bearer ${session.token}`] })).toBe(403);
  });

  it("rejects malformed Host and unapproved origins even with a valid token", async () => {
    const host = new URL(session.url).host;
    for (const value of [host + "/ignored", host + "#ignored", host + "?ignored", "attacker.example", "localhost"]) {
      expect(await raw(session.url, { authorization: `Bearer ${session.token}`, host: value }), value).toBe(403);
    }
    expect(await raw(session.url, { authorization: `Bearer ${session.token}`, origin: "http://localhost:9999" })).toBe(403);
    expect(await raw(session.url, { authorization: `Bearer ${session.token}`, origin: ["http://localhost:5173", "http://localhost:5173"] })).toBe(403);
  });
});
