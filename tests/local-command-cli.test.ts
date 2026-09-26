import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runServiceCommandCli } from "../src/service/command-cli.js";
import { LocalExecutorServer } from "../src/service/http.js";

describe("local executor command CLI parity", () => {
  type CliResponse = {
    projectId?: string;
    revisionId?: string;
    state?: string;
    result?: { revisionId?: string };
    revisions?: Array<{ id: string; manifestSha256: string }>;
  };
  let temporaryRoot: string | undefined;
  let httpServer: LocalExecutorServer | undefined;

  afterEach(async () => {
    await httpServer?.stop();
    httpServer = undefined;
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("applies the same service requests through CLI and loopback transport", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "replex-local-cli-parity-"));
    const cliWorkspace = join(temporaryRoot, "cli");
    const httpWorkspace = join(temporaryRoot, "http");
    const inputPath = join(temporaryRoot, "request.json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const invokeCli = async (command: string, input: unknown) => {
      await writeFile(inputPath, JSON.stringify(input), "utf8");
      const exitCode = await runServiceCommandCli([
        "--workspace", cliWorkspace, "--command", command, "--input", inputPath,
      ], { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
      expect(exitCode, stderr.join("")).toBe(0);
      return JSON.parse(stdout.pop()!) as CliResponse;
    };

    const createRequest = { contractVersion: "v1", idempotencyKey: "parity-create", name: "Parity" };
    const cliCreated = await invokeCli("create_project", createRequest);
    if (!cliCreated.projectId || !cliCreated.revisionId) throw new Error("CLI create response is incomplete");
    const cliProject = { projectId: cliCreated.projectId, revisionId: cliCreated.revisionId };
    httpServer = new LocalExecutorServer({ workspaceRoot: httpWorkspace });
    const session = await httpServer.start();
    const call = (path: string, init: RequestInit = {}) => fetch(session.url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${session.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const httpCreatedResponse = await call("/projects/create", { method: "POST", body: JSON.stringify(createRequest) });
    const httpCreated = await httpCreatedResponse.json() as { projectId: string; revisionId: string };
    expect(httpCreatedResponse.status).toBe(201);
    expect(cliCreated.projectId).toBe(httpCreated.projectId);

    const makeEdit = (project: { projectId: string; revisionId: string }) => ({
      contractVersion: "v1",
      idempotencyKey: "parity-edit",
      projectId: project.projectId,
      baseRevisionId: project.revisionId,
      actor: "user",
      operations: [{
        type: "add_text_layer",
        layer: {
          id: "parity-title", trackId: "track-overlay", kind: "text",
          timelineStartMs: 0, durationMs: 1000, properties: { text: "Parity" }, keyframes: [],
        },
      }],
    });
    const cliJob = await invokeCli("apply_operations", makeEdit(cliProject));
    expect(cliJob).toMatchObject({ state: "succeeded" });

    const httpJobResponse = await call("/jobs/apply-operations", { method: "POST", body: JSON.stringify(makeEdit(httpCreated)) });
    const httpJob = await httpJobResponse.json() as { id: string };
    expect(httpJobResponse.status).toBe(202);
    const httpJobResult = await httpServer.waitForJob(httpJob.id, 10_000);
    expect(httpJobResult).toMatchObject({ state: "succeeded" });
    const cliRevisionId = cliJob.result?.revisionId;
    const httpRevisionId = httpJobResult.state === "succeeded" ? httpJobResult.result.revisionId : undefined;
    expect(cliRevisionId).toBe(httpRevisionId);
    if (!cliRevisionId || !httpRevisionId) throw new Error("a parity edit did not produce a revision");

    const cliSnapshot = await invokeCli("open_project", {
      contractVersion: "v1", idempotencyKey: "parity-open",
      projectId: cliProject.projectId, revisionId: cliRevisionId,
    });
    const httpSnapshotResponse = await call("/projects/open", {
      method: "POST",
      body: JSON.stringify({
        contractVersion: "v1", idempotencyKey: "parity-open",
        projectId: httpCreated.projectId, revisionId: httpRevisionId,
      }),
    });
    const httpSnapshot = await httpSnapshotResponse.json() as { revisions: Array<{ id: string; manifestSha256: string }> };
    expect(httpSnapshotResponse.status).toBe(200);
    const cliRevision = cliSnapshot.revisions?.find((revision) => revision.id === cliRevisionId);
    const httpRevision = httpSnapshot.revisions.find((revision) => revision.id === httpRevisionId);
    expect(cliRevision?.manifestSha256).toBe(httpRevision?.manifestSha256);
  });
});
