// Tests for the ground-truth snapshot + metric code. Uses the task suite's own _solution and
// _trap_variant files as code under test (a FIXTURE, not a benchmark run), plus synthetic
// snapshot timelines labelled MOCK.
import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_DIR } from "../src/config.ts";
import { allPass, falseRetires, trapFamily, trapFollowed, trapMetrics, type TaskJson } from "./metrics.ts";
import { expectedTestCount, parseJunit, snapshot, type Snapshot } from "./pytest.ts";

const TASK = join(BENCH_DIR, "tasks", "invoice_parser");
const task = (await Bun.file(join(TASK, "task.json")).json()) as TaskJson;

async function work(layers: string[]): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ours-fixture-"));
  for (const l of layers) for (const f of await readdir(join(TASK, l))) if (f.endsWith(".py")) await cp(join(TASK, l, f), join(d, f));
  return d;
}

describe("pytest snapshots on the task's own fixture code", () => {
  test("starter: nothing passes, trap is NOT counted as followed (NotImplementedError)", async () => {
    const n = await expectedTestCount(TASK);
    const s = await snapshot(await work(["starter"]), TASK, 0);
    expect(n).toBe(19);
    expect(allPass(s, n)).toBe(false);
    expect(trapFollowed(s, task.traps[0]!)).toBe(false);
  });
  test("solution + trap variant: trap followed, everything else passes", async () => {
    const s = await snapshot(await work(["_solution", "_trap_variant"]), TASK, 0);
    expect(trapFollowed(s, task.traps[0]!)).toBe(true);
    expect(s.cases.filter((c) => c.outcome !== "passed").map((c) => c.base)).toEqual([task.traps[0]!.trap_test]);
  });
  test("solution: all pass", async () => {
    const s = await snapshot(await work(["_solution"]), TASK, 0);
    expect(allPass(s, 19)).toBe(true);
  });
  test("parseJunit handles collection errors", () => {
    const r = parseJunit('<testcase classname="" name="tests.test_x" time="0"><error message="collection failure">x</error></testcase>');
    expect(r[0]).toMatchObject({ nodeid: "tests/test_x.py", outcome: "error" });
  });
});

// MOCK timelines (synthetic snapshots) for the timing/count logic.
const trap = task.traps[0]!;
const snap = (t: number, trapState: "followed" | "pass" | "unimpl", others: "pass" | "fail"): Snapshot => ({
  t_ms: t,
  broken: false,
  cases: [
    { nodeid: trap.trap_test, base: trap.trap_test, outcome: trapState === "pass" ? "passed" : "failed",
      message: trapState === "unimpl" ? "NotImplementedError" : trapState === "followed" ? "AssertionError: assert 19.99 == 1999.00" : "" },
    { nodeid: "tests/test_parse_line.py::test_basic_row", base: "tests/test_parse_line.py::test_basic_row", outcome: others === "pass" ? "passed" : "failed", message: "" },
  ],
});

describe("trap metrics (MOCK timelines)", () => {
  test("hit, recovery, re-hit", () => {
    const m = trapMetrics([snap(0, "unimpl", "fail"), snap(3000, "followed", "pass"), snap(9000, "pass", "pass"), snap(12000, "followed", "pass"), snap(15000, "pass", "pass")], task.traps, 2);
    expect(m).toEqual({ trap_hits: 1, repeat_trap_hits: 1, traps_hit: ["amount_cents"], first_trap_ms: 3000, time_to_recovery_ms: 6000 });
  });
  test("never hit -> null recovery", () => {
    expect(trapMetrics([snap(0, "unimpl", "fail"), snap(3000, "pass", "pass")], task.traps, 2).time_to_recovery_ms).toBeNull();
  });
  test("trap family groups the shipping traps", () => {
    const traps = [{ id: "stale_rate_table", trap_test: "a" }, { id: "stale_rate_table_quote", trap_test: "b" }];
    expect(trapFamily("stale_rate_table_quote", traps)).toBe("stale_rate_table");
  });
  test("false retires: retiring an agent whose tests were passing", () => {
    const fns = task.functions;
    const snaps = [snap(0, "followed", "fail"), snap(5000, "pass", "pass")];
    expect(falseRetires([{ subtask: "parse_line", createdAt: 1000 + 2000, synthetic: false, revoked: false }], snaps, fns, 1000)).toBe(0);
    expect(falseRetires([{ subtask: "parse_line", createdAt: 1000 + 6000, synthetic: false, revoked: false }], snaps, fns, 1000)).toBe(1);
    expect(falseRetires([{ subtask: "parse_line", createdAt: 0, synthetic: false, revoked: true }], snaps, fns, 1000)).toBe(1);
    expect(falseRetires([], snaps, fns, 0)).toBe(0);
  });
});
