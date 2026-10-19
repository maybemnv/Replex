import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AgentBudgetPolicySchema = z.object({
  maxJobMicroUsd: integer.positive(),
  inputMicroUsdPerMillion: integer.positive(),
  outputMicroUsdPerMillion: integer.positive(),
  requestsPerMinute: integer.positive().max(120),
}).strict();
export type AgentBudgetPolicy = z.infer<typeof AgentBudgetPolicySchema>;

/** Internal error; maps to the existing AGENT_BUDGET_EXCEEDED job error. */
export class AgentBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "AgentBudgetError"; }
}

const recordSchema = z.object({
  capMicroUsd: integer.positive(), reservedMicroUsd: integer, calls: integer,
  inputTokens: integer, outputTokens: integer, blocked: z.boolean(),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1), requests: z.array(integer).max(120),
  jobs: z.record(z.string().regex(/^[a-f0-9]{64}$/), recordSchema),
}).strict();
type Ledger = z.infer<typeof ledgerSchema>;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** Integer micro-USD, rounded upward; no floating point currency accounting. */
export function reservedCost(policy: AgentBudgetPolicy, inputTokens: number, outputTokens: number): number {
  integer.parse(inputTokens);
  integer.parse(outputTokens);
  const cost = (BigInt(inputTokens) * BigInt(policy.inputMicroUsdPerMillion)
    + BigInt(outputTokens) * BigInt(policy.outputMicroUsdPerMillion) + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentBudgetError("model cost exceeds the accounting limit");
  return Number(cost);
}

/** Host-only ledger. One supported executor owns the workspace; writes serialize across adapter instances. */
export class AgentBudgetLedger {
  private static readonly tails = new Map<string, Promise<void>>();
  readonly policy: Readonly<AgentBudgetPolicy>;

  constructor(private readonly workspaceRoot: string, policy: AgentBudgetPolicy, private readonly clock = Date.now) {
    this.policy = Object.freeze(AgentBudgetPolicySchema.parse(policy));
  }

  key(projectId: string, intentId: string): string {
    return createHash("sha256").update(JSON.stringify([projectId, intentId])).digest("hex");
  }

  /** Count and generation requests each consume a slot, including failed/aborted attempts. */
  async requestSlot(signal: AbortSignal): Promise<void> {
    await this.update((state) => {
      signal.throwIfAborted();
      const now = this.clock();
      // Keep future timestamps if the wall clock moves backward: fail closed until it catches up.
      state.requests = state.requests.filter((time) => time > now - 60_000);
      if (state.requests.length >= this.policy.requestsPerMinute) throw new AgentBudgetError("model request rate limit reached");
      state.requests.push(now);
    });
  }

  /** Reservations are never refunded: an ambiguous failure may still have incurred provider charges. */
  async reserve(key: string, inputTokens: number, outputTokens: number, signal: AbortSignal): Promise<void> {
    const cost = reservedCost(this.policy, inputTokens, outputTokens);
    await this.update((state) => {
      signal.throwIfAborted();
      if (!state.jobs[key] && Object.keys(state.jobs).length >= 10_000) throw new AgentBudgetError("model budget ledger is full");
      const job = state.jobs[key] ??= { capMicroUsd: this.policy.maxJobMicroUsd, reservedMicroUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, blocked: false };
      job.capMicroUsd = Math.min(job.capMicroUsd, this.policy.maxJobMicroUsd);
      if (job.blocked || cost > job.capMicroUsd - job.reservedMicroUsd) throw new AgentBudgetError("model job cost cap reached");
      job.reservedMicroUsd += cost;
      job.calls += 1;
    });
  }

  /** Sanitized aggregate usage only; prompts, response IDs, images, and keys never enter this file. */
  async usage(key: string, inputTokens: number, outputTokens: number, blocked: boolean): Promise<void> {
    await this.update((state) => {
      const job = state.jobs[key];
      if (!job) throw new AgentBudgetError("model budget reservation is missing");
      job.inputTokens += integer.parse(inputTokens);
      job.outputTokens += integer.parse(outputTokens);
      job.blocked ||= blocked;
    });
  }

  private async update(mutate: (state: Ledger) => void): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.workspaceRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new AgentBudgetError("model budget workspace is invalid");
    const root = await realpath(this.workspaceRoot);
    const prior = AgentBudgetLedger.tails.get(root) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const path = join(root, ".replex-agent-budget.json");
      let state: Ledger = { version: 1, requests: [], jobs: {} };
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_LEDGER_BYTES) throw new Error("invalid ledger");
        state = ledgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentBudgetError("model budget ledger is unavailable or invalid");
      }
      mutate(state);
      const text = JSON.stringify(ledgerSchema.parse(state));
      if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new AgentBudgetError("model budget ledger is full");
      const temporary = join(root, `.replex-agent-budget-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, path);
      } finally {
        await handle.close();
        await unlink(temporary).catch(() => undefined);
      }
    });
    AgentBudgetLedger.tails.set(root, next);
    try { await next; }
    finally { if (AgentBudgetLedger.tails.get(root) === next) AgentBudgetLedger.tails.delete(root); }
  }
}
