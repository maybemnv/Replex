import { request as httpRequest } from "node:http";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutorServer } from "../src/service/http.js";

describe("local demo request and upload limits", () => {
  let root: string;
  let server: LocalExecutorServer;
  let session: { url: string; token: string };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "replex-resource-limits-"));
    server = new LocalExecutorServer({ workspaceRoot: root, importRoots: [root] });
    session = await server.start();
  });
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); });
  const post = (url: string, token: string, body: unknown, type = "application/json") => fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type }, body: JSON.stringify(body),
  });

  it("refuses a selected source above 256 MiB before issuing an import token", async () => {
    const path = join(root, "oversized.mp4");
    const file = await open(path, "wx");
    try { await file.truncate(256 * 1024 * 1024 + 1); } finally { await file.close(); }
    const response = await post(session.url + "/local/imports/authorize", session.token, { hostContractVersion: "v1", sourcePath: path });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(JSON.stringify(body)).not.toContain(root);
    expect(await readdir(root)).not.toContain("projects");
  });

  it("bounds unconsumed file handles and releases them on shutdown", async () => {
    const path = join(root, "selected.mp4");
    await writeFile(path, "not media, authorization does not probe");
    for (let index = 0; index < 16; index++) {
      const response = await post(session.url + "/local/imports/authorize", session.token, { hostContractVersion: "v1", sourcePath: path });
      expect(response.status).toBe(201); await response.json();
    }
    const full = await post(session.url + "/local/imports/authorize", session.token, { hostContractVersion: "v1", sourcePath: path });
    expect(full.status).toBe(400); await full.json();
    await server.stop(); session = await server.start();
    const afterRestart = await post(session.url + "/local/imports/authorize", session.token, { hostContractVersion: "v1", sourcePath: path });
    expect(afterRestart.status).toBe(201); await afterRestart.json();
  });

  it("rejects non-JSON MIME lookalikes before creating a project", async () => {
    const response = await post(session.url + "/projects/create", session.token, { contractVersion: "v1", idempotencyKey: "mime", name: "Blocked" }, "application/json-malicious");
    expect(response.status).toBe(415); await response.json();
    expect(await readdir(root)).not.toContain("projects");
  });

  it("returns bounded 413 errors for declared and chunked JSON bodies above 4 MiB", async () => {
    const send = (declared: boolean) => new Promise<{ status: number; bytes: number }>((resolve, reject) => {
      const request = httpRequest(session.url + "/projects/create", {
        method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json",
          ...(declared ? { "content-length": String(4 * 1024 * 1024 + 1) } : { "transfer-encoding": "chunked" }) },
      }, (response) => {
        let bytes = 0; response.on("data", (chunk: Buffer) => { bytes += chunk.length; });
        response.on("end", () => resolve({ status: response.statusCode!, bytes })); response.on("error", reject);
      });
      request.on("error", reject);
      if (declared) request.end("{");
      else { for (let index = 0; index < 5; index++) request.write(Buffer.alloc(1024 * 1024, 32)); request.end(); }
    });
    expect(await send(true)).toMatchObject({ status: 413 });
    const streamed = await send(false);
    expect(streamed.status).toBe(413);
    expect(streamed.bytes).toBeLessThan(1000);
    expect(await readdir(root)).not.toContain("projects");
  });
});
