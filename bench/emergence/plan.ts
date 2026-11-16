// Config, task discovery, launch schedule and the dry-run estimate. Schedule logic is pure (tested).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, CONFIG_DIR } from "../src/config.ts";
import type { TaskJson } from "../ours/metrics.ts";
import type { Arm } from "./types.ts";

export const EMERGENCE_DIR = join(BENCH_DIR, "emergence");

export interface Config {
  sharedRuns: number;
  controlRuns: number;
  /** Runs launched together per wave (each run = agents_per_run subagents). */
  concurrency: number;
  budgetUsd: number;
  tasksDir: string;
  tasks: string[] | null;
  libraryId: string | null;
  outDir: string;
  pollMs: number;
  snapshotMs: number;
  keyCheckMs: number;
  maxStackRssMb: number;
  maxRuns: number | null;
  dryRun: boolean;
  checkService: boolean;
  allowDevModel: boolean;
  allowNoKeyUsage: boolean;
}

export function parseConfig(argv: string[]): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      "shared-runs": { type: "string", default: "250" },
      "control-runs": { type: "string", default: "250" },
      concurrency: { type: "string", default: "8" },
      "budget-usd": { type: "string", default: "12" },
      "tasks-dir": { type: "string" },
      tasks: { type: "string" },
      "library-id": { type: "string" },
      "out-dir": { type: "string", default: EMERGENCE_DIR },
      "poll-ms": { type: "string", default: "5000" },
      "snapshot-ms": { type: "string", default: "15000" },
      "key-check-ms": { type: "string", default: "30000" },
      "max-stack-rss-mb": { type: "string", default: "16000" },
      "max-runs": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "check-service": { type: "boolean", default: false },
      "allow-dev-model": { type: "boolean", default: false },
      "allow-no-key-usage": { type: "boolean", default: false },
    },
    strict: true,
  });
  const int = (k: string, v: string | undefined, min: number): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${k} must be an integer >= ${min} (got ${v})`);
    return n;
  };
  const budget = Number(values["budget-usd"]);
  if (!(budget > 0)) throw new Error(`--budget-usd must be > 0 (got ${values["budget-usd"]})`);
  return {
    sharedRuns: int("shared-runs", values["shared-runs"], 0),
    controlRuns: int("control-runs", values["control-runs"], 0),
    concurrency: int("concurrency", values.concurrency, 1),
    budgetUsd: budget,
    tasksDir: values["tasks-dir"] ?? "",
    tasks: values.tasks ? values.tasks.split(",").map((t) => t.trim()).filter(Boolean) : null,
    libraryId: values["library-id"] ?? null,
    outDir: values["out-dir"],
    pollMs: int("poll-ms", values["poll-ms"], 500),
    snapshotMs: int("snapshot-ms", values["snapshot-ms"], 1000),
    keyCheckMs: int("key-check-ms", values["key-check-ms"], 5000),
    maxStackRssMb: int("max-stack-rss-mb", values["max-stack-rss-mb"], 256),
    maxRuns: values["max-runs"] ? int("max-runs", values["max-runs"], 1) : null,
    dryRun: values["dry-run"],
    checkService: values["check-service"],
    allowDevModel: values["allow-dev-model"],
    allowNoKeyUsage: values["allow-no-key-usage"],
  };
}

/** bench/tasks-v2 when it exists and holds tasks, else bench/tasks. */
export async function resolveTasksDir(explicit: string): Promise<string> {
  if (explicit) return explicit;
  const v2 = join(BENCH_DIR, "tasks-v2");
  if ((await listTaskIds(v2)).length > 0) return v2;
  return join(BENCH_DIR, "tasks");
}

export async function listTaskIds(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names.sort()) if (await Bun.file(join(dir, n, "task.json")).exists()) out.push(n);
  return out;
}

export interface LoadedTask {
  id: string;
  dir: string;
  json: TaskJson;
}

export async function loadTasks(dir: string, ids: string[] | null): Promise<LoadedTask[]> {
  const all = await listTaskIds(dir);
  const want = ids ?? all;
  if (want.length === 0) throw new Error(`no tasks (no */task.json) in ${dir}`);
  const out: LoadedTask[] = [];
  for (const id of want) {
    if (!all.includes(id)) throw new Error(`task ${id} not found in ${dir} (have: ${all.join(", ") || "none"})`);
    const json = (await Bun.file(join(dir, id, "task.json")).json()) as TaskJson;
    if (!Array.isArray(json.functions) || json.functions.length === 0) throw new Error(`${id}/task.json has no functions`);
    if (!Array.isArray(json.traps) || json.traps.length === 0) throw new Error(`${id}/task.json has no traps (emergence needs trap tasks)`);
    for (const t of json.traps) {
      const file = t.trap_test.split("::")[0] ?? "";
      const fnName = (t as { function?: string }).function;
      if (fnName ? !json.functions.some((f) => f.name === fnName) : !json.functions.some((f) => f.test === file))
        throw new Error(`${id}: trap ${t.id} belongs to no function of the task`);
      if (!(await Bun.file(join(dir, id, file)).exists())) throw new Error(`${id}: trap test file ${file} missing`);
    }
    out.push({ id, dir: join(dir, id), json });
  }
  return out;
}

export interface PlannedRun {
  key: string;
  arm: Arm;
  armRunIndex: number;
  task: string;
}

export const runKey = (arm: Arm, i: number) => `${arm}:${String(i).padStart(4, "0")}`;

/**
 * Interleaves the arms in proportion (so both see the same time-of-day, provider and load), rotating tasks
 * per arm by arm run index. Stable: a run's key and task never depend on the arm sizes.
 */
export function buildSchedule(sharedRuns: number, controlRuns: number, tasks: string[]): PlannedRun[] {
  const out: PlannedRun[] = [];
  let s = 0;
  let c = 0;
  const total = sharedRuns + controlRuns;
  for (let i = 0; i < total; i++) {
    // Pick the arm that is furthest behind its share; shared wins ties so it leads.
    const sLag = sharedRuns ? (s + 1) / sharedRuns : Infinity;
    const cLag = controlRuns ? (c + 1) / controlRuns : Infinity;
    const arm: Arm = s < sharedRuns && (c >= controlRuns || sLag <= cLag) ? "shared" : "control";
    const idx = arm === "shared" ? s++ : c++;
    out.push({ key: runKey(arm, idx), arm, armRunIndex: idx, task: tasks[idx % tasks.length]! });
  }
  return out;
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export interface Caps {
  agents_per_run: number;
  usd_per_run: number;
  steps_per_generation: number;
  generations_per_slot: number;
  prompt_input_tokens_per_step: number;
  codex_wall_clock_ms: number;
  max_lessons: number;
}

export const loadCapsFull = async () => (await Bun.file(join(CONFIG_DIR, "caps.json")).json()) as Caps;

export interface Estimate {
  label: "est.";
  basis: string;
  usd_per_run: number | null;
  usd_total_remaining: number | null;
  runs_fit_in_budget: number | null;
  hard_cap_usd_total: number;
}

/**
 * Cost estimate for the runs still to do. Prefers measured per-run USD from this experiment's results.jsonl;
 * else a token model from config (stated in `basis`). Always labelled est.
 */
export function estimateCost(
  remainingRuns: number,
  caps: Caps,
  price: { input: number; cached_input?: number; output: number } | undefined,
  measuredRunUsd: number[],
  assumptions = { stepsPerAgent: 6, inputPerStep: 6000, cachedShare: 0.5, outputPerStep: 800, overheadShare: 0.3 },
  budgetLeft?: number,
): Estimate {
  let perRun: number | null = null;
  let basis: string;
  if (measuredRunUsd.length > 0) {
    perRun = measuredRunUsd.reduce((a, b) => a + b, 0) / measuredRunUsd.length;
    basis = `mean measured Ledger USD of ${measuredRunUsd.length} completed run(s) in results.jsonl`;
  } else if (price) {
    const a = assumptions;
    const inTok = caps.agents_per_run * a.stepsPerAgent * a.inputPerStep;
    const outTok = caps.agents_per_run * a.stepsPerAgent * a.outputPerStep;
    const worker = (inTok * (1 - a.cachedShare) * price.input + inTok * a.cachedShare * (price.cached_input ?? price.input) + outTok * price.output) / 1e6;
    perRun = worker * (1 + a.overheadShare);
    basis =
      `token model, no measured runs yet: ${caps.agents_per_run} agents x ${a.stepsPerAgent} steps x ${a.inputPerStep} input ` +
      `(${a.cachedShare * 100}% cached) + ${a.outputPerStep} output per step at config/prices.json, +${a.overheadShare * 100}% overhead`;
  } else {
    basis = "no measured runs and no price for the bench model";
  }
  const total = perRun === null ? null : perRun * remainingRuns;
  return {
    label: "est.",
    basis,
    usd_per_run: perRun === null ? null : round6(perRun),
    usd_total_remaining: total === null ? null : round6(total),
    runs_fit_in_budget: perRun && budgetLeft !== undefined ? Math.floor(budgetLeft / perRun) : null,
    hard_cap_usd_total: round6(remainingRuns * caps.usd_per_run),
  };
}

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
