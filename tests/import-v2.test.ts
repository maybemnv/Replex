import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { semanticHashV2 } from "../src/operations-v2.js";
import { ProjectV2Schema, type ProjectV2 } from "../src/schema-v2.js";
import { authorizeLocalImport, importLocalAssetV2 } from "../src/import-v2.js";

const roots: string[] = [];

function emptyProject(): ProjectV2 {
  const project = ProjectV2Schema.parse({
    schemaVersion: 2,
    projectId: "project-import-test",
    brief: {},
    assets: {},
    composition: {
      width: 320,
      height: 240,
      fps: 24,
      durationMs: 1,
      tracks: [
        { id: "track-video", kind: "video", order: 0, muted: false, locked: false },
        { id: "track-audio", kind: "audio", order: 1, muted: false, locked: false },
        { id: "track-overlay", kind: "overlay", order: 2, muted: false, locked: false },
      ],
      clips: [],
      layers: [],
    },
    revisions: [{ id: "revision-0", actor: "user", operationIds: [], manifestSha256: "0".repeat(64), createdAt: "2026-09-25T00:00:00.000Z" }],
    operationLogRef: "operations/operations.jsonl",
    outputs: [],
    verification: { revisionId: "revision-0", status: "unknown", refs: [] },
    currentRevisionId: "revision-0",
  });
  project.revisions[0].manifestSha256 = semanticHashV2(project);
  return project;
}

async function workspace(): Promise<{ root: string; sourceRoot: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "replex-v2-import-"));
  roots.push(root);
  const sourceRoot = join(root, "authorized");
  const projectRoot = join(root, "project");
  await mkdir(sourceRoot);
  await mkdir(projectRoot);
  return { root, sourceRoot, projectRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 local asset import", () => {
  it("stages and validates media before one canonical import revision, preserving provenance on byte deduplication", async () => {
    const { sourceRoot, projectRoot } = await workspace();
    const filename = "product.ppm";
    const sourcePath = join(sourceRoot, filename);
    const imageBytes = Buffer.concat([
      Buffer.from("P6\n2 2\n255\n", "ascii"),
      Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
    ]);
    await writeFile(sourcePath, imageBytes);

    const original = emptyProject();
    const firstSource = await authorizeLocalImport(sourcePath, [sourceRoot]);
    const first = await importLocalAssetV2(original, projectRoot, firstSource);

    expect(first.project.assets[first.asset.id]).toEqual(first.asset);
    expect(first.asset).toMatchObject({ type: "image", provenance: { kind: "upload", originalFilename: filename, importMethod: "file_picker" } });
    expect(first.project.revisions).toHaveLength(2);
    expect(first.project.currentRevisionId).toBe(first.revisionId);
    expect(first.operationLog).toHaveLength(1);
    expect(first.operationLog[0].input).toMatchObject({ type: "import_asset", asset: { id: first.asset.id } });
    expect(original.assets).toEqual({});
    expect(first.asset.sha256).toBe(createHash("sha256").update(imageBytes).digest("hex"));
    expect(await readFile(join(projectRoot, first.asset.path!))).toEqual(imageBytes);

    const secondSource = await authorizeLocalImport(sourcePath, [sourceRoot]);
    const second = await importLocalAssetV2(first.project, projectRoot, secondSource);
    expect(second.asset.id).not.toBe(first.asset.id);
    expect(second.asset.path).toBe(first.asset.path);
    expect(second.asset.provenance).toMatchObject({ kind: "upload", originalFilename: filename, sourceSha256: first.asset.sha256 });
    expect(Object.keys(second.project.assets)).toHaveLength(2);
  });
});
