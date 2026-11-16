// FIXTURE — HAND-WRITTEN, NOT MEASURED. Every row carries mock: true.
// Used only by summarize.test.ts to check the summarizer's arithmetic. Never chart these numbers.
import type { AgentRow, ExperimentState } from "../types.ts";

const T = (i: number, o: number) => ({ input: i, cached: 0, output: o, reasoning: 0 });

function row(arm: AgentRow["arm"], run: number, slot: number, over: Partial<AgentRow> = {}): AgentRow {
  return {
    schema: "emergence.agent.v1",
    experiment: "FIXTURE-not-measured",
    arm,
    run_key: `${arm}:${String(run).padStart(4, "0")}`,
    arm_run_index: run,
    arm_agent_index: run * 4 + slot,
    launch_seq: run * 2 + (arm === "shared" ? 1 : 2),
    wave: run + 1,
    run_id: `FIX-${arm}-${run}`,
    library_id: arm === "shared" ? "FIX-lib" : `FIX-lib-${run}`,
    task: "invoice_parser",
    model: "FIXTURE",
    slot,
    function: `fn${slot}`,
    launched_at: 1_000_000 + run * 100_000,
    ended_at: 1_000_000 + run * 100_000 + 90_000,
    run_status: "finished",
    run_wall_ms: 90_000,
    killed: false,
    capped_usd: false,
    stopped_by_budget: false,
    crash: null,
    generations: 1,
    retired: false,
    retire_cases: 0,
    trap_ids: [],
    exposed: false,
    trap_hit_final: false,
    trap_hit_any: false,
    traps_followed: [],
    function_pass_final: true,
    tokens: T(1000, 100),
    usd: 0.002,
    tokens_source: "FIXTURE",
    lesson_in_prompt: false,
    lesson_in_prompt_source: "FIXTURE",
    trap_lesson_in_library_at_launch: false,
    library_cases_at_launch: 0,
    library_lessons_at_launch: 0,
    library_synthetic_at_launch: 0,
    chunk_reused: false,
    chunk_reuse_source: "FIXTURE",
    run_tokens: T(5000, 500),
    run_usd: 0.01,
    run_unattributed_tokens: 1100,
    snapshots: 6,
    notes: ["FIXTURE: not measured"],
    mock: true,
    ...over,
  };
}

const trap = { trap_ids: ["amount_cents"], exposed: true };

export const FIXTURE_ROWS: AgentRow[] = [
  // shared run 0: the trap is hit (slot 1), slot 1 fails its tests.
  row("shared", 0, 0, { tokens: T(1, 1) }), // replaced by the duplicate below (last row wins)
  row("shared", 0, 1, { ...trap, trap_hit_final: true, trap_hit_any: true, traps_followed: ["amount_cents"], function_pass_final: false }),
  row("shared", 0, 2),
  row("shared", 0, 3),
  row("shared", 0, 0), // duplicate of (shared:0000, slot 0)
  // shared run 1: lesson in library and prompt; trap followed mid-run but fixed by the end; a chunk reused.
  row("shared", 1, 0, { chunk_reused: true, library_cases_at_launch: 1, library_lessons_at_launch: 1 }),
  row("shared", 1, 1, { ...trap, trap_hit_any: true, traps_followed: ["amount_cents"], lesson_in_prompt: true, trap_lesson_in_library_at_launch: true, library_cases_at_launch: 1, library_lessons_at_launch: 1 }),
  row("shared", 1, 2, { library_cases_at_launch: 1, library_lessons_at_launch: 1 }),
  row("shared", 1, 3, { library_cases_at_launch: 1, library_lessons_at_launch: 1 }),
  // shared run 2: two exposed slots, one prompt not exposed (null), one agent without ledger tokens.
  row("shared", 2, 0, { ...trap, task: "shipping_rates", library_cases_at_launch: 2, library_lessons_at_launch: 2 }),
  row("shared", 2, 1, { task: "shipping_rates", library_cases_at_launch: 2, library_lessons_at_launch: 2 }),
  row("shared", 2, 2, { ...trap, task: "shipping_rates", lesson_in_prompt: null, library_cases_at_launch: 2, library_lessons_at_launch: 2 }),
  row("shared", 2, 3, { task: "shipping_rates", tokens: null, usd: null, library_cases_at_launch: 2, library_lessons_at_launch: 2 }),
  // control run 0 and 1: trap hit both times; run 1's slot 1 retired.
  row("control", 0, 0),
  row("control", 0, 1, { ...trap, trap_hit_final: true, trap_hit_any: true, function_pass_final: false }),
  row("control", 0, 2),
  row("control", 0, 3),
  row("control", 1, 0),
  row("control", 1, 1, { ...trap, trap_hit_final: true, trap_hit_any: true, retired: true, generations: 2, retire_cases: 1, function_pass_final: false }),
  row("control", 1, 2),
  row("control", 1, 3),
];

export const FIXTURE_STATE: ExperimentState = {
  experiment: "FIXTURE-not-measured",
  library_id: "FIX-lib",
  created_at: 900_000,
  key_usage_baseline: 10,
  key_usage_last: 10.06,
  key_usage_last_at: 1_400_000,
  budget_usd: 12,
  next_launch_seq: 7,
  sessions: [
    { started_at: 950_000, ended_at: 1_150_000, runs_completed: 3, stop_reason: null, peaks: { processes: 600, stack_processes: 40, stack_rss_mb: 3000, bench_rss_mb: 200, samples: 10 } },
    { started_at: 1_160_000, ended_at: 1_400_000, runs_completed: 2, stop_reason: "SIGINT", peaks: { processes: 550, stack_processes: 70, stack_rss_mb: 2500, bench_rss_mb: 250, samples: 12 } },
  ],
  waves: [
    { wave: 1, at: 1_100_000, run_keys: ["shared:0000", "control:0000"], library: { cases: 1, lessons: 1, synthetic: 0, revoked: 0 } },
    { wave: 2, at: 1_200_000, run_keys: ["shared:0001", "control:0001"], library: null },
    { wave: 3, at: 1_300_000, run_keys: ["shared:0002"], library: { cases: 2, lessons: 2, synthetic: 0, revoked: 0 } },
  ],
};
