import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { V2AgentModelClient, V2AgentModelRequest } from "../src/agent-v2.js";
import type { Operation } from "../src/operations-v2.js";
import { LocalExecutor } from "../src/service/executor.js";
import { ffmpegPath, ffprobePath } from "./media.js";

/** Shared real-media setup: a 1s fixture imported and placed on the video track. */
export async function projectWithClip(roots: string[], prefix: string, options: { agentModel?: V2AgentModelClient } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `${prefix}-workspace-`));
  const sourceRoot = await mkdtemp(join(tmpdir(), `${prefix}-source-`));
  roots.push(workspaceRoot, sourceRoot);
  const sourcePath = join(sourceRoot, "walkthrough.mp4");
  const fixture = spawnSync(ffmpegPath, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
  ], { windowsHide: true, shell: false, timeout: 30_000 });
  expect(fixture.status, fixture.stderr?.toString()).toBe(0);

  const executor = new LocalExecutor({ workspaceRoot, media: { ffmpegPath, ffprobePath }, ...options });
  await executor.start();
  const project = await executor.createProject({ contractVersion: "v1", idempotencyKey: `${prefix}-create`, name: "Render jobs", brief: { targetDurationMs: 1000 } });
  const source = await executor.authorizeLocalImport(sourcePath, [sourceRoot]);
  const imported = await executor.waitForJob((await executor.submitImportAsset({
    contractVersion: "v1", idempotencyKey: `${prefix}-import`, projectId: project.projectId, baseRevisionId: project.revisionId,
    source: { kind: "local_token", ref: source.token }, declaredFilename: source.filename,
  })).id, 60_000);
  if (imported.state !== "succeeded") throw new Error("fixture import failed: " + JSON.stringify(imported));
  const placed = await executor.waitForJob((await executor.submitApplyOperations({
    contractVersion: "v1", idempotencyKey: `${prefix}-place`, projectId: project.projectId, baseRevisionId: imported.result.revisionId!, actor: "user",
    operations: [{ type: "create_clip", clip: {
      id: "clip-walkthrough", assetId: imported.result.assetId!, trackId: "track-video", timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 1000,
      speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, audioGainDb: 0, muted: false,
    } }],
  })).id, 30_000);
  if (placed.state !== "succeeded") throw new Error("fixture clip failed: " + JSON.stringify(placed));
  return { executor, workspaceRoot, projectId: project.projectId, revisionId: placed.result.revisionId!, assetId: imported.result.assetId! };
}

/** Deterministic model: inspect clips and their media evidence, then propose the scripted batch citing disclosed evidence, then finish. */
export function scriptedModel(batches: Record<string, Operation[]>) {
  const inputs: V2AgentModelRequest[] = [];
  let counter = 0;
  const model: V2AgentModelClient = {
    async respond(input) {
      inputs.push(input);
      const responseId = `response-${++counter}`;
      const operations = batches[input.prompt];
      const last = input.toolResults.at(-1);
      if (!operations) return { responseId, calls: [], text: "Nothing to change." };
      if (!last) return { responseId, calls: [{ id: `inspect-${counter}`, name: "inspect_v2", arguments: { kind: "clips" } }] };
      const output = last.output as { evidenceRefs?: string[]; data?: { items?: Array<{ assetId: string }> } };
      if (last.name === "inspect_v2" && !output.evidenceRefs?.length) {
        return { responseId, calls: [{ id: `evidence-${counter}`, name: "inspect_v2", arguments: {
          kind: "media_evidence", assetId: output.data!.items![0]!.assetId, image: "selected_frame", frameOffset: 0,
        } }] };
      }
      if (last.name === "inspect_v2") {
        return { responseId, calls: [{ id: `propose-${counter}`, name: "propose_edit_batch", arguments: {
          baseRevisionId: input.context.currentRevisionId, evidenceRefs: output.evidenceRefs!, operations,
        } }] };
      }
      return { responseId, calls: [], text: "Applied." };
    },
  };
  /** Tool outputs the model saw, for diagnosable assertion failures. */
  const trace = () => JSON.stringify(inputs.map(({ prompt, toolResults }) => ({ prompt, results: toolResults.map(({ name, output }) => ({ name, output })) }))).slice(-4000);
  return { model, inputs, trace };
}
