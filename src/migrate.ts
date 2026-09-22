import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { loadProjectVersioned } from "./project.js";
import { parseProjectV1, type ProjectV1 } from "./schema-v1.js";
import {
  parseProjectV2,
  type Clip,
  type Layer,
  type MediaAsset,
  type ProjectV2,
} from "./schema-v2.js";

export interface MigrationWarning {
  code: "DERIVED" | "OMITTED" | "WARNING";
  field: string;
  detail: string;
}

export interface SemanticCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MigrationReport {
  sourceSchemaVersion: 1;
  destinationSchemaVersion: 2;
  sourceSha256: string;
  destinationSha256: string;
  preservedIds: {
    projectId: string;
    actionIds: string[];
    captureIds: string[];
    assetIds: string[];
    sceneIds: string[];
    clipIds: string[];
    overlayIds: string[];
    layerIds: string[];
    revisionIds: string[];
    outputIds: string[];
    recaptureLineageIds: string[];
  };
  warnings: MigrationWarning[];
  semanticEquivalence: {
    passed: boolean;
    checks: SemanticCheck[];
  };
  reused?: boolean;
}

export interface MigrateProjectOptions {
  /** Test seam for proving staged data is never published after interruption. */
  interruptAfterStage?: boolean;
}

export interface MigrateProjectResult {
  project: ProjectV2;
  report: MigrationReport;
  destinationRoot: string;
  reportPath: string;
  reused: boolean;
}

export class MigrationError extends Error {
  readonly code:
    | "MIGRATION_SOURCE_INVALID"
    | "MIGRATION_SOURCE_NOT_V1"
    | "MIGRATION_DESTINATION_INVALID"
    | "MIGRATION_DESTINATION_COLLISION"
    | "MIGRATION_INTERRUPTED"
    | "MIGRATION_FAILED";
  readonly report?: MigrationReport;

  constructor(code: MigrationError["code"], message: string, report?: MigrationReport) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.report = report;
  }
}

/** Returns a V2 read view while leaving a V1 project untouched on disk. */
export async function loadProjectView(root: string): Promise<ProjectV2> {
  const loaded = await loadProjectVersioned(root);
  return loaded.schemaVersion === 1 ? adaptV1ToV2(loaded.project) : loaded.project;
}

const VIDEO_TRACK_ID = "track-video";
const OVERLAY_TRACK_ID = "track-overlay";
const OPERATION_LOG_REF = "operations/operations.jsonl";

/** Pure, deterministic V1-to-V2 view adapter. It never reads or writes files. */
export function adaptV1ToV2(input: ProjectV1): ProjectV2 {
  const source = parseProjectV1(input);
  const lineagePredecessors = new Map(source.recaptureLineage.map((lineage) => [lineage.replacementCaptureId, lineage.previousCaptureId]));
  const assets: Record<string, MediaAsset> = {};
  for (const capture of Object.values(source.captures)) {
    const predecessor = capture.predecessorId ?? lineagePredecessors.get(capture.id);
    assets[capture.id] = {
      id: capture.id,
      type: "browser_capture",
      path: capture.path.replace(/\\/g, "/"),
      sha256: capture.sha256,
      probe: {
        durationMs: capture.durationMs,
        width: capture.width,
        height: capture.height,
        fps: capture.fps,
      },
      provenance: {
        kind: "browser",
        flowId: source.flow.id,
        sceneKey: capture.sceneKey,
        actionIds: [...capture.actionIds],
        checkpointActionId: capture.checkpointActionId,
        runId: capture.runId,
        capturedAt: capture.capturedAt,
        ...(predecessor ? { predecessorAssetId: predecessor } : {}),
      },
    };
  }

  const sortedScenes = [...source.scenes].sort((left, right) => left.order - right.order);
  let timelineStartMs = 0;
  const clips: Clip[] = [];
  for (const scene of sortedScenes) {
    const durationMs = Math.round((scene.sourceOutMs - scene.sourceInMs) / scene.speed);
    if (durationMs <= 0) throw new MigrationError("MIGRATION_FAILED", `scene ${scene.id} has no representable duration`);
    const transform = { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 };
    const focus = scene.focus;
    if (focus?.bounds && (focus.bounds.x + focus.bounds.width > 1 || focus.bounds.y + focus.bounds.height > 1)) {
      throw new MigrationError("MIGRATION_FAILED", `scene ${scene.id} focus bounds cannot be represented by V2 crop bounds`);
    }
    clips.push({
      id: scene.id,
      assetId: scene.captureId,
      trackId: VIDEO_TRACK_ID,
      timelineStartMs,
      sourceInMs: scene.sourceInMs,
      sourceOutMs: scene.sourceOutMs,
      speed: scene.speed,
      transform,
      ...(focus?.bounds ? { crop: { ...focus.bounds } } : {}),
      opacity: 1,
      audioGainDb: 0,
      transitionOut: { ...scene.transition },
    });
    timelineStartMs += durationMs;
    if (scene.transition.type === "crossfade") timelineStartMs -= scene.transition.durationMs;
    if (timelineStartMs < 0) throw new MigrationError("MIGRATION_FAILED", `scene ${scene.id} transition exceeds the timeline`);
  }

  const sceneById = new Map(source.scenes.map((scene) => [scene.id, scene]));
  const layers: Layer[] = Object.values(source.overlays).map((overlay) => {
    const scene = sceneById.get(overlay.sceneId);
    const clip = clips.find((candidate) => candidate.id === overlay.sceneId);
    if (!scene || !clip) throw new MigrationError("MIGRATION_FAILED", `overlay ${overlay.id} has no representable scene`);
    const durationMs = Math.round((overlay.endMs - overlay.startMs) / scene.speed);
    if (durationMs <= 0) throw new MigrationError("MIGRATION_FAILED", `overlay ${overlay.id} has no representable duration`);
    return {
      id: overlay.id,
      trackId: OVERLAY_TRACK_ID,
      kind: "text",
      timelineStartMs: clip.timelineStartMs + Math.round(overlay.startMs / scene.speed),
      durationMs,
      properties: { text: overlay.text },
      keyframes: [],
    };
  });

  const migrationRevisionId = migrationRevisionIdFor(source);
  const revisions = source.revisions.map((revision) => ({
    id: revision.id,
    ...(revision.parentId ? { parentId: revision.parentId } : {}),
    actor: revision.actor === "baseline" ? "migration" as const : revision.actor === "model" ? "agent" as const : revision.actor === "operator" ? "user" as const : "recapture" as const,
    operationIds: [...revision.operationIds],
    manifestSha256: revision.manifestSha256,
    createdAt: revision.createdAt,
  }));
  const currentRevision = source.revisions.find((revision) => revision.id === source.currentRevisionId);
  if (!currentRevision) throw new MigrationError("MIGRATION_FAILED", `current V1 revision is missing: ${source.currentRevisionId}`);

  const outputRefs = source.outputs.map((output) => ({
    id: output.verificationId,
    revisionId: output.revisionId,
    status: "passed" as const,
    evidenceRefs: [`verification/${output.verificationId}.json`],
  }));
  const draft: Omit<ProjectV2, "revisions" | "currentRevisionId"> & { revisions: ProjectV2["revisions"]; currentRevisionId: string } = {
    schemaVersion: 2,
    projectId: source.projectId,
    brief: { ...source.brief },
    assets,
    composition: {
      width: source.environment.viewport.width,
      height: source.environment.viewport.height,
      fps: Object.values(source.captures)[0]?.fps ?? 30,
      durationMs: Math.max(1, clips.reduce((end, clip) => Math.max(end, clip.timelineStartMs + Math.round((clip.sourceOutMs - clip.sourceInMs) / clip.speed)), 0)),
      tracks: [
        { id: VIDEO_TRACK_ID, kind: "video", order: 0, muted: false, locked: false },
        { id: OVERLAY_TRACK_ID, kind: "overlay", order: 1, muted: false, locked: false },
      ],
      clips,
      layers,
    },
    revisions: [
      ...revisions,
      {
        id: migrationRevisionId,
        parentId: source.currentRevisionId,
        actor: "migration",
        operationIds: [],
        manifestSha256: "0".repeat(64),
        createdAt: currentRevision.createdAt,
      },
    ],
    operationLogRef: OPERATION_LOG_REF,
    outputs: source.outputs.map((output) => ({
      outputId: output.id,
      revisionId: output.revisionId,
      ref: output.path.replace(/\\/g, "/"),
      sha256: output.renderJobSha256,
      probe: { ...output.ffprobe },
      sourceRevisionId: output.revisionId,
      renderJobHash: output.renderJobSha256,
      backendId: "native-ffmpeg",
      backendVersion: "v1",
      verificationRefId: output.verificationId,
    })),
    verification: {
      revisionId: migrationRevisionId,
      status: "stale",
      refs: outputRefs,
    },
    browser: {
      flows: { [source.flow.id]: source.flow },
      recaptureLineage: source.recaptureLineage.map((lineage) => ({
        id: lineage.id,
        previousAssetId: lineage.previousCaptureId,
        replacementAssetId: lineage.replacementCaptureId,
        changedActionIds: [...lineage.changedStepIds],
        reason: lineage.reason,
        revisionId: lineage.revisionId,
      })),
    },
    currentRevisionId: migrationRevisionId,
  };
  draft.revisions.at(-1)!.manifestSha256 = v2SemanticHash(draft);
  try {
    return parseProjectV2(draft);
  } catch (error) {
    throw new MigrationError("MIGRATION_FAILED", `V1 project cannot be represented by the V2 schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createMigrationReport(sourceInput: ProjectV1, destinationInput: ProjectV2): MigrationReport {
  const source = parseProjectV1(sourceInput);
  const destination = parseProjectV2(destinationInput);
  const warnings = migrationWarnings(source);
  const checks: SemanticCheck[] = [
    check("project identity", source.projectId === destination.projectId, "projectId is preserved"),
    check("brief", canonicalJson(source.brief) === canonicalJson(destination.brief), "brief fields are preserved"),
    check("browser flow actions", source.flow.id === destination.browser?.flows[source.flow.id]?.id && source.flow.steps.map((step) => step.id).join("|") === destination.browser?.flows[source.flow.id]?.steps.map((step) => step.id).join("|"), "flow and action identity are preserved"),
    check("capture hashes", Object.values(source.captures).every((capture) => destination.assets[capture.id]?.sha256 === capture.sha256), "capture hashes are preserved"),
    check("capture provenance", Object.values(source.captures).every((capture) => {
      const asset = destination.assets[capture.id];
      return asset?.provenance.kind === "browser" && asset.provenance.sceneKey === capture.sceneKey && asset.provenance.actionIds.join("|") === capture.actionIds.join("|") && asset.provenance.checkpointActionId === capture.checkpointActionId;
    }), "scene/action/checkpoint provenance is preserved"),
    check("scene clips", source.scenes.every((scene) => destination.composition.clips.some((clip) => clip.id === scene.id && clip.assetId === scene.captureId && clip.sourceInMs === scene.sourceInMs && clip.sourceOutMs === scene.sourceOutMs && clip.speed === scene.speed)), "scene identity and timing are preserved as clips"),
    check("overlay layers", Object.values(source.overlays).every((overlay) => destination.composition.layers.some((layer) => layer.id === overlay.id && "text" in layer.properties && layer.properties.text === overlay.text)), "overlay identity and text are preserved as layers"),
    check("revision ancestry", source.revisions.every((revision) => destination.revisions.some((candidate) => candidate.id === revision.id && candidate.parentId === revision.parentId && candidate.operationIds.join("|") === revision.operationIds.join("|"))), "historical revision IDs, parents, and operation references are preserved"),
    check("outputs", source.outputs.every((output) => destination.outputs.some((candidate) => candidate.outputId === output.id && candidate.sourceRevisionId === output.revisionId && candidate.ref === output.path.replace(/\\/g, "/") && candidate.renderJobHash === output.renderJobSha256)), "output references and hashes are preserved"),
    check("recapture lineage", source.recaptureLineage.every((lineage) => destination.browser?.recaptureLineage.some((candidate) => candidate.id === lineage.id && candidate.previousAssetId === lineage.previousCaptureId && candidate.replacementAssetId === lineage.replacementCaptureId && candidate.revisionId === lineage.revisionId)), "recapture lineage is preserved"),
  ];
  return {
    sourceSchemaVersion: 1,
    destinationSchemaVersion: 2,
    sourceSha256: hash(source),
    destinationSha256: hash(destination),
    preservedIds: {
      projectId: source.projectId,
      actionIds: source.flow.steps.map((step) => step.id),
      captureIds: Object.keys(source.captures),
      assetIds: Object.keys(destination.assets),
      sceneIds: source.scenes.map((scene) => scene.id),
      clipIds: destination.composition.clips.map((clip) => clip.id),
      overlayIds: Object.keys(source.overlays),
      layerIds: destination.composition.layers.map((layer) => layer.id),
      revisionIds: source.revisions.map((revision) => revision.id),
      outputIds: source.outputs.map((output) => output.id),
      recaptureLineageIds: source.recaptureLineage.map((lineage) => lineage.id),
    },
    warnings,
    semanticEquivalence: { passed: checks.every((item) => item.passed), checks },
  };
}

export async function migrateProject(sourceRootInput: string, destinationRootInput: string, options: MigrateProjectOptions = {}): Promise<MigrateProjectResult> {
  const sourceRoot = resolve(sourceRootInput);
  const destinationRoot = resolve(destinationRootInput);
  if (isSameOrNested(sourceRoot, destinationRoot) || isSameOrNested(destinationRoot, sourceRoot)) {
    throw new MigrationError("MIGRATION_DESTINATION_INVALID", "migration source and destination must be distinct, non-nested roots");
  }
  let sourceBytes: string;
  try {
    sourceBytes = await readFile(join(sourceRoot, "project.json"), "utf8");
  } catch (error) {
    throw new MigrationError("MIGRATION_SOURCE_INVALID", `unable to read V1 project: ${error instanceof Error ? error.message : String(error)}`);
  }
  let source: ProjectV1;
  try {
    source = parseProjectV1(JSON.parse(sourceBytes));
  } catch (error) {
    throw new MigrationError("MIGRATION_SOURCE_NOT_V1", `migration requires a valid V1 project: ${error instanceof Error ? error.message : String(error)}`);
  }
  let project: ProjectV2;
  try {
    project = adaptV1ToV2(source);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("MIGRATION_FAILED", error instanceof Error ? error.message : String(error));
  }
  const report = createMigrationReport(source, project);
  report.sourceSha256 = hashText(sourceBytes);
  if (!report.semanticEquivalence.passed) throw new MigrationError("MIGRATION_FAILED", "migration semantic equivalence checks failed", report);
  const destinationExists = await pathExists(destinationRoot);
  if (destinationExists) return reuseOrCollision(destinationRoot, project, report);

  const parent = dirname(destinationRoot);
  await mkdir(parent, { recursive: true });
  const sourceRealRoot = await realpath(sourceRoot);
  const destinationRealParent = await realpath(parent);
  const destinationRealRoot = join(destinationRealParent, destinationRoot.split(/[\\/]/).at(-1) ?? "replex");
  if (isSameOrNested(sourceRealRoot, destinationRealRoot) || isSameOrNested(destinationRealRoot, sourceRealRoot)) {
    throw new MigrationError("MIGRATION_DESTINATION_INVALID", "migration source and destination must be distinct, non-nested roots");
  }
  const stage = await mkdtemp(join(parent, `.${destinationRoot.split(/[\\/]/).at(-1) ?? "replex"}.migration-`));
  let published = false;
  try {
    await copyReferencedArtifacts(sourceRoot, stage, source, report);
    await writeFile(join(stage, "project.json"), `${JSON.stringify(project, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    parseProjectV2(JSON.parse(await readFile(join(stage, "project.json"), "utf8")));
    await writeFile(join(stage, "migration-report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (options.interruptAfterStage) throw new MigrationError("MIGRATION_INTERRUPTED", "migration interrupted before atomic publish", report);
    try {
      await rename(stage, destinationRoot);
    } catch (error) {
      throw new MigrationError("MIGRATION_DESTINATION_COLLISION", `migration destination became occupied: ${error instanceof Error ? error.message : String(error)}`, report);
    }
    published = true;
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
  }
  return { project, report, destinationRoot, reportPath: join(destinationRoot, "migration-report.json"), reused: false };
}

function check(name: string, passed: boolean, detail: string): SemanticCheck {
  return { name, passed, detail };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function v2SemanticHash(value: Partial<ProjectV2>): string {
  const { currentRevisionId: _currentRevisionId, revisions: _revisions, outputs: _outputs, ...semantic } = value;
  return hash(semantic);
}

function migrationRevisionIdFor(source: ProjectV1): string {
  const ids = new Set(source.revisions.map((revision) => revision.id));
  const base = `migration-${source.currentRevisionId}`;
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function migrationWarnings(source: ProjectV1): MigrationWarning[] {
  const warnings: MigrationWarning[] = [
    { code: "OMITTED", field: "environment", detail: "V2 does not yet model the V1 capture environment; viewport is used for composition dimensions." },
    { code: "DERIVED", field: "operationLog", detail: "V2 uses a project-relative operations/operations.jsonl reference; V1 operation records are copied when available." },
  ];
  for (const capture of Object.values(source.captures)) {
    if (capture.screenshotPath) warnings.push({ code: "OMITTED", field: `captures.${capture.id}.screenshotPath`, detail: "V2 browser asset provenance has no screenshot artifact field." });
    if (capture.tracePath) warnings.push({ code: "OMITTED", field: `captures.${capture.id}.tracePath`, detail: "V2 browser asset provenance has no trace artifact field." });
  }
  for (const scene of source.scenes) if (scene.focus) warnings.push({ code: "DERIVED", field: `scenes.${scene.id}.focus`, detail: "V1 focus bounds become a static V2 crop; temporal focus timing and preset behavior are not represented." });
  for (const overlay of Object.values(source.overlays)) warnings.push({ code: "DERIVED", field: `overlays.${overlay.id}.placement`, detail: "V2 text layers preserve text and timing but do not yet model V1 placement or title/callout styling." });
  for (const revision of source.revisions) if (revision.actor !== "recapture") warnings.push({ code: "DERIVED", field: `revisions.${revision.id}.actor`, detail: `V1 actor ${revision.actor} maps to the closest V2 actor vocabulary.` });
  if (source.outputs.length) warnings.push({ code: "DERIVED", field: "outputs.backend", detail: "V1 output records do not carry backend identity/version; native-ffmpeg/v1 is derived." });
  return warnings;
}

function isSameOrNested(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith(".." + sep) && relation !== ".." && !isAbsolute(relation));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function reuseOrCollision(destinationRoot: string, project: ProjectV2, report: MigrationReport): Promise<MigrateProjectResult> {
  return (async () => {
    try {
      const existing = parseProjectV2(JSON.parse(await readFile(join(destinationRoot, "project.json"), "utf8")));
      if (hash(existing) !== hash(project)) throw new Error("destination contains a different V2 project");
      const existingReportPath = join(destinationRoot, "migration-report.json");
      const existingReport = await readFile(existingReportPath, "utf8").then((text) => JSON.parse(text) as MigrationReport).catch(() => undefined);
      return { project: existing, report: { ...(existingReport ?? report), reused: true }, destinationRoot, reportPath: existingReportPath, reused: true };
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError("MIGRATION_DESTINATION_COLLISION", `migration destination already exists: ${error instanceof Error ? error.message : String(error)}`, report);
    }
  })();
}

async function copyReferencedArtifacts(sourceRoot: string, stageRoot: string, source: ProjectV1, _report: MigrationReport): Promise<void> {
  const refs = new Map<string, string>([["operations.jsonl", OPERATION_LOG_REF]]);
  const captureHashes = new Map<string, string>();
  for (const capture of Object.values(source.captures)) {
    refs.set(capture.path, capture.path);
    captureHashes.set(capture.path, capture.sha256);
    if (capture.screenshotPath) refs.set(capture.screenshotPath, capture.screenshotPath);
    if (capture.tracePath) refs.set(capture.tracePath, capture.tracePath);
  }
  for (const output of source.outputs) {
    refs.set(output.path, output.path);
    const verificationFile = output.verificationId.replace(/^verification-/, "");
    refs.set(`verification/${verificationFile}.json`, `verification/${output.verificationId}.json`);
  }
  for (const [sourceRef, destinationRef] of refs) {
    const sourcePath = await safeContainedPath(sourceRoot, sourceRef);
    if (!sourcePath || !(await pathExists(sourcePath))) {
      _report.warnings.push({ code: "WARNING", field: `artifact.${sourceRef}`, detail: "Referenced V1 artifact is absent; the V2 reference is retained and must be resolved before media execution." });
      continue;
    }
    const expectedHash = captureHashes.get(sourceRef);
    if (expectedHash && hashBytes(await readFile(sourcePath)) !== expectedHash) {
      throw new MigrationError("MIGRATION_FAILED", `capture artifact does not match its recorded SHA-256: ${sourceRef}`);
    }
    const destinationPath = join(stageRoot, destinationRef);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
  const operationLogPath = join(stageRoot, OPERATION_LOG_REF);
  if (!(await pathExists(operationLogPath))) {
    await mkdir(dirname(operationLogPath), { recursive: true });
    await writeFile(operationLogPath, "", { encoding: "utf8", flag: "wx" });
  }
}

async function safeContainedPath(root: string, candidate: string): Promise<string | undefined> {
  const normalized = candidate.replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || normalized.split("/").includes("..")) throw new MigrationError("MIGRATION_FAILED", `referenced artifact escapes the V1 project root: ${candidate}`);
  const resolved = resolve(root, normalized);
  const relation = relative(resolve(root), resolved);
  if (relation === "" || relation.startsWith(".." + sep) || relation === ".." || isAbsolute(relation)) throw new MigrationError("MIGRATION_FAILED", `referenced artifact escapes the V1 project root: ${candidate}`);
  if (!(await pathExists(resolved))) return resolved;
  const actualRoot = await realpath(root);
  const actualPath = await realpath(resolved);
  const actualRelation = relative(actualRoot, actualPath);
  if (actualRelation === "" || actualRelation.startsWith(".." + sep) || actualRelation === ".." || isAbsolute(actualRelation)) throw new MigrationError("MIGRATION_FAILED", `referenced artifact escapes the V1 project root: ${candidate}`);
  return actualPath;
}
