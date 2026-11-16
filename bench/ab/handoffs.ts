#!/usr/bin/env bun
// Post-hoc: reads every replacement generation's handoff from its Agent actor and stores, per row, whether its own
// checkpoint was handed over marked STALE (retire.buildHandoff re-test). Needs the actor runtime the rows ran on:
//   DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:<port> bun bench/ab/handoffs.ts results.fix.json --arms A,B
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadRepoEnv } from "../src/config.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { arms: { type: "string" } } });
await loadRepoEnv();
const { runActors } = await import("../../orchestrator/src/actors.ts");
const file = join(import.meta.dir, positionals[0] ?? "results.fix.json");
const arms = new Set((values.arms ?? "A,B,C").split(","));
const rows = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>[];
let n = 0;
for (const r of rows) {
  if (!arms.has(r.arm)) continue;
  const a = runActors(r.run_id, r.library_id);
  const reps = [...new Set((r.worker_calls as any[]).filter((w) => w.gen >= 2).map((w) => `${w.slot}.${w.gen}`))];
  const out: Record<string, unknown> = {};
  for (const k of reps) {
    const [slot, gen] = k.split(".");
    const st = await a.agent(slot!, Number(gen)).state().catch(() => null);
    const h = (st?.info?.handoff ?? null) as { remaining?: string; checkpoints?: { fn: string; stale?: string }[]; lesson?: string } | null;
    out[`w${slot}-g${gen}`] = h
      ? { stale: (h.checkpoints ?? []).some((c) => !!c.stale), checkpoints: (h.checkpoints ?? []).map((c) => ({ fn: c.fn, stale: c.stale ?? null })), lesson: h.lesson ?? null, remaining: (h.remaining ?? "").slice(0, 2500) }
      : null;
    n++;
  }
  r.handoffs = out;
}
writeFileSync(file, JSON.stringify(rows, null, 1));
console.log(`handoffs read: ${n}`);
