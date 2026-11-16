// Runs our system ("ours": cold, warm, ablation) on the benchmark tasks and appends one
// BenchmarkResultRow per trial to bench/results.json. Drives the orchestrator only through its
// RuntimeService (orchestrator/src/service.ts). Fails loudly when the service is missing; never
// fabricates a result. See bench/ours/README.md for metric definitions.
//
//   bun --env-file=/Users/avneh/Code/SmarterSubagents/.env bench/ours/run.ts \
//       [--modes cold,warm,ablation] [--tasks invoice_parser,shipping_rates,discount_engine]
//       [--trials 3] [--parallel 3] [--warm-library <libraryId>] [--check]
import { parseArgs } from "node:util";
import { join } from "node:path";
import { BENCH_DIR, loadCaps, loadRepoEnv } from "../src/config.ts";
import { appendResult, RESULTS_PATH } from "../src/results.ts";
import { SUITE_DIRS, SUITE_VERSIONS } from "../src/tasks.ts";
import type { BenchMode, BenchmarkResultRow, TestSummary, TokenCounts } from "../src/types.ts";
import type { CaseFile, LedgerTotals, Mode as SvcMode, RunSummary } from "../../orchestrator/src/contract.ts";
import { allPass, falseRetires, trapMetrics, type TaskJson } from "./metrics.ts";
import { expectedTestCount, snapshot, type Snapshot } from "./pytest.ts";
import { loadService, resolveWorkDir, ServiceUnavailable, type BenchService, type RunSummaryExt } from "./service.ts";

export type OursMode = "cold" | "warm" | "ablation";
const ROW_MODE: Record<OursMode, BenchMode> = { cold: "ours_cold", warm: "ours_warm", ablation: "ablation" };
const SVC_MODE: Record<OursMode, SvcMode> = { cold: "ours", warm: "ours", ablation: "ablation" };
const TERMINAL = new Set(["finished", "failed", "stopped"]);
const DEFAULT_TASKS = ["invoice_parser", "shipping_rates", "discount_engine"];

/** Contract row + bench extras + ours-only traceability fields. */
export interface OursRow extends BenchmarkResultRow {
  run_id: string;
  library_id: string;
  retires: number | null;
  capped_usd: boolean;
  usd_cap: number;
  /** Trap rule applied to the final code only (what the Codex runner reports). */
  trap_hits_final: number;
  repeat_trap_hits_final: number;
  ground_truth_snapshots: number;
  tokens_by_category?: LedgerTotals["by_category"] | null;
  false_completion_claims_basis?: string;
  jev_blocked_messages_basis?: string;
}

export interface Opts {
  modes: OursMode[];
  tasks: string[];
  trials: number;
  trialStart: number;
  parallel: number;
  warmLibrary?: string;
  pollMs: number;
  wallMs: number;
  usdCap: number;
  benchModel: string;
  allowDevModel: boolean;
  /** task.json "version" (1 = bench/tasks, 2 = bench/tasks-v2). */
  taskVersion: number;
}

const log = (...a: unknown[]) => console.log(`[bench/ours ${new Date().toISOString().slice(11, 19)}]`, ...a);

function toTokens(l: LedgerTotals | null): TokenCounts {
  if (!l) return { input: 0, cached: 0, output: 0, reasoning: 0 };
  return { input: l.tokens.input, cached: l.tokens.cached, output: l.tokens.output, reasoning: l.tokens.reasoning };
}

function summarize(s: Snapshot | undefined, expected: number): TestSummary {
  if (!s) return { passed: 0, failed: 0, errors: 0, total: expected, failing: [] };
  const passed = s.cases.filter((c) => c.outcome === "passed").length;
  const failed = s.cases.filter((c) => c.outcome === "failed").length;
  const errors = s.cases.filter((c) => c.outcome === "error").length + (s.broken && s.cases.length === 0 ? 1 : 0);
  return {
    passed,
    failed,
    errors,
    total: Math.max(expected, s.cases.length),
    failing: s.cases.filter((c) => c.outcome === "failed" || c.outcome === "error").map((c) => c.nodeid),
  };
}

async function findRun(svc: BenchService, runId: string): Promise<RunSummaryExt | undefined> {
  return (await svc.listRuns()).find((r) => r.runId === runId) as RunSummaryExt | undefined;
}

export async function runTrial(
  svc: BenchService,
  o: Opts,
  mode: OursMode,
  task: TaskJson,
  taskDir: string,
  expected: number,
  trial: number,
  libraryId: string | undefined,
): Promise<OursRow> {
  const notes: string[] = [];
  const t0 = Date.now();
  const startedIso = new Date(t0).toISOString();
  const taskId = task.id; // contract TaskId = the task folder id
  const started = (await svc.startRun({ taskId, mode: SVC_MODE[mode], ...(libraryId ? { libraryId } : {}) })) as RunSummaryExt;
  const runId = started.runId;
  log(`start ${mode} ${task.id} trial ${trial}: run ${runId} library ${started.libraryId} model ${started.model}`);

  if (!o.allowDevModel && started.model !== o.benchModel) {
    await svc.stopRun(runId).catch(() => {});
    throw new Error(`run ${runId} uses model ${started.model}, expected ${o.benchModel} (MODEL_PROFILE=bench). Aborting.`);
  }
  if (mode !== "warm" && libraryId === undefined && started.libraryId === undefined) notes.push("service returned no libraryId");
  if (mode === "warm" && started.libraryId !== libraryId)
    notes.push(`warm: requested library ${libraryId}, service reports ${started.libraryId}`);

  const snaps: Snapshot[] = [];
  let workDir = "";
  let timedOut = false;
  let capped = false;
  let crash: string | null = null;
  let final: RunSummaryExt | undefined = started;
  let ledger: LedgerTotals | null = null;
  try {
    workDir = await resolveWorkDir(svc, started);
    for (;;) {
      await Bun.sleep(o.pollMs);
      const now = Date.now() - t0;
      snaps.push(await snapshot(workDir, taskDir, now));
      final = (await findRun(svc, runId)) ?? final;
      ledger = await svc.getLedger(runId).catch(() => ledger);
      const usd = ledger ? ledger.worker_usd + ledger.overhead_usd : 0;
      if (final && TERMINAL.has(final.status)) break;
      if (usd >= o.usdCap) {
        capped = true;
        notes.push(`stopped by bench at $${usd.toFixed(4)} >= cap $${o.usdCap}`);
        await svc.stopRun(runId);
        break;
      }
      if (Date.now() - t0 >= o.wallMs) {
        timedOut = true;
        notes.push(`killed at ${o.wallMs / 1000}s wall clock`);
        await svc.stopRun(runId);
        break;
      }
    }
  } catch (e) {
    if (e instanceof ServiceUnavailable) {
      await svc.stopRun(runId).catch(() => {});
      throw e;
    }
    crash = e instanceof Error ? e.message : String(e);
    notes.push(`crash (scored as failed): ${crash}`);
    await svc.stopRun(runId).catch(() => {});
  }
  const endMs = final?.endedAt ?? Date.now();
  // Final ground truth on the final code.
  if (workDir) snaps.push(await snapshot(workDir, taskDir, Date.now() - t0));
  final = (await findRun(svc, runId).catch(() => undefined)) ?? final;
  ledger = (await svc.getLedger(runId).catch(() => null)) ?? ledger;
  let blocked: number | null = null;
  try {
    blocked = (await svc.getRelayFeed(runId)).filter((m) => !!m.blocked).length;
  } catch (e) {
    notes.push(`getRelayFeed failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let cases: CaseFile[] = [];
  try {
    cases = await svc.listCases({ runId });
  } catch (e) {
    notes.push(`listCases failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const last = snaps.at(-1);
  const success = !timedOut && !capped && !crash && !!last && allPass(last, expected);
  const tm = trapMetrics(snaps, task.traps, expected);
  const tokens = toTokens(ledger);
  if (!ledger) notes.push("ledger unavailable: tokens/usd not measured");
  const usd = ledger ? Math.round((ledger.worker_usd + ledger.overhead_usd) * 1e6) / 1e6 : Number.NaN; // NaN -> null in JSON
  const fr = falseRetires(
    cases.map((c) => ({ subtask: c.subtask, createdAt: c.createdAt, synthetic: c.synthetic, revoked: c.revoked })),
    snaps,
    task.functions,
    t0,
  );
  if (final && final.status !== "finished") notes.push(`run status ${final.status}`);
  if (final?.mock || svc.mock) notes.push("MOCK service: not a measured run");

  const finalOnly = last ? trapMetrics([last], task.traps, expected) : null;
  const isMock = !!(svc.mock || final?.mock);
  return {
    mode: ROW_MODE[mode],
    task_version: o.taskVersion,
    model: final?.model ?? started.model,
    task: task.id,
    trial,
    sourceId: runId,
    success,
    tokens,
    tokens_per_passing_task: success && ledger ? tokens.input + tokens.output : null,
    usd,
    trap_hits: tm.trap_hits,
    repeat_trap_hits: tm.repeat_trap_hits,
    recovery_ms: tm.time_to_recovery_ms,
    finish_ms: Math.round(endMs - t0),
    false_retires: fr,
    subagents_spawned: final?.agents ?? started.agents,
    ...(timedOut ? { killed: true } : {}),
    notes: [`${snaps.length} ground-truth snapshots every ~${o.pollMs}ms`, ...notes].join("; "),
    ...(isMock ? { mock: true as const } : {}),
    tests: summarize(last, expected),
    traps_hit: tm.traps_hit,
    tokens_scope: "ledger totals for the run (all categories: worker, jev, fallback_judge, embedding, lesson_writer, case_discussion)",
    usd_source: "Ledger totals worker_usd + overhead_usd (OpenRouter usage.cost, else config/prices.json)",
    models_seen: [...new Set([started.model, final?.model].filter((m): m is string => !!m))],
    exit_code: null,
    run_dir: workDir,
    started_at: startedIso,
    run_id: runId,
    library_id: final?.libraryId ?? started.libraryId,
    retires: final?.retires ?? null,
    capped_usd: capped,
    usd_cap: o.usdCap,
    trap_hits_final: finalOnly?.trap_hits ?? 0,
    repeat_trap_hits_final: finalOnly?.repeat_trap_hits ?? 0,
    ground_truth_snapshots: snaps.length,
    tokens_by_category: ledger?.by_category ?? null,
    time_to_finish_s: Math.round(endMs - t0) / 1000,
    time_to_recovery_s: tm.time_to_recovery_ms == null ? null : tm.time_to_recovery_ms / 1000,
    false_completion_claims: cases.filter((c) => !c.synthetic && c.category === "false_success_claim").length,
    false_completion_claims_basis: "non-synthetic case files in this run with category false_success_claim (claims the system caught)",
    jev_blocked_messages: blocked,
    jev_blocked_messages_basis: "Relay feed items of this run with blocked set (never delivered)",
  };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, q.length) }, async () => {
      for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x);
    }),
  );
}

async function warmLibraryFromResults(task: string): Promise<string | undefined> {
  const f = Bun.file(RESULTS_PATH);
  if (!(await f.exists())) return undefined;
  const rows = (await f.json()) as Partial<OursRow>[];
  return rows.filter((r) => r.mode === "ours_cold" && r.task === task && r.library_id && !r.mock).at(-1)?.library_id;
}

async function main() {
  const { values } = parseArgs({
    options: {
      modes: { type: "string", default: "cold,warm,ablation" },
      tasks: { type: "string", default: DEFAULT_TASKS.join(",") },
      trials: { type: "string", default: "3" },
      "trial-start": { type: "string", default: "1" },
      parallel: { type: "string", default: "3" },
      "warm-library": { type: "string" },
      "poll-ms": { type: "string", default: "3000" },
      "allow-dev-model": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      suite: { type: "string", default: "v1" },
    },
  });
  await loadRepoEnv();
  process.env.MODEL_PROFILE = "bench"; // before the service (and its config) is imported
  process.env.LLM_CONCURRENCY = "benchmark"; // caps.concurrent_llm_calls_benchmark in the service
  log(`OPENROUTER_API_KEY ${process.env.OPENROUTER_API_KEY ? "present" : "MISSING"}; MODEL_PROFILE=bench`);

  const models = (await Bun.file(join(BENCH_DIR, "..", "config", "models.json")).json()) as {
    profiles?: { bench?: { worker?: string } };
  };
  const benchModel = models.profiles?.bench?.worker;
  if (!benchModel) throw new Error("config/models.json has no profiles.bench.worker");
  const caps = (await loadCaps()) as Awaited<ReturnType<typeof loadCaps>> & { usd_per_run?: number };

  const modes = values.modes.split(",").map((m) => m.trim()) as OursMode[];
  for (const m of modes) if (!(m in ROW_MODE)) throw new Error(`unknown mode ${m} (cold|warm|ablation)`);
  const o: Opts = {
    modes,
    tasks: values.tasks.split(",").map((t) => t.trim()),
    trials: Number(values.trials),
    trialStart: Number(values["trial-start"]),
    // BENCH_PARALLEL_MAX (default 3) raises the trial cap; LLM concurrency is scaled to match (see below).
    parallel: Math.min(Number(process.env.BENCH_PARALLEL_MAX ?? 3), Number(values.parallel)),
    warmLibrary: values["warm-library"],
    pollMs: Number(values["poll-ms"]),
    wallMs: caps.codex_wall_clock_ms ?? 600_000,
    usdCap: caps.usd_per_run ?? 1.0,
    benchModel,
    allowDevModel: values["allow-dev-model"],
    taskVersion: SUITE_VERSIONS[values.suite] ?? Number(values.suite.replace(/^v/, "")),
  };
  const suiteDir = SUITE_DIRS[values.suite];
  if (!suiteDir) throw new Error(`unknown --suite ${values.suite} (${Object.keys(SUITE_DIRS).join("|")})`);

  const tasks = new Map<string, { json: TaskJson; dir: string; expected: number }>();
  for (const t of o.tasks) {
    const dir = join(BENCH_DIR, suiteDir, t);
    const json = (await Bun.file(join(dir, "task.json")).json()) as TaskJson;
    tasks.set(t, { json, dir, expected: await expectedTestCount(dir) });
  }

  let svc: BenchService;
  try {
    svc = await loadService();
  } catch (e) {
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    console.error("No trials were run and nothing was written to bench/results.json.");
    process.exit(2);
  }
  if (svc.mock) {
    console.error("FATAL: the loaded RuntimeService is a MOCK (svc.mock === true). Refusing to benchmark it.");
    process.exit(2);
  }
  // The real service reconciles unfinished runs from actors in the background; let that settle first.
  await (svc as BenchService & { ready?: Promise<void> }).ready;
  // Point the orchestrator's task loader at the suite (RunManager.d.tasksRoot; service.ts hard-codes bench/tasks).
  const rm = (svc as unknown as { runManager?: { d?: { tasksRoot?: string } } }).runManager;
  if (suiteDir !== "tasks") {
    if (!rm?.d) throw new Error("service exposes no runManager.d: cannot point it at the task suite");
    rm.d.tasksRoot = join(BENCH_DIR, suiteDir);
    log(`tasksRoot -> ${rm.d.tasksRoot}`);
  }
  // BENCH_AGENTS_PER_RUN=<n>|functions: this process only (config/caps.json is untouched). "functions" = one
  // agent per function (v3 tasks have 7); the RunManager uses min(functions, caps.agents_per_run).
  const apr = process.env.BENCH_AGENTS_PER_RUN?.trim();
  if (apr) {
    const caps = (rm as unknown as { d?: { cfg?: { caps?: { agents_per_run: number } } } })?.d?.cfg?.caps;
    if (!caps) throw new Error("service exposes no runManager.d.cfg.caps: cannot set agents_per_run");
    const n = apr === "functions" ? Math.max(...[...tasks.values()].map((t) => t.json.functions.length)) : Number(apr);
    if (!Number.isInteger(n) || n < 1) throw new Error(`BENCH_AGENTS_PER_RUN=${apr} is not a positive integer or "functions"`);
    caps.agents_per_run = n;
    log(`agents_per_run -> ${n} (BENCH_AGENTS_PER_RUN=${apr}, this process only)`);
  }
  // More than 3 trials at once: scale caps.concurrent_llm_calls_benchmark by parallel/3 (this process only) so
  // each trial sees the same LLM concurrency share as a 3-parallel run.
  if (o.parallel > 3) {
    const caps = (rm as unknown as { d?: { cfg?: { caps?: { concurrent_llm_calls_benchmark: number } } } })?.d?.cfg?.caps;
    if (!caps) throw new Error("service exposes no runManager.d.cfg.caps: cannot scale LLM concurrency for parallel > 3");
    caps.concurrent_llm_calls_benchmark = Math.ceil((caps.concurrent_llm_calls_benchmark * o.parallel) / 3);
    log(`parallel ${o.parallel}: concurrent_llm_calls_benchmark -> ${caps.concurrent_llm_calls_benchmark} (this process only)`);
  }
  log(`service loaded; tasks ${[...tasks.keys()].join(", ")} expect ${[...tasks.values()].map((t) => t.expected).join("/")} tests`);
  if (values.check) return;

  // BENCH_ROW_TAGS='{"key":"value"}': extra fields copied onto every row (the aggregator splits groups by
  // `variant`/`sharing_fix`, so tagged rows never merge with untagged ones of the same mode).
  const rowTags = process.env.BENCH_ROW_TAGS ? (JSON.parse(process.env.BENCH_ROW_TAGS) as Record<string, unknown>) : {};
  if (Object.keys(rowTags).length) log(`row tags ${JSON.stringify(rowTags)}`);
  const coldLibs = new Map<string, string>();
  let failures = 0;
  for (const mode of o.modes) {
    const jobs: { task: string; trial: number }[] = [];
    for (const task of o.tasks) for (let i = 0; i < o.trials; i++) jobs.push({ task, trial: o.trialStart + i });
    await pool(jobs, o.parallel, async ({ task, trial }) => {
      const t = tasks.get(task)!;
      let lib: string | undefined;
      if (mode === "warm") {
        lib = o.warmLibrary ?? coldLibs.get(task) ?? (await warmLibraryFromResults(task));
        if (!lib) {
          console.error(`SKIP warm ${task} trial ${trial}: no library from an earlier cold run (pass --warm-library)`);
          failures++;
          return;
        }
      }
      try {
        const row = await runTrial(svc, o, mode, t.json, t.dir, t.expected, trial, lib);
        if (mode === "cold" && row.library_id && !coldLibs.has(task)) coldLibs.set(task, row.library_id);
        Object.assign(row, rowTags); // BENCH_ROW_TAGS (e.g. {"sharing_fix":"note-only-v1"}) keeps variants apart
        const path = await appendResult(row);
        log(
          `done ${mode} ${task} trial ${trial}: success=${row.success} usd=${row.usd} tokens=${row.tokens.input + row.tokens.output} traps=${row.trap_hits} -> ${path}`,
        );
      } catch (e) {
        failures++;
        console.error(`FAILED ${mode} ${task} trial ${trial}: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof ServiceUnavailable) process.exit(2);
      }
    });
  }
  if (failures) process.exit(1);
}

if (import.meta.main) {
  await main();
  process.exit(0); // the service keeps sockets open
}
