import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseProjectV1, type ProjectV1 } from "../src/schema-v1.js";
import { adaptV1ToV2, createMigrationReport, loadProjectView, migrateProject } from "../src/migrate.js";
import { ProjectV2Schema } from "../src/schema-v2.js";
import { loadProject, loadProjectVersioned } from "../src/project.js";
import { runCli } from "../src/cli.js";
import { semanticHashV2 } from "../src/operations-v2.js";

async function golden(): Promise<ProjectV1> {
  return parseProjectV1(JSON.parse(await readFile(new URL("./golden/project-v1.json", import.meta.url), "utf8")));
}

describe("V1 to V2 migration", () => {
  it("adapts the golden project without losing browser identity or stable IDs", async () => {
    const source = await golden();
    const migrated = adaptV1ToV2(source);
    const parsed = ProjectV2Schema.parse(migrated);

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.projectId).toBe(source.projectId);
    expect(Object.keys(parsed.assets)).toEqual(Object.keys(source.captures));
    expect(Object.values(parsed.assets).map((asset) => asset.sha256)).toEqual(Object.values(source.captures).map((capture) => capture.sha256));
    expect(parsed.composition.clips.map((clip) => clip.id)).toEqual(source.scenes.map((scene) => scene.id));
    expect(parsed.composition.layers).toHaveLength(0);
    expect(parsed.browser?.flows[source.flow.id]).toEqual(source.flow);
    expect(parsed.currentRevisionId).toBe(`migration-${source.currentRevisionId}`);
    expect(parsed.revisions.at(-1)?.manifestSha256).toBe(semanticHashV2(parsed));
  });

  it("is deterministic and reports semantic equivalence plus deliberate omissions", async () => {
    const source = await golden();
    const first = adaptV1ToV2(source);
    const second = adaptV1ToV2(source);
    const firstReport = createMigrationReport(source, first);
    const secondReport = createMigrationReport(source, second);

    expect(first).toEqual(second);
    expect(firstReport).toEqual(secondReport);
    expect(firstReport.semanticEquivalence.passed).toBe(true);
    expect(firstReport.preservedIds.sceneIds).toEqual(source.scenes.map((scene) => scene.id));
    expect(firstReport.preservedIds.captureIds).toEqual(Object.keys(source.captures));
    expect(firstReport.warnings.map((warning) => warning.field)).toEqual(expect.arrayContaining(["environment", "operationLog"]));
  });

  it("normalizes Windows separators in semantic equivalence", async () => {
    const source = await golden();
    for (const capture of Object.values(source.captures)) capture.path = capture.path.replaceAll("/", "\\\\");
    for (const output of source.outputs) output.path = output.path.replaceAll("/", "\\\\");
    const report = createMigrationReport(source, adaptV1ToV2(source));
    expect(report.semanticEquivalence.passed).toBe(true);
    expect(report.semanticEquivalence.checks.every((check) => check.passed)).toBe(true);
  });

  it("preserves overlays, output references, revision ancestry, and recapture lineage", () => {
    const source = parseProjectV1({
      schemaVersion: 1,
      projectId: "migration-project",
      brief: { audience: "Founders", message: "Show it", targetDurationMs: 30000 },
      environment: {
        appOrigin: "https://example.test",
        allowedOrigins: ["https://example.test"],
        viewport: { width: 1920, height: 1080 },
        locale: "en-US",
        timezone: "UTC",
        browserVersion: "test",
        reducedMotion: "reduce",
        colorScheme: "light",
      },
      flow: {
        id: "flow",
        approvedAt: "2026-09-01T00:00:00.000Z",
        prohibitedActions: [],
        steps: [{
          id: "action",
          order: 0,
          action: "goto",
          target: { kind: "url", value: "https://example.test/" },
          consequential: false,
          approved: true,
          checkpoint: { kind: "url", expected: "https://example.test/" },
          sceneKey: "scene",
        }],
      },
      captures: {
        "capture-old": {
          id: "capture-old", sceneKey: "scene", runId: "run-old", actionIds: ["action"], checkpointActionId: "action",
          path: "captures/old.webm", sha256: "a".repeat(64), durationMs: 30000, width: 1920, height: 1080, fps: 30,
          capturedAt: "2026-09-01T00:00:00.000Z",
        },
        "capture-new": {
          id: "capture-new", sceneKey: "scene", runId: "run-new", actionIds: ["action"], checkpointActionId: "action",
          path: "captures/new.webm", sha256: "b".repeat(64), durationMs: 30000, width: 1920, height: 1080, fps: 30,
          capturedAt: "2026-09-02T00:00:00.000Z", predecessorId: "capture-old",
        },
      },
      scenes: [{
        id: "scene-id", sceneKey: "scene", captureId: "capture-new", actionIds: ["action"], checkpointActionId: "action",
        sourceInMs: 0, sourceOutMs: 30000, speed: 1, order: 0, transition: { type: "cut", durationMs: 0 },
      }],
      overlays: {
        "overlay-id": { id: "overlay-id", sceneId: "scene-id", kind: "title", text: "Hello", placement: "top", startMs: 0, endMs: 1000 },
      },
      outputs: [{
        id: "output-id", revisionId: "revision-1", renderJobSha256: "c".repeat(64), path: "renders/output.mp4",
        ffprobe: { durationMs: 30000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" }, verificationId: "verification-1",
      }],
      recaptureLineage: [{ id: "lineage-id", sceneId: "scene-id", previousCaptureId: "capture-old", replacementCaptureId: "capture-new", changedStepIds: ["action"], reason: "changed state", revisionId: "revision-1" }],
      currentRevisionId: "revision-1",
      revisions: [
        { id: "revision-0", actor: "baseline", operationIds: [], manifestSha256: "d".repeat(64), createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "revision-1", parentId: "revision-0", actor: "recapture", operationIds: ["operation-1"], manifestSha256: "e".repeat(64), createdAt: "2026-09-02T00:00:00.000Z" },
      ],
    });

    const migrated = adaptV1ToV2(source);
    expect(migrated.composition.layers[0]).toMatchObject({ id: "overlay-id", kind: "text", properties: { text: "Hello" } });
    expect(migrated.outputs).toEqual([]);
    expect(migrated.verification.refs).toEqual([]);
    expect(migrated.browser?.recaptureLineage[0]).toMatchObject({ previousAssetId: "capture-old", replacementAssetId: "capture-new", changedActionIds: ["action"] });
    expect(migrated.revisions.map((revision) => revision.id)).toEqual(["revision-0", "revision-1", "migration-revision-1"]);
    expect(ProjectV2Schema.parse(migrated)).toEqual(migrated);
  });
});

describe("explicit non-destructive migration", () => {
  it("version-dispatches normal reads without writing or adapting on disk", async () => {
    const { mkdtemp, readFile: readFileBytes, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "replex-versioned-read-"));
    const source = await golden();
    const sourceBytes = `${JSON.stringify(source, null, 2)}\n`;
    try {
      await writeFile(join(root, "project.json"), sourceBytes);
      await expect(loadProjectVersioned(root)).resolves.toMatchObject({ schemaVersion: 1, project: { schemaVersion: 1 } });
      await expect(loadProjectView(root)).resolves.toMatchObject({ schemaVersion: 2, projectId: source.projectId });
      expect(await readFileBytes(join(root, "project.json"), "utf8")).toBe(sourceBytes);

      await writeFile(join(root, "project.json"), `${JSON.stringify(adaptV1ToV2(source))}\n`);
      await expect(loadProject(root)).rejects.toMatchObject({ code: "PROJECT_VERSION_MISMATCH" });
      await expect(loadProjectVersioned(root)).resolves.toMatchObject({ schemaVersion: 2, project: { schemaVersion: 2 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes migration through the explicit CLI command without startup media tools", async () => {
    const { mkdtemp, readFile: read, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-cli-v1-"));
    const destinationRoot = join(tmpdir(), `replex-cli-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const source = await golden();
    try {
      await writeFile(join(sourceRoot, "project.json"), `${JSON.stringify(source, null, 2)}\n`);
      const output = { stdout: "", stderr: "" };
      const exitCode = await runCli(["migrate-project", "--to", "2", "--project", sourceRoot, "--output", destinationRoot], {
        io: { stdout: (text) => { output.stdout += text; }, stderr: (text) => { output.stderr += text; } },
      });
      expect(exitCode, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({ command: "migrate-project", status: "completed", report: { destinationSchemaVersion: 2 } });
      await expect(read(join(destinationRoot, "project.json"), "utf8")).resolves.toContain('"schemaVersion": 2');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destinationRoot, { recursive: true, force: true });
    }
  });

  it("publishes a distinct destination and leaves source bytes unchanged", async () => {
    const { mkdtemp, readFile: read, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-v1-source-"));
    const destinationRoot = join(tmpdir(), `replex-v2-destination-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const source = await golden();
    const sourceBytes = `${JSON.stringify(source, null, 2)}\n`;
    try {
      await writeFile(join(sourceRoot, "project.json"), sourceBytes);
      const result = await migrateProject(sourceRoot, destinationRoot);
      expect(await read(join(sourceRoot, "project.json"), "utf8")).toBe(sourceBytes);
      expect(JSON.parse(await read(join(destinationRoot, "project.json"), "utf8"))).toMatchObject({ schemaVersion: 2, projectId: source.projectId });
      expect(result.report.semanticEquivalence.passed).toBe(true);
      expect(await read(join(destinationRoot, "migration-report.json"), "utf8")).toContain('"destinationSchemaVersion": 2');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destinationRoot, { recursive: true, force: true });
    }
  });

  it("removes an interrupted staging directory and safely reuses an identical published destination", async () => {
    const { mkdtemp, readFile: read, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-v1-source-"));
    const destinationRoot = join(tmpdir(), `replex-v2-interrupted-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const source = await golden();
    try {
      await writeFile(join(sourceRoot, "project.json"), `${JSON.stringify(source, null, 2)}\n`);
      await expect(migrateProject(sourceRoot, destinationRoot, { interruptAfterStage: true })).rejects.toMatchObject({ code: "MIGRATION_INTERRUPTED" });
      await expect(read(join(destinationRoot, "project.json"), "utf8")).rejects.toThrow();
      const first = await migrateProject(sourceRoot, destinationRoot);
      const second = await migrateProject(sourceRoot, destinationRoot);
      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.report.reused).toBe(true);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destinationRoot, { recursive: true, force: true });
    }
  });

  it("rejects same-root and collision destinations without touching the source", async () => {
    const { mkdtemp, readFile: read, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-v1-source-"));
    const collisionRoot = await mkdtemp(join(tmpdir(), "replex-v2-collision-"));
    const source = await golden();
    const sourceBytes = `${JSON.stringify(source, null, 2)}\n`;
    try {
      await writeFile(join(sourceRoot, "project.json"), sourceBytes);
      await expect(migrateProject(sourceRoot, sourceRoot)).rejects.toMatchObject({ code: "MIGRATION_DESTINATION_INVALID" });
      await expect(migrateProject(sourceRoot, collisionRoot)).rejects.toMatchObject({ code: "MIGRATION_DESTINATION_COLLISION" });
      expect(await read(join(sourceRoot, "project.json"), "utf8")).toBe(sourceBytes);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(collisionRoot, { recursive: true, force: true });
    }
  });

  it("rejects referenced artifacts that escape through a junction", async () => {
    const { access, mkdtemp, rm, symlink, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-v1-source-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "replex-v1-outside-"));
    const destinationRoot = join(tmpdir(), `replex-v2-junction-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const source = await golden();
    try {
      await writeFile(join(sourceRoot, "project.json"), `${JSON.stringify(source, null, 2)}\n`);
      await writeFile(join(outsideRoot, "open.webm"), "outside");
      await symlink(outsideRoot, join(sourceRoot, "captures"), "junction");
      await expect(migrateProject(sourceRoot, destinationRoot)).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
      await expect(access(destinationRoot)).rejects.toThrow();
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
      await rm(destinationRoot, { recursive: true, force: true });
    }
  });

  it("hashes copied render artifacts and omits absent outputs without passed verification", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const source = await golden();
    source.outputs = [
      { id: "output-present", revisionId: source.currentRevisionId, renderJobSha256: "c".repeat(64), path: "renders/present.mp4", ffprobe: { durationMs: 1000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" }, verificationId: "verification-present" },
      { id: "output-missing", revisionId: source.currentRevisionId, renderJobSha256: "d".repeat(64), path: "renders/missing.mp4", ffprobe: { durationMs: 1000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" }, verificationId: "verification-missing" },
    ];
    const sourceRoot = await mkdtemp(join(tmpdir(), "replex-output-source-"));
    const destinationRoot = join(tmpdir(), `replex-output-destination-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const bytes = Buffer.from("actual rendered media bytes");
    try {
      await mkdir(join(sourceRoot, "renders"), { recursive: true });
      await writeFile(join(sourceRoot, "project.json"), JSON.stringify(source));
      await writeFile(join(sourceRoot, "renders/present.mp4"), bytes);
      const result = await migrateProject(sourceRoot, destinationRoot);
      expect(result.project.outputs).toHaveLength(1);
      expect(result.project.outputs[0]).toMatchObject({ outputId: "output-present", sha256: createHash("sha256").update(bytes).digest("hex"), renderJobHash: "c".repeat(64) });
      expect(result.project.outputs[0].sha256).not.toBe("c".repeat(64));
      expect(createHash("sha256").update(await readFile(join(destinationRoot, "renders/present.mp4"))).digest("hex")).toBe(result.project.outputs[0].sha256);
      expect(result.project.verification.refs.map((ref) => ref.id)).toEqual(["verification-present"]);
      expect(result.project.verification.refs).not.toContainEqual(expect.objectContaining({ id: "verification-missing" }));
      expect(result.report.warnings).toContainEqual(expect.objectContaining({ field: "outputs.output-missing", code: "OMITTED" }));
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(destinationRoot, { recursive: true, force: true });
    }
  });

  it("maps V1 crossfades to adjacent non-overlapping clips", async () => {
    const source = await golden();
    source.scenes[0].transition = { type: "crossfade", durationMs: 500 };
    const migrated = adaptV1ToV2(source);
    const [first, second] = migrated.composition.clips;
    expect(first.timelineStartMs + (first.sourceOutMs - first.sourceInMs) / first.speed).toBe(second.timelineStartMs);
    expect(second.timelineStartMs).toBe(10000);
    expect(() => ProjectV2Schema.parse(migrated)).not.toThrow();
  });
});
