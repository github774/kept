// Unit tests for aggregate.ts against a hand-written MOCK fixture (fixtures/results.MOCK.fixture.json).
// The fixture is not measured data; it only checks the arithmetic.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { aggregate, buildClaim, normalize } from "./aggregate.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "results.MOCK.fixture.json");
const rows = (await Bun.file(FIXTURE).json()) as unknown[];

describe("aggregate (MOCK fixture)", () => {
  const { summary, chart } = aggregate(rows);

  test("excludes mock rows by default and normalizes both row shapes", () => {
    expect(summary.rows_read).toBe(9);
    expect(summary.rows_used).toBe(8);
    expect(summary.rows_excluded_mock).toBe(1);
    expect(summary.mock).toBe(false);
    expect(Object.keys(summary.modes).sort()).toEqual(["ablation", "codex_baseline", "ours_cold", "ours_warm"]);
    expect(normalize({ mode: "codex_baseline", task: "shipping", recovery_ms: 20000, tokens: { input: 1, cached: 0, output: 2, reasoning: 0 } })?.recovery_s).toBe(20);
    expect(normalize({ mode: "nope" })).toBeNull();
  });

  test("codex baseline stats", () => {
    const c = summary.modes.codex_baseline!;
    expect(c.trials).toBe(3);
    expect(c.passes).toBe(2);
    expect(c.success_rate).toEqual({ mean: 0.6667, min: 0.5, max: 1, n: 3 });
    expect(c.tokens_per_passing_task).toEqual({ mean: 1100, min: 1000, max: 1200, n: 2 });
    expect(c.tokens_per_passing_task_pooled).toBe(2000);
    expect(c.usd_per_passing_task_pooled).toBe(0.03);
    expect(c.recovery_s).toEqual({ mean: 30, min: 20, max: 40, n: 2 });
    expect(c.finish_s.max).toBe(600);
    expect(c.trap_hits.mean).toBeCloseTo(1.3333, 4);
    expect(c.repeat_trap_hits).toEqual({ mean: 0.6667, min: 0, max: 1, n: 3 });
    expect(c.tasks).toEqual(["invoice", "shipping"]);
  });

  test("ours cold stats ignore the mock row", () => {
    const o = summary.modes.ours_cold!;
    expect(o.trials).toBe(3);
    expect(o.success_rate.mean).toBe(1);
    expect(o.usd_per_passing_task_pooled).toBe(0.01);
    expect(o.recovery_s).toEqual({ mean: 15, min: 10, max: 20, n: 2 });
    expect(o.false_retires).toEqual({ mean: 0.3333, min: 0, max: 1, n: 3 });
  });

  test("claim filled from measured numbers", () => {
    expect(summary.claim.sentence).toBe(
      "On our 2-task benchmark against Codex subagents, 50% higher success at 67% lower net cost, with 50% faster recovery.",
    );
  });

  test("claim is null when data is missing or ours is worse", () => {
    expect(buildClaim({}).sentence).toBeNull();
    const onlyOurs = aggregate(rows.filter((r) => !String((r as { mode: string }).mode).startsWith("codex")));
    expect(onlyOurs.summary.claim.sentence).toBeNull();
    expect(onlyOurs.summary.claim.missing).toContain("no codex_baseline rows");
    const swapped = rows.map((r) => {
      const x = r as { mode: string };
      return { ...x, mode: x.mode === "ours" || x.mode === "ours_cold" ? "codex" : x.mode.startsWith("codex") ? "ours" : x.mode };
    });
    const s = aggregate(swapped).summary.claim;
    expect(s.sentence).toBeNull();
    expect(s.missing.some((m) => m.includes("not better"))).toBe(true);
  });

  test("include-mock flags the output", () => {
    const { summary: s } = aggregate(rows, { includeMock: true });
    expect(s.mock).toBe(true);
    expect(s.mock_note).toContain("MOCK");
  });

  test("chart data shape", () => {
    expect(chart.modes.map((m) => m.id)).toEqual(["codex_baseline", "ours_cold", "ours_warm", "ablation"]);
    const sr = chart.metrics.find((m) => m.id === "success_rate")!;
    expect(sr.series.find((s) => s.mode === "ours_cold")!.mean).toBe(1);
    expect(sr.points.length).toBe(8);
    const tok = chart.metrics.find((m) => m.id === "tokens_per_passing_task")!;
    expect(tok.points.filter((p) => p.value === null).length).toBe(1);
    expect(chart.claim).toBe(summary.claim.sentence);
  });

  test("legacy fixture rows are task version 1", () => {
    expect(summary.groups.map((g) => g.group)).toEqual(["codex_baseline@v1", "ours_cold@v1", "ours_warm@v1", "ablation@v1"]);
    expect(summary.claim.task_version).toBe(1);
  });
});

describe("aggregate: excluded rows, versions, breakdowns, curves (inline MOCK rows)", () => {
  const base = { model: "m", usd: 0.02, trap_hits: 0, repeat_trap_hits: 0 };
  const rows2 = [
    { ...base, mode: "codex_baseline", task: "invoice_parser", trial: 1, task_version: 1, success: true, sourceId: "a",
      tokens: { input: 1000, cached: 900, output: 100, reasoning: 40 }, started_at: "2026-10-31T18:00:00Z" },
    { ...base, mode: "codex_baseline", task: "invoice_parser", trial: 1, task_version: 1, success: false, sourceId: "dup",
      tokens: { input: 5, cached: 0, output: 5, reasoning: 0 }, excluded: "duplicate_trial", started_at: "2026-10-31T18:05:00Z" },
    { ...base, mode: "codex_baseline", task: "invoice_parser", trial: 1, task_version: 2, success: true, sourceId: "b",
      tokens: { input: 2000, cached: 1500, output: 200, reasoning: 80 }, usd: 0.04, trap_hits: 2, repeat_trap_hits: 1,
      false_completion_claims: 1, trap_following_edits: 2,
      subagent_efficiency: [{ tokens_total: 100, model_calls: 4, turns: 1 }, { tokens_total: 300, model_calls: 6, turns: 2 }] },
    { ...base, mode: "ours_cold", task: "invoice_parser", trial: 1, task_version: 2, success: true, sourceId: "c", library_id: "L1",
      tokens: { input: 800, cached: 0, output: 100, reasoning: 0 }, usd: 0.01, trap_hits: 1, repeat_trap_hits: 0, started_at: "2026-10-31T19:00:00Z" },
    { ...base, mode: "ours_warm", task: "invoice_parser", trial: 1, task_version: 2, success: true, sourceId: "d", library_id: "L1",
      tokens: { input: 600, cached: 0, output: 80, reasoning: 0 }, usd: 0.008, trap_hits: 0, repeat_trap_hits: 0, started_at: "2026-10-31T19:10:00Z" },
  ];
  const { summary: s, chart: c } = aggregate(rows2);

  test("excluded rows are skipped and listed", () => {
    expect(s.rows_used).toBe(4);
    expect(s.rows_excluded).toEqual([{ mode: "codex_baseline", task: "invoice", trial: 1, source: "dup", reason: "duplicate_trial" }]);
    const v1 = s.by_version.v1!.codex_baseline!;
    expect(v1.trials).toBe(1);
    expect(v1.success_rate.mean).toBe(1);
  });

  test("versions are separate groups; token breakdown and subagent efficiency", () => {
    expect(s.groups.map((g) => g.group)).toEqual(["codex_baseline@v1", "codex_baseline@v2", "ours_cold@v2", "ours_warm@v2"]);
    const g = s.by_version.v2!.codex_baseline!;
    expect(g.tokens_breakdown_per_passing_task.input_uncached.mean).toBe(500);
    expect(g.tokens_breakdown_per_passing_task.cached.mean).toBe(1500);
    expect(g.tokens_breakdown_per_passing_task.reasoning.mean).toBe(80);
    expect(g.tokens_breakdown_per_passing_task_pooled.total).toBe(2200);
    expect(g.usd_per_passing_task.mean).toBe(0.04);
    expect(g.subagents.tokens_per_subagent).toEqual({ mean: 200, min: 100, max: 300, n: 2 });
    expect(g.subagents.model_calls_per_subagent.mean).toBe(5);
    expect(g.factuality.false_completion_claims.mean).toBe(1);
    expect(g.factuality.poisoned_facts_accepted).toEqual({ mean: null, min: null, max: null, n: 0 });
  });

  test("claim compares like with like (newest version with both sides)", () => {
    expect(s.claim.task_version).toBe(2);
    expect(s.claim.values.cost_pct_lower).toBe(75);
  });

  test("learning curves: library sequence ordered by start, codex control by trial", () => {
    const lib = s.learning_curves.find((x) => x.kind === "library")!;
    expect(lib.id).toBe("L1");
    expect(lib.runs.map((r) => [r.index, r.mode, r.trap_hits])).toEqual([[1, "ours_cold", 1], [2, "ours_warm", 0]]);
    expect(s.learning_curves.filter((x) => x.kind === "control").map((x) => x.id).sort()).toEqual(["codex:invoice@v1", "codex:invoice@v2"]);
  });

  test("chart series are per group", () => {
    const tok = c.metrics.find((m) => m.id === "tokens_reasoning_per_passing_task")!;
    expect(tok.series.find((x) => x.group === "codex_baseline@v2")!.mean).toBe(80);
    expect(c.groups.length).toBe(4);
  });
});

