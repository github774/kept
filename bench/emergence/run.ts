// Emergent-learning experiment: N runs x 4 LLM subagents. The "shared" arm runs all share ONE case
// library (libraryId), so lessons from early agents can reach later ones; the "control" arm runs each
// get a fresh library. Arms are interleaved and launched in waves. One row per agent goes to
// results.jsonl; summary.json is rebuilt after every wave. Drives the orchestrator only through its
// RuntimeService (orchestrator/src/service.ts); exits if that is missing. Never fabricates data.
//
//   bun bench/emergence/run.ts [--shared-runs 250] [--control-runs 250] [--concurrency 8] [--budget-usd 12]
//       [--tasks-dir bench/tasks-v2] [--tasks a,b,c] [--library-id <id>] [--max-runs N] [--dry-run] [--check-service]
// See bench/emergence/README.md.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CaseFile, LedgerTotals, RunSummary } from "../../orchestrator/src/contract.ts";
import { CONFIG_DIR, loadRepoEnv } from "../src/config.ts";
import { expectedTestCount, snapshot, type Snapshot } from "../ours/pytest.ts";
import { loadService, resolveWorkDir, SERVICE_PATH, ServiceUnavailable, type BenchService } from "../ours/service.ts";
import { checkBudget, fetchKeyUsage, spentUsd } from "./budget.ts";
import {
  buildSchedule,
  chunk,
  estimateCost,
  loadCapsFull,
  loadTasks,
  parseConfig,
  resolveTasksDir,
  round6,
  type Caps,
  type Config,
  type LoadedTask,
  type PlannedRun,
} from "./plan.ts";
import { actorsError, buildAgentRows, trapFunction, readChunks, readLedgerRows, type AgentTelemetry, type RunEvidence } from "./probe.ts";
import { ResourceMonitor } from "./resources.ts";
import { readRows, readState, summarize } from "./summarize.ts";
import type { AgentRow, ExperimentState } from "./types.ts";

const TERMINAL = new Set(["finished", "failed", "stopped"]);
const log = (...a: unknown[]) => console.log(`[emergence ${new Date().toISOString().slice(11, 19)}]`, ...a);

class Fatal extends Error {
  constructor(msg: string, readonly code = 4) {
    super(msg);
  }
}

type Svc = BenchService & {
  getAgentTelemetry?: (runId: string) => Promise<AgentTelemetry[] | null> | AgentTelemetry[] | null;
};

/** Small async semaphore (limits concurrent pytest snapshots). */
export function semaphore(n: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => q.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      q.shift()?.();
    }
  };
}

export interface Ctx {
  cfg: Config;
  caps: Caps;
  benchModel: string;
  tasks: Map<string, LoadedTask>;
  state: ExperimentState;
  svc: Svc;
  paths: { results: string; state: string; summary: string };
  /** runId -> latest Ledger USD of active runs. */
  live: Map<string, number>;
  completedUsd: number;
  stop: { reason: string | null; budget: boolean };
  pytest: ReturnType<typeof semaphore>;
  writeLock: Promise<void>;
  monitor: ResourceMonitor;
  startFailures: number;
}

async function saveState(ctx: Ctx) {
  await Bun.write(ctx.paths.state, JSON.stringify(ctx.state, null, 2) + "\n");
}

async function writeSummary(ctx: Pick<Ctx, "paths">) {
  const rows = await readRows(ctx.paths.results);
  const s = summarize(rows, await readState(ctx.paths.state));
  await Bun.write(ctx.paths.summary, JSON.stringify(s, null, 2) + "\n");
  return s;
}

function appendRows(ctx: Ctx, rows: AgentRow[]): Promise<void> {
  // One append per run (all its rows together), serialized.
  ctx.writeLock = ctx.writeLock.then(() => appendFile(ctx.paths.results, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  return ctx.writeLock;
}

export async function runOne(ctx: Ctx, plan: PlannedRun, wave: number, launchSeq: number): Promise<AgentRow[] | null> {
  const task = ctx.tasks.get(plan.task)!;
  const startedAt = Date.now();
  let started: RunSummary & { workDir?: string };
  try {
    started = await ctx.svc.startRun({
      taskId: task.id,
      mode: "ours",
      ...(plan.arm === "shared" ? { libraryId: ctx.state.library_id } : {}),
    });
  } catch (e) {
    if (e instanceof ServiceUnavailable) throw new Fatal(e.message, 2);
    ctx.startFailures++;
    console.error(`startRun failed for ${plan.key} (${task.id}): ${e instanceof Error ? e.message : String(e)} — not recorded`);
    if (ctx.startFailures >= 3) throw new Fatal(`${ctx.startFailures} startRun failures; stopping`);
    return null;
  }
  ctx.startFailures = 0;
  const runId = started.runId;
  log(`start ${plan.key} ${task.id} wave ${wave}: run ${runId} library ${started.libraryId} model ${started.model}`);

  const fail = async (msg: string, code = 4): Promise<never> => {
    await ctx.svc.stopRun(runId).catch(() => {});
    throw new Fatal(msg, code);
  };
  if (ctx.svc.mock || started.mock) await fail(`run ${runId} is MOCK; refusing to record it`);
  if (!ctx.cfg.allowDevModel && started.model !== ctx.benchModel)
    await fail(`run ${runId} uses model ${started.model}, expected ${ctx.benchModel} (MODEL_PROFILE=bench)`);
  if (plan.arm === "shared" && started.libraryId !== ctx.state.library_id)
    await fail(`shared run ${runId} got library ${started.libraryId}, requested ${ctx.state.library_id}: the service ignores libraryId, shared learning would not be real`);
  if (plan.arm === "control" && started.libraryId === ctx.state.library_id)
    await fail(`control run ${runId} was given the shared library ${started.libraryId}`);

  const notes: string[] = [];
  const libraryAtLaunch = await ctx.svc.listCases({ libraryId: started.libraryId }).catch((e) => {
    notes.push(`listCases(library) at launch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });

  const snaps: Snapshot[] = [];
  let final: RunSummary = started;
  let ledger: LedgerTotals | null = null;
  let killed = false;
  let capped = false;
  let stoppedByBudget = false;
  let crash: string | null = null;
  let workDir = "";
  let lastSnap = 0;
  try {
    workDir = await resolveWorkDir(ctx.svc, started);
    // Ground truth uses --tasks-dir's canonical tests; refuse if the service runs another version of the task.
    const theirSpec = Bun.file(join(workDir, "SPEC.md"));
    if ((await theirSpec.exists()) && (await theirSpec.text()) !== (await Bun.file(join(task.dir, "SPEC.md")).text().catch(() => "")))
      await fail(`run ${runId}: SPEC.md in the work dir differs from ${task.dir}/SPEC.md (service uses another task version than --tasks-dir)`);
    for (;;) {
      await Bun.sleep(ctx.cfg.pollMs);
      const now = Date.now();
      final = (await ctx.svc.listRuns()).find((r) => r.runId === runId) ?? final;
      ledger = (await ctx.svc.getLedger(runId).catch(() => null)) ?? ledger;
      const usd = ledger ? ledger.worker_usd + ledger.overhead_usd : 0;
      ctx.live.set(runId, usd);
      if (TERMINAL.has(final.status)) break;
      if (ctx.stop.reason) {
        stoppedByBudget = ctx.stop.budget;
        notes.push(`stopped by experiment: ${ctx.stop.reason}`);
        await ctx.svc.stopRun(runId);
        break;
      }
      if (usd >= ctx.caps.usd_per_run) {
        capped = true;
        notes.push(`stopped at $${usd.toFixed(4)} >= caps.usd_per_run $${ctx.caps.usd_per_run}`);
        await ctx.svc.stopRun(runId);
        break;
      }
      if (now - startedAt >= ctx.caps.codex_wall_clock_ms) {
        killed = true;
        notes.push(`killed at ${ctx.caps.codex_wall_clock_ms / 1000}s wall clock`);
        await ctx.svc.stopRun(runId);
        break;
      }
      if (now - lastSnap >= ctx.cfg.snapshotMs) {
        lastSnap = now;
        snaps.push(await ctx.pytest(() => snapshot(workDir, task.dir, now - startedAt)));
      }
    }
  } catch (e) {
    if (e instanceof Fatal) throw e;
    if (e instanceof ServiceUnavailable) {
      await ctx.svc.stopRun(runId).catch(() => {});
      throw new Fatal(e.message, 2);
    }
    crash = e instanceof Error ? e.message : String(e);
    notes.push(`crash (recorded): ${crash}`);
    await ctx.svc.stopRun(runId).catch(() => {});
  }
  if (workDir) snaps.push(await ctx.pytest(() => snapshot(workDir, task.dir, Date.now() - startedAt)));
  final = (await ctx.svc.listRuns().catch(() => [] as RunSummary[])).find((r) => r.runId === runId) ?? final;
  ledger = (await ctx.svc.getLedger(runId).catch(() => null)) ?? ledger;
  const endedAt = final.endedAt ?? Date.now();

  const tryOr = async <T>(label: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      notes.push(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const telemetry = ctx.svc.getAgentTelemetry ? await tryOr("getAgentTelemetry", async () => (await ctx.svc.getAgentTelemetry!(runId)) ?? null) : null;
  const ev: RunEvidence = {
    snapshots: snaps,
    roster: await tryOr("getRoster", () => ctx.svc.getRoster(runId)),
    runCases: await tryOr("listCases(run)", () => ctx.svc.listCases({ runId })),
    libraryAtLaunch,
    libraryAtEnd: telemetry ? await tryOr("listCases(library end)", () => ctx.svc.listCases({ libraryId: started.libraryId })) : null,
    ledgerRows: await readLedgerRows(runId),
    ledgerTotals: ledger,
    chunks: await readChunks(runId),
    telemetry,
  };
  if (!ev.ledgerRows || !ev.chunks) notes.push(`actor reads unavailable: ${actorsError() || "unknown"}`);
  ctx.live.delete(runId);
  if (ledger) ctx.completedUsd += ledger.worker_usd + ledger.overhead_usd;

  const rows = buildAgentRows(
    {
      experiment: ctx.state.experiment,
      key: plan.key,
      arm: plan.arm,
      armRunIndex: plan.armRunIndex,
      launchSeq,
      wave,
      agentsPerRun: ctx.caps.agents_per_run,
      task: task.json,
      startedAt,
      endedAt,
      summary: final,
      killed,
      capped,
      stoppedByBudget,
      crash,
    },
    ev,
  );
  for (const r of rows) r.notes.push(...notes);
  await appendRows(ctx, rows);
  const exposed = rows.filter((r) => r.exposed);
  log(
    `done ${plan.key} ${task.id}: ${final.status} ${Math.round((endedAt - startedAt) / 1000)}s usd=${ledger ? round6(ledger.worker_usd + ledger.overhead_usd) : "?"} ` +
      `trap-hit ${exposed.filter((r) => r.trap_hit_final).length}/${exposed.length} retired ${rows.filter((r) => r.retired).length}`,
  );
  return rows;
}

async function libraryCounts(svc: Svc, libraryId: string) {
  try {
    const cs: CaseFile[] = await svc.listCases({ libraryId });
    const lesson = (c: CaseFile) => !c.revoked && !!c.lesson && c.lesson.trim() !== "NO_LESSON";
    return {
      cases: cs.filter((c) => !c.synthetic).length,
      lessons: cs.filter((c) => !c.synthetic && lesson(c)).length,
      synthetic: cs.filter((c) => c.synthetic).length,
      revoked: cs.filter((c) => c.revoked).length,
    };
  } catch {
    return null;
  }
}

function fmtUsd(x: number | null) {
  return x === null ? "unknown" : `$${x.toFixed(4)}`;
}

async function main() {
  let cfg: Config;
  try {
    cfg = parseConfig(process.argv.slice(2));
  } catch (e) {
    console.error(`config error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  await loadRepoEnv();
  process.env.MODEL_PROFILE = "bench"; // before the service (and its config) is imported

  const models = (await Bun.file(join(CONFIG_DIR, "models.json")).json()) as { profiles?: { bench?: { worker?: string } } };
  const benchModel = models.profiles?.bench?.worker;
  if (!benchModel) throw new Fatal("config/models.json has no profiles.bench.worker", 2);
  const prices = (await Bun.file(join(CONFIG_DIR, "prices.json")).json()) as { models: Record<string, { input: number; cached_input?: number; output: number }> };
  const caps = await loadCapsFull();

  const tasksDir = await resolveTasksDir(cfg.tasksDir);
  const taskList = await loadTasks(tasksDir, cfg.tasks);
  const tasks = new Map(taskList.map((t) => [t.id, t]));

  await mkdir(cfg.outDir, { recursive: true });
  const paths = { results: join(cfg.outDir, "results.jsonl"), state: join(cfg.outDir, "state.json"), summary: join(cfg.outDir, "summary.json") };
  const existing = (await readRows(paths.results)).filter((r) => !r.mock);
  const done = new Set(existing.map((r) => r.run_key));
  const fullSchedule = buildSchedule(cfg.sharedRuns, cfg.controlRuns, taskList.map((t) => t.id));
  let todo = fullSchedule.filter((p) => !done.has(p.key));
  if (cfg.maxRuns !== null) todo = todo.slice(0, cfg.maxRuns);
  const waves = chunk(todo, cfg.concurrency);

  const prior = await readState(paths.state);
  if (prior && cfg.libraryId && prior.library_id !== cfg.libraryId)
    throw new Fatal(`state.json has library ${prior.library_id}; --library-id ${cfg.libraryId} differs (use a new --out-dir for a new experiment)`, 2);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const experiment = prior?.experiment ?? `emg-${stamp}`;
  const libraryId = prior?.library_id ?? cfg.libraryId ?? `${experiment}-shared`;

  const runUsd = new Map<string, number>();
  for (const r of existing) if (r.run_usd !== null) runUsd.set(r.run_key, r.run_usd);
  const measured = [...runUsd.values()];
  const completedUsd = measured.reduce((a, b) => a + b, 0);

  const key = await fetchKeyUsage(process.env.OPENROUTER_API_KEY);
  const keyDelta = prior?.key_usage_baseline != null && key ? key.usage - prior.key_usage_baseline : null;
  const spent = Math.max(keyDelta ?? 0, completedUsd);
  const est = estimateCost(todo.length, caps, prices.models[benchModel], measured, undefined, cfg.budgetUsd - spent);

  if (cfg.dryRun) {
    const p = (s = "") => console.log(s);
    p("EMERGENCE DRY RUN (nothing is started, nothing is written)");
    p(`experiment        ${experiment}${prior ? " (resuming state.json)" : " (new)"}`);
    p(`shared library    ${libraryId}`);
    p(`out dir           ${cfg.outDir}`);
    p(`model             ${benchModel} (MODEL_PROFILE=bench)${prices.models[benchModel] ? "" : "  WARNING: no price in config/prices.json"}`);
    p(`tasks dir         ${tasksDir}`);
    for (const t of taskList) {
      const n = await expectedTestCount(t.dir).then(String, (e) => `ERROR ${e instanceof Error ? e.message : e}`);
      const exposedFns = new Set(t.json.traps.map((x) => trapFunction(t.json, x)));
      p(`  ${t.id.padEnd(18)} ${t.json.functions.length} functions, ${t.json.traps.length} trap(s) [${t.json.traps.map((x) => x.id).join(", ")}], ${exposedFns.size} exposed function(s), ${n} canonical tests`);
    }
    const count = (arm: string, xs: PlannedRun[]) => xs.filter((x) => x.arm === arm).length;
    p(`arms              shared ${cfg.sharedRuns} runs (${cfg.sharedRuns * caps.agents_per_run} agents), control ${cfg.controlRuns} runs (${cfg.controlRuns * caps.agents_per_run} agents)`);
    p(`already recorded  ${done.size} runs (${existing.length} agent rows) — skipped on resume`);
    p(`to run now        ${todo.length} runs = shared ${count("shared", todo)} + control ${count("control", todo)} (${todo.length * caps.agents_per_run} agents)${cfg.maxRuns ? ` [--max-runs ${cfg.maxRuns}]` : ""}`);
    p(`waves             ${waves.length} x up to ${cfg.concurrency} runs (${cfg.concurrency * caps.agents_per_run} agents at once)`);
    for (const [i, w] of waves.slice(0, 2).entries()) p(`  wave ${i + 1}: ${w.map((x) => `${x.key}/${x.task}`).join(" ")}`);
    if (waves.length > 2) p(`  ... wave ${waves.length}: ${waves.at(-1)!.map((x) => `${x.key}/${x.task}`).join(" ")}`);
    const awake = cfg.concurrency * (caps.agents_per_run + 4) + 1;
    p(`resources (est.)  ~${awake} awake actors (agents + Fleet/Ledger/CaseLibrary/ReasoningStore per run) x ~2 processes, ~100 MB each => ~${awake * 2} processes, ~${(awake * 100 / 1024).toFixed(1)} GB; launch gate --max-stack-rss-mb ${cfg.maxStackRssMb}`);
    const runMs = existing.length ? existing.reduce((a, r) => a + r.run_wall_ms, 0) / existing.length : null;
    p(`wall time (est.)  ${runMs ? `${waves.length} waves x ${Math.round(runMs / 1000)} s measured mean run` : `${waves.length} waves x ~100 s typical (BUILD_SPEC), cap ${caps.codex_wall_clock_ms / 1000} s per run`} => ~${Math.round((waves.length * (runMs ?? 100_000)) / 60_000)} min (upper bound ${Math.round((waves.length * caps.codex_wall_clock_ms) / 60_000)} min)`);
    p(`cost (est.)       ${fmtUsd(est.usd_per_run)} per run => ${fmtUsd(est.usd_total_remaining)} for ${todo.length} runs [${est.basis}]`);
    p(`                  hard cap if every run hit caps.usd_per_run: $${est.hard_cap_usd_total}`);
    p(`budget            $${cfg.budgetUsd}; spent so far ${fmtUsd(spent)} (Ledger ${fmtUsd(completedUsd)}, key delta ${fmtUsd(keyDelta)})${est.runs_fit_in_budget !== null ? `; ~${est.runs_fit_in_budget} runs fit (est.)` : ""}`);
    p(`openrouter key    ${process.env.OPENROUTER_API_KEY ? "present" : "MISSING"}; usage ${key ? `$${key.usage.toFixed(4)}${key.limit_remaining !== null ? `, limit remaining $${key.limit_remaining.toFixed(2)}` : ""}` : "unreadable"}`);
    for (const k of ["DURABLE_ACTORS_CONTROL_PLANE_URL", "DURABLE_ACTORS_PROJECT_ID"]) p(`env ${k.padEnd(33)} ${process.env[k] ? "present" : "MISSING"}`);
    const svcExists = await Bun.file(SERVICE_PATH).exists();
    p(`service           ${SERVICE_PATH} ${svcExists ? "exists" : "MISSING (a real run will exit)"}`);
    if (cfg.checkService) {
      try {
        const svc = (await loadService()) as Svc;
        p(`service import    ok (mock=${svc.mock}); getRunWorkDir ${svc.getRunWorkDir ? "yes" : "no (needs RunSummary.workDir)"}; getAgentTelemetry ${svc.getAgentTelemetry ? "yes" : "no (lesson_in_prompt will be null)"}`);
      } catch (e) {
        p(`service import    FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const problems = [
      !process.env.OPENROUTER_API_KEY && "OPENROUTER_API_KEY missing",
      !key && !cfg.allowNoKeyUsage && "key usage unreadable (budget guard needs it; --allow-no-key-usage to rely on the Ledger only)",
      !svcExists && "orchestrator/src/service.ts missing",
    ].filter(Boolean);
    p(problems.length ? `NOT READY: ${problems.join("; ")}` : "READY");
    process.exit(problems.length ? 1 : 0);
  }

  if (todo.length === 0) {
    log("nothing to run: every scheduled run is already in results.jsonl");
    await writeSummary({ paths });
    return;
  }
  if (!key && !cfg.allowNoKeyUsage)
    throw new Fatal("OpenRouter key usage unreadable (GET /api/v1/key); the budget guard needs it. Pass --allow-no-key-usage to rely on Ledger totals only.", 2);

  let svc: Svc;
  try {
    svc = (await loadService()) as Svc;
  } catch (e) {
    throw new Fatal(`${e instanceof Error ? e.message : String(e)}\nNo run was started; nothing was written.`, 2);
  }
  if (svc.mock) throw new Fatal("the loaded RuntimeService is a MOCK (svc.mock === true); refusing to run the experiment", 2);

  const state: ExperimentState = prior ?? {
    experiment,
    library_id: libraryId,
    created_at: Date.now(),
    key_usage_baseline: key?.usage ?? null,
    key_usage_last: key?.usage ?? null,
    key_usage_last_at: key ? Date.now() : null,
    budget_usd: cfg.budgetUsd,
    next_launch_seq: 1,
    sessions: [],
    waves: [],
  };
  if (state.key_usage_baseline === null && key) state.key_usage_baseline = key.usage;
  state.budget_usd = cfg.budgetUsd;
  const monitor = new ResourceMonitor();
  const session = { started_at: Date.now(), ended_at: null as number | null, runs_completed: 0, stop_reason: null as string | null, peaks: monitor.peaks };
  state.sessions.push(session);

  const ctx: Ctx = {
    cfg,
    caps,
    benchModel,
    tasks,
    state,
    svc,
    paths,
    live: new Map(),
    completedUsd,
    stop: { reason: null, budget: false },
    pytest: semaphore(6),
    writeLock: Promise.resolve(),
    monitor,
    startFailures: 0,
  };
  await saveState(ctx);
  monitor.start(5000);
  log(`experiment ${experiment}, shared library ${libraryId}, ${todo.length} runs in ${waves.length} waves, budget $${cfg.budgetUsd}`);

  const budgetNow = async () => {
    const k = await fetchKeyUsage(process.env.OPENROUTER_API_KEY);
    if (k) {
      state.key_usage_last = k.usage;
      state.key_usage_last_at = Date.now();
    }
    const ledgerUsd = ctx.completedUsd + [...ctx.live.values()].reduce((a, b) => a + b, 0);
    return checkBudget(cfg.budgetUsd, state.key_usage_baseline, k?.usage ?? null, ledgerUsd);
  };
  const watcher = setInterval(async () => {
    if (ctx.stop.reason) return;
    const b = await budgetNow();
    if (b.over) {
      ctx.stop = { reason: b.reason, budget: true };
      log(`BUDGET STOP: ${b.reason}; stopping active runs`);
    }
  }, cfg.keyCheckMs);
  process.on("SIGINT", () => {
    if (ctx.stop.reason) process.exit(130);
    ctx.stop = { reason: "SIGINT", budget: false };
    log("SIGINT: stopping active runs and recording them (Ctrl-C again to exit at once)");
  });

  let exitCode = 0;
  try {
    for (const [wi, waveRuns] of waves.entries()) {
      if (ctx.stop.reason) break;
      const b = await budgetNow();
      if (b.over) {
        ctx.stop = { reason: b.reason, budget: true };
        break;
      }
      // Headroom: don't launch more runs than the measured mean cost says still fit.
      const measuredNow = [...runUsd.values()];
      let launch = waveRuns;
      if (measuredNow.length >= 3) {
        const mean = measuredNow.reduce((a, x) => a + x, 0) / measuredNow.length;
        const fit = Math.floor((cfg.budgetUsd - spentUsd(b)) / mean);
        if (fit <= 0) {
          ctx.stop = { reason: `budget headroom: spent $${spentUsd(b).toFixed(4)}, mean run $${mean.toFixed(4)}, budget $${cfg.budgetUsd}`, budget: true };
          break;
        }
        if (fit < launch.length) {
          log(`budget headroom fits ${fit} more run(s); trimming wave`);
          launch = launch.slice(0, fit);
        }
      }
      // Memory gate.
      for (let waited = 0; (monitor.tick()?.stack_rss_mb ?? 0) > cfg.maxStackRssMb; waited += 10_000) {
        if (waited >= 300_000) throw new Fatal(`stack RSS ${monitor.last?.stack_rss_mb} MB > --max-stack-rss-mb ${cfg.maxStackRssMb} for 5 min`);
        log(`stack RSS ${monitor.last?.stack_rss_mb} MB > ${cfg.maxStackRssMb} MB; waiting before wave ${wi + 1}`);
        await Bun.sleep(10_000);
      }
      const waveNo = state.waves.length + 1;
      log(`wave ${waveNo} (${wi + 1}/${waves.length}): ${launch.map((x) => x.key).join(" ")}`);
      const results = await Promise.allSettled(
        launch.map(async (plan, i) => {
          await Bun.sleep(i * 300); // stagger startRun calls
          if (ctx.stop.reason) return null;
          const seq = state.next_launch_seq++;
          let rows: AgentRow[] | null;
          try {
            rows = await runOne(ctx, plan, waveNo, seq);
          } catch (e) {
            // Stop the sibling runs of this wave too (they are recorded as stopped).
            if (!ctx.stop.reason) ctx.stop = { reason: `fatal in ${plan.key}: ${e instanceof Error ? e.message : String(e)}`, budget: false };
            throw e;
          }
          if (rows) {
            session.runs_completed++;
            if (rows[0]?.run_usd != null) runUsd.set(plan.key, rows[0].run_usd);
          }
          return rows;
        }),
      );
      const fatal = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      state.waves.push({ wave: waveNo, at: Date.now(), run_keys: launch.map((x) => x.key), library: await libraryCounts(svc, libraryId) });
      await saveState(ctx);
      const s = await writeSummary(ctx);
      const sh = s.arms.shared;
      log(
        `after wave ${waveNo}: library ${JSON.stringify(state.waves.at(-1)!.library)}; ledger ${fmtUsd(s.cost.ledger_usd)}; ` +
          `trap-hit shared ${sh?.trap_hit_final.rate ?? "-"} control ${s.arms.control?.trap_hit_final.rate ?? "-"}; stack peak ${monitor.peaks.stack_processes} procs ${monitor.peaks.stack_rss_mb} MB`,
      );
      if (fatal) {
        ctx.stop = { reason: ctx.stop.reason ?? "fatal error", budget: ctx.stop.budget };
        throw fatal.reason;
      }
    }
    if (ctx.stop.reason) {
      session.stop_reason = ctx.stop.reason;
      exitCode = ctx.stop.budget ? 3 : 130;
      log(`stopped: ${ctx.stop.reason}`);
    }
  } catch (e) {
    session.stop_reason = e instanceof Error ? e.message : String(e);
    exitCode = e instanceof Fatal ? e.code : 4;
    console.error(`FATAL: ${session.stop_reason}`);
  } finally {
    clearInterval(watcher);
    monitor.stop();
    session.ended_at = Date.now();
    await budgetNow().catch(() => {});
    await saveState(ctx);
    const s = await writeSummary(ctx);
    log(`summary -> ${paths.summary}: ${s.rows_used} agent rows; ledger ${fmtUsd(s.cost.ledger_usd)}; key delta ${fmtUsd(s.cost.openrouter_key_usage_delta_usd)}`);
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof Fatal ? e.code : 4);
  }
}
