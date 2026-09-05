import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../../fixtures/apps/normal/flow.js";
import { runRecordedAgentDraft } from "../../src/agent.js";
import { createProject, semanticHash } from "../../src/project.js";

const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
const mediaAvailable = existsSync(ffmpegPath) && existsSync(ffprobePath);

describe.skipIf(!mediaAvailable)("recorded agent draft integration", () => {
  it("replays a grounded model draft through verification and a valid MP4 render", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-agent-draft-"));
    try {
      await mkdir(join(root, "captures"), { recursive: true });
      for (const index of [0, 1, 2]) source(join(root, "captures", `${index}.mp4`), index);
      const captures = ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 9000, sha256: createHash("sha256").update(readFileSync(join(root, "captures", `${index}.mp4`))).digest("hex") }));
      const project = createProject({ projectId: "agent-render-project", brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 }, environment: normalEnvironment("http://127.0.0.1:4173"), flow: normalFlow("http://127.0.0.1:4173"), captures });
      const first = runRecordedAgentDraft(project, root, [
        { tool: "inspect_project", input: {} },
        { tool: "set_title", input: { baseRevisionId: "revision-0", evidenceRefs: ["capture:capture-0"], overlay: { id: "agent-title", sceneId: project.scenes[0].id, kind: "title", text: "Filter releases", placement: "top", startMs: 0, endMs: 2500 } } },
        { tool: "verify_project", input: {} },
        { tool: "render_draft", input: {} },
        { tool: "inspect_render_result", input: {} },
      ]);
      expect(first).toMatchObject({ ok: true, toolCalls: 5 });
      if (!first.ok) return;
      expect(existsSync(join(root, "renders", `${first.project.currentRevisionId}.mp4`))).toBe(true);
      expect(first.project.overlays["agent-title"].text).toBe("Filter releases");
      expect(semanticHash(first.project)).not.toBe(semanticHash(project));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

function source(path: string, index: number): void {
  const run = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", `color=c=${["0x243447", "0x355c7d", "0x5c3d2e"][index]}:s=1920x1080:r=30:d=9`, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr);
}
