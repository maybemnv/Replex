import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import {
  BriefSchema,
  EnvironmentSchema,
  FlowSchema,
  ProjectSchema,
  type Brief,
  type Capture,
  type Environment,
  type Flow,
  type Project,
} from "./schema.js";

export type SourceCapture = ProjectCaptureInput;

export type { Overlay, Project, RecaptureLineage, RenderOutput, Revision, Scene } from "./schema.js";

export type ProjectCaptureInput = {
  id: string;
  sceneKey: string;
  sourcePath?: string;
  path?: string;
  runId?: string;
  actionIds?: string[];
  checkpointActionId?: string;
  sha256?: string;
  durationMs: number;
  width?: number;
  height?: number;
  fps?: 30;
  capturedAt?: string;
  predecessorId?: string;
};

export interface ProjectInput {
  projectId: string;
  brief: Brief;
  environment: Environment;
  flow: Flow;
  captures: ProjectCaptureInput[] | Record<string, ProjectCaptureInput>;
}

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CAPTURED_AT = "1970-01-01T00:00:00.000Z";

export function createProject(input: ProjectInput): Project {
  const brief = BriefSchema.parse(input.brief);
  const environment = EnvironmentSchema.parse(input.environment);
  const flow = FlowSchema.parse(input.flow);
  const sourceCaptures = Array.isArray(input.captures) ? input.captures : Object.values(input.captures);
  const sceneKeys = [...new Set(flow.steps.flatMap((step) => (step.sceneKey ? [step.sceneKey] : [])))];
  const captureRecords = sourceCaptures.map((capture) => normalizeCapture(capture, flow, environment));
  const captures: Record<string, Capture> = {};
  for (const capture of captureRecords) {
    if (captures[capture.id]) throw new Error(`duplicate capture id: ${capture.id}`);
    captures[capture.id] = capture;
  }
  const captureByScene = new Map<string, Capture>();
  for (const capture of captureRecords) {
    if (captureByScene.has(capture.sceneKey)) throw new Error(`duplicate capture for scene key: ${capture.sceneKey}`);
    captureByScene.set(capture.sceneKey, capture);
  }
  const scenes = sceneKeys.map((sceneKey, order) => {
    const capture = captureByScene.get(sceneKey);
    if (!capture) throw new Error(`missing capture for scene key: ${sceneKey}`);
    const steps = flow.steps.filter((step) => step.sceneKey === sceneKey);
    return {
      id: stableSceneId(input.projectId, sceneKey),
      sceneKey,
      captureId: capture.id,
      actionIds: steps.map((step) => step.id),
      checkpointActionId: capture.checkpointActionId,
      sourceInMs: 0,
      sourceOutMs: capture.durationMs,
      speed: 1 as const,
      order,
      transition: { type: "cut" as const, durationMs: 0 as const },
    };
  });
  const base = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    brief,
    environment,
    flow,
    captures,
    scenes,
    overlays: {},
    outputs: [],
    recaptureLineage: [],
    currentRevisionId: "revision-0",
  };
  const manifestSha256 = semanticHash(base as unknown as Project);
  return ProjectSchema.parse({
    ...base,
    revisions: [{
      id: "revision-0",
      actor: "baseline",
      operationIds: [],
      manifestSha256,
      createdAt: new Date().toISOString(),
    }],
  });
}

export function stableSceneId(projectId: string, sceneKey: string): string {
  const namespace = UUID_PATTERN.test(projectId) ? projectId : uuidv5(DNS_NAMESPACE, projectId);
  return uuidv5(namespace, sceneKey);
}

export function uuidv5(namespace: string, name: string): string {
  if (!UUID_PATTERN.test(namespace)) throw new Error("UUIDv5 namespace must be a UUID");
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function semanticHash(project: Project | Record<string, unknown>): string {
  const { currentRevisionId: _currentRevisionId, revisions: _revisions, outputs: _outputs, revision: _revision, ...semanticProject } = project as Record<string, unknown>;
  return createHash("sha256").update(canonicalJson(semanticProject)).digest("hex");
}

export async function writeRevision(
  root: string,
  project: Project,
  options: { interruptBeforeCommit?: boolean } = {},
): Promise<void> {
  const canonicalProject = ProjectSchema.parse(stripLegacyRevision(project));
  const serialized = JSON.stringify(canonicalProject, null, 2) + "\n";
  const revisionsRoot = join(root, "revisions");
  await mkdir(revisionsRoot, { recursive: true });
  const revisionPath = join(revisionsRoot, `${canonicalProject.currentRevisionId}.json`);
  if (await exists(revisionPath)) throw new Error(`revision already exists: ${canonicalProject.currentRevisionId}`);
  await writeDurable(revisionPath, serialized);
  if (options.interruptBeforeCommit) throw new Error("simulated interruption");
  await writeDurable(join(root, "project.json"), serialized);
}

export async function loadProject(root: string): Promise<Project> {
  return ProjectSchema.parse(JSON.parse(await readFile(join(root, "project.json"), "utf8")));
}

function normalizeCapture(input: ProjectCaptureInput, flow: Flow, environment: Environment): Capture {
  const steps = flow.steps.filter((step) => step.sceneKey === input.sceneKey);
  const actionIds = input.actionIds?.length ? input.actionIds : steps.map((step) => step.id);
  const checkpointActionId = input.checkpointActionId ?? actionIds.at(-1);
  if (!checkpointActionId) throw new Error(`missing checkpoint for scene key: ${input.sceneKey}`);
  const path = input.path ?? input.sourcePath ?? `captures/${input.id}.webm`;
  const runId = input.runId ?? `run-${input.id}`;
  const capturedAt = input.capturedAt ?? DEFAULT_CAPTURED_AT;
  const sha256 = input.sha256 ?? createHash("sha256").update(canonicalJson({ id: input.id, runId, actionIds, path, durationMs: input.durationMs })).digest("hex");
  return {
    id: input.id,
    sceneKey: input.sceneKey,
    runId,
    actionIds,
    checkpointActionId,
    path,
    sha256,
    durationMs: input.durationMs,
    width: input.width ?? environment.viewport.width,
    height: input.height ?? environment.viewport.height,
    fps: input.fps ?? 30,
    capturedAt,
    ...(input.predecessorId ? { predecessorId: input.predecessorId } : {}),
  };
}

async function writeDurable(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${parsePath(path).base}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function stripLegacyRevision(project: Project): Record<string, unknown> {
  const { revision: _revision, ...canonical } = project as Project & { revision?: unknown };
  return canonical;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
