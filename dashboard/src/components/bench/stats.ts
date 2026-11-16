// Benchmark aggregation: bench/results.json rows -> per-mode summaries.
// Spec: "Report mean and min-max per mode; with 3 trials, say 'in our runs',
// not 'significant'." Every number here is computed from rows; nothing is
// filled in when a mode has no data.

import type { BenchMode, BenchRow } from "../../data/model";

export const MODE_ORDER: BenchMode[] = ["codex_baseline", "ours_cold", "ours_warm", "ablation"];

export const MODE_LABEL: Record<BenchMode, string> = {
  codex_baseline: "Codex subagents",
  ours_cold: "Ours, cold",
  ours_warm: "Ours, warm",
  ablation: "Ours, no sharing",
};

/** The two modes in the headline comparison; the others are supporting evidence. */
export const HEADLINE_MODES: ReadonlySet<BenchMode> = new Set(["codex_baseline", "ours_cold"]);

/** mean with its min-max range; null when there is nothing to summarise. */
export interface Spread {
  mean: number;
  min: number;
  max: number;
  n: number; // values that went into it
}

export interface ModeSummary {
  mode: BenchMode;
  runs: number;
  passes: number;
  /** Overall pass rate; range = pass rate per task (same as bench/aggregate). */
  success: Spread | null;
  /** Seconds, over runs that recorded a recovery. */
  recovery: Spread | null;
  recoveryMissing: number; // runs with recoverySec === null
  /** USD per run. */
  cost: Spread | null;
  /** Headline: all tokens (failed runs included) / passing runs. Range = the same ratio per task. */
  tokensPerPass: Spread | null;
  trapHits: Spread | null;
  repeatTrapHits: Spread | null;
  models: string[];
  tasks: number;
}

export function spread(values: number[]): Spread | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  let min = v[0];
  let max = v[0];
  let sum = 0;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  return { mean: sum / v.length, min, max, n: v.length };
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function summarizeMode(mode: BenchMode, rows: BenchRow[]): ModeSummary {
  const passes = rows.filter((r) => r.success).length;
  const byTask = [...groupBy(rows, (r) => r.task).values()];

  // Success: the mean is the overall pass rate; the range shows how much it
  // moved between tasks.
  let success: Spread | null = null;
  if (rows.length > 0) {
    const perTask = byTask.map((g) => g.filter((r) => r.success).length / g.length);
    const s = spread(perTask);
    success = s && { ...s, mean: passes / rows.length, n: rows.length };
  }

  // Tokens per passing task: total tokens over passes, never a mean of ratios.
  let tokensPerPass: Spread | null = null;
  if (passes > 0) {
    const total = rows.reduce((a, r) => a + r.tokensTotal, 0);
    const perTask = byTask
      .map((g) => {
        const p = g.filter((r) => r.success).length;
        return p > 0 ? g.reduce((a, r) => a + r.tokensTotal, 0) / p : NaN;
      })
      .filter((x) => Number.isFinite(x));
    const s = spread(perTask);
    tokensPerPass = s ? { ...s, mean: total / passes } : null;
  }

  const recoveryVals = rows.flatMap((r) => (r.recoverySec === null ? [] : [r.recoverySec]));

  return {
    mode,
    runs: rows.length,
    passes,
    success,
    recovery: spread(recoveryVals),
    recoveryMissing: rows.length - recoveryVals.length,
    cost: spread(rows.map((r) => r.usd)),
    tokensPerPass,
    trapHits: spread(rows.map((r) => r.trapHits)),
    repeatTrapHits: spread(rows.map((r) => r.repeatTrapHits)),
    models: [...new Set(rows.map((r) => r.model))],
    tasks: new Set(rows.map((r) => r.task)).size,
  };
}

export function summarize(rows: BenchRow[]): ModeSummary[] {
  const byMode = groupBy(rows, (r) => r.mode);
  return MODE_ORDER.map((m) => summarizeMode(m, byMode.get(m) ?? []));
}

/**
 * Headline ratio: baseline tokens-per-pass over ours_cold tokens-per-pass.
 * null unless both sides have at least one passing run.
 */
export function headlineRatio(summaries: ModeSummary[]): number | null {
  const base = summaries.find((s) => s.mode === "codex_baseline")?.tokensPerPass;
  const ours = summaries.find((s) => s.mode === "ours_cold")?.tokensPerPass;
  if (!base || !ours || ours.mean <= 0) return null;
  return base.mean / ours.mean;
}
