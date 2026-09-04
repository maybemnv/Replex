import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brief, Environment, Flow } from "./schema.js";

export interface SourceCapture {
  id: string;
  sceneKey: string;
  sourcePath: string;
  durationMs: number;
}

export interface Scene {
  id: string;
  sceneKey: string;
  captureId: string;
}

export interface Project {
  schemaVersion: 1;
  projectId: string;
  brief: Brief;
  environment: Environment;
  flow: Flow;
  captures: SourceCapture[];
  scenes: Scene[];
  currentRevisionId: string;
  revision: { id: string; manifestSha256: string };
}

export interface ProjectInput {
  projectId: string;
  brief: Brief;
  environment: Environment;
  flow: Flow;
  captures: SourceCapture[];
}

export function createProject(input: ProjectInput): Project {
  const sceneKeys = [...new Set(input.flow.steps.flatMap((step) => (step.sceneKey ? [step.sceneKey] : [])))];
  const captures = new Map(input.captures.map((capture) => [capture.sceneKey, capture]));
  const scenes = sceneKeys.map((sceneKey) => {
    const capture = captures.get(sceneKey);
    if (!capture) throw new Error(`missing capture for scene key: ${sceneKey}`);
    return { id: stableSceneId(input.projectId, sceneKey), sceneKey, captureId: capture.id };
  });
  const project: Project = {
    schemaVersion: 1,
    projectId: input.projectId,
    brief: input.brief,
    environment: input.environment,
    flow: input.flow,
    captures: input.captures,
    scenes,
    currentRevisionId: "revision-0",
    revision: { id: "revision-0", manifestSha256: "" },
  };
  project.revision.manifestSha256 = semanticHash(project);
  return project;
}

export function stableSceneId(projectId: string, sceneKey: string): string {
  return `scene-${createHash("sha256").update(`${projectId}:${sceneKey}`).digest("hex").slice(0, 24)}`;
}

export function semanticHash(project: Project): string {
  const { currentRevisionId: _currentRevisionId, revision: _revision, ...semanticProject } = project;
  return createHash("sha256").update(canonicalJson(semanticProject)).digest("hex");
}

export async function writeRevision(
  root: string,
  project: Project,
  options: { interruptBeforeCommit?: boolean } = {},
): Promise<void> {
  await mkdir(join(root, "revisions"), { recursive: true });
  const serialized = JSON.stringify(project, null, 2) + "\n";
  const temporary = join(root, `.project-${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { flag: "wx" });
  if (options.interruptBeforeCommit) throw new Error("simulated interruption");
  await rename(temporary, join(root, "revisions", `${project.revision.id}.json`));
  await writeAtomic(join(root, "project.json"), serialized);
}

export async function loadProject(root: string): Promise<Project> {
  return JSON.parse(await readFile(join(root, "project.json"), "utf8")) as Project;
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: "wx" });
  await rename(temporary, path);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
