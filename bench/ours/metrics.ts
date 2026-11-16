// Pure metric functions over ground-truth test snapshots (see pytest.ts). No I/O.
// Definitions are documented in bench/ours/README.md.
import type { Snapshot } from "./pytest.ts";

export interface TaskTrap {
  id: string;
  trap_test: string; // "tests/test_parse_line.py::test_trap_amount_is_dollars"
  description?: string;
}
export interface TaskFunction {
  name: string;
  file: string;
  test: string; // "tests/test_parse_line.py"
}
export interface TaskJson {
  id: string;
  functions: TaskFunction[];
  traps: TaskTrap[];
}

/** Failures that mean "not implemented / does not load", not "followed the trap". */
const NOT_A_TRAP = /NotImplementedError|ImportError|ModuleNotFoundError|NameError|SyntaxError|IndentationError/;

/**
 * The trap test fails with a real assertion (not NotImplementedError/import errors) while another
 * test in the same file passes, i.e. the function works but followed the trap. Same rule as the
 * Codex runner's scoreTraps (bench/src/pytest.ts), applied to every snapshot.
 */
export function trapFollowed(s: Snapshot, trap: TaskTrap): boolean {
  const file = trap.trap_test.split("::")[0] ?? "";
  const failing = s.cases.some((c) => c.base === trap.trap_test && c.outcome === "failed" && !NOT_A_TRAP.test(c.message));
  const sibling = s.cases.some((c) => c.base !== trap.trap_test && c.nodeid.startsWith(`${file}::`) && c.outcome === "passed");
  return failing && sibling;
}

export function allPass(s: Snapshot, expected: number): boolean {
  if (s.broken) return false;
  const passed = s.cases.filter((c) => c.outcome === "passed").length;
  const bad = s.cases.filter((c) => c.outcome === "failed" || c.outcome === "error").length;
  return bad === 0 && passed >= expected && expected > 0;
}

/** Family = the shortest trap id of the task that prefixes this id ("stale_rate_table_quote" -> "stale_rate_table"). */
export function trapFamily(id: string, all: TaskTrap[]): string {
  let best = id;
  for (const t of all) if (id.startsWith(t.id) && t.id.length < best.length) best = t.id;
  return best;
}

export interface TrapMetrics {
  trap_hits: number;
  repeat_trap_hits: number;
  traps_hit: string[];
  first_trap_ms: number | null;
  time_to_recovery_ms: number | null;
}

export function trapMetrics(snaps: Snapshot[], traps: TaskTrap[], expected: number): TrapMetrics {
  const ordered = [...snaps].sort((a, b) => a.t_ms - b.t_ms);
  const events = new Map<string, number>(); // trap id -> # of not-followed -> followed transitions
  let firstTrap: number | null = null;
  for (const trap of traps) {
    let prev = false;
    for (const s of ordered) {
      const now = trapFollowed(s, trap);
      if (now && !prev) {
        events.set(trap.id, (events.get(trap.id) ?? 0) + 1);
        if (firstTrap === null || s.t_ms < firstTrap) firstTrap = s.t_ms;
      }
      prev = now;
    }
  }
  const traps_hit = [...events.keys()].sort();
  const reHits = [...events.values()].reduce((a, n) => a + (n - 1), 0);
  const families = new Map<string, number>();
  for (const id of traps_hit) {
    const f = trapFamily(id, traps);
    families.set(f, (families.get(f) ?? 0) + 1);
  }
  const familyRepeats = [...families.values()].reduce((a, n) => a + (n - 1), 0);

  let recovery: number | null = null;
  if (firstTrap !== null) {
    const ok = ordered.find((s) => s.t_ms > firstTrap! && allPass(s, expected));
    if (ok) recovery = ok.t_ms - firstTrap;
  }
  return {
    trap_hits: traps_hit.length,
    repeat_trap_hits: reHits + familyRepeats,
    traps_hit,
    first_trap_ms: firstTrap,
    time_to_recovery_ms: recovery,
  };
}

export interface RetireCase {
  subtask: string;
  createdAt: number; // epoch ms
  synthetic: boolean;
  revoked: boolean;
}

/**
 * False retire = a retire that later got revoked, or one whose agent's function tests were all
 * passing in the latest ground-truth snapshot taken before the retire. Returns null when no
 * snapshot precedes any retire (cannot judge).
 */
export function falseRetires(
  cases: RetireCase[],
  snaps: Snapshot[],
  fns: TaskFunction[],
  startedAt: number,
): number | null {
  const real = cases.filter((c) => !c.synthetic);
  if (real.length === 0) return 0;
  const ordered = [...snaps].sort((a, b) => a.t_ms - b.t_ms);
  let n = 0;
  let judged = 0;
  for (const c of real) {
    if (c.revoked) {
      n++;
      judged++;
      continue;
    }
    const at = c.createdAt - startedAt;
    const before = ordered.filter((s) => s.t_ms <= at).pop();
    const fn = fns.find((f) => f.name === c.subtask);
    if (!before || !fn) continue;
    judged++;
    const mine = before.cases.filter((x) => x.nodeid.startsWith(`${fn.test}::`));
    if (mine.length > 0 && mine.every((x) => x.outcome === "passed")) n++;
  }
  return judged === 0 ? null : n;
}
