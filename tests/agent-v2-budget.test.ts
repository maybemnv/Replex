import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentBudgetLedger, reservedCost } from "../src/agent-v2-budget.js";

const policy = { maxJobMicroUsd: 100, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000, requestsPerMinute: 2 };
const signal = new AbortController().signal;
describe("durable live-agent budget ledger", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "replex-budget-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rounds reservations upward using integer arithmetic", () => {
    expect(reservedCost({ ...policy, inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 2 }, 1, 1)).toBe(1);
    expect(() => reservedCost(policy, NaN, 0)).toThrow();
    expect(() => reservedCost(policy, Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
  it("serializes competing reservations, persists usage, and never raises an existing cap", async () => {
    const first = new AgentBudgetLedger(root, policy);
    const key = first.key("project-1", "intent-1");
    const second = new AgentBudgetLedger(root, { ...policy, maxJobMicroUsd: 1000 });
    await first.reserve(key, 50, 0, signal);
    const outcomes = await Promise.allSettled([first.reserve(key, 40, 0, signal), second.reserve(key, 40, 0, signal)]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    await second.usage(key, 12, 5, false);
    expect(JSON.parse(await readFile(join(root, ".replex-agent-budget.json"), "utf8")).jobs[key]).toMatchObject({ capMicroUsd: 100, reservedMicroUsd: 90, inputTokens: 12, outputTokens: 5 });
  });
  it("expires rate slots after a minute and fails closed on clock rollback", async () => {
    let now = 100_000;
    const ledger = new AgentBudgetLedger(root, policy, () => now);
    await ledger.requestSlot(signal);
    await ledger.requestSlot(signal);
    now -= 1;
    await expect(ledger.requestSlot(signal)).rejects.toThrow("rate limit");
    now = 160_000;
    await expect(ledger.requestSlot(signal)).resolves.toBeUndefined();
  });
  it("refuses a corrupt or linked ledger rather than resetting spending", async () => {
    const ledger = new AgentBudgetLedger(root, policy);
    const path = join(root, ".replex-agent-budget.json");
    await writeFile(path, "not json");
    await expect(ledger.requestSlot(signal)).rejects.toThrow("invalid");
    await rm(path);
    const target = join(root, "other");
    await writeFile(target, "unchanged");
    await symlink(target, path);
    await expect(ledger.requestSlot(signal)).rejects.toThrow("invalid");
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });
});
