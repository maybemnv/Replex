import { createHash } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { V2AgentModelClient } from "../src/agent-v2.js";
import type { JobView } from "../src/service-contract/index.js";
import type { LocalExecutor } from "../src/service/executor.js";
import { LocalProjectStore } from "../src/service/project-store.js";
import { mediaAvailable } from "./media.js";
import { projectWithClip } from "./service-fixture.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function untilRunning(executor: LocalExecutor, jobId: string): Promise<JobView> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await executor.getJob(jobId);
    if (job.state !== "queued") return job;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`job ${jobId} never started`);
}

describe("local verify jobs and running-job cancellation", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!mediaAvailable)("verifies a revision without rendering, gates a final render on it, and records failures", async () => {
    const { executor, workspaceRoot, projectId, revisionId } = await projectWithClip(roots, "replex-verify-jobs");
    try {
      const pin = { contractVersion: "v1" as const, projectId, revisionId };
      const submitted = await executor.submitVerify({ ...pin, idempotencyKey: "verify-1" });
      expect(submitted).toMatchObject({ kind: "verify_revision", state: "queued", revisionId });
      const verified = await executor.waitForJob(submitted.id, 60_000);
      expect(verified, JSON.stringify(verified)).toMatchObject({ state: "succeeded", result: { revisionId } });

      const snapshot = await executor.openProject({ ...pin, idempotencyKey: "open-after-verify" });
      expect(snapshot.verification).toMatchObject({ revisionId, status: "passed" });
      expect(snapshot.renderArtifacts).toEqual([]);
      const ref = snapshot.verification.refs.at(-1)!;
      expect(ref).toMatchObject({ revisionId, status: "passed", evidenceRefs: [expect.stringMatching(/^evidence\/verification\//)] });
      const projectRoot = join(workspaceRoot, "projects", sha256(projectId));
      const report = JSON.parse(await readFile(join(projectRoot, ...ref.evidenceRefs[0]!.split("/")), "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({ kind: "revision_preflight", revisionId, status: "passed", checks: { plan: true, sourceHashes: true } });
      const events = (await executor.eventsAfter(projectId)).events;
      expect(events.some((event) => event.type === "verification.updated" && event.verification.status === "passed")).toBe(true);

      // Re-verifying the same state is idempotent; a final render can be gated on it without a preview.
      expect((await executor.waitForJob((await executor.submitVerify({ ...pin, idempotencyKey: "verify-again" })).id, 60_000)).state).toBe("succeeded");
      expect((await executor.openProject({ ...pin, idempotencyKey: "open-again" })).verification.refs).toHaveLength(1);
      const final = await executor.waitForJob((await executor.submitRenderFinal({ ...pin, idempotencyKey: "final-on-verify", verificationRefId: ref.id })).id, 120_000);
      expect(final, JSON.stringify(final)).toMatchObject({ state: "succeeded", result: { revisionId, outputId: expect.any(String) } });

      // Changed source bytes fail verification and record the failure.
      const asset = (await new LocalProjectStore(workspaceRoot).current(projectId)).assets[snapshot.assets[0]!.id]!;
      const blob = join(projectRoot, ...asset.path!.split("/"));
      await chmod(blob, 0o600);
      await writeFile(blob, Buffer.from("tampered"));
      const failed = await executor.waitForJob((await executor.submitVerify({ ...pin, idempotencyKey: "verify-tampered" })).id, 60_000);
      expect(failed).toMatchObject({ state: "failed", error: { code: "VERIFICATION_FAILED" } });
      const failedSnapshot = await executor.openProject({ ...pin, idempotencyKey: "open-tampered" });
      expect(failedSnapshot.verification.status).toBe("failed");
      expect(failedSnapshot.verification.refs.at(-1)).toMatchObject({ status: "failed" });
      const failedEvents = (await executor.eventsAfter(projectId)).events;
      expect(failedEvents.some((event) => event.type === "verification.updated" && event.verification.status === "failed")).toBe(true);

      const edited = await executor.waitForJob((await executor.submitApplyOperations({
        contractVersion: "v1", idempotencyKey: "mute-after-verify", projectId, baseRevisionId: revisionId, actor: "user",
        operations: [{ type: "mute_clip", clipId: "clip-walkthrough", muted: true }],
      })).id, 30_000);
      expect(edited.state).toBe("succeeded");
      const stale = await executor.waitForJob((await executor.submitVerify({ ...pin, idempotencyKey: "verify-stale" })).id, 30_000);
      expect(stale).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT" } });
    } finally {
      await executor.stop();
    }
  }, 300_000);

  it.skipIf(!mediaAvailable)("cancels a running agent edit before it commits", async () => {
    let calls = 0;
    const model: V2AgentModelClient = {
      // Hangs until the job is cancelled, so cancellation lands while the job is running.
      respond: (input) => new Promise((_resolve, reject) => {
        calls += 1;
        input.signal?.addEventListener("abort", () => reject(new Error("model call aborted")), { once: true });
      }),
    };
    const { executor, workspaceRoot, projectId, revisionId } = await projectWithClip(roots, "replex-agent-cancel", { agentModel: model });
    try {
      const submitted = await executor.submitAgentEdit({ contractVersion: "v1", idempotencyKey: "agent-cancel", projectId, baseRevisionId: revisionId, prompt: "Tighten it.", preview: true });
      expect(await untilRunning(executor, submitted.id)).toMatchObject({ state: "running", cancellable: true });
      for (let attempt = 0; attempt < 500 && calls === 0; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      expect(calls).toBe(1);
      expect((await executor.cancelJob({ contractVersion: "v1", idempotencyKey: "agent-cancel-request", projectId, jobId: submitted.id })).disposition).toBe("requested");
      expect(await executor.waitForJob(submitted.id, 60_000)).toMatchObject({ state: "cancelled" });
      expect((await new LocalProjectStore(workspaceRoot).current(projectId)).currentRevisionId).toBe(revisionId);
    } finally {
      await executor.stop();
    }
  }, 120_000);
});
