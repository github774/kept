// Summarizes results.jsonl (+ state.json) into summary.json: the emergence curve (trap-hit rate per
// window of N agents, shared vs control), library growth, tokens per passing subtask, cost, wall time,
// process/memory peaks. Pure `summarize`; CLI at the bottom. Missing data stays null: no interpolation.
//
//   bun bench/emergence/summarize.ts [--in bench/emergence/results.jsonl] [--state bench/emergence/state.json]
//       [--out bench/emergence/summary.json] [--window 50] [--include-mock]
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentRow, Arm, ExperimentState, ResourcePeaks } from "./types.ts";

export interface Ratio {
  count: number;
  /** Rows where the field was measured (non-null). */
  known: number;
  /** count / known, null when known = 0. */
  rate: number | null;
}

export interface WindowStats {
  window: number;
  /** arm_agent_index range [from, to]. */
  from: number;
  to: number;
  agents: number;
  /** Fewer than window-size agents recorded in this range. */
  partial: boolean;
  runs: number;
  exposed: number;
  /** Over exposed agents (function owns a trap test). */
  trap_hit_final: Ratio;
  trap_hit_any: Ratio;
  retired: Ratio;
  /** Over exposed agents. */
  lesson_in_prompt: Ratio;
  trap_lesson_in_library_at_launch: Ratio;
  chunk_reused: Ratio;
  passing_subtasks: Ratio;
  /** input + output over agents with ledger tokens. */
  tokens: number;
  tokens_known: number;
  /** tokens / passing subtasks; null unless every agent in the window has measured tokens and >= 1 passes. */
  tokens_per_passing_subtask: number | null;
  usd: number;
  library_cases_at_launch_max: number | null;
  library_lessons_at_launch_max: number | null;
}

export interface ArmStats {
  agents: number;
  runs: number;
  exposed: number;
  trap_hit_final: Ratio;
  trap_hit_any: Ratio;
  retired: Ratio;
  lesson_in_prompt: Ratio;
  chunk_reused: Ratio;
  passing_subtasks: Ratio;
  runs_killed: number;
  runs_capped_usd: number;
  runs_crashed: number;
  /** Ledger run totals (all categories, attributed or not), one per run. */
  run_tokens: number | null;
  run_usd: number | null;
  /** run_tokens / passing subtasks, all overhead included. */
  run_tokens_per_passing_subtask: number | null;
  windows: WindowStats[];
}

export interface Summary {
  generated_at: string;
  mock: boolean;
  rows_read: number;
  rows_used: number;
  rows_excluded_mock: number;
  duplicate_rows_dropped: number;
  window_size: number;
  experiment: string | null;
  library_id: string | null;
  arms: Partial<Record<Arm, ArmStats>>;
  /** The emergence chart: per window, trap-hit rate (final) for each arm. null = no exposed agents measured. */
  curve: {
    metric: "trap_hit_final rate over exposed agents";
    windows: { window: number; from: number; to: number; shared: number | null; shared_n: number; control: number | null; control_n: number; shared_any: number | null; control_any: number | null }[];
  };
  library_growth: { wave: number; at: number; cases: number; lessons: number; synthetic: number; revoked: number }[];
  cost: {
    ledger_usd: number | null;
    openrouter_key_usage_delta_usd: number | null;
    budget_usd: number | null;
  };
  wall: {
    first_launch: number | null;
    last_end: number | null;
    span_ms: number | null;
    session_ms: number | null;
    run_ms_mean: number | null;
  };
  resources: ResourcePeaks | null;
  notes: string[];
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

function ratio(rows: AgentRow[], get: (r: AgentRow) => boolean | null): Ratio {
  let count = 0;
  let known = 0;
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined) continue;
    known++;
    if (v) count++;
  }
  return { count, known, rate: known ? r4(count / known) : null };
}

const sumTokens = (rows: AgentRow[]) => rows.reduce((a, r) => a + (r.tokens ? r.tokens.input + r.tokens.output : 0), 0);
const maxOrNull = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};

function windowStats(rows: AgentRow[], w: number, size: number): WindowStats {
  const exposed = rows.filter((r) => r.exposed);
  const tokens_known = rows.filter((r) => r.tokens !== null).length;
  const tokens = sumTokens(rows);
  const passing = ratio(rows, (r) => r.function_pass_final);
  return {
    window: w,
    from: w * size,
    to: w * size + size - 1,
    agents: rows.length,
    partial: rows.length < size,
    runs: new Set(rows.map((r) => r.run_key)).size,
    exposed: exposed.length,
    trap_hit_final: ratio(exposed, (r) => r.trap_hit_final),
    trap_hit_any: ratio(exposed, (r) => r.trap_hit_any),
    retired: ratio(rows, (r) => r.retired),
    lesson_in_prompt: ratio(exposed, (r) => r.lesson_in_prompt),
    trap_lesson_in_library_at_launch: ratio(exposed, (r) => r.trap_lesson_in_library_at_launch),
    chunk_reused: ratio(rows, (r) => r.chunk_reused),
    passing_subtasks: passing,
    tokens,
    tokens_known,
    tokens_per_passing_subtask: tokens_known === rows.length && rows.length > 0 && passing.count > 0 ? Math.round(tokens / passing.count) : null,
    usd: r6(rows.reduce((a, r) => a + (r.usd ?? 0), 0)),
    library_cases_at_launch_max: maxOrNull(rows.map((r) => r.library_cases_at_launch)),
    library_lessons_at_launch_max: maxOrNull(rows.map((r) => r.library_lessons_at_launch)),
  };
}

function armStats(rows: AgentRow[], size: number): ArmStats {
  const sorted = [...rows].sort((a, b) => a.arm_agent_index - b.arm_agent_index);
  const byWindow = new Map<number, AgentRow[]>();
  for (const r of sorted) {
    const w = Math.floor(r.arm_agent_index / size);
    byWindow.set(w, [...(byWindow.get(w) ?? []), r]);
  }
  const maxW = sorted.length ? Math.floor(sorted.at(-1)!.arm_agent_index / size) : -1;
  const windows: WindowStats[] = [];
  for (let w = 0; w <= maxW; w++) windows.push(windowStats(byWindow.get(w) ?? [], w, size));

  const runs = new Map<string, AgentRow>();
  for (const r of sorted) if (!runs.has(r.run_key)) runs.set(r.run_key, r);
  const runRows = [...runs.values()];
  const allRunTok = runRows.every((r) => r.run_tokens !== null);
  const allRunUsd = runRows.every((r) => r.run_usd !== null);
  const runTokens = runRows.length && allRunTok ? runRows.reduce((a, r) => a + r.run_tokens!.input + r.run_tokens!.output, 0) : null;
  const passing = ratio(sorted, (r) => r.function_pass_final);
  const exposed = sorted.filter((r) => r.exposed);
  return {
    agents: sorted.length,
    runs: runRows.length,
    exposed: exposed.length,
    trap_hit_final: ratio(exposed, (r) => r.trap_hit_final),
    trap_hit_any: ratio(exposed, (r) => r.trap_hit_any),
    retired: ratio(sorted, (r) => r.retired),
    lesson_in_prompt: ratio(exposed, (r) => r.lesson_in_prompt),
    chunk_reused: ratio(sorted, (r) => r.chunk_reused),
    passing_subtasks: passing,
    runs_killed: runRows.filter((r) => r.killed).length,
    runs_capped_usd: runRows.filter((r) => r.capped_usd).length,
    runs_crashed: runRows.filter((r) => r.crash).length,
    run_tokens: runTokens,
    run_usd: runRows.length && allRunUsd ? r6(runRows.reduce((a, r) => a + r.run_usd!, 0)) : null,
    run_tokens_per_passing_subtask: runTokens !== null && passing.count > 0 ? Math.round(runTokens / passing.count) : null,
    windows,
  };
}

export function summarize(
  input: AgentRow[],
  state: ExperimentState | null,
  opts: { windowSize?: number; includeMock?: boolean; now?: Date } = {},
): Summary {
  const size = opts.windowSize ?? 50;
  const notes: string[] = [];
  const mockRows = input.filter((r) => r.mock);
  const kept = opts.includeMock ? input : input.filter((r) => !r.mock);
  // Last row wins per (run_key, slot): a resumed run that was re-recorded replaces the earlier one.
  const dedup = new Map<string, AgentRow>();
  for (const r of kept) dedup.set(`${r.run_key}#${r.slot}`, r);
  const rows = [...dedup.values()];

  const arms: Partial<Record<Arm, ArmStats>> = {};
  for (const arm of ["shared", "control"] as Arm[]) {
    const a = rows.filter((r) => r.arm === arm);
    if (a.length) arms[arm] = armStats(a, size);
  }

  const nW = Math.max(arms.shared?.windows.length ?? 0, arms.control?.windows.length ?? 0);
  const curve: Summary["curve"] = { metric: "trap_hit_final rate over exposed agents", windows: [] };
  for (let w = 0; w < nW; w++) {
    const s = arms.shared?.windows[w];
    const c = arms.control?.windows[w];
    curve.windows.push({
      window: w,
      from: w * size,
      to: w * size + size - 1,
      shared: s?.trap_hit_final.rate ?? null,
      shared_n: s?.trap_hit_final.known ?? 0,
      control: c?.trap_hit_final.rate ?? null,
      control_n: c?.trap_hit_final.known ?? 0,
      shared_any: s?.trap_hit_any.rate ?? null,
      control_any: c?.trap_hit_any.rate ?? null,
    });
  }

  const runFirst = new Map<string, AgentRow>();
  for (const r of rows) if (!runFirst.has(r.run_key)) runFirst.set(r.run_key, r);
  const runRows = [...runFirst.values()];
  const ledgerKnown = runRows.length > 0 && runRows.every((r) => r.run_usd !== null);
  if (runRows.some((r) => r.run_usd === null)) notes.push("some runs have no Ledger totals: ledger_usd is null");

  let peaks: ResourcePeaks | null = null;
  for (const s of state?.sessions ?? []) {
    const p = s.peaks;
    if (!p || p.samples === 0) continue;
    peaks = peaks
      ? {
          processes: Math.max(peaks.processes, p.processes),
          stack_processes: Math.max(peaks.stack_processes, p.stack_processes),
          stack_rss_mb: Math.max(peaks.stack_rss_mb, p.stack_rss_mb),
          bench_rss_mb: Math.max(peaks.bench_rss_mb, p.bench_rss_mb),
          samples: peaks.samples + p.samples,
        }
      : { ...p };
  }
  const sessionMs = state?.sessions.length
    ? state.sessions.reduce((a, s) => a + ((s.ended_at ?? s.started_at) - s.started_at), 0)
    : null;
  const first = runRows.length ? Math.min(...runRows.map((r) => r.launched_at)) : null;
  const lastEnd = runRows.length ? Math.max(...runRows.map((r) => r.ended_at)) : null;
  const keyDelta =
    state && state.key_usage_baseline !== null && state.key_usage_last !== null ? r6(state.key_usage_last - state.key_usage_baseline) : null;
  if (!state) notes.push("no state.json: library growth, key usage, sessions and resource peaks unknown");

  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    mock: rows.some((r) => r.mock),
    rows_read: input.length,
    rows_used: rows.length,
    rows_excluded_mock: opts.includeMock ? 0 : mockRows.length,
    duplicate_rows_dropped: kept.length - rows.length,
    window_size: size,
    experiment: state?.experiment ?? rows[0]?.experiment ?? null,
    library_id: state?.library_id ?? null,
    arms,
    curve,
    library_growth: (state?.waves ?? []).filter((w) => w.library).map((w) => ({ wave: w.wave, at: w.at, ...w.library! })),
    cost: {
      ledger_usd: ledgerKnown ? r6(runRows.reduce((a, r) => a + r.run_usd!, 0)) : null,
      openrouter_key_usage_delta_usd: keyDelta,
      budget_usd: state?.budget_usd ?? null,
    },
    wall: {
      first_launch: first,
      last_end: lastEnd,
      span_ms: first !== null && lastEnd !== null ? lastEnd - first : null,
      session_ms: sessionMs,
      run_ms_mean: runRows.length ? Math.round(runRows.reduce((a, r) => a + r.run_wall_ms, 0) / runRows.length) : null,
    },
    resources: peaks,
    notes,
  };
}

export async function readRows(path: string): Promise<AgentRow[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  const out: AgentRow[] = [];
  for (const line of (await f.text()).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as AgentRow);
  }
  return out;
}

export async function readState(path: string): Promise<ExperimentState | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? ((await f.json()) as ExperimentState) : null;
}

async function main() {
  const dir = import.meta.dir;
  const { values } = parseArgs({
    options: {
      in: { type: "string", default: join(dir, "results.jsonl") },
      state: { type: "string", default: join(dir, "state.json") },
      out: { type: "string", default: join(dir, "summary.json") },
      window: { type: "string", default: "50" },
      "include-mock": { type: "boolean", default: false },
    },
  });
  const rows = await readRows(values.in);
  const s = summarize(rows, await readState(values.state), { windowSize: Number(values.window), includeMock: values["include-mock"] });
  await Bun.write(values.out, JSON.stringify(s, null, 2) + "\n");
  console.log(`${values.out}: ${s.rows_used} agent rows (${s.rows_excluded_mock} mock excluded)`);
  for (const w of s.curve.windows)
    console.log(`  window ${w.window} [${w.from}-${w.to}] trap-hit shared ${w.shared ?? "-"} (n=${w.shared_n}) control ${w.control ?? "-"} (n=${w.control_n})`);
}

if (import.meta.main) await main();
