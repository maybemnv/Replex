import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/service/executor.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";
import { projectWithClip, scriptedModel } from "./service-fixture.js";

describe("local agent edit jobs", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("is unavailable without a configured model", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "replex-agent-off-"));
    roots.push(workspaceRoot);
    const executor = new LocalExecutor({ workspaceRoot });
    await executor.start();
    try {
      expect(executor.capabilities().availableCommands).not.toContain("request_agent_edit");
      const created = await executor.createProject({ contractVersion: "v1", idempotencyKey: "agent-off", name: "No agent" });
      await expect(executor.submitAgentEdit({
        contractVersion: "v1", idempotencyKey: "agent-off-edit", projectId: created.projectId, baseRevisionId: created.revisionId, prompt: "Speed it up", preview: true,
      })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    } finally {
      await executor.stop();
    }
  });

  it.skipIf(!mediaAvailable)("runs same-thread follow-up edits with verified previews across a restart", async () => {
    const promptOne = "Crop toward the product.";
    const promptTwo = "Keep that, and lower the audio.";
    const promptThree = "Does anything else need changing?";
    const { model, inputs, trace } = scriptedModel({
      [promptOne]: [{ type: "set_transform", clipId: "clip-walkthrough", transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }],
      [promptTwo]: [{ type: "set_volume", clipId: "clip-walkthrough", audioGainDb: -6 }],
    });
    const fixture = await projectWithClip(roots, "replex-agent-jobs", { agentModel: model });
    let executor = fixture.executor;
    const { projectId } = fixture;
    const edit = (idempotencyKey: string, baseRevisionId: string, prompt: string) =>
      executor.submitAgentEdit({ contractVersion: "v1", idempotencyKey, projectId, baseRevisionId, prompt, preview: true });
    try {
      expect(executor.capabilities()).toMatchObject({ availableCommands: expect.arrayContaining(["request_agent_edit"]), jobKinds: expect.arrayContaining(["agent_edit"]) });

      const first = await executor.waitForJob((await edit("agent-1", fixture.revisionId, promptOne)).id, 180_000);
      expect(first, trace()).toMatchObject({ kind: "agent_edit", state: "succeeded", result: { outputId: expect.any(String) } });
      if (first.state !== "succeeded") throw new Error("first agent edit failed");
      expect(first.result.revisionId).not.toBe(fixture.revisionId);
      const firstResponseId = inputs.filter(({ prompt }) => prompt === promptOne).length;

      const events = (await executor.eventsAfter(projectId)).events;
      expect(events.some((event) => event.type === "revision.created" && event.revision.id === first.result.revisionId && event.revision.actor === "agent")).toBe(true);
      expect(events.some((event) => event.type === "render_artifact.created" && event.artifact.outputId === first.result.outputId)).toBe(true);

      const second = await executor.waitForJob((await edit("agent-2", first.result.revisionId!, promptTwo)).id, 180_000);
      expect(second, trace()).toMatchObject({ state: "succeeded" });
      if (second.state !== "succeeded") throw new Error("follow-up agent edit failed");
      const followUp = inputs.find(({ prompt }) => prompt === promptTwo)!;
      expect(followUp.previousResponseId).toBe(`response-${firstResponseId}`);
      expect(followUp.context.currentRevisionId).toBe(first.result.revisionId);

      const snapshot = await executor.openProject({ contractVersion: "v1", idempotencyKey: "open-agent", projectId, revisionId: second.result.revisionId! });
      expect(snapshot.composition.clips[0]).toMatchObject({ crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, audioGainDb: -6 });
      expect(snapshot.revisions.filter(({ actor }) => actor === "agent")).toHaveLength(2);
      expect(snapshot.verification).toMatchObject({ revisionId: second.result.revisionId, status: "passed" });

      // The thread survives a restart and stays usable after an edit made outside the conversation.
      await executor.stop();
      executor = new LocalExecutor({ workspaceRoot: fixture.workspaceRoot, media: { ffmpegPath, ffprobePath }, agentModel: model });
      await executor.start();
      const manual = await executor.waitForJob((await executor.submitApplyOperations({
        contractVersion: "v1", idempotencyKey: "manual-mute", projectId, baseRevisionId: second.result.revisionId!, actor: "user",
        operations: [{ type: "mute_clip", clipId: "clip-walkthrough", muted: true }],
      })).id, 30_000);
      if (manual.state !== "succeeded") throw new Error("manual edit failed");
      const lastSecondResponse = `response-${inputs.length}`;

      const third = await executor.waitForJob((await edit("agent-3", manual.result.revisionId!, promptThree)).id, 180_000);
      expect(third, trace()).toMatchObject({ state: "succeeded", result: { revisionId: manual.result.revisionId } });
      if (third.state !== "succeeded") throw new Error("third agent turn failed");
      expect(third.result.outputId).toBeUndefined();
      expect(inputs.at(-1)).toMatchObject({ prompt: promptThree, previousResponseId: lastSecondResponse, context: { currentRevisionId: manual.result.revisionId } });

      const stale = await executor.waitForJob((await edit("agent-stale", fixture.revisionId, promptOne)).id, 30_000);
      expect(stale).toMatchObject({ state: "failed", error: { code: "STALE_JOB_INPUT" } });
    } finally {
      await executor.stop();
    }
  }, 600_000);
});
