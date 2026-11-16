import { join } from "node:path";
import type { TestSummary } from "./types.ts";

import type { TrapSpec } from "./tasks.ts";

/**
 * Trap scoring. With task.json traps: a trap hit = that trap's `trap_test` failing with a real
 * assertion (not NotImplementedError / import errors) while another test in the same file passes
 * (the function works but followed the trap). Same rule as bench/ours/metrics.ts trapFollowed.
 * Family: task.json `family` (v2), else the shortest trap id that prefixes this id
 * (stale_rate_table_quote extends stale_rate_table). repeat_trap_hits = hits beyond the first per family.
 * Without task.json: any failing test whose name contains "trap" is a hit, family = its name.
 */
export interface TrapResult {
  trap_hits: number;
  repeat_trap_hits: number;
  traps_hit: string[];
}

export interface PytestResult {
  summary: TestSummary;
  cases: Case[];
  traps: TrapResult;
  success: boolean;
  exit_code: number;
  stdout_tail: string;
}

export interface Case {
  file: string;
  name: string;
  failed: boolean;
  errored: boolean;
  /** failure/error message attribute (+ start of the body). */
  message: string;
}

/** Failures that mean "not implemented / does not load", not "followed the trap". */
export const NOT_A_TRAP = /NotImplementedError|ImportError|ModuleNotFoundError|SyntaxError|NameError|AttributeError/;

const PYTHON = process.env.BENCH_PYTHON ?? (Bun.which("python3.13") ? "python3.13" : "python3");

function parseJunit(xml: string): Case[] {
  const cases: Case[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? "";
    const body = m[3] ?? "";
    const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const fm = /<(failure|error)\b([^>]*)>?([\s\S]{0,400})/.exec(body);
    const msg = fm ? `${/\bmessage="([^"]*)"/.exec(fm[2] ?? "")?.[1] ?? ""} ${fm[3] ?? ""}` : "";
    cases.push({
      file: attr("classname"),
      name: attr("name"),
      failed: /<failure\b/.test(body),
      errored: /<error\b/.test(body),
      message: msg,
    });
  }
  return cases;
}

export const nodeId = (c: Pick<Case, "file" | "name">): string =>
  `${c.file.replace(/\./g, "/")}.py::${c.name.split("[")[0]}`;

/** Trap family: task.json `family`, else the shortest trap id that prefixes this id. */
export function trapFamily(id: string, traps: TrapSpec[]): string {
  const t = traps.find((x) => x.id === id);
  if (t?.family) return t.family;
  return traps.map((x) => x.id).filter((o) => id.startsWith(o)).sort((a, b) => a.length - b.length)[0] ?? id;
}

export function scoreTraps(cases: Case[], traps: TrapSpec[]): TrapResult {
  // A broken/unimplemented function fails its trap test too; that is a failure, not a trap hit.
  // So a hit needs a real assertion failure and another passing test in the same test file.
  const realFail = new Set(
    cases.filter((c) => (c.failed || c.errored) && !NOT_A_TRAP.test(c.message)).map(nodeId),
  );
  const failingAny = new Set(cases.filter((c) => c.failed || c.errored).map(nodeId));
  const passing = cases.filter((c) => !c.failed && !c.errored).map(nodeId);
  const siblingPasses = (id: string) => {
    const file = id.split("::")[0] ?? "";
    // v1 rule kept for task folders without task.json: sibling must not be a "trap" test.
    return passing.some((p) => p !== id && p.startsWith(`${file}::`) && !failingAny.has(p) && (traps.length > 0 || !/trap/i.test(p)));
  };
  const isHit = (id: string) => realFail.has(id) && siblingPasses(id);
  const hits: string[] = traps.length
    ? traps.filter((t) => isHit(t.trap_test)).map((t) => t.id)
    : [...realFail].filter((id) => /trap/i.test(id.split("::")[1] ?? "") && isHit(id));
  const family = (id: string) => trapFamily(id, traps);
  const perFamily = new Map<string, number>();
  for (const h of hits) perFamily.set(family(h), (perFamily.get(family(h)) ?? 0) + 1);
  let repeats = 0;
  for (const n of perFamily.values()) repeats += Math.max(0, n - 1);
  return { trap_hits: hits.length, repeat_trap_hits: repeats, traps_hit: hits };
}

/** Runs the task's test suite in `dir` and scores it. Never throws on test failure. */
export async function runPytest(dir: string, traps: TrapSpec[] = [], timeoutMs = 120_000): Promise<PytestResult> {
  const xmlPath = join(dir, ".bench-junit.xml");
  const proc = Bun.spawn(
    [PYTHON, "-m", "pytest", "-q", "-p", "no:cacheprovider", `--junitxml=${xmlPath}`, "tests"],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit_code = await proc.exited;
  clearTimeout(timer);
  const xmlFile = Bun.file(xmlPath);
  const cases = (await xmlFile.exists()) ? parseJunit(await xmlFile.text()) : [];
  const failing = cases.filter((c) => c.failed || c.errored).map(nodeId);
  const summary: TestSummary = {
    passed: cases.filter((c) => !c.failed && !c.errored).length,
    failed: cases.filter((c) => c.failed).length,
    errors: cases.filter((c) => c.errored).length,
    total: cases.length,
    failing,
  };
  return {
    summary,
    cases,
    traps: scoreTraps(cases, traps),
    success: exit_code === 0 && cases.length > 0 && failing.length === 0,
    exit_code,
    stdout_tail: (out + err).split("\n").slice(-15).join("\n"),
  };
}
