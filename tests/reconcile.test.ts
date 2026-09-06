import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { applyOperations } from "../src/operations.js";
import { createProject } from "../src/project.js";
import { reconcileCapture } from "../src/reconcile.js";
import { ffmpegPath, ffprobePath, mediaAvailable } from "./media.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "replex-reconcile-"));
  await mkdir(join(root, "captures"), { recursive: true });
  for (const index of [0, 1, 2]) await writeFile(join(root, "captures", `${index}.mp4`), `capture-${index}`);
  const project = createProject({ projectId: "reconcile-project", brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 }, environment: normalEnvironment("http://127.0.0.1:4173"), flow: normalFlow("http://127.0.0.1:4173"), captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 10000, sha256: createHash("sha256").update(`capture-${index}`).digest("hex") })) });
  const edited = applyOperations(project, project.currentRevisionId, [{ type: "set_title", overlay: { id: "agent-title", sceneId: project.scenes[1].id, kind: "title", text: "Results update", placement: "top", startMs: 0, endMs: 2000 } }], { root });
  if (!edited.ok) throw new Error(edited.detail);
  return { root, project: edited.project };
}

describe("selective recapture reconciliation", () => {
  it.skipIf(!mediaAvailable)("changes only the target capture while retaining stable scene and unrelated agent edits", async () => {
    const { root, project } = await fixture();
    try {
      await writeVideo(join(root, "captures", "0-new.mp4"), 10, 1920, 1080);
      const result = reconcileCapture(project, root, { id: "capture-0-new", sceneKey: "open-demo", path: "captures/0-new.mp4", durationMs: 10000, sha256: createHash("sha256").update(await readFile(join(root, "captures", "0-new.mp4"))).digest("hex"), changedStepIds: [project.scenes[0].checkpointActionId], reason: "known fixture state change", ffprobePath });
      expect(result).toMatchObject({ ok: true, preserved: true });
      if (!result.ok) return;
      expect(result.project.scenes[0]).toMatchObject({ id: project.scenes[0].id, captureId: "capture-0-new" });
      expect(result.project.scenes.slice(1)).toEqual(project.scenes.slice(1));
      expect(result.project.overlays["agent-title"]).toEqual(project.overlays["agent-title"]);
      expect(result.project.recaptureLineage.at(-1)).toMatchObject({ previousCaptureId: "capture-0", replacementCaptureId: "capture-0-new", changedStepIds: [project.scenes[0].checkpointActionId] });
      const operations = (await readFile(join(root, "operations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(operations.map((operation) => operation.input.type)).toEqual(["set_title", "replace_capture"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!mediaAvailable)("rejects replacement media with incompatible dimensions", async () => {
    const { root, project } = await fixture();
    try {
      const path = join(root, "captures", "wrong-size.mp4");
      await writeVideo(path, 10, 1280, 720);
      const result = reconcileCapture(project, root, { id: "capture-wrong-size", sceneKey: "open-demo", path: "captures/wrong-size.mp4", durationMs: 10000, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), changedStepIds: [project.scenes[0].checkpointActionId], reason: "bad media", ffprobePath });
      expect(result).toMatchObject({ ok: false, code: "INVALID_RECAPTURE" });
      expect(result.ok ? "" : result.detail).toContain("dimensions or frame rate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a replacement with the wrong durable scene key", async () => {
    const { root, project } = await fixture();
    try {
      const result = reconcileCapture(project, root, { id: "capture-wrong", sceneKey: "wrong-scene", path: "captures/0.mp4", durationMs: 10000, sha256: "a".repeat(64), changedStepIds: [project.scenes[0].checkpointActionId], reason: "bad input" });
      expect(result).toMatchObject({ ok: false, code: "INVALID_RECAPTURE" });
      expect(project.scenes[0].captureId).toBe("capture-0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeVideo(path: string, durationSeconds: number, width: number, height: number): Promise<void> {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x355c7d:s=${width}x${height}:r=30:d=${durationSeconds}`, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "ffmpeg failed");
}
