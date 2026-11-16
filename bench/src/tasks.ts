import { cp, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BENCH_DIR } from "./config.ts";

/** Never copied into an agent workspace. */
export const HIDDEN = new Set(["_solution", "_trap_variant", "task.json", "faults.json", "__pycache__", ".pytest_cache"]);

export interface TrapSpec {
  id: string;
  /** pytest nodeid, e.g. "tests/test_parse_line.py::test_trap_amount_is_dollars" */
  trap_test: string;
  /** v2: trap family (same misleading fact in several functions). v1: derived from id prefixes. */
  family?: string;
  /** v2: the function whose file the trap lands in. */
  function?: string;
  /** v2: shared-module helpers that implement the trap behaviour (calling one = following the trap). */
  trap_helpers?: string[];
  /** v2: regexes over added code lines that signal the trap behaviour (heuristic). */
  code_patterns?: string[];
  /** v2: regexes that, in the same edit, undo the trap helper's wrong behaviour (e.g. `* 100` after a cents helper). */
  compensation_patterns?: string[];
}

export interface TaskMeta {
  id: string;
  /** task.json "version" (1 when absent). */
  version: number;
  /** Function names, one subagent each. */
  functions: string[];
  traps: TrapSpec[];
  /** v2: shared helper module agents may import but not edit. */
  sharedModule: string | null;
}

/**
 * Task suites: v1 = bench/tasks, v2 = bench/tasks-v2 (harder traps), v3 = bench/tasks-v3 (reasoning-heavy, 7 functions),
 * humaneval = bench/tasks-humaneval (public OpenAI HumanEval problems, 4 per task, no traps; task_version 100),
 * big = bench/tasks-big (one codebase-scale task, 12 functions, 4 trap families; task_version 200).
 */
export const SUITE_DIRS: Record<string, string> = { v1: "tasks", v2: "tasks-v2", v3: "tasks-v3", humaneval: "tasks-humaneval", big: "tasks-big" };

/** Row task_version per suite: "v<n>" -> n; named suites get a fixed version so they never pool with v1-v3. */
export const SUITE_VERSIONS: Record<string, number> = { v1: 1, v2: 2, v3: 3, humaneval: 100, big: 200 };

export function resolveTaskDir(task: string, taskDir?: string, suite = "v1"): string {
  if (taskDir) return resolve(taskDir);
  const sub = SUITE_DIRS[suite];
  if (!sub) throw new Error(`unknown suite ${suite} (${Object.keys(SUITE_DIRS).join("|")})`);
  return join(BENCH_DIR, sub, task);
}

export async function assertTaskDir(dir: string): Promise<void> {
  for (const need of ["SPEC.md", "tests"]) {
    const ok = await stat(join(dir, need)).then(() => true, () => false);
    if (!ok) throw new Error(`task folder ${dir} is missing ${need}`);
  }
}

/**
 * Copies the visible task materials (SPEC.md, tests/, planted_note.md or TEAM_NOTES.md, fixtures/, AGENTS.md, ...) and places
 * starter/*.py at the workspace root, where tests/conftest.py imports them from (same layout as
 * bench/tasks/verify_tasks.py).
 */
export async function copyTaskFolder(src: string, dst: string): Promise<string[]> {
  const copied: string[] = [];
  for (const name of await readdir(src)) {
    if (HIDDEN.has(name)) continue;
    if (name === "starter") {
      for (const f of await readdir(join(src, name))) {
        if (!f.endsWith(".py")) continue;
        await cp(join(src, name, f), join(dst, f));
        copied.push(f);
      }
      continue;
    }
    await cp(join(src, name), join(dst, name), {
      recursive: true,
      filter: (p) => !HIDDEN.has(basename(p)),
    });
    copied.push(name);
  }
  return copied;
}

export async function loadTaskMeta(dir: string): Promise<TaskMeta> {
  const fallbackId = basename(dir);
  const metaFile = Bun.file(join(dir, "task.json"));
  if (await metaFile.exists()) {
    const m = (await metaFile.json()) as {
      id?: string;
      version?: number;
      functions?: (string | { name: string })[];
      traps?: TrapSpec[];
      shared_module?: string;
    };
    return {
      id: m.id ?? fallbackId,
      version: typeof m.version === "number" ? m.version : 1,
      functions: (m.functions ?? []).map((f) => (typeof f === "string" ? f : f.name)),
      traps: m.traps ?? [],
      sharedModule: m.shared_module ?? null,
    };
  }
  const functions = (await readdir(join(dir, "tests")))
    .map((f) => /^test_(.+)\.py$/.exec(f)?.[1])
    .filter((f): f is string => !!f);
  return { id: fallbackId, version: 1, functions, traps: [], sharedModule: null };
}
