// MOCK: writes orchestrator/mock/events.jsonl (the slot-3 recording built by script.ts) and
// bench-results.json. Every event and row carries mock:true. Numbers are invented, not measured.
// Run: bun run mock/generate.ts   (from orchestrator/)
import { join } from "node:path";
import type { BenchmarkResultRow } from "../src/contract.ts";
import { buildMockScript, MOCK_MODEL as MODEL, RECORDED_POSSESS_SLOT } from "./script.ts";

const out = buildMockScript(RECORDED_POSSESS_SLOT).events;
const dir = import.meta.dir;
await Bun.write(join(dir, "events.jsonl"), out.map((e) => JSON.stringify(e)).join("\n") + "\n");

// ---- Benchmark rows (MOCK) ----
const rnd = (seed: number): number => ((Math.sin(seed) * 10000) % 1 + 1) % 1;
const rows: BenchmarkResultRow[] = [];
const modes = [
  ["codex_baseline", 61000, 2, 1.0],
  ["ours_cold", 42000, 1, 0.9],
  ["ours_warm", 36000, 0, 1.0],
  ["ablation", 51000, 1, 0.9],
] as const;
let k = 1;
for (const [mode, base, traps] of modes)
  for (const task of ["invoice_parser", "shipping_rates", "discount_engine"])
    for (let trial = 1; trial <= 3; trial++) {
      const r = rnd(k++);
      const success = !(mode === "codex_baseline" && trial === 2 && task === "discount_engine") && !(mode === "ablation" && trial === 3 && task === "shipping_rates");
      const input = Math.round(base * (0.85 + r * 0.3));
      const output = Math.round(input * 0.18);
      const tokens = { input, cached: Math.round(input * 0.55), output, reasoning: Math.round(output * 0.4) };
      rows.push({
        mode,
        model: MODEL,
        task,
        trial,
        sourceId: mode === "codex_baseline" ? `codex-mock-${task}-${trial}` : `mock-${mode}-${task}-${trial}`,
        success,
        tokens,
        tokens_per_passing_task: success ? input + output : null,
        usd: +(((input - tokens.cached) * 0.1 + tokens.cached * 0.025 + output * 0.5) / 1e6).toFixed(5),
        trap_hits: Math.max(0, traps - (r > 0.6 ? 1 : 0)),
        repeat_trap_hits: mode === "codex_baseline" ? (r > 0.4 ? 1 : 0) : 0,
        recovery_ms: traps ? Math.round(20000 + r * 25000) : null,
        finish_ms: Math.round(80000 + r * 40000),
        false_retires: mode === "codex_baseline" ? null : 0,
        ...(mode === "codex_baseline" ? { subagents_spawned: 4 } : {}),
        notes: "MOCK row, not measured",
        mock: true,
      });
    }
await Bun.write(join(dir, "bench-results.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(`MOCK: wrote ${out.length} events, ${rows.length} bench rows`);
