import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { ConfigValidationError, parseRuntimeConfig } from "./schema.js";

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

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export const HELP_TEXT = `Release Replay POC\n\nUsage: npm run cli -- <command> [--config <path>]\n\nCommands:\n  capture      Run an approved browser flow\n  baseline     Build the deterministic baseline\n  agent-draft  Create a bounded agent draft\n  verify       Verify a project or render\n  render       Render a verified draft\n  recapture    Replace one affected scene capture\n  report       Write the local review report\n\nOptions:\n  --config <path>  Validate a JSON runtime config before starting\n  --help           Show this help\n`;

function executableStatus(name: ToolName, path: string): StartupToolStatus {
  if (name === "chromium") {
    return existsSync(path)
      ? { name, path, available: true }
      : { name, path, available: false, detail: "Playwright Chromium executable does not exist" };
  }

  const result = spawnSync(path, ["-version"], { stdio: "ignore", windowsHide: true });
  if (result.error) return { name, path, available: false, detail: result.error.message };
  if (result.status !== 0) return { name, path, available: false, detail: `exited with status ${result.status}` };
  return { name, path, available: true };
}

export function checkStartupTools(paths: ToolPaths = {}): StartupCheckResult {
  const resolved: Record<ToolName, string> = {
    chromium: paths.chromium ?? process.env.REPLEX_CHROMIUM_PATH ?? chromium.executablePath(),
    ffmpeg: paths.ffmpeg ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg",
    ffprobe: paths.ffprobe ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe",
  };
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
  if (error instanceof Error) return { code: "CLI_ERROR", message: error.message };
  return { code: "CLI_ERROR", message: String(error) };
}

function usageError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "CLI_USAGE_ERROR";
  return error;
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
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      io.stdout(HELP_TEXT);
      return 0;
    }

    const command = argv[0];
    if (!COMMANDS.includes(command as Command)) throw usageError(`unknown command: ${command}`);

    let configPath: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === "--config") {
        configPath = argv[index + 1];
        if (!configPath || configPath.startsWith("-")) throw usageError("--config requires a path");
        index += 1;
      } else {
        throw usageError(`unknown option: ${argv[index]}`);
      }
    }

    if (configPath) await validateConfig(configPath);
    const startup = checkStartupTools(options.toolPaths);
    if (!startup.ok) throw new StartupCheckError(startup);

    io.stdout(JSON.stringify({ command, status: "accepted", tools: startup.tools }) + "\n");
    return 0;
  } catch (error) {
    const payload = errorPayload(error);
    io.stderr(JSON.stringify({ error: payload }) + "\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
