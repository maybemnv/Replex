import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runServiceCommandCli } from "../src/service/command-cli.js";
import { ffmpegPath, mediaAvailable } from "./media.js";

describe("local service command CLI media import", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it.skipIf(!mediaAvailable)("authorizes and imports a selected file in the one-shot executor process", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "replex-v2-command-workspace-"));
    const inputRoot = await mkdtemp(join(tmpdir(), "replex-v2-command-input-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-v2-command-source-"));
    roots.push(workspace, inputRoot, sourceRoot);
    const sourcePath = join(sourceRoot, "cli-selected.mp4");
    const fixture = spawnSync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=8:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath], { windowsHide: true, shell: false, timeout: 30_000 });
    expect(fixture.status, fixture.stderr?.toString()).toBe(0);

    const createInput = join(inputRoot, "create.json");
    await writeFile(createInput, JSON.stringify({ contractVersion: "v1", idempotencyKey: "cli-create", name: "CLI import" }));
    let stdout = "";
    let stderr = "";
    expect(await runServiceCommandCli(["--workspace", workspace, "--command", "create_project", "--input", createInput], {
      stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; },
    })).toBe(0);
    expect(stderr).toBe("");
    const project = JSON.parse(stdout) as { projectId: string; revisionId: string };

    const importInput = join(inputRoot, "import.json");
    await writeFile(importInput, JSON.stringify({
      contractVersion: "v1", idempotencyKey: "cli-import", projectId: project.projectId,
      baseRevisionId: project.revisionId,
    }));
    stdout = "";
    stderr = "";
    expect(await runServiceCommandCli([
      "--workspace", workspace, "--command", "import_asset", "--input", importInput,
      "--source-path", sourcePath, "--import-root", sourceRoot,
    ], { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } })).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ state: "succeeded", result: { assetId: expect.any(String), revisionId: expect.any(String) } });
    expect(stdout).not.toContain(sourcePath);
  }, 60_000);
});
