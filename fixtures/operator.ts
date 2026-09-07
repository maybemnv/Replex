import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapture } from "../src/capture.js";
import { captureInputFromResult, createProject, normalizeRunMedia, writeRevision } from "../src/project.js";
import type { Brief, Environment, Flow } from "../src/schema.js";
import { renderNormalFixture, type NormalFixtureState } from "./apps/normal/app.js";
import { normalEnvironment, normalFlow } from "./apps/normal/flow.js";
import { renderDynamicFixture, type DynamicFixtureState } from "./apps/dynamic/app.js";
import { dynamicEnvironment, dynamicFlow } from "./apps/dynamic/flow.js";
import { renderDifficultFixture, type DifficultFixtureState } from "./apps/difficult/app.js";
import { difficultEnvironment, difficultFlow } from "./apps/difficult/flow.js";

export type FixtureKind = "normal" | "dynamic" | "difficult";
type FixtureState = NormalFixtureState | DynamicFixtureState | DifficultFixtureState;

export interface RunningFixtureServers {
  origins: Record<FixtureKind, string>;
  close: () => Promise<void>;
}

export interface FixtureDefinition {
  brief: Brief;
  environment: Environment;
  flow: Flow;
  values: Record<string, string>;
  uploadRoots: string[];
}

const defaultPorts: Record<FixtureKind, number> = { normal: 4173, dynamic: 4174, difficult: 4175 };

export function fixtureDefinition(kind: FixtureKind, origin: string, root: string): FixtureDefinition {
  if (kind === "normal") return {
    brief: { audience: "Product teams", message: "Show release filtering", targetDurationMs: 30_000 },
    environment: normalEnvironment(origin), flow: normalFlow(origin), values: { filterValue: "release" }, uploadRoots: [],
  };
  if (kind === "dynamic") return {
    brief: { audience: "Product teams", message: "Show the dynamic release flow", targetDurationMs: 30_000 },
    environment: dynamicEnvironment(origin), flow: dynamicFlow(origin),
    values: { dynamicEmail: "demo@example.test", dynamicPassword: "fixture-password", dynamicPlan: "priority" }, uploadRoots: [],
  };
  const uploadRoot = join(root, "uploads");
  return {
    brief: { audience: "Product teams", message: "Show the difficult release flow", targetDurationMs: 30_000 },
    environment: difficultEnvironment(origin), flow: difficultFlow(origin),
    values: { difficultProjectName: "Release Replay", difficultAsset: join(uploadRoot, "release-asset.txt") }, uploadRoots: [uploadRoot],
  };
}

export async function startFixtureServers(ports: Record<FixtureKind, number> = defaultPorts): Promise<RunningFixtureServers> {
  const entries = await Promise.all((Object.keys(ports) as FixtureKind[]).map(async (kind) => {
    let state: FixtureState = { changed: false };
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/__reset") {
        state = { changed: false };
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && request.url === "/__change") {
        state = { ...state, changed: true };
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/__failure")) {
        state = { ...state, failureActionId: new URL(request.url, "http://fixture").searchParams.get("action") ?? undefined };
        response.writeHead(204).end();
        return;
      }
      const html = kind === "normal" ? renderNormalFixture(state) : kind === "dynamic"
        ? renderDynamicFixture(state as DynamicFixtureState) : renderDifficultFixture(state as DifficultFixtureState);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    await listen(server, ports[kind]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error(`${kind} fixture server did not start`);
    return [kind, { server, origin: `http://127.0.0.1:${address.port}` }] as const;
  }));
  const running = Object.fromEntries(entries) as Record<FixtureKind, { server: Server; origin: string }>;
  return {
    origins: Object.fromEntries(entries.map(([kind, value]) => [kind, value.origin])) as Record<FixtureKind, string>,
    close: async () => Promise.all(Object.values(running).map(({ server }) => close(server))).then(() => undefined),
  };
}

export async function bootstrapFixture(kind: FixtureKind, projectRoot: string, origin = `http://127.0.0.1:${defaultPorts[kind]}`): Promise<void> {
  const root = resolve(projectRoot);
  const definition = fixtureDefinition(kind, origin, root);
  await mkdir(root, { recursive: true });
  if (kind === "difficult") {
    await mkdir(definition.uploadRoots[0], { recursive: true });
    await writeFile(definition.values.difficultAsset, "release replay fixture\n", "utf8");
  }
  const run = await runCapture(definition.flow, definition.environment, {
    artifactRoot: join(root, "capture-runs"), values: definition.values, uploadRoots: definition.uploadRoots,
  });
  const captured = captureInputFromResult(root, run);
  const captures = normalizeRunMedia(root, captured.captures.map((capture) => {
    if (!capture.path) throw new Error(`capture path is missing: ${capture.sceneKey}`);
    return { ...capture, path: capture.path };
  }), { targetTotalSeconds: definition.brief.targetDurationMs / 1000 });
  const project = createProject({ projectId: kind, ...definition, captures });
  await writeRevision(root, project);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "serve") {
    const running = await startFixtureServers();
    process.stdout.write(`${JSON.stringify({ status: "ready", origins: running.origins })}\n`);
    return;
  }
  if (argv[0] === "bootstrap" && ["normal", "dynamic", "difficult"].includes(argv[1])) {
    const kind = argv[1] as FixtureKind;
    const projectIndex = argv.indexOf("--project");
    const root = projectIndex >= 0 ? argv[projectIndex + 1] : undefined;
    if (!root) throw new Error("bootstrap requires --project <path>");
    await bootstrapFixture(kind, root);
    process.stdout.write(`${JSON.stringify({ status: "completed", fixture: kind, project: resolve(root) })}\n`);
    return;
  }
  throw new Error("usage: npm run fixtures -- serve | bootstrap <normal|dynamic|difficult> --project <path>");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
