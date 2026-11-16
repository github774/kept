#!/usr/bin/env bun
// Poisoning head-to-head runner (docs/BENCHMARK.md "Poisoning head-to-head").
//   bun bench/poison/run.ts --side codex|ours --task invoice_parser --poison fact|instruction|commit|all --trial 1[,2,3]
// Several trials (comma list) run in parallel (max 3). Rows -> bench/poison/results.json, summary -> summary.json.
// ours: needs the actor runtime + Relay engine (ports from env/.env) and runs the orchestrator in-process.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadCaps, loadRepoEnv } from "../src/config.ts";
import { appendRow } from "./common.ts";
import { KINDS, POISONS, type PoisonKind } from "./poisons.ts";

const { values } = parseArgs({
  options: {
    side: { type: "string" },
    task: { type: "string", default: "invoice_parser" },
    poison: { type: "string", default: "all" },
    trial: { type: "string", default: "1" },
  },
});
const side = values.side;
const task = values.task!;
const kinds: PoisonKind[] = values.poison === "all" ? KINDS : (values.poison!.split(",") as PoisonKind[]);
const trials = values.trial!.split(",").map(Number);
if ((side !== "codex" && side !== "ours") || !POISONS[task] || kinds.some((k) => !KINDS.includes(k)) || trials.some((t) => !(t >= 1))) {
  console.error("usage: bun bench/poison/run.ts --side codex|ours --task <id> --poison fact|instruction|commit|all --trial N[,N...]");
  process.exit(2);
}
process.env.MODEL_PROFILE = "bench";
process.env.LLM_CONCURRENCY = "benchmark";
await loadRepoEnv();
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY missing: refusing to run (no mock rows)");
  process.exit(2);
}
const log = (t: number) => (m: string) => console.error(`[poison ${side} ${task} t${t} ${new Date().toISOString().slice(11, 19)}] ${m}`);
const caps = (await loadCaps()) as Awaited<ReturnType<typeof loadCaps>> & { usd_per_run?: number };

let runOne: (t: number) => Promise<import("./common.ts").PoisonRow>;
if (side === "codex") {
  const { runCodexPoison } = await import("./codex.ts");
  runOne = (t) => runCodexPoison(task, t, kinds, log(t));
} else {
  const { buildPoisonTasksRoot, createPoisonService, runOursPoison } = await import("./ours.ts");
  const root = buildPoisonTasksRoot(join(import.meta.dir, "runs", "tasks-root"), task);
  const svc = await createPoisonService(root);
  if (svc.mock) throw new Error("service is a MOCK");
  runOne = (t) => runOursPoison(svc, task, t, kinds, { wallMs: caps.codex_wall_clock_ms, usdCap: caps.usd_per_run ?? 1 }, log(t));
}
let failed = 0;
await Promise.all(
  trials.slice(0, 3).map(async (t) => {
    try {
      const row = await runOne(t);
      await appendRow(row);
      const p = Object.entries(row.poisons).map(([k, m]) => `${k}:${m!.accepted_final ? "ACCEPTED" : "clean"}${m!.spread_any.length ? `(any ${m!.spread_any.join("+")})` : ""}`);
      log(t)(`done success=${row.success} usd=${row.usd} ${p.join(" ")}`);
    } catch (e) {
      failed++;
      log(t)(`FAILED: ${e instanceof Error ? e.stack : String(e)}`);
    }
  }),
);
process.exit(failed ? 1 : 0);
