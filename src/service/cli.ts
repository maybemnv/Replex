import { resolve } from "node:path";
import { LocalExecutorError } from "./local-jobs.js";
import { LocalExecutorServer } from "./http.js";

function parseArgs(argv: string[]): { workspaceRoot: string; allowedOrigins: string[]; importRoots: string[] } {
  let workspaceRoot: string | undefined;
  const allowedOrigins: string[] = [];
  const importRoots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--workspace" || argument === "--allow-origin" || argument === "--import-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new LocalExecutorError("VALIDATION_FAILED", `${argument} requires a value.`);
      if (argument === "--workspace") {
        if (workspaceRoot) throw new LocalExecutorError("VALIDATION_FAILED", "--workspace may be specified only once.");
        workspaceRoot = resolve(value);
      } else {
        if (argument === "--allow-origin") allowedOrigins.push(value);
        else importRoots.push(resolve(value));
      }
      index += 1;
      continue;
    }
    throw new LocalExecutorError("VALIDATION_FAILED", `Unknown service option: ${argument}.`);
  }
  if (!workspaceRoot) throw new LocalExecutorError("VALIDATION_FAILED", "--workspace is required.");
  return { workspaceRoot, allowedOrigins, importRoots };
}

async function main(): Promise<void> {
  let server: LocalExecutorServer | undefined;
  try {
    server = new LocalExecutorServer(parseArgs(process.argv.slice(2)));
    const session = await server.start();
    process.stdout.write(JSON.stringify({ contractVersion: "v1", url: session.url, bearerToken: session.token }) + "\n");
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server!.stop().then(() => { process.exitCode = 0; }).catch(() => {
        process.stderr.write(JSON.stringify({ error: { code: "EXECUTION_FAILED", message: "The local service could not stop cleanly." } }) + "\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    const code = error instanceof LocalExecutorError ? error.code : "EXECUTION_FAILED";
    const message = error instanceof LocalExecutorError ? error.message : "The local service could not start.";
    process.stderr.write(JSON.stringify({ error: { code, message } }) + "\n");
    process.exitCode = 1;
    await server?.stop().catch(() => undefined);
  }
}

void main();
