import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutorServer } from "../src/service/http.js";
import { ffmpegPath, mediaAvailable } from "./media.js";

describe("LocalExecutorServer", () => {
  let workspaceRoot: string | undefined;
  let server: LocalExecutorServer | undefined;
  const extraRoots: string[] = [];

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
    await Promise.all(extraRoots.map((root) => rm(root, { recursive: true, force: true })));
    extraRoots.length = 0;
  });

  it("serves typed local commands with loopback binding, bearer auth, CORS, jobs, and event replay", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "replex-local-http-"));
    server = new LocalExecutorServer({ workspaceRoot, allowedOrigins: ["http://localhost:5173"] });
    const [session, sameInstance] = await Promise.all([server.start(), server.start()]);
    expect(sameInstance).toEqual(session);
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    const denied = await fetch(session.url + "/capabilities");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const blockedOrigin = await fetch(session.url + "/capabilities", {
      headers: { authorization: `Bearer ${session.token}`, origin: "https://untrusted.example" },
    });
    expect(blockedOrigin.status).toBe(403);

    const preflight = await fetch(session.url + "/projects/create", {
      method: "OPTIONS", headers: { origin: "http://localhost:5173" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const call = (path: string, init: RequestInit = {}) => fetch(session.url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${session.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const capabilities = await call("/capabilities", { headers: { origin: "http://localhost:5173" } });
    expect(capabilities.status).toBe(200);
    expect(capabilities.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(await capabilities.json()).toMatchObject({ contractVersion: "v1", target: "local", jobKinds: ["asset_import", "apply_operations"] });

    const createdResponse = await call("/projects/create", {
      method: "POST",
      body: JSON.stringify({ contractVersion: "v1", idempotencyKey: "http-create", name: "HTTP edit" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { projectId: string; revisionId: string };

    const opened = await call("/projects/open", {
      method: "POST",
      body: JSON.stringify({ contractVersion: "v1", idempotencyKey: "http-open", projectId: created.projectId, revisionId: created.revisionId }),
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ summary: { projectId: created.projectId }, revisionId: created.revisionId });

    const submittedResponse = await call("/jobs/apply-operations", {
      method: "POST",
      body: JSON.stringify({
        contractVersion: "v1", idempotencyKey: "http-edit", projectId: created.projectId,
        baseRevisionId: created.revisionId, actor: "user",
        operations: [{
          type: "add_text_layer",
          layer: {
            id: "http-title", trackId: "track-overlay", kind: "text",
            timelineStartMs: 0, durationMs: 1000, properties: { text: "Local service" }, keyframes: [],
          },
        }],
      }),
    });
    expect(submittedResponse.status).toBe(202);
    const submitted = await submittedResponse.json() as { id: string };

    let job: { state: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await call(`/jobs/${submitted.id}`);
      job = await response.json() as { state: string };
      if (["succeeded", "failed", "cancelled"].includes(job.state)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect(job?.state).toBe("succeeded");

    const events = await call(`/projects/${created.projectId}/events?afterSequence=0&limit=20`);
    expect(events.status).toBe(200);
    const eventPage = await events.json() as { events: Array<{ sequence: number; type: string }>; cursorExpired: boolean };
    const eventList = eventPage.events;
    expect(eventPage.cursorExpired).toBe(false);
    expect(eventList.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(eventList.map(({ type }) => type)).toEqual(["job.updated", "job.updated", "revision.created", "job.updated"]);
    const futureCursor = await call(`/projects/${created.projectId}/events?afterSequence=99`);
    expect(futureCursor.status).toBe(400);

    const second = new LocalExecutorServer({ workspaceRoot });
    await expect(second.start()).rejects.toMatchObject({ code: "EXECUTOR_OFFLINE" });
    await second.stop();
    await Promise.all([server.stop(), server.stop()]);
    const restarted = await server.start();
    expect(restarted.url).toBe(session.url);
    expect(restarted.token).not.toBe(session.token);
  });

  it.skipIf(!mediaAvailable)("authorizes a selected local file inside configured roots and imports it without exposing its path", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "replex-local-http-import-workspace-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-local-http-import-source-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "replex-local-http-import-outside-"));
    extraRoots.push(sourceRoot, outsideRoot);
    const sourcePath = join(sourceRoot, "selected.mp4");
    const outsidePath = join(outsideRoot, "outside.mp4");
    for (const path of [sourcePath, outsidePath]) {
      const fixture = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=8:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path], { windowsHide: true, shell: false, timeout: 30_000 });
      expect(fixture.status, fixture.stderr?.toString()).toBe(0);
    }
    server = new LocalExecutorServer({ workspaceRoot, importRoots: [sourceRoot] });
    const session = await server.start();
    const call = (path: string, body: unknown) => fetch(session.url + path, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const projectResponse = await call("/projects/create", { contractVersion: "v1", idempotencyKey: "create-http-import", name: "HTTP import" });
    const project = await projectResponse.json() as { projectId: string; revisionId: string };
    const outside = await call("/local/imports/authorize", { sourcePath: outsidePath });
    expect(outside.status).toBe(403);
    expect(JSON.stringify(await outside.json())).not.toContain(outsidePath);

    const authorized = await call("/local/imports/authorize", { sourcePath });
    expect(authorized.status).toBe(201);
    const selection = await authorized.json() as { token: string; filename: string; sizeBytes: number };
    expect(selection).toMatchObject({ filename: "selected.mp4", sizeBytes: expect.any(Number) });
    expect(JSON.stringify(selection)).not.toContain(sourcePath);

    const submittedResponse = await call("/jobs/import-asset", {
      contractVersion: "v1", idempotencyKey: "http-import", projectId: project.projectId, baseRevisionId: project.revisionId,
      source: { kind: "local_token", ref: selection.token }, declaredFilename: selection.filename,
    });
    expect(submittedResponse.status).toBe(202);
    const submitted = await submittedResponse.json() as { id: string };
    const completed = await server.waitForJob(submitted.id, 30_000);
    expect(completed).toMatchObject({ state: "succeeded", result: { assetId: expect.any(String) } });
  }, 60_000);

  it("rejects invalid JSON and contract payloads with bounded errors", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "replex-local-http-errors-"));
    server = new LocalExecutorServer({ workspaceRoot });
    const session = await server.start();
    const badJson = await fetch(session.url + "/projects/create", {
      method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: "{",
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const invalidContract = await fetch(session.url + "/projects/create", {
      method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: "v9", idempotencyKey: "create", name: "bad" }),
    });
    const payload = await invalidContract.json() as object;
    expect(invalidContract.status).toBe(400);
    expect(payload).toMatchObject({ contractVersion: "v1", error: { code: "VALIDATION_FAILED" } });
    expect(JSON.stringify(payload)).not.toContain(workspaceRoot);
  });
});
