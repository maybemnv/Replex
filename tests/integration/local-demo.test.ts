import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalDemo } from "../../src/demo/workflow.js";
import { LocalProjectStore } from "../../src/service/project-store.js";
import { LocalExecutorServer } from "../../src/service/http.js";
import { mediaAvailable, ffmpegPath, ffprobePath } from "../media.js";
import type { V2AgentModelRequest } from "../../src/agent-v2.js";

const { modelTrace, evidenceErrors, failedTools, captureErrors } = vi.hoisted(() => ({ modelTrace: [] as Array<{ names: string[]; output: unknown }>, evidenceErrors: [] as string[], failedTools: [] as string[], captureErrors: [] as string[] }));
vi.mock("../../src/capture.js", async (original) => {
  const actual = await original<typeof import("../../src/capture.js")>();
  return { ...actual, runCapture: async (...args: Parameters<typeof actual.runCapture>) => {
    try { return await actual.runCapture(...args); }
    catch (error) { captureErrors.push(String(error)); throw error; }
  } };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: (...args: unknown[]) => {
    const result = Reflect.apply(actual.spawnSync, actual, args) as { status: number | null; stderr?: string | Buffer };
    if (result.status !== 0) failedTools.push(String(result.stderr ?? "").slice(-2000));
    return result;
  } };
});
vi.mock("../../src/media-evidence.js", async (original) => {
  const actual = await original<typeof import("../../src/media-evidence.js")>();
  return { ...actual, generateMediaEvidence: async (...args: Parameters<typeof actual.generateMediaEvidence>) => {
    try { return await actual.generateMediaEvidence(...args); }
    catch (error) { evidenceErrors.push(error instanceof actual.MediaEvidenceError ? error.code : "UNKNOWN"); throw error; }
  } };
});
vi.mock("../../src/demo/scripted-model.js", async (original) => {
  const actual = await original<typeof import("../../src/demo/scripted-model.js")>();
  return { createDemoScriptedModel: () => {
    const model = actual.createDemoScriptedModel();
    return { respond: async (request: V2AgentModelRequest) => {
      modelTrace.push({ names: request.toolResults.map(({ name }) => name), output: request.toolResults.at(-1)?.output });
      return model.respond(request);
    } };
  } };
});

describe("one-command demo workflow", () => {
  let root: string | undefined;
  let demo: Awaited<ReturnType<typeof startLocalDemo>> | undefined;
  let restarted: LocalExecutorServer | undefined;
  afterEach(async () => {
    await demo?.close(); demo = undefined; await restarted?.stop(); restarted = undefined;
    if (root && process.env.REPLEX_TEST_ARTIFACT_ROOT) {
      const artifacts = process.env.REPLEX_TEST_ARTIFACT_ROOT;
      await mkdir(artifacts, { recursive: true });
      await cp(root, join(artifacts, basename(root)), { recursive: true });
    }
    if (root) await rm(root, { recursive: true, force: true }); root = undefined; vi.unstubAllEnvs(); modelTrace.splice(0); evidenceErrors.splice(0); failedTools.splice(0); captureErrors.splice(0);
  });

  it.skipIf(!mediaAvailable || !process.env.REPLEX_FFMPEG_PATH || !process.env.REPLEX_FFPROBE_PATH)("runs the real guarded HTTP workflow, exports verified media, and reopens the project after shutdown", async () => {
    root = await mkdtemp(join(tmpdir(), "replex-demo-workflow-"));
    vi.stubEnv("OPENAI_API_KEY", "unused-test-placeholder");
    const progress: string[] = [];
    try { demo = await startLocalDemo({ workspaceRoot: root, progress: (stage) => progress.push(stage) }); }
    catch (error) { throw new Error(`${String(error)}\n${JSON.stringify({ captureErrors, evidenceErrors, failedTools, modelTrace }).slice(-5000)}`); }
    expect(demo).toMatchObject({ mode: "scripted", preservationPassed: true });
    expect(progress).toEqual(expect.arrayContaining(["capturing", "scripted_agent_edit", "recapturing_changed_scene", "verifying", "rendering_final"]));
    expect((await stat(demo.finalPath)).size).toBeGreaterThan(0);
    expect((await stat(demo.previewPath)).size).toBeGreaterThan(0);
    const probe = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", demo.finalPath], { encoding: "utf8", shell: false });
    expect(probe.status).toBe(0);
    expect(Number(JSON.parse(probe.stdout).format.duration)).toBeCloseTo(6, 0);
    expect(JSON.parse(probe.stdout).streams).toEqual(expect.arrayContaining([expect.objectContaining({ width: 1920, height: 1080 })]));
    const decode = spawnSync(ffmpegPath, ["-v", "error", "-i", demo.finalPath, "-f", "null", "-"], { encoding: "utf8", shell: false, timeout: 30_000 });
    expect(decode.status, decode.stderr).toBe(0);
    expect((await fetch(demo.url + "/capabilities")).status).toBe(401);
    const catalog = await new LocalProjectStore(root).listProjects();
    expect(catalog.projects).toEqual([{ projectId: demo.projectId, name: "Replex local demo", currentRevisionId: demo.revisionId }]);
    const original = demo;
    await demo.close();
    await expect(fetch(original.url + "/capabilities")).rejects.toThrow();
    restarted = new LocalExecutorServer({ workspaceRoot: root });
    const session = await restarted.start();
    expect(session.token).not.toBe(original.bearerToken);
    const response = await fetch(session.url + "/projects/open", { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: "v1", idempotencyKey: "demo-reopen", projectId: original.projectId, revisionId: original.revisionId }) });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { verification: { status: string }; renderArtifacts: unknown[] };
    expect(snapshot.verification.status).toBe("passed");
    expect(snapshot.renderArtifacts.length).toBeGreaterThanOrEqual(1);
    const previewResponse = await fetch(session.url + "/projects/open", { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: "v1", idempotencyKey: "demo-reopen-preview", projectId: original.projectId, revisionId: original.previewRevisionId }) });
    expect(previewResponse.status).toBe(200);
    expect((await previewResponse.json() as { renderArtifacts: unknown[] }).renderArtifacts.length).toBeGreaterThanOrEqual(1);
    const store = new LocalProjectStore(root);
    const logs = await readFile(join(await store.projectRoot(original.projectId), "operations/operations.jsonl"), "utf8");
    expect(logs).not.toContain(original.bearerToken);
    expect(logs).not.toContain("unused-test-placeholder");
  }, 240_000);

  it("does not start services when already cancelled", async () => {
    root = await mkdtemp(join(tmpdir(), "replex-demo-aborted-"));
    await expect(startLocalDemo({ workspaceRoot: root, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(await new LocalProjectStore(root).listProjects()).toEqual({ projects: [], unavailableCount: 0 });
  });

  it.skipIf(!mediaAvailable || !process.env.REPLEX_FFMPEG_PATH || !process.env.REPLEX_FFPROBE_PATH)("closes services on cancellation while preserving the last committed capture", async () => {
    root = await mkdtemp(join(tmpdir(), "replex-demo-cancel-"));
    const controller = new AbortController();
    await expect(startLocalDemo({ workspaceRoot: root, signal: controller.signal, progress: (stage) => {
      if (stage === "importing") controller.abort();
    } })).rejects.toThrow();
    const store = new LocalProjectStore(root);
    const catalog = await store.listProjects();
    expect(catalog.unavailableCount).toBe(0);
    expect(catalog.projects).toHaveLength(1);
    const project = await store.current(catalog.projects[0]!.projectId);
    expect(Object.keys(project.assets)).toHaveLength(3);
    expect(project.revisions).toHaveLength(2);
    const origin = Object.values(project.browser!.flows)[0]!.steps[0]!.target!.value;
    await expect(fetch(origin)).rejects.toThrow();
    restarted = new LocalExecutorServer({ workspaceRoot: root });
    await expect(restarted.start()).resolves.toMatchObject({ url: expect.any(String) });
  }, 120_000);
});
