import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractError, ServiceCommand } from "../service-contract/index.js";
import { ImportAssetRequestSchema, ServiceErrorResponseSchema } from "../service-contract/index.js";
import { LocalExecutorError } from "./local-jobs.js";
import { LocalProjectStoreError } from "./project-store.js";
import { LocalExecutorServer } from "./http.js";
import { LocalImportError } from "../import-v2.js";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
type LocalCommand = Extract<ServiceCommand, "create_project" | "open_project" | "import_asset" | "apply_operations" | "cancel_job">;
interface CliIO { stdout(text: string): void; stderr(text: string): void }

function parseArgs(argv: string[]): { workspaceRoot: string; command: LocalCommand; inputPath: string; sourcePath?: string; importRoots: string[] } {
  let workspaceRoot: string | undefined;
  let command: LocalCommand | undefined;
  let inputPath: string | undefined;
  let sourcePath: string | undefined;
  const importRoots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new LocalExecutorError("VALIDATION_FAILED", `${key} requires a value.`);
    if (key === "--workspace" && !workspaceRoot) workspaceRoot = resolve(value);
    else if (key === "--command" && !command && ["create_project", "open_project", "import_asset", "apply_operations", "cancel_job"].includes(value)) command = value as LocalCommand;
    else if (key === "--input" && !inputPath) inputPath = resolve(value);
    else if (key === "--source-path" && !sourcePath) sourcePath = resolve(value);
    else if (key === "--import-root") importRoots.push(resolve(value));
    else throw new LocalExecutorError("VALIDATION_FAILED", `Invalid or repeated service option: ${key}.`);
    index += 1;
  }
  if (!workspaceRoot || !command || !inputPath) {
    throw new LocalExecutorError("VALIDATION_FAILED", "--workspace, --command, and --input are required.");
  }
  if (sourcePath && command !== "import_asset") throw new LocalExecutorError("VALIDATION_FAILED", "--source-path is only valid for import_asset.");
  if (command === "import_asset" && !sourcePath) throw new LocalExecutorError("VALIDATION_FAILED", "import_asset requires --source-path because local tokens belong to one executor process.");
  return { workspaceRoot, command, inputPath, ...(sourcePath ? { sourcePath } : {}), importRoots };
}

function publicError(error: unknown): ContractError {
  if (error instanceof LocalExecutorError) {
    return { code: error.code, message: error.message, retryable: error.code === "STORAGE_FAILED" };
  }
  if (error instanceof LocalImportError) {
    return error.code === "SOURCE_TOO_LARGE"
      ? { code: "VALIDATION_FAILED", message: "The selected local file exceeds the import size limit.", retryable: false }
      : { code: "UNAUTHORIZED", message: "The selected local file is not available under the configured import roots.", retryable: false };
  }
  if (error instanceof LocalProjectStoreError) {
    const code: ContractError["code"] = error.code === "PROJECT_NOT_FOUND" ? "PROJECT_NOT_FOUND"
      : error.code === "REVISION_NOT_FOUND" ? "REVISION_NOT_FOUND"
      : error.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT"
      : error.code === "INVALID_OPERATION" ? "OPERATION_REJECTED" : "STORAGE_FAILED";
    return { code, message: "The local project request could not be completed.", retryable: code === "STORAGE_FAILED" };
  }
  return { code: "EXECUTION_FAILED", message: "The local service request failed.", retryable: true };
}

export async function runServiceCommandCli(argv: string[], io: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}): Promise<number> {
  let server: LocalExecutorServer | undefined;
  try {
    const args = parseArgs(argv);
    const info = await lstat(args.inputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INPUT_BYTES) {
      throw new LocalExecutorError("VALIDATION_FAILED", "The service request file is invalid or too large.");
    }
    let request: unknown;
    try { request = JSON.parse(await readFile(args.inputPath, "utf8")) as unknown; }
    catch { throw new LocalExecutorError("VALIDATION_FAILED", "The service request file is not valid JSON."); }

    server = new LocalExecutorServer({ workspaceRoot: args.workspaceRoot, importRoots: args.importRoots });
    await server.start();
    if (args.command === "import_asset") {
      const raw = typeof request === "object" && request !== null && !Array.isArray(request) ? request as Record<string, unknown> : {};
      const selected = await server.authorizeLocalImport(args.sourcePath!);
      request = ImportAssetRequestSchema.parse({
        ...raw,
        source: { kind: "local_token", ref: selected.token },
        declaredFilename: selected.filename,
      });
    }
    let result = await server.dispatch(args.command, request);
    let exitCode = 0;
    if (args.command === "apply_operations" || args.command === "import_asset") {
      const job = result as { id: string };
      result = await server.waitForJob(job.id, 600_000);
      if ((result as { state?: string }).state !== "succeeded") exitCode = 1;
    }
    io.stdout(JSON.stringify(result) + "\n");
    return exitCode;
  } catch (error) {
    io.stderr(JSON.stringify(ServiceErrorResponseSchema.parse({ contractVersion: "v1", error: publicError(error) })) + "\n");
    return 1;
  } finally {
    await server?.stop().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runServiceCommandCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
