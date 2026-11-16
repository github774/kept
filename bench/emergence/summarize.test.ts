// Unit tests for the emergence summarizer, schedule, budget guard and row builder.
// Data comes from fixtures/rows.FIXTURE.ts: HAND-WRITTEN, NOT MEASURED (every row is mock: true).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentCard, RunSummary } from "../../orchestrator/src/contract.ts";
import type { TaskJson } from "../ours/metrics.ts";
import type { Snapshot } from "../ours/pytest.ts";
import { checkBudget } from "./budget.ts";
import { FIXTURE_ROWS, FIXTURE_STATE } from "./fixtures/rows.FIXTURE.ts";
import { buildSchedule, estimateCost } from "./plan.ts";
import { agentIdSlot, buildAgentRows } from "./probe.ts";
import { summarize } from "./summarize.ts";

describe("summarize (FIXTURE, not measured)", () => {
  const s = summarize(FIXTURE_ROWS, FIXTURE_STATE, { windowSize: 4, includeMock: true, now: new Date(0) });

  test("excludes mock rows unless asked", () => {
    const d = summarize(FIXTURE_ROWS, FIXTURE_STATE, { windowSize: 4 });
    expect(d.rows_used).toBe(0);
    expect(d.rows_excluded_mock).toBe(21);
    expect(d.curve.windows).toEqual([]);
    expect(s.mock).toBe(true);
  });

  test("dedupes (run_key, slot), last row wins", () => {
    expect(s.rows_read).toBe(21);
    expect(s.rows_used).toBe(20);
    expect(s.duplicate_rows_dropped).toBe(1);
    expect(s.arms.shared!.windows[0]!.tokens).toBe(4400); // the dropped row had 2 tokens
  });

  test("shared windows", () => {
    const [w0, w1, w2] = s.arms.shared!.windows;
    expect(w0!.trap_hit_final).toEqual({ count: 1, known: 1, rate: 1 });
    expect(w0!.passing_subtasks).toEqual({ count: 3, known: 4, rate: 0.75 });
    expect(w0!.tokens_per_passing_subtask).toBe(1467);
    expect(w0!.partial).toBe(false);

    expect(w1!.trap_hit_final.rate).toBe(0);
    expect(w1!.trap_hit_any.rate).toBe(1);
    expect(w1!.lesson_in_prompt).toEqual({ count: 1, known: 1, rate: 1 });
    expect(w1!.trap_lesson_in_library_at_launch.rate).toBe(1);
    expect(w1!.chunk_reused).toEqual({ count: 1, known: 4, rate: 0.25 });
    expect(w1!.tokens_per_passing_subtask).toBe(1100);
    expect(w1!.library_cases_at_launch_max).toBe(1);

    expect(w2!.exposed).toBe(2);
    expect(w2!.trap_hit_final).toEqual({ count: 0, known: 2, rate: 0 });
    expect(w2!.lesson_in_prompt).toEqual({ count: 0, known: 1, rate: 0 }); // null is unknown, not false
    expect(w2!.tokens_known).toBe(3);
    expect(w2!.tokens_per_passing_subtask).toBeNull(); // one agent unmeasured: no gap filling
    expect(w2!.usd).toBe(0.006);
  });

  test("arm totals", () => {
    const a = s.arms.shared!;
    expect(a.agents).toBe(12);
    expect(a.runs).toBe(3);
    expect(a.trap_hit_final).toEqual({ count: 1, known: 4, rate: 0.25 });
    expect(a.trap_hit_any).toEqual({ count: 2, known: 4, rate: 0.5 });
    expect(a.run_tokens).toBe(16500);
    expect(a.run_usd).toBe(0.03);
    expect(a.run_tokens_per_passing_subtask).toBe(1500);
    const c = s.arms.control!;
    expect(c.trap_hit_final.rate).toBe(1);
    expect(c.retired).toEqual({ count: 1, known: 8, rate: 0.125 });
    expect(c.run_tokens_per_passing_subtask).toBe(1833);
  });

  test("curve keeps missing windows null", () => {
    expect(s.curve.windows.map((w) => [w.shared, w.control])).toEqual([[1, 1], [0, 1], [0, null]]);
    expect(s.curve.windows[2]!.control_n).toBe(0);
  });

  test("cost, wall, resources, library growth", () => {
    expect(s.cost).toEqual({ ledger_usd: 0.05, openrouter_key_usage_delta_usd: 0.06, budget_usd: 12 });
    expect(s.wall).toEqual({ first_launch: 1_000_000, last_end: 1_290_000, span_ms: 290_000, session_ms: 440_000, run_ms_mean: 90_000 });
    expect(s.resources).toEqual({ processes: 600, stack_processes: 70, stack_rss_mb: 3000, bench_rss_mb: 250, samples: 22 });
    expect(s.library_growth.map((w) => [w.wave, w.cases])).toEqual([[1, 1], [3, 2]]);
  });

  test("no state => nulls, not zeros", () => {
    const n = summarize(FIXTURE_ROWS, null, { windowSize: 4, includeMock: true });
    expect(n.resources).toBeNull();
    expect(n.cost.openrouter_key_usage_delta_usd).toBeNull();
    expect(n.wall.session_ms).toBeNull();
  });
});

describe("schedule", () => {
  test("interleaves arms, rotates tasks, stable keys", () => {
    const s = buildSchedule(4, 2, ["a", "b", "c"]);
    expect(s.map((x) => x.key)).toEqual(["shared:0000", "shared:0001", "control:0000", "shared:0002", "shared:0003", "control:0001"]);
    expect(buildSchedule(3, 3, ["a"]).map((x) => x.arm)).toEqual(["shared", "control", "shared", "control", "shared", "control"]);
    expect(s.filter((x) => x.arm === "shared").map((x) => x.task)).toEqual(["a", "b", "c", "a"]);
    const bigger = buildSchedule(8, 8, ["a", "b", "c"]);
    for (const x of s) expect(bigger.find((y) => y.key === x.key)!.task).toBe(x.task);
    expect(buildSchedule(0, 3, ["a"]).every((x) => x.arm === "control")).toBe(true);
  });

  test("estimate is labelled and prefers measured runs", () => {
    const caps = { agents_per_run: 4, usd_per_run: 1, steps_per_generation: 12, generations_per_slot: 2, prompt_input_tokens_per_step: 12000, codex_wall_clock_ms: 600000, max_lessons: 10 };
    const e = estimateCost(10, caps, { input: 0.1, output: 0.5 }, [0.02, 0.04], undefined, 1);
    expect(e.label).toBe("est.");
    expect(e.usd_per_run).toBe(0.03);
    expect(e.usd_total_remaining).toBe(0.3);
    expect(e.runs_fit_in_budget).toBe(33);
    expect(e.hard_cap_usd_total).toBe(10);
  });
});

describe("budget guard", () => {
  test("key delta or ledger over the limit stops", () => {
    expect(checkBudget(12, 10, 21.9, 5).over).toBe(false);
    expect(checkBudget(12, 10, 22.01, 5).over).toBe(true);
    expect(checkBudget(12, null, null, 12.5).reason).toContain("Ledger");
    expect(checkBudget(12, 10, null, 1).key_delta_usd).toBeNull();
  });
});

describe("buildAgentRows (synthetic snapshot, not measured)", () => {
  const task: TaskJson = {
    id: "invoice_parser",
    functions: [
      { name: "format_invoice_id", file: "format_invoice_id.py", test: "tests/test_format_invoice_id.py" },
      { name: "parse_line", file: "parse_line.py", test: "tests/test_parse_line.py" },
    ],
    traps: [{ id: "amount_cents", trap_test: "tests/test_parse_line.py::test_trap_amount_is_dollars" }],
  };
  const pl = "tests/test_parse_line.py";
  const snap = (t: number, trapFails: boolean): Snapshot => ({
    t_ms: t,
    broken: false,
    cases: [
      { nodeid: `${pl}::test_basic_row`, base: `${pl}::test_basic_row`, outcome: "passed", message: "" },
      { nodeid: `${pl}::test_trap_amount_is_dollars`, base: `${pl}::test_trap_amount_is_dollars`, outcome: trapFails ? "failed" : "passed", message: trapFails ? "assert 12.5 == 1250" : "" },
      { nodeid: "tests/test_format_invoice_id.py::test_x", base: "tests/test_format_invoice_id.py::test_x", outcome: "passed", message: "" },
    ],
  });
  const card = (slot: number, subtask: string, gen = 1): AgentCard =>
    ({ slot, name: `w${slot}-g${gen}-r1`, gen, status: gen > 1 ? "probation" : "trusted", step: 3, subtask, tokens: { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 }, possessed: false, verifiedSteps: 2 }) as AgentCard;
  const summary = { runId: "r1", taskId: "invoice_parser", mode: "ours", libraryId: "L", status: "finished", model: "m", startedAt: 0, agents: 2, retires: 1, cases: 1, testsPassing: 2, testsTotal: 2, usd: 0.01 } as RunSummary;
  const lessonCase = { id: "r0.1.g1", runId: "r0", libraryId: "L", slot: 1, gen: 1, agentName: "w1-g1-r0", task: "invoice_parser", subtask: "parse_line", claim: "", evidence: { testOutput: "FAILED test_trap_amount_is_dollars" }, category: "spec_misread", lesson: "Amounts are dollars.", recipients: [], synthetic: false, revoked: false, createdAt: 50 } as any;

  const rows = buildAgentRows(
    { experiment: "x", key: "shared:0001", arm: "shared", armRunIndex: 1, launchSeq: 3, wave: 2, agentsPerRun: 2, task, startedAt: 100, endedAt: 200, summary, killed: false, capped: false, stoppedByBudget: false, crash: null },
    {
      snapshots: [snap(10, true), snap(20, false)],
      roster: [card(0, "format_invoice_id"), card(1, "parse_line", 2)],
      runCases: [{ ...lessonCase, id: "r1.1.g1", runId: "r1", createdAt: 150 }],
      libraryAtLaunch: [lessonCase, { ...lessonCase, id: "late", createdAt: 150 }],
      libraryAtEnd: null,
      ledgerRows: [
        { id: "a", category: "worker", input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_tokens: 5, usd: 0.001, slot: "1" },
        { id: "b", category: "jev", input_tokens: 30, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0.0001, slot: "w1" },
        { id: "c", category: "reuse_est", input_tokens: 999, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0, slot: "0" },
        { id: "d", category: "embedding", input_tokens: 7, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0 },
      ],
      ledgerTotals: null,
      chunks: null,
      telemetry: [{ slot: 1, gen: 2, lessonCaseIds: ["r0.1.g1"] }],
    },
  );

  test("trap, retire, tokens, lesson, reuse per slot", () => {
    const [a0, a1] = rows;
    expect(a0!.exposed).toBe(false);
    expect(a0!.trap_hit_final).toBe(false);
    expect(a0!.chunk_reused).toBe(true); // reuse_est row on slot 0
    expect(a0!.tokens).toEqual({ input: 0, cached: 0, output: 0, reasoning: 0 });
    expect(a0!.arm_agent_index).toBe(2);

    expect(a1!.exposed).toBe(true);
    expect(a1!.trap_hit_any).toBe(true);
    expect(a1!.trap_hit_final).toBe(false);
    expect(a1!.function_pass_final).toBe(true);
    expect(a1!.retired).toBe(true);
    expect(a1!.generations).toBe(2);
    expect(a1!.tokens).toEqual({ input: 130, cached: 10, output: 20, reasoning: 5 });
    expect(a1!.lesson_in_prompt).toBe(true);
    expect(a1!.trap_lesson_in_library_at_launch).toBe(true);
    expect(a1!.library_cases_at_launch).toBe(1); // the case created after launch does not count
    expect(a1!.run_unattributed_tokens).toBe(7);
  });

  test("agent id parsing", () => {
    expect(agentIdSlot("w3-g2-r7k2")).toBe(3);
    expect(agentIdSlot("agent.r7k2.2.g1")).toBe(2);
    expect(agentIdSlot("nope")).toBeNull();
  });
});

test("fixture file is labelled", async () => {
  const text = await Bun.file(join(import.meta.dir, "fixtures", "rows.FIXTURE.ts")).text();
  expect(text.startsWith("// FIXTURE — HAND-WRITTEN, NOT MEASURED")).toBe(true);
  expect(FIXTURE_ROWS.every((r) => r.mock === true)).toBe(true);
});
