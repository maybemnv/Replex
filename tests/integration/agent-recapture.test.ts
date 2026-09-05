import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../../fixtures/apps/normal/flow.js";
import { runRecordedAgentDraft } from "../../src/agent.js";
import { createProject } from "../../src/project.js";
import { reconcileCapture } from "../../src/reconcile.js";
import { buildRenderJob, executeRenderJob } from "../../src/render.js";
import { verifyProject } from "../../src/verify.js";

const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
const mediaAvailable = existsSync(ffmpegPath) && existsSync(ffprobePath);

describe.skipIf(!mediaAvailable)("agent edits across selective recapture", () => {
  it("keeps unrelated agent edits and renders the reconciled revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-agent-recapture-"));
    try {
      await mkdir(join(root, "captures"), { recursive: true });
      for (const index of [0, 1, 2]) source(join(root, "captures", `${index}.mp4`), index);
      const captures = ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => capture(root, index, sceneKey));
      const base = createProject({ projectId: "agent-recapture-project", brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 }, environment: normalEnvironment("http://127.0.0.1:4173"), flow: normalFlow("http://127.0.0.1:4173"), captures });
      const agent = runRecordedAgentDraft(base, root, [{ tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-1"], overlay: { id: "agent-title", sceneId: base.scenes[1].id, kind: "title", text: "Results update", placement: "top", startMs: 0, endMs: 2500 } } }]);
      if (!agent.ok) throw new Error(agent.detail);
      source(join(root, "captures", "0-new.mp4"), 3);
      const replacement = { ...capture(root, 0, "open-demo", "0-new"), changedStepIds: [agent.project.scenes[0].checkpointActionId], reason: "controlled App A change" };
      const reconciled = reconcileCapture(agent.project, root, replacement);
      expect(reconciled).toMatchObject({ ok: true, preserved: true });
      if (!reconciled.ok) return;
      expect(reconciled.project.overlays["agent-title"]).toEqual(agent.project.overlays["agent-title"]);
      const verification = verifyProject(reconciled.project, root);
      expect(verification.passed).toBe(true);
      const rendered = executeRenderJob(buildRenderJob(reconciled.project, root, verification), root, { ffmpegPath, ffprobePath });
      expect(rendered.probe.durationMs).toBeGreaterThanOrEqual(25000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

function capture(root: string, index: number, sceneKey: string, suffix = String(index)) {
  const path = `captures/${suffix}.mp4`;
  return { id: `capture-${suffix}`, sceneKey, path, durationMs: 9000, sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex") };
}

function source(path: string, index: number): void {
  const color = ["0x243447", "0x355c7d", "0x5c3d2e", "0x6c4b5e"][index];
  const run = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=1920x1080:r=30:d=9`, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr);
}
