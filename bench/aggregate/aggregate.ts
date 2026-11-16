// Aggregates bench/results.json (rows from the Codex runner and from bench/ours/run.ts) into
// bench/results.summary.json and bench/aggregate/chart-data.json. Numbers come only from rows;
// anything missing stays null. Mock rows are excluded unless --include-mock (then flagged mock).
// Rows with `excluded` set (e.g. "duplicate_trial") are always skipped and counted in rows_excluded.
//
// Groups are mode × task version (v1 = bench/tasks, v2 = bench/tasks-v2): numbers from different task
// versions are never pooled, except in the legacy per-mode block `modes` (kept for older readers).
//
//   bun bench/aggregate/aggregate.ts [--in bench/results.json] [--include-mock]
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";

export const MODES = ["codex_baseline", "ours_cold", "ours_warm", "ablation"] as const;
export type AggMode = (typeof MODES)[number];
export const MODE_LABELS: Record<AggMode, string> = {
  codex_baseline: "Codex subagents",
  ours_cold: "Ours (cold)",
  ours_warm: "Ours (warm)",
  ablation: "Ours, no shared reasoning",
};

/** One trial, normalized from either row shape (bench/src/types.ts or orchestrator contract.ts). */
export interface NormRow {
  mode: AggMode;
  task_version: number;
  task: string;
  trial: number;
  source: string;
  started_at: string | null;
  library_id: string | null;
  success: boolean;
  tokens: number | null; // input + output (cached ⊂ input, reasoning ⊂ output)
  tok_input_uncached: number | null;
  tok_cached: number | null;
  tok_output: number | null;
  tok_reasoning: number | null;
  usd: number | null;
  recovery_s: number | null;
  finish_s: number | null;
  trap_hits: number | null;
  trap_hits_final: number | null;
  repeat_trap_hits: number | null;
  trap_following_edits: number | null;
  repeat_trap_edits: number | null;
  false_completion_claims: number | null;
  completion_claims: number | null;
  unverified_pass_claims: number | null;
  poisoned_facts_accepted: number | null;
  jev_blocked_messages: number | null;
  false_retires: number | null;
  retires: number | null;
  subagents_spawned: number | null;
  /** Per-subagent values (Codex: rollout threads; ours: per-agent rows when the runner provides them). */
  subagent_tokens: number[] | null;
  subagent_model_calls: number[] | null;
  subagent_turns: number[] | null;
  wasted_tokens: number | null;
  mock: boolean;
  excluded: string | null;
  /** Row variant (`variant` or `sharing_fix`): grouped apart from untagged rows of the same mode. */
  variant: string | null;
}

const MODE_ALIASES: Record<string, AggMode> = {
  codex: "codex_baseline",
  codex_baseline: "codex_baseline",
  baseline: "codex_baseline",
  ours: "ours_cold",
  ours_cold: "ours_cold",
  cold: "ours_cold",
  warm: "ours_warm",
  ours_warm: "ours_warm",
  ablation: "ablation",
};

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const first = (...xs: unknown[]): number | null => {
  for (const x of xs) if (num(x) !== null) return x as number;
  return null;
};

/** Task ids differ between row producers ("invoice" vs "invoice_parser"); fold to the short id. */
export const canonTask = (t: string): string => t.replace(/_(parser|rates|engine)$/, "");

function perSubagent(raw: Record<string, unknown>, key: string): number[] | null {
  const list = raw.subagent_efficiency ?? raw.agents;
  if (!Array.isArray(list) || list.length === 0) return null;
  const v = list.map((a) => num((a as Record<string, unknown>)[key]));
  return v.every((x) => x !== null) ? (v as number[]) : null;
}

export function normalize(raw: Record<string, unknown>): NormRow | null {
  const mode = MODE_ALIASES[String(raw.mode)];
  if (!mode) return null;
  const tk = (raw.tokens ?? null) as Record<string, unknown> | null;
  const tin = num(tk?.input);
  const tout = num(tk?.output);
  const tcached = first(tk?.cached, tk?.cached_input);
  const recMs = num(raw.recovery_ms);
  const finMs = num(raw.finish_ms);
  return {
    mode,
    task_version: num(raw.task_version) ?? 1,
    task: canonTask(String(raw.task)),
    trial: Number(raw.trial),
    source: String(raw.run_id ?? raw.sourceId ?? raw.session_id ?? ""),
    started_at: typeof raw.started_at === "string" ? raw.started_at : null,
    library_id: typeof raw.library_id === "string" && raw.library_id ? raw.library_id : null,
    success: raw.success === true,
    tokens: tin !== null && tout !== null ? tin + tout : null,
    tok_input_uncached: tin !== null && tcached !== null ? tin - tcached : null,
    tok_cached: tcached,
    tok_output: tout,
    tok_reasoning: num(tk?.reasoning),
    usd: num(raw.usd),
    recovery_s: num(raw.time_to_recovery_s) ?? (recMs !== null ? recMs / 1000 : null),
    finish_s: num(raw.time_to_finish_s) ?? (finMs !== null ? finMs / 1000 : null),
    trap_hits: num(raw.trap_hits),
    trap_hits_final: num(raw.trap_hits_final),
    repeat_trap_hits: num(raw.repeat_trap_hits),
    trap_following_edits: num(raw.trap_following_edits),
    repeat_trap_edits: num(raw.repeat_trap_edits),
    false_completion_claims: first(raw.false_completion_claims, raw.false_claims),
    completion_claims: num(raw.completion_claims),
    unverified_pass_claims: num(raw.unverified_pass_claims),
    poisoned_facts_accepted: num(raw.poisoned_facts_accepted),
    jev_blocked_messages: first(raw.jev_blocked_messages, raw.jev_blocked),
    false_retires: num(raw.false_retires),
    retires: num(raw.retires),
    subagents_spawned: first(raw.subagents_spawned, raw.agents_spawned),
    subagent_tokens: perSubagent(raw, "tokens_total"),
    subagent_model_calls: perSubagent(raw, "model_calls"),
    subagent_turns: perSubagent(raw, "turns"),
    wasted_tokens: first(raw.wasted_tokens, raw.retired_tokens),
    mock: raw.mock === true,
    excluded: typeof raw.excluded === "string" && raw.excluded ? raw.excluded : null,
    variant: str(raw.variant) ?? str(raw.sharing_fix),
  };
}

export interface Stat {
  mean: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function stat(xs: (number | null)[]): Stat {
  const v = xs.filter((x): x is number => x !== null);
  if (v.length === 0) return { mean: null, min: null, max: null, n: 0 };
  return { mean: r4(v.reduce((a, b) => a + b, 0) / v.length), min: r4(Math.min(...v)), max: r4(Math.max(...v)), n: v.length };
}

/** Sum over all rows / passes; null if any row lacks the value or nothing passed. */
function pooled(rows: NormRow[], pick: (r: NormRow) => number | null, passes: number): number | null {
  const v = rows.map(pick);
  if (passes === 0 || v.some((x) => x === null)) return null;
  return r4((v as number[]).reduce((a, b) => a + b, 0) / passes);
}

const TOKEN_PARTS = {
  total: (r: NormRow) => r.tokens,
  input_uncached: (r: NormRow) => r.tok_input_uncached,
  cached: (r: NormRow) => r.tok_cached,
  output: (r: NormRow) => r.tok_output,
  reasoning: (r: NormRow) => r.tok_reasoning,
} as const;
type TokenPart = keyof typeof TOKEN_PARTS;

export interface GroupSummary {
  group: string; // "<mode>@v<version>", or "<mode>@v<version>+<variant>" for tagged rows
  mode: AggMode;
  task_version: number | null; // null in the legacy cross-version `modes` block
  label: string;
  trials: number;
  passes: number;
  tasks: string[];
  /** Completion rate. mean = pass rate over all trials; min/max = range of per-task pass rates. */
  success_rate: Stat;
  /** Over passing trials only (input + output of that trial). */
  tokens_per_passing_task: Stat;
  /** All tokens of all trials / passing trials (failed trials' tokens count against the mode). */
  tokens_per_passing_task_pooled: number | null;
  tokens_breakdown_per_passing_task: Record<TokenPart, Stat>;
  tokens_breakdown_per_passing_task_pooled: Record<TokenPart, number | null>;
  usd: Stat;
  usd_per_passing_task: Stat;
  usd_per_passing_task_pooled: number | null;
  subagents: {
    spawned: Stat;
    /** Over every subagent of every trial in the group. */
    tokens_per_subagent: Stat;
    model_calls_per_subagent: Stat;
    turns_per_subagent: Stat;
    /** Per trial: tokens of retired (ours) or failed (Codex: own tests fail at the end) agents. */
    wasted_tokens: Stat;
    retires: Stat;
  };
  factuality: {
    false_completion_claims: Stat;
    completion_claims: Stat;
    unverified_pass_claims: Stat;
    trap_hits: Stat;
    trap_hits_final: Stat;
    repeat_trap_hits: Stat;
    trap_following_edits: Stat;
    repeat_trap_edits: Stat;
    poisoned_facts_accepted: Stat;
    jev_blocked_messages: Stat;
    false_retires: Stat;
  };
  recovery_s: Stat;
  finish_s: Stat;
  // legacy flat copies
  trap_hits: Stat;
  repeat_trap_hits: Stat;
  false_retires: Stat;
  sources: string[];
}

const flat = (rows: NormRow[], pick: (r: NormRow) => number[] | null): Stat => {
  const all: number[] = [];
  for (const r of rows) {
    const v = pick(r);
    if (v) all.push(...v);
  }
  return stat(all);
};

function summarizeGroup(mode: AggMode, version: number | null, rows: NormRow[], variant: string | null = null): GroupSummary {
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const passes = rows.filter((r) => r.success).length;
  const passing = rows.filter((r) => r.success);
  const perTask = tasks.map((t) => {
    const tr = rows.filter((r) => r.task === t);
    return tr.filter((r) => r.success).length / tr.length;
  });
  const sr = stat(perTask);
  const s = (pick: (r: NormRow) => number | null) => stat(rows.map(pick));
  const parts = Object.keys(TOKEN_PARTS) as TokenPart[];
  const fact = {
    false_completion_claims: s((r) => r.false_completion_claims),
    completion_claims: s((r) => r.completion_claims),
    unverified_pass_claims: s((r) => r.unverified_pass_claims),
    trap_hits: s((r) => r.trap_hits),
    trap_hits_final: s((r) => r.trap_hits_final),
    repeat_trap_hits: s((r) => r.repeat_trap_hits),
    trap_following_edits: s((r) => r.trap_following_edits),
    repeat_trap_edits: s((r) => r.repeat_trap_edits),
    poisoned_facts_accepted: s((r) => r.poisoned_facts_accepted),
    jev_blocked_messages: s((r) => r.jev_blocked_messages),
    false_retires: s((r) => r.false_retires),
  };
  return {
    group: (version === null ? mode : `${mode}@v${version}`) + (variant ? `+${variant}` : ""),
    mode,
    task_version: version,
    label: (version === null ? MODE_LABELS[mode] : `${MODE_LABELS[mode]} · tasks v${version}`) + (variant ? ` · ${variant}` : ""),
    trials: rows.length,
    passes,
    tasks,
    success_rate: { ...sr, mean: rows.length ? r4(passes / rows.length) : null, n: rows.length },
    tokens_per_passing_task: stat(passing.map((r) => r.tokens)),
    tokens_per_passing_task_pooled: pooled(rows, (r) => r.tokens, passes),
    tokens_breakdown_per_passing_task: Object.fromEntries(parts.map((p) => [p, stat(passing.map(TOKEN_PARTS[p]))])) as Record<TokenPart, Stat>,
    tokens_breakdown_per_passing_task_pooled: Object.fromEntries(parts.map((p) => [p, pooled(rows, TOKEN_PARTS[p], passes)])) as Record<
      TokenPart,
      number | null
    >,
    usd: s((r) => r.usd),
    usd_per_passing_task: stat(passing.map((r) => r.usd)),
    usd_per_passing_task_pooled: pooled(rows, (r) => r.usd, passes),
    subagents: {
      spawned: s((r) => r.subagents_spawned),
      tokens_per_subagent: flat(rows, (r) => r.subagent_tokens),
      model_calls_per_subagent: flat(rows, (r) => r.subagent_model_calls),
      turns_per_subagent: flat(rows, (r) => r.subagent_turns),
      wasted_tokens: s((r) => r.wasted_tokens),
      retires: s((r) => r.retires),
    },
    factuality: fact,
    recovery_s: s((r) => r.recovery_s),
    finish_s: s((r) => r.finish_s),
    trap_hits: fact.trap_hits,
    repeat_trap_hits: fact.repeat_trap_hits,
    false_retires: fact.false_retires,
    sources: rows.map((r) => r.source),
  };
}

/** Back-compat alias: the legacy per-mode summary has the same shape. */
export type ModeSummary = GroupSummary;

export interface Claim {
  sentence: string | null;
  task_version: number | null;
  missing: string[];
  values: { success_pct_higher: number | null; cost_pct_lower: number | null; recovery_pct_faster: number | null; tasks: number | null };
}

/**
 * "On our N-task benchmark against Codex subagents, X% higher success at Y% lower net cost,
 *  with Z% faster recovery." X = relative success-rate gain, Y = relative drop in USD per passing
 *  task (pooled), Z = relative drop in mean recovery time. Null unless every number is measured
 *  and points our way (the template only has "higher/lower/faster" wording). Both sides must come from
 *  the same task version.
 */
export function buildClaim(by: Partial<Record<AggMode, GroupSummary>>, version: number | null = null): Claim {
  const missing: string[] = [];
  const c = by.codex_baseline;
  const o = by.ours_cold;
  if (!c) missing.push("no codex_baseline rows");
  if (!o) missing.push("no ours_cold rows");
  const rel = (ours: number | null | undefined, base: number | null | undefined, name: string, higherBetter: boolean) => {
    if (ours == null || base == null) {
      missing.push(`${name}: not measured on both sides`);
      return null;
    }
    if (base === 0) {
      missing.push(`${name}: baseline is 0, relative change undefined`);
      return null;
    }
    const pct = higherBetter ? ((ours - base) / base) * 100 : ((base - ours) / base) * 100;
    if (pct <= 0) missing.push(`${name}: ours is not better (${pct.toFixed(1)}%)`);
    return Math.round(pct);
  };
  const x = rel(o?.success_rate.mean, c?.success_rate.mean, "success", true);
  const y = rel(o?.usd_per_passing_task_pooled, c?.usd_per_passing_task_pooled, "net cost", false);
  const z = rel(o?.recovery_s.mean, c?.recovery_s.mean, "recovery", false);
  const tasks = c && o ? new Set([...c.tasks, ...o.tasks]).size : null;
  const values = { success_pct_higher: x, cost_pct_lower: y, recovery_pct_faster: z, tasks };
  if (missing.length || x === null || y === null || z === null || tasks === null)
    return { sentence: null, task_version: version, missing, values };
  return {
    sentence: `On our ${tasks}-task benchmark against Codex subagents, ${x}% higher success at ${y}% lower net cost, with ${z}% faster recovery.`,
    task_version: version,
    missing,
    values,
  };
}

// ---------------------------------------------------------------- learning curves

export interface CurvePoint {
  index: number; // 1-based position in the sequence
  mode: AggMode;
  task: string;
  trial: number;
  source: string;
  success: boolean;
  usd: number | null;
  tokens: number | null;
  trap_hits: number | null;
  repeat_trap_hits: number | null;
  trap_following_edits: number | null;
}

export interface LearningCurve {
  /** "library": ours runs sharing a case library (cold run then warm runs), ordered by started_at.
   *  "control": Codex trials of one task ordered by trial (no memory between trials). */
  kind: "library" | "control";
  id: string; // library id, or "codex:<task>@v<version>"
  task: string;
  task_version: number;
  runs: CurvePoint[];
}

const point = (r: NormRow, i: number): CurvePoint => ({
  index: i + 1,
  mode: r.mode,
  task: r.task,
  trial: r.trial,
  source: r.source,
  success: r.success,
  usd: r.usd,
  tokens: r.tokens,
  trap_hits: r.trap_hits,
  repeat_trap_hits: r.repeat_trap_hits,
  trap_following_edits: r.trap_following_edits,
});

const byStart = (a: NormRow, b: NormRow) =>
  (a.started_at ? Date.parse(a.started_at) : 0) - (b.started_at ? Date.parse(b.started_at) : 0) || a.trial - b.trial;

export function learningCurves(rows: NormRow[]): { curves: LearningCurve[]; by_index: Record<string, unknown>[] } {
  const curves: LearningCurve[] = [];
  const libs = new Map<string, NormRow[]>();
  for (const r of rows) if (r.library_id && r.mode !== "codex_baseline") libs.set(r.library_id, [...(libs.get(r.library_id) ?? []), r]);
  for (const [id, rs] of libs) {
    const sorted = [...rs].sort(byStart);
    curves.push({ kind: "library", id, task: sorted[0]!.task, task_version: sorted[0]!.task_version, runs: sorted.map(point) });
  }
  const ctl = new Map<string, NormRow[]>();
  for (const r of rows.filter((x) => x.mode === "codex_baseline")) {
    const k = `codex:${r.task}@v${r.task_version}`;
    ctl.set(k, [...(ctl.get(k) ?? []), r]);
  }
  for (const [id, rs] of ctl) {
    const sorted = [...rs].sort((a, b) => a.trial - b.trial);
    curves.push({ kind: "control", id, task: sorted[0]!.task, task_version: sorted[0]!.task_version, runs: sorted.map(point) });
  }
  // Mean per run index, per kind × task version (library curves only pool with library curves).
  const by_index: Record<string, unknown>[] = [];
  const keys = new Set(curves.map((c) => `${c.kind}@v${c.task_version}`));
  for (const k of keys) {
    const cs = curves.filter((c) => `${c.kind}@v${c.task_version}` === k);
    const maxLen = Math.max(...cs.map((c) => c.runs.length));
    for (let i = 0; i < maxLen; i++) {
      const pts = cs.map((c) => c.runs[i]).filter((p): p is CurvePoint => !!p);
      by_index.push({
        series: k,
        index: i + 1,
        n: pts.length,
        usd: stat(pts.map((p) => p.usd)),
        tokens: stat(pts.map((p) => p.tokens)),
        trap_hits: stat(pts.map((p) => p.trap_hits)),
        repeat_trap_hits: stat(pts.map((p) => p.repeat_trap_hits)),
        success_rate: pts.length ? r4(pts.filter((p) => p.success).length / pts.length) : null,
      });
    }
  }
  return { curves, by_index };
}

// ---------------------------------------------------------------- chart

export interface ChartMetric {
  id: string;
  label: string;
  unit: string;
  higher_is_better: boolean;
  /** One bar + range per group (mode × task version). */
  series: { group: string; mode: AggMode; task_version: number; label: string; mean: number | null; min: number | null; max: number | null; n: number }[];
  points: { group: string; mode: AggMode; task_version: number; task: string; trial: number; value: number | null }[];
}

type MetricDef = { id: string; label: string; unit: string; hib: boolean; stat: (g: GroupSummary) => Stat; point: (r: NormRow) => number | null };
const ifPass = (r: NormRow, v: number | null) => (r.success ? v : null);
const mean = (xs: number[] | null) => (xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const METRICS: MetricDef[] = [
  { id: "success_rate", label: "Completion rate", unit: "fraction", hib: true, stat: (g) => g.success_rate, point: (r) => (r.success ? 1 : 0) },
  { id: "tokens_per_passing_task", label: "Tokens per passing task", unit: "tokens", hib: false, stat: (g) => g.tokens_per_passing_task, point: (r) => ifPass(r, r.tokens) },
  { id: "tokens_input_uncached_per_passing_task", label: "Uncached input tokens per passing task", unit: "tokens", hib: false, stat: (g) => g.tokens_breakdown_per_passing_task.input_uncached, point: (r) => ifPass(r, r.tok_input_uncached) },
  { id: "tokens_cached_per_passing_task", label: "Cached input tokens per passing task", unit: "tokens", hib: false, stat: (g) => g.tokens_breakdown_per_passing_task.cached, point: (r) => ifPass(r, r.tok_cached) },
  { id: "tokens_output_per_passing_task", label: "Output tokens per passing task", unit: "tokens", hib: false, stat: (g) => g.tokens_breakdown_per_passing_task.output, point: (r) => ifPass(r, r.tok_output) },
  { id: "tokens_reasoning_per_passing_task", label: "Reasoning tokens per passing task", unit: "tokens", hib: false, stat: (g) => g.tokens_breakdown_per_passing_task.reasoning, point: (r) => ifPass(r, r.tok_reasoning) },
  { id: "usd_per_passing_task", label: "USD per passing task", unit: "USD", hib: false, stat: (g) => g.usd_per_passing_task, point: (r) => ifPass(r, r.usd) },
  { id: "usd", label: "Net cost per trial", unit: "USD", hib: false, stat: (g) => g.usd, point: (r) => r.usd },
  { id: "tokens_per_subagent", label: "Tokens per subagent", unit: "tokens", hib: false, stat: (g) => g.subagents.tokens_per_subagent, point: (r) => mean(r.subagent_tokens) },
  { id: "model_calls_per_subagent", label: "Model calls per subagent", unit: "count", hib: false, stat: (g) => g.subagents.model_calls_per_subagent, point: (r) => mean(r.subagent_model_calls) },
  { id: "wasted_tokens", label: "Tokens on retired/failed agents", unit: "tokens", hib: false, stat: (g) => g.subagents.wasted_tokens, point: (r) => r.wasted_tokens },
  { id: "false_completion_claims", label: "False completion claims", unit: "count", hib: false, stat: (g) => g.factuality.false_completion_claims, point: (r) => r.false_completion_claims },
  { id: "trap_hits", label: "Trap hits (any time in run)", unit: "count", hib: false, stat: (g) => g.factuality.trap_hits, point: (r) => r.trap_hits },
  { id: "trap_hits_final", label: "Trap hits left in final code", unit: "count", hib: false, stat: (g) => g.factuality.trap_hits_final, point: (r) => r.trap_hits_final },
  { id: "repeat_trap_hits", label: "Repeat trap hits", unit: "count", hib: false, stat: (g) => g.factuality.repeat_trap_hits, point: (r) => r.repeat_trap_hits },
  { id: "trap_following_edits", label: "Trap-following edits", unit: "count", hib: false, stat: (g) => g.factuality.trap_following_edits, point: (r) => r.trap_following_edits },
  { id: "poisoned_facts_accepted", label: "Poisoned facts accepted", unit: "count", hib: false, stat: (g) => g.factuality.poisoned_facts_accepted, point: (r) => r.poisoned_facts_accepted },
  { id: "jev_blocked_messages", label: "Messages blocked by Jev", unit: "count", hib: false, stat: (g) => g.factuality.jev_blocked_messages, point: (r) => r.jev_blocked_messages },
  { id: "recovery_s", label: "Time to recovery", unit: "s", hib: false, stat: (g) => g.recovery_s, point: (r) => r.recovery_s },
  { id: "finish_s", label: "Time to finish", unit: "s", hib: false, stat: (g) => g.finish_s, point: (r) => r.finish_s },
];

export function aggregate(rawRows: unknown[], opts: { includeMock?: boolean } = {}) {
  const all = rawRows.map((r) => normalize(r as Record<string, unknown>)).filter((r): r is NormRow => r !== null);
  const kept = all.filter((r) => !r.excluded);
  const rows = opts.includeMock ? kept : kept.filter((r) => !r.mock);
  const mock = rows.some((r) => r.mock);

  // legacy: per mode across versions
  const by: Partial<Record<AggMode, GroupSummary>> = {};
  for (const m of MODES) {
    const mr = rows.filter((r) => r.mode === m && !r.variant);
    if (mr.length) by[m] = summarizeGroup(m, null, mr);
  }
  // groups: mode × task version
  const versions = [...new Set(rows.map((r) => r.task_version))].sort((a, b) => a - b);
  const groups: GroupSummary[] = [];
  const byVersion: Record<string, Partial<Record<AggMode, GroupSummary>>> = {};
  for (const v of versions)
    for (const m of MODES) {
      const gr = rows.filter((r) => r.mode === m && r.task_version === v && !r.variant);
      if (gr.length) {
        const g = summarizeGroup(m, v, gr);
        groups.push(g);
        (byVersion[`v${v}`] ??= {})[m] = g;
      }
      // Tagged variants: their own group only (never in by_version, the legacy block or the claim).
      const variants = [...new Set(rows.filter((r) => r.mode === m && r.task_version === v && r.variant).map((r) => r.variant!))].sort();
      for (const vt of variants)
        groups.push(summarizeGroup(m, v, rows.filter((r) => r.mode === m && r.task_version === v && r.variant === vt), vt));
    }
  // Claim: newest version that has both codex_baseline and ours_cold; else the newest version.
  const claimV =
    [...versions].reverse().find((v) => byVersion[`v${v}`]?.codex_baseline && byVersion[`v${v}`]?.ours_cold) ?? versions.at(-1) ?? null;
  const claim = buildClaim(claimV === null ? {} : (byVersion[`v${claimV}`] ?? {}), claimV);
  const learning = learningCurves(rows);

  const summary = {
    generated_at: new Date().toISOString(),
    mock,
    ...(mock ? { mock_note: "MOCK: includes rows flagged mock, not measured" } : {}),
    rows_read: rawRows.length,
    rows_used: rows.length,
    rows_excluded_mock: kept.length - rows.length,
    rows_excluded: all.filter((r) => r.excluded).map((r) => ({ mode: r.mode, task: r.task, trial: r.trial, source: r.source, reason: r.excluded })),
    note: "In our runs (3 trials per task); mean and min-max, no significance claimed. Task versions are never pooled in `groups`.",
    groups,
    by_version: byVersion,
    modes: by,
    claim,
    learning_curves: learning.curves,
    learning_by_index: learning.by_index,
  };
  const chart = {
    generated_at: summary.generated_at,
    mock,
    groups: groups.map((g) => ({ id: g.group, mode: g.mode, task_version: g.task_version, label: g.label })),
    modes: MODES.filter((m) => by[m]).map((m) => ({ id: m, label: MODE_LABELS[m] })),
    metrics: METRICS.map(
      (mt): ChartMetric => ({
        id: mt.id,
        label: mt.label,
        unit: mt.unit,
        higher_is_better: mt.hib,
        series: groups.map((g) => {
          const s = mt.stat(g);
          return { group: g.group, mode: g.mode, task_version: g.task_version!, label: g.label, mean: s.mean, min: s.min, max: s.max, n: s.n };
        }),
        points: rows.map((r) => ({
          group: `${r.mode}@v${r.task_version}${r.variant ? `+${r.variant}` : ""}`,
          mode: r.mode,
          task_version: r.task_version,
          task: r.task,
          trial: r.trial,
          value: (() => {
            const v = mt.point(r);
            return v === null ? null : r4(v);
          })(),
        })),
      }),
    ),
    learning_curves: learning.curves,
    claim: claim.sentence,
    claim_task_version: claim.task_version,
  };
  return { summary, chart };
}

async function main() {
  const benchDir = resolve(import.meta.dir, "..");
  const { values } = parseArgs({
    options: {
      in: { type: "string", default: join(benchDir, "results.json") },
      out: { type: "string", default: join(benchDir, "results.summary.json") },
      chart: { type: "string", default: join(import.meta.dir, "chart-data.json") },
      "include-mock": { type: "boolean", default: false },
    },
  });
  const f = Bun.file(values.in);
  if (!(await f.exists())) {
    console.error(`no results file at ${values.in}`);
    process.exit(1);
  }
  const { summary, chart } = aggregate((await f.json()) as unknown[], { includeMock: values["include-mock"] });
  await Bun.write(values.out, JSON.stringify(summary, null, 2) + "\n");
  await Bun.write(values.chart, JSON.stringify(chart, null, 2) + "\n");
  console.log(`rows used ${summary.rows_used}/${summary.rows_read} (excluded: ${summary.rows_excluded.length}); groups: ${summary.groups.map((g) => g.group).join(", ") || "none"}`);
  console.log(`claim: ${summary.claim.sentence ?? `null (${summary.claim.missing.join("; ")})`}`);
  console.log(`wrote ${values.out} and ${values.chart}`);
}

if (import.meta.main) await main();
