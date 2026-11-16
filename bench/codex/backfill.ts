#!/usr/bin/env bun
/**
 * Backfills Codex rows in bench/results.json from their run_dir logs (idempotent):
 *  - time_to_finish_s (+ basis), in-run trap hits, factuality and subagent-efficiency fields (bench/codex/trace.ts).
 *    t0 = the row's started_at, taken before the codex spawn (measured 0.0-0.3 s early on the v1 runs, by
 *    comparing events.jsonl mtime - finish_ms). Rows whose run_dir is gone keep null and get a note.
 *  - task_version = 1 when absent.
 *  - Duplicate trials (same mode, task, task_version, trial): every trial counts and there are no reruns, so the
 *    first by started_at is kept and later ones get `excluded: "duplicate_trial"` (never deleted).
 *
 *   bun bench/codex/backfill.ts [--dry-run] [--recompute-edits]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR } from "../src/config.ts";
import { updateResults } from "../src/results.ts";
import { loadTaskMeta, SUITE_DIRS } from "../src/tasks.ts";
import { traceFields } from "./run.ts";
import { readTrace, traceMetrics } from "./trace.ts";

const dry = process.argv.includes("--dry-run");
/** Recompute only the trap-edit fields of rows that already have trace metrics (after a detector change). */
const recomputeEdits = process.argv.includes("--recompute-edits");
const today = new Date().toISOString().slice(0, 10);

type Row = Record<string, any>;

async function backfillRow(r: Row): Promise<void> {
  if (r.mode !== "codex_baseline" || r.mock) return;
  r.task_version ??= 1;
  const sessions = join(String(r.run_dir ?? ""), "sessions");
  if (r.time_to_finish_s !== undefined && r.false_completion_claims !== undefined) {
    if (!recomputeEdits || !r.run_dir || !existsSync(sessions)) return; // already done
    const meta = await loadTaskMeta(join(BENCH_DIR, SUITE_DIRS[`v${r.task_version}`] ?? "tasks", r.task));
    const tm = traceMetrics({
      trace: await readTrace(sessions),
      t0_ms: Date.parse(r.started_at),
      exit_ms: typeof r.finish_ms === "number" ? r.finish_ms : null,
      functions: meta.functions,
      traps: meta.traps,
      sharedModule: meta.sharedModule,
      finalFailing: r.tests?.failing ?? [],
      finalSuccess: r.success === true,
      testFiles: [],
    });
    Object.assign(r, {
      trap_edits: tm.trap_edits,
      trap_following_edits: tm.trap_following_edits,
      repeat_trap_edits: tm.repeat_trap_edits,
      traps_followed_in_edits: tm.traps_followed_in_edits,
    });
    return;
  }
  const addNote = (n: string) => (r.notes = [r.notes, n].filter(Boolean).join("; "));
  if (!r.run_dir || !existsSync(sessions)) {
    r.time_to_finish_s = null;
    addNote(`backfill ${today}: run_dir logs missing, time_to_finish_s and factuality left null`);
    return;
  }
  const meta = await loadTaskMeta(join(BENCH_DIR, SUITE_DIRS[`v${r.task_version}`] ?? "tasks", r.task));
  const tm = traceMetrics({
    trace: await readTrace(sessions),
    t0_ms: Date.parse(r.started_at),
    exit_ms: typeof r.finish_ms === "number" ? r.finish_ms : null,
    functions: meta.functions,
    traps: meta.traps,
    sharedModule: meta.sharedModule,
    finalFailing: r.tests?.failing ?? [],
    finalSuccess: r.success === true,
    testFiles: [],
  });
  const final = { trap_hits: r.trap_hits ?? 0, repeat_trap_hits: r.repeat_trap_hits ?? 0, traps_hit: r.traps_hit ?? [] };
  const f = traceFields(tm, final, meta.traps, r.recovery_ms ?? null);
  Object.assign(r, { trap_hits: f.trap_hits, repeat_trap_hits: f.repeat_trap_hits, traps_hit: f.traps_hit, recovery_ms: f.recovery_ms }, f.extra);
  addNote(
    `backfill ${today}: trace metrics from run_dir rollouts; time_to_finish_s t0 = started_at (<=0.3 s before spawn)` +
      (tm.pytest_runs_unavailable ? `; ${tm.pytest_runs_unavailable}/${tm.pytest_runs_total} agent pytest runs could not run (no pytest for python3 in agent shells)` : ""),
  );
}

function markDuplicates(rows: Row[]): string[] {
  const seen = new Map<string, Row>();
  const marked: string[] = [];
  const order = [...rows].filter((r) => !r.mock).sort((a, b) => Date.parse(a.started_at ?? 0) - Date.parse(b.started_at ?? 0));
  for (const r of order) {
    const k = `${r.mode}|${r.task}|v${r.task_version ?? 1}|${r.trial}`;
    const first = seen.get(k);
    if (!first) {
      seen.set(k, r);
      continue;
    }
    if (r.excluded) continue;
    r.excluded = "duplicate_trial";
    r.notes = [r.notes, `excluded ${today}: duplicate of trial ${r.trial} run ${first.run_dir ?? first.sourceId} (started ${first.started_at}); every trial counts, no reruns, the first one is kept`]
      .filter(Boolean)
      .join("; ");
    marked.push(String(r.run_dir ?? r.sourceId));
  }
  return marked;
}

let rowsOut: Row[] = [];
let marked: string[] = [];
const work = async (rows: Row[]) => {
  for (const r of rows) await backfillRow(r);
  marked = markDuplicates(rows);
  rowsOut = rows;
  return rows;
};
if (dry) {
  await work((await Bun.file(join(BENCH_DIR, "results.json")).json()) as Row[]);
} else {
  // updateResults takes a sync fn; do the async work first on a snapshot, then apply under the lock by sourceId+started_at.
  const snapshot = (await Bun.file(join(BENCH_DIR, "results.json")).json()) as Row[];
  await work(snapshot);
  const key = (r: Row) => `${r.sourceId}|${r.started_at}|${r.mode}|${r.task}|${r.trial}`;
  const done = new Map(rowsOut.map((r) => [key(r), r]));
  await updateResults((rows) => rows.map((r) => done.get(key(r)) ?? r));
}
for (const r of rowsOut.filter((x) => x.mode === "codex_baseline"))
  console.log(
    `${r.task} t${r.trial} v${r.task_version}${r.excluded ? ` EXCLUDED(${r.excluded})` : ""}: finish ${r.time_to_finish_s}s (${r.time_to_finish_basis}), false claims ${r.false_completion_claims}/${r.completion_claims}, trap hits ${r.trap_hits} (final ${r.trap_hits_final}), trap edits ${r.trap_following_edits}`,
  );
console.log(`duplicates marked: ${marked.length ? marked.join(", ") : "none"}${dry ? " (dry run)" : ""}`);
