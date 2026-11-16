#!/usr/bin/env bun
// bench/ab/results.json -> bench/ab/summary.json (docs/BENCHMARK.md "Feature A/B: caucus and vector kill").
// Every number is derived from the raw per-run data the runner stored (test runs, cases, chunks, events, snapshots).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
// bun bench/ab/summarize.ts [results.json [summary.json]]
const IN = process.argv[2] ?? "results.json";
const OUT = process.argv[3] ?? "summary.json";
const rows = JSON.parse(readFileSync(join(DIR, IN), "utf8")) as Row[];
const FNS = ["line_net", "line_tax", "invoice_totals", "convert", "due_date", "credit_note", "late_fee"];
const SENS: Record<string, string[]> = {
  line_net: ["test_half_away_from_zero", "test_yen_line"],
  line_tax: ["test_distance_sale_uses_buyer_rates", "test_dutch_reduced_rate"],
  invoice_totals: ["test_distance_sale", "test_only_exempt_and_export_kwd"],
  convert: ["test_same_currency_rounds", "test_into_yen"],
  credit_note: ["test_negative_half_away_from_zero"],
};
const DEP_SLOTS = Object.keys(SENS).map((f) => FNS.indexOf(f));

interface TestRun { t_s: number; agent: string; slot: number; gen: number; fn: string; passed: boolean; failed: string[]; usesHelper: boolean }
interface Case { id: string; slot: number; gen: number; category: string; reason: string | null; failed_tests: string[]; created_s: number; lesson: string; receivers: string[] }
interface Row {
  arm: string; trial: number; run_id: string; library_id: string; status: string; stopped: string | null; finish_s: number;
  tokens: { input: number; output: number; cached: number; reasoning: number }; usd: number; lessons_at_start: string[];
  poison_s: number | null; poison_rule: string; imports_at_poison: string[];
  final: { passing: string[]; followed: string[]; imports: string[] };
  test_runs: TestRun[]; cases: Case[];
  chunks: { id: string; slot: number; fn: string; helper: boolean; revoked: boolean; reusers: { name: string; first_seen_s: number }[] }[];
  revokes: { t_s: number; chunkId: string; suppressed: boolean }[];
  events: { t_s: number; type: string; slot?: number; gen?: number; status?: string; tokens?: { input: number; output: number } | null; ms?: number; caseId?: string; kind?: string | null }[];
  worker_calls: { t_s: number; slot: number; gen: number; step: number }[];
}

const stat = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return { mean: null, min: null, max: null, n: 0 };
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { mean: r(v.reduce((a, b) => a + b, 0) / v.length), min: r(Math.min(...v)), max: r(Math.max(...v)), n: v.length };
};
const poisonRun = (r: Row, tr: TestRun) => r.poison_s !== null && tr.t_s >= r.poison_s && !tr.passed && (SENS[tr.fn] ?? []).some((s) => tr.failed.includes(s));
const poisonCase = (r: Row, c: Case) => {
  const fn = FNS[c.slot]!;
  return r.poison_s !== null && c.created_s >= r.poison_s && (SENS[fn] ?? []).some((s) => c.failed_tests.includes(s));
};
const slotOf = (name: string) => Number(/^w(\d+)-/.exec(name)?.[1] ?? -1);
const tokensOf = (r: Row, slot: number, gen?: number) => {
  const best = new Map<string, number>();
  for (const e of r.events) if (e.type === "agent.status" && e.slot === slot && (gen === undefined || e.gen === gen) && e.tokens) {
    const k = `${e.slot}.${e.gen}`;
    best.set(k, Math.max(best.get(k) ?? 0, e.tokens.input + e.tokens.output));
  }
  return [...best.values()].reduce((a, b) => a + b, 0);
};

function perRun(r: Row) {
  const pcases = r.cases.filter((c) => poisonCase(r, c)).sort((a, b) => a.created_s - b.created_s);
  const first = pcases[0] ?? null;
  const indexSlot = first ? first.slot : null;
  const others = DEP_SLOTS.filter((s) => s !== indexSlot);
  const pruns = r.test_runs.filter((t) => poisonRun(r, t));
  const after = first ? first.created_s : (r.poison_s ?? Infinity);
  const othersAfterFirst = pruns.filter((t) => others.includes(t.slot) && t.t_s > after);
  const touch = r.test_runs.filter((t) => r.poison_s !== null && t.t_s >= r.poison_s && t.usesHelper).sort((a, b) => a.t_s - b.t_s)[0] ?? null;
  // Exp2a: replacement generations.
  const reps = [...new Set(r.worker_calls.filter((w) => w.gen >= 2).map((w) => `${w.slot}.${w.gen}`))].map((k) => {
    const [slot, gen] = k.split(".").map(Number) as [number, number];
    const runs = r.test_runs.filter((t) => t.slot === slot && t.gen === gen).sort((a, b) => a.t_s - b.t_s);
    const green = runs.find((t) => t.passed) ?? null;
    const calls = r.worker_calls.filter((w) => w.slot === slot && w.gen === gen).sort((a, b) => a.t_s - b.t_s);
    const start = calls[0]?.t_s ?? null;
    const prevCase = r.cases.find((c) => c.slot === slot && c.gen === gen - 1);
    const rec = r.events.find((e) => e.type === "recovery" && e.slot === slot && e.caseId === prevCase?.id);
    return {
      agent: `w${slot}-g${gen}`, fn: FNS[slot], after_poison_case: !!prevCase && poisonCase(r, prevCase),
      retired_again: r.cases.some((c) => c.slot === slot && c.gen === gen),
      poison_fail_runs: runs.filter((t) => poisonRun(r, t)).length,
      repeat_failure: runs.some((t) => poisonRun(r, t)) || r.cases.some((c) => c.slot === slot && c.gen === gen && poisonCase(r, c)),
      steps_to_green: green ? calls.filter((w) => w.t_s <= green.t_s).length : null,
      steps: calls.length,
      tokens: tokensOf(r, slot, gen),
      s_to_green: green && start !== null ? Math.round((green.t_s - start) * 10) / 10 : null,
      recovery_ms: rec?.ms ?? null,
      final_pass: r.final.passing.includes(FNS[slot]!), final_followed: r.final.followed.includes(FNS[slot]!),
      stale_handoff: ((r as unknown as { handoffs?: Record<string, { stale: boolean } | null> }).handoffs?.[`w${slot}-g${gen}`]?.stale) ?? null,
    };
  });
  // Exp2b: reusers of verified chunks whose code calls round_money.
  const helperChunks = r.chunks.filter((c) => c.helper);
  const reusers = [...new Set(helperChunks.flatMap((c) => c.reusers.map((u) => u.name)))];
  const reuserSlots = [...new Set(reusers.map(slotOf))];
  return {
    arm: r.arm, trial: r.trial, run_id: r.run_id, library_id: r.library_id, status: r.status, stopped: r.stopped,
    poison_s: r.poison_s, poison_rule: r.poison_rule, seed_met: r.poison_rule.startsWith("seed"),
    lessons_at_start: r.lessons_at_start.length,
    deps_importing_at_poison: r.imports_at_poison.filter((f) => SENS[f]).length,
    deps_importing_final: r.final.imports.filter((f) => SENS[f]).length,
    finish_s: r.finish_s, tokens: r.tokens.input + r.tokens.output, usd: r.usd, final_passing: r.final.passing.length,
    poison_final_all: r.final.followed.filter((f) => SENS[f]).length,
    retires: r.cases.length, poison_cases: pcases.length,
    lessons_naming_helper: r.cases.filter((c) => /round_money|billing_common/.test(c.lesson ?? "")).length,
    first_case_s: first?.created_s ?? null, index_fn: indexSlot !== null ? FNS[indexSlot] : null,
    // Exp1 (OTHER helper-dependent agents = the 5 dependent functions minus the index case's slot)
    repeat_failures_same_type_after_first_case: Math.max(0, pcases.length - 1),
    others_repeat_cases: pcases.filter((c) => c !== first && others.includes(c.slot)).length,
    others_retires_after_poison: r.cases.filter((c) => others.includes(c.slot) && r.poison_s !== null && c.created_s >= r.poison_s).length,
    others_poison_fail_runs_after_first_case: othersAfterFirst.length,
    others_poison_fail_runs_after_poison: pruns.filter((t) => others.includes(t.slot)).length,
    others_poison_final: r.final.followed.filter((f) => others.includes(FNS.indexOf(f))).length,
    others_failing_final: others.filter((s) => !r.final.passing.includes(FNS[s]!)).length,
    others_tokens: others.reduce((a, s) => a + tokensOf(r, s), 0),
    others_last_step_s: Math.max(0, ...r.worker_calls.filter((w) => others.includes(w.slot)).map((w) => w.t_s)),
    // Exp3
    poison_fail_runs_all: pruns.length,
    agents_with_poison_failure: new Set(pruns.map((t) => t.agent)).size,
    first_toucher: touch ? { agent: touch.agent, fn: touch.fn, failed_on_poison: r.test_runs.some((t) => t.agent === touch.agent && poisonRun(r, t)) } : null,
    // Exp2a
    replacements: reps,
    // Exp2b
    helper_chunks: helperChunks.length, helper_chunks_revoked: helperChunks.filter((c) => c.revoked).length,
    helper_reusers: reusers.length,
    helper_reuses_after_poison: helperChunks.flatMap((c) => c.reusers).filter((u) => r.poison_s !== null && u.first_seen_s > r.poison_s).length,
    reusers_poison_final: reuserSlots.filter((s) => r.final.followed.includes(FNS[s]!)).length,
    reusers_failing_final: reuserSlots.filter((s) => !r.final.passing.includes(FNS[s]!)).length,
    revoke_calls: r.revokes.filter((x) => !x.suppressed).length, revoke_suppressed: r.revokes.filter((x) => x.suppressed).length,
    revoke_dms: r.events.filter((e) => e.type === "relay.message" && e.kind === "revoke").length,
  };
}

type P = ReturnType<typeof perRun>;
// A run where the poison never landed (the run ended before the poison rule fired) tests nothing: excluded, listed.
const excluded = rows.filter((r) => r.poison_s === null).map((r) => ({ arm: r.arm, trial: r.trial, run_id: r.run_id, reason: "run ended before the poison rule fired" }));
const runsBy = (arm: string) => rows.filter((r) => r.arm === arm && r.poison_s !== null).map(perRun);
const agg = (ps: P[], keys: (keyof P)[]) => Object.fromEntries(keys.map((k) => [k, stat(ps.map((p) => p[k] as number | null))]));
const repAgg = (ps: P[]) => {
  // Only replacements of a slot retired on a poison case (round 2 also had retires on load-induced test timeouts).
  const reps = ps.flatMap((p) => p.replacements).filter((x) => x.after_poison_case);
  const n = reps.length;
  const rate = (f: (x: P["replacements"][number]) => boolean) => (n ? Math.round((reps.filter(f).length / n) * 1000) / 1000 : null);
  return {
    replacements: n, replacements_after_poison_case: reps.filter((x) => x.after_poison_case).length,
    repeat_failure_rate: rate((x) => x.repeat_failure), retired_again_rate: rate((x) => x.retired_again),
    final_pass_rate: rate((x) => x.final_pass), final_followed_rate: rate((x) => x.final_followed),
    steps_to_green: stat(reps.map((x) => x.steps_to_green)), tokens: stat(reps.map((x) => x.tokens)),
    s_to_green: stat(reps.map((x) => x.s_to_green)), recovery_ms: stat(reps.map((x) => x.recovery_ms)),
    never_green: reps.filter((x) => x.steps_to_green === null).length,
    stale_handoffs: reps.filter((x) => x.stale_handoff === true).length,
    handoffs_read: reps.filter((x) => x.stale_handoff !== null).length,
  };
};

const COMMON: (keyof P)[] = ["poison_s", "deps_importing_at_poison", "finish_s", "tokens", "usd", "final_passing", "poison_final_all", "retires", "poison_cases", "lessons_naming_helper"];
const arms = Object.fromEntries(["A", "B", "C", "D", "E"].map((a) => [a, runsBy(a)]));
const summary = {
  generated_at: new Date().toISOString(),
  task: "invoicing_ab (bench/ab/tasks; v3 invoicing, clean helper, mid-run round_money -> ROUND_HALF_EVEN)",
  model: [...new Set(rows.map((r) => (r as unknown as { model: string }).model))],
  rows: rows.length,
  excluded,
  usd_total: Math.round(rows.reduce((a, r) => a + (r.usd ?? 0), 0) * 10000) / 10000,
  note: "mean and min-max over trials; no significance claimed. OTHER agents = the 5 helper-dependent functions minus the first poison case's slot.",
  exp1_caucus: Object.fromEntries((["A", "B"] as const).map((a) => [a === "A" ? "herd_on" : "herd_off", {
    arm: a, trials: arms[a]!.length,
    ...agg(arms[a]!, [...COMMON, "first_case_s", "repeat_failures_same_type_after_first_case", "others_repeat_cases", "others_retires_after_poison", "others_poison_fail_runs_after_first_case", "others_poison_fail_runs_after_poison", "others_poison_final", "others_failing_final", "others_tokens", "others_last_step_s"]),
  }])),
  exp2a_respawn: Object.fromEntries((["A", "C"] as const).map((a) => [a === "A" ? "clean" : "dirty", { arm: a, trials: arms[a]!.length, ...agg(arms[a]!, COMMON), replacement: repAgg(arms[a]!) }])),
  exp2b_revocation: Object.fromEntries((["B", "D"] as const).map((a) => [a === "B" ? "revoke_on" : "revoke_off", {
    arm: a, trials: arms[a]!.length, seed_met: arms[a]!.filter((p) => p.seed_met).length,
    ...agg(arms[a]!, [...COMMON, "helper_chunks", "helper_chunks_revoked", "helper_reusers", "helper_reuses_after_poison", "reusers_poison_final", "reusers_failing_final", "revoke_calls", "revoke_suppressed", "revoke_dms"]),
  }])),
  exp3_library: Object.fromEntries((["A", "E"] as const).map((a) => [a === "A" ? "cold" : "warm_with_cases", {
    arm: a, trials: arms[a]!.length, libraries: [...new Set(arms[a]!.map((p) => p.library_id))],
    ...agg(arms[a]!, [...COMMON, "lessons_at_start", "deps_importing_final", "poison_fail_runs_all", "agents_with_poison_failure"]),
    first_toucher_failed: arms[a]!.map((p) => p.first_toucher?.failed_on_poison ?? null),
  }])),
  per_run: arms,
};
writeFileSync(join(DIR, OUT), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ exp1: summary.exp1_caucus, exp2a: summary.exp2a_respawn, exp2b: summary.exp2b_revocation, exp3: summary.exp3_library }, (k, v) => (k === "per_run" ? undefined : v), 0).slice(0, 200));
