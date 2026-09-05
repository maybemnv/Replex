import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { runClaudeDraft } from "./agent.js";
import { runCapture } from "./capture.js";
import { capturesFromRun, loadProject } from "./project.js";
import { reconcileCapture } from "./reconcile.js";
import { buildRenderJob, executeRenderJob } from "./render.js";
import { generateReport } from "./report.js";
import { ConfigValidationError, parseRuntimeConfig } from "./schema.js";
import { verifyProject } from "./verify.js";

export const COMMANDS = ["capture", "baseline", "agent-draft", "verify", "render", "recapture", "report"] as const;
export type Command = (typeof COMMANDS)[number];
export type ToolName = "chromium" | "ffmpeg" | "ffprobe";

export interface ToolPaths {
  chromium?: string;
  ffmpeg?: string;
  ffprobe?: string;
}

export interface StartupToolStatus {
  name: ToolName;
  path: string;
  available: boolean;
  version?: string;
  detail?: string;
}

export interface StartupCheckResult {
  ok: boolean;
  tools: StartupToolStatus[];
  missing: ToolName[];
}

export class StartupCheckError extends Error {
  readonly code = "STARTUP_CHECK_FAILED" as const;
  readonly missing: ToolName[];
  readonly tools: StartupToolStatus[];

  constructor(result: StartupCheckResult) {
    super(`missing required startup tools: ${result.missing.join(", ")}`);
    this.name = "StartupCheckError";
    this.missing = result.missing;
    this.tools = result.tools;
  }
}

interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface RunCliOptions {
  io?: CliIO;
  toolPaths?: ToolPaths;
}

interface ParsedArgs {
  configPath?: string;
  projectRoot?: string;
  artifactRoot?: string;
  outputPath?: string;
  storageStatePath?: string;
  uploadRoots: string[];
  inputPath?: string;
}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export const HELP_TEXT = `Release Replay POC\n\nUsage: npm run cli -- <command> [options]\n\nCommands:\n  capture      Run an approved browser flow\n  baseline     Build the deterministic baseline\n  agent-draft  Create a bounded agent draft\n  verify       Verify a project or render\n  render       Render a verified draft\n  recapture    Replace one affected scene capture\n  report       Write the local review report\n\nOptions:\n  --config <path>  Validate a JSON runtime config before starting\n  --project <path>  Project directory containing project.json\n  --artifact-root <path>  Capture artifact directory (defaults to project/work/captures)\n  --output <path>  Project-relative render output path\n  --storage-state <path>  Auth state outside the project artifacts\n  --upload-root <path>  Approved upload root (repeatable)\n  --input <path>  Recapture JSON input (required by recapture)\n  --help           Show this help\n`;

function executableStatus(name: ToolName, path: string): StartupToolStatus {
  const args = name === "chromium"
    ? ["--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", "data:text/html,<script>document.write(navigator.userAgent)</script>"]
    : ["-version"];
  const result = spawnSync(path, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 15_000,
  });
  if (result.error) return { name, path, available: false, detail: result.error.message };
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(0, 500);
    const signal = result.signal ? ` signal ${result.signal}` : "";
    return { name, path, available: false, detail: `exited with status ${result.status}${signal}${output ? `: ${output}` : ""}` };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  if (name === "chromium") {
    const version = output.match(/(?:Chrome|Chromium)\/[^\s<]+/)?.[0];
    if (!version) return { name, path, available: false, detail: "probe output did not contain a Chromium version signature" };
    return { name, path, available: true, version };
  }
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  const expected = name === "ffmpeg" ? /ffmpeg version/i : /ffprobe version/i;
  if (!expected.test(firstLine)) return { name, path, available: false, detail: `probe output did not contain an ${name} version signature` };
  return { name, path, available: true, version: firstLine };
}

function resolveToolPaths(paths: ToolPaths = {}): Record<ToolName, string> {
  let chromiumPath: string;
  try {
    chromiumPath = paths.chromium ?? process.env.REPLEX_CHROMIUM_PATH ?? chromium.executablePath();
  } catch (error) {
    throw new StartupCheckError({
      ok: false,
      tools: [{ name: "chromium", path: paths.chromium ?? process.env.REPLEX_CHROMIUM_PATH ?? "<unresolved>", available: false, detail: error instanceof Error ? error.message : String(error) }],
      missing: ["chromium"],
    });
  }
  return {
    chromium: chromiumPath,
    ffmpeg: paths.ffmpeg ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg",
    ffprobe: paths.ffprobe ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe",
  };
}

export function checkStartupTools(paths: ToolPaths = {}): StartupCheckResult {
  const resolved = resolveToolPaths(paths);
  const tools = (Object.entries(resolved) as [ToolName, string][]).map(([name, path]) => executableStatus(name, path));
  const missing = tools.filter((tool) => !tool.available).map((tool) => tool.name);
  return { ok: missing.length === 0, tools, missing };
}

function errorPayload(error: unknown) {
  if (error instanceof StartupCheckError) {
    return {
      code: error.code,
      message: error.message,
      missing: error.missing,
      tools: error.tools,
    };
  }
  if (error instanceof ConfigValidationError) {
    return { code: error.code, message: error.message, issues: error.issues };
  }
  if (error instanceof Error) {
    const attached = (error as { code?: unknown }).code;
    if (typeof attached === "string" && attached.length > 0) return { code: attached, message: error.message };
    return { code: "CLI_ERROR", message: error.message };
  }
  return { code: "CLI_ERROR", message: String(error) };
}

function usageError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "CLI_USAGE_ERROR";
  return error;
}

function commandUnavailable(command: Command, detail: string): Error & { code: string } {
  const error = new Error(`${command}: ${detail}`) as Error & { code: string };
  error.code = "CLI_COMMAND_UNAVAILABLE";
  return error;
}

function requiredPath(value: string | undefined, flag: string): string {
  if (!value) throw usageError(`${flag} requires a path`);
  return resolve(value);
}

async function loadProjectForCommand(args: ParsedArgs) {
  const root = requiredPath(args.projectRoot, "--project");
  return { root, project: await loadProject(root) };
}

function printJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

async function executeRenderCommand(
  command: "baseline" | "render",
  args: ParsedArgs,
  toolPaths: ToolPaths,
  io: CliIO,
): Promise<number> {
  const { root, project } = await loadProjectForCommand(args);
  const verification = verifyProject(project, root);
  if (!verification.passed) {
    printJson(io, { command, status: "blocked", verification });
    return 1;
  }
  const job = buildRenderJob(project, root, verification, args.outputPath ?? `renders/${project.currentRevisionId}.mp4`);
  const render = executeRenderJob(job, root, { ffmpegPath: toolPaths.ffmpeg, ffprobePath: toolPaths.ffprobe });
  printJson(io, {
    command,
    status: "completed",
    verification,
    render: { ...render, outputPath: relative(root, render.outputPath).replace(/\\/g, "/") },
  });
  return 0;
}

async function executeCommand(command: Command, args: ParsedArgs, options: RunCliOptions, io: CliIO): Promise<number> {
  const toolPaths = options.toolPaths ?? {};
  if (command === "capture") {
    const { root, project } = await loadProjectForCommand(args);
    const artifactRoot = resolve(args.artifactRoot ?? join(root, "work", "captures"));
    const run = await runCapture(project.flow, project.environment, {
      artifactRoot,
      ffmpegPath: toolPaths.ffmpeg,
      ffprobePath: toolPaths.ffprobe,
      storageStatePath: args.storageStatePath,
      uploadRoots: args.uploadRoots,
    });
    const captureRoot = capturesFromRun(run).root;
    const captures = capturesFromRun(run).captures.map((capture) => ({
      ...capture,
      path: relative(root, resolve(captureRoot, capture.path ?? "")).replace(/\\/g, "/"),
    }));
    printJson(io, { command, status: "completed", run: run.run, runPath: relative(root, run.runPath).replace(/\\/g, "/"), captures });
    return 0;
  }
  if (command === "verify") {
    const { root, project } = await loadProjectForCommand(args);
    const verification = verifyProject(project, root);
    printJson(io, { command, status: verification.passed ? "passed" : "failed", verification });
    return verification.passed ? 0 : 1;
  }
  if (command === "report") {
    const { root, project } = await loadProjectForCommand(args);
    const verification = verifyProject(project, root);
    const reportPath = generateReport(project, root, { checks: verification.checks });
    printJson(io, { command, status: "completed", reportPath: relative(root, reportPath).replace(/\\/g, "/"), verification });
    return 0;
  }
  if (command === "baseline" || command === "render") return executeRenderCommand(command, args, toolPaths, io);
  if (command === "agent-draft") {
    const { root, project } = await loadProjectForCommand(args);
    const result = await runClaudeDraft(project, root);
    printJson(io, { command, status: result.ok ? "completed" : "failed", result });
    return result.ok ? 0 : 1;
  }
  if (command === "recapture") {
    const { root, project } = await loadProjectForCommand(args);
    const inputPath = requiredPath(args.inputPath, "--input");
    let input: unknown;
    try {
      input = JSON.parse(await readFile(inputPath, "utf8"));
    } catch (error) {
      throw commandUnavailable(command, `unable to read JSON input: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = reconcileCapture(project, root, input as Parameters<typeof reconcileCapture>[2]);
    printJson(io, { command, status: result.ok ? "completed" : "failed", result });
    return result.ok ? 0 : 1;
  }
  throw commandUnavailable(command, "no execution path is registered");
}

async function validateConfig(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const configError = new Error(`unable to read config: ${detail}`) as Error & { code: string };
    configError.code = "CONFIG_READ_FAILED";
    throw configError;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const configError = new Error(`config is not valid JSON: ${detail}`) as Error & { code: string };
    configError.code = "CONFIG_INVALID_JSON";
    throw configError;
  }
  parseRuntimeConfig(value);
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? defaultIO;
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      io.stdout(HELP_TEXT);
      return 0;
    }

    const command = argv[0];
    if (!COMMANDS.includes(command as Command)) throw usageError(`unknown command: ${command}`);

    const args: ParsedArgs = { uploadRoots: [] };
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      const configInline = arg.startsWith("--config=") ? arg.slice("--config=".length) : undefined;
      if (arg === "--config" || configInline !== undefined) {
        if (args.configPath !== undefined) throw usageError("--config specified more than once");
        if (configInline !== undefined) {
          if (!configInline) throw usageError("--config requires a path");
          args.configPath = configInline;
        } else {
          args.configPath = argv[index + 1];
          if (!args.configPath || args.configPath.startsWith("-")) throw usageError("--config requires a path");
          index += 1;
        }
      } else if (arg === "--project" || arg.startsWith("--project=")) {
        args.projectRoot = argv[index + 1];
        if (!args.projectRoot || args.projectRoot.startsWith("-")) throw usageError("--project requires a path");
        index += 1;
      } else if (argv[index] === "--artifact-root") {
        args.artifactRoot = argv[index + 1];
        if (!args.artifactRoot || args.artifactRoot.startsWith("-")) throw usageError("--artifact-root requires a path");
        index += 1;
      } else if (argv[index] === "--output") {
        args.outputPath = argv[index + 1];
        if (!args.outputPath || args.outputPath.startsWith("-")) throw usageError("--output requires a path");
        index += 1;
      } else if (argv[index] === "--storage-state") {
        args.storageStatePath = argv[index + 1];
        if (!args.storageStatePath || args.storageStatePath.startsWith("-")) throw usageError("--storage-state requires a path");
        index += 1;
      } else if (argv[index] === "--upload-root") {
        const root = argv[index + 1];
        if (!root || root.startsWith("-")) throw usageError("--upload-root requires a path");
        args.uploadRoots.push(resolve(root));
        index += 1;
      } else if (argv[index] === "--input") {
        args.inputPath = argv[index + 1];
        if (!args.inputPath || args.inputPath.startsWith("-")) throw usageError("--input requires a path");
        index += 1;
      } else {
        throw usageError(`unknown option: ${argv[index]}`);
      }
    }

    if (args.configPath) await validateConfig(args.configPath);
    const startup = checkStartupTools(options.toolPaths);
    if (!startup.ok) throw new StartupCheckError(startup);

    const exitCode = await executeCommand(command as Command, args, options, io);
    if (exitCode === 0) printJson(io, { command, status: "ready", tools: startup.tools });
    return exitCode;
  } catch (error) {
    const payload = errorPayload(error);
    io.stderr(JSON.stringify({ error: payload }) + "\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ error: { code: "CLI_ERROR", message: error instanceof Error ? error.message : String(error) } }) + "\n");
    process.exitCode = 1;
  });
}
