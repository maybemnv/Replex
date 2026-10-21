import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalProjectStore } from "./project-store.js";

/** Read-only host discovery; not a ServiceCommand and does not start an executor. */
export async function runProjectsCli(argv: string[], io: { stdout(text: string): void; stderr(text: string): void } = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
}): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--workspace" || !argv[1] || argv[1].startsWith("--")) {
    io.stderr(JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "Usage: service:v2:projects --workspace <directory>" } }) + "\n");
    return 1;
  }
  try {
    const catalog = await new LocalProjectStore(resolve(argv[1])).listProjects();
    io.stdout(JSON.stringify(catalog) + "\n");
    return 0;
  } catch {
    io.stderr(JSON.stringify({ error: { code: "STORAGE_FAILED", message: "The local project catalog is unavailable." } }) + "\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runProjectsCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
