import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDemoPrerequisites } from "./preflight.js";
import { startLocalDemo } from "./workflow.js";

const usage = "npm run demo -- [--workspace <directory>] [--once | --check] [--live --agent-model <model>]";

export function parseDemoArgs(argv: string[]) {
  let workspaceRoot = resolve("work", "invite-demo");
  let workspaceSet = false;
  let once = false;
  let check = false;
  let live = false;
  let agentModel: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--once" && !once) once = true;
    else if (argument === "--check" && !check) check = true;
    else if (argument === "--live" && !live) live = true;
    else if ((argument === "--workspace" && !workspaceSet) || (argument === "--agent-model" && !agentModel)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value. Usage: ${usage}`);
      if (argument === "--workspace") { workspaceRoot = resolve(value); workspaceSet = true; }
      else agentModel = value;
    } else throw new Error(`Unknown or repeated demo option. Usage: ${usage}`);
  }
  if (live !== Boolean(agentModel)) throw new Error("Live mode requires both --live and --agent-model; otherwise the demo uses the scripted agent.");
  if (once && check) throw new Error("Choose --once or --check.");
  return { workspaceRoot, once, check, ...(live ? { liveModel: agentModel! } : {}) };
}

export async function runDemoCli(argv: string[], io: { stdout(text: string): void; stderr(text: string): void } = {
  stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text),
}): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") { io.stdout(usage + "\n"); return 0; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let demo: Awaited<ReturnType<typeof startLocalDemo>> | undefined;
  try {
    const options = parseDemoArgs(argv);
    if (options.check) {
      const { versions } = checkDemoPrerequisites();
      io.stdout(JSON.stringify({ status: "ready", versions, chromium: "installed", providerCalls: 0 }) + "\n");
      return 0;
    }
    io.stderr(`Starting the ${options.liveModel ? "live" : "scripted"} local demo.\n`);
    demo = await startLocalDemo({ ...options, signal: controller.signal, progress: (stage) => io.stderr(stage + "\n") });
    const { close: _close, ...session } = demo;
    if (options.once) {
      await demo.close();
      const { url: _url, bearerToken: _token, ...result } = session;
      io.stdout(JSON.stringify({ ...result, executor: "stopped" }) + "\n");
    } else {
      io.stdout(JSON.stringify({ ...session, executor: "running" }) + "\n");
      io.stderr("Preview and final video are ready at the printed paths. The local API requires the printed bearer token. Press Ctrl+C to stop.\n");
      await new Promise<void>((resolveStopped) => {
        if (controller.signal.aborted) resolveStopped();
        else controller.signal.addEventListener("abort", () => resolveStopped(), { once: true });
      });
    }
    return 0;
  } catch (error) {
    if (controller.signal.aborted) { io.stderr("Demo stopped.\n"); return 0; }
    io.stderr((error instanceof Error ? error.message : "The local demo could not run.") + "\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { await demo?.close(); }
    catch { io.stderr("The demo could not stop cleanly; inspect the retained workspace before retrying.\n"); return 1; }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDemoCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
