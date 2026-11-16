// Drives runTrial with a MOCK in-process RuntimeService (no network, no model). The fake run writes
// the trap variant first, then the task's _solution, so the loop must see a trap hit and a recovery.
import { expect, test } from "bun:test";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_DIR } from "../src/config.ts";
import type { LedgerTotals, RunSummary } from "../../orchestrator/src/contract.ts";
import type { TaskJson } from "./metrics.ts";
import { runTrial, type Opts } from "./run.ts";
import type { BenchService } from "./service.ts";

const TASK = join(BENCH_DIR, "tasks", "invoice_parser");

async function layer(dst: string, l: string) {
  for (const f of await readdir(join(TASK, l))) if (f.endsWith(".py")) await cp(join(TASK, l, f), join(dst, f));
}

test("runTrial with a MOCK service: trap hit, recovery, success, ledger tokens", async () => {
  const wd = await mkdtemp(join(tmpdir(), "ours-mock-run-"));
  await layer(wd, "starter");
  const t0 = Date.now();
  let status: RunSummary["status"] = "running";
  setTimeout(async () => { await layer(wd, "_solution"); await layer(wd, "_trap_variant"); }, 150);
  setTimeout(async () => { await layer(wd, "_solution"); }, 600);
  setTimeout(() => { status = "finished"; }, 900);
  const summary = (): RunSummary & { workDir: string } => ({
    runId: "rMOCK", taskId: "invoice_parser", mode: "ours", libraryId: "libMOCK", status, model: "openai/gpt-6-luna",
    startedAt: t0, agents: 4, retires: 0, cases: 0, testsPassing: 0, testsTotal: 4, usd: 0.01, mock: true, workDir: wd,
  });
  const ledger = { worker_usd: 0.008, overhead_usd: 0.002, tokens: { input: 1000, cached: 100, output: 300, reasoning: 0 } } as LedgerTotals;
  const svc = {
    mock: true,
    startRun: async () => summary(),
    listRuns: async () => [summary()],
    getLedger: async () => ledger,
    listCases: async () => [],
    stopRun: async () => ({ ok: true }),
  } as unknown as BenchService;
  const o: Opts = { modes: ["cold"], tasks: ["invoice_parser"], trials: 1, trialStart: 1, parallel: 1, pollMs: 100, wallMs: 30_000, usdCap: 1, benchModel: "openai/gpt-6-luna", allowDevModel: false };
  const task = (await Bun.file(join(TASK, "task.json")).json()) as TaskJson;
  const row = await runTrial(svc, o, "cold", task, TASK, 19, 1, undefined);
  expect(row.mock).toBe(true);
  expect(row.mode).toBe("ours_cold");
  expect(row.success).toBe(true);
  expect(row.trap_hits).toBe(1);
  expect(row.traps_hit).toEqual(["amount_cents"]);
  expect(row.recovery_ms).not.toBeNull();
  expect(row.trap_hits_final).toBe(0);
  expect(row.usd).toBe(0.01);
  expect(row.tokens_per_passing_task).toBe(1300);
  expect(row.sourceId).toBe("rMOCK");
}, 20_000);
