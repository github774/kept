// Run lifecycle (BUILD_SPEC "Retire and respawn" -> Reconcile; rule 3). Owner: service implementer.
// Everything here is rebuildable from actors: Fleet (run.<runId>) holds the run config and roster,
// RunIndex (runs.index) lists the runs so a restarted orchestrator can find them, Agent actors hold
// Relay tokens. The Maps below are caches and in-flight handles only.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ActionResult,
  AgentCard,
  AgentStatus,
  CaseFile,
  CaseId,
  CaseReply,
  LibraryId,
  Mode,
  RelayFeedItem,
  RelayMetadata,
  RunId,
  RunStatus,
  RunSummary,
  StartRunOpts,
  TaskId,
} from "../contract.ts";
import type { EventBus } from "../events.ts";
import type { BusMessage, RelayBus } from "../relay/bus.ts";
import { RelayNameConflictError, relayNames } from "../relay/bus.ts";
import type { Config } from "../config.ts";
import { LedgerWriter, toContractTotals } from "../ledger.ts";
import { actors as actorsClient, runActors, withRetry, type CaseFile as ActorCaseFile, type SlotSummary } from "../actors.ts";
import type { RunIndexEntry } from "../../../actors/src/actors.ts";
import type { RunTestsResult } from "../testrunner.ts";
import { runFnTests } from "../verify.ts";
import { lessonsFromCases } from "../lessons.ts";
import { recallLessons } from "../memory/immune.ts";
import { caseFromActor, closeRecoveriesOnFinalTests, rebroadcastPending, recomputeReassignments, resumeRetire } from "./retire.ts";
import { runAgentLoop } from "./worker.ts";
import type { FaultScheduleEntry, LoopOutcome, RunActors, RunContext, RuntimeDeps, TaskDef, TaskFn } from "./types.ts";

/** Actor id of the run index (one per actor runtime). */
export const RUN_INDEX_ID = "runs.index";
const DEFAULT_TASKS_ROOT = resolve(import.meta.dir, "..", "..", "..", "bench", "tasks");
const ACTIVE = new Set<string>(["trusted", "probation", "under_investigation"]);
const TERMINAL = new Set<RunStatus>(["finished", "failed", "stopped"]);

/** The slice of the RunIndex actor stub the RunManager uses (fakes in tests implement this). */
export interface RunIndexStub {
  add(e: RunIndexEntry): Promise<unknown>;
  setStatus(runId: string, status: string, endedAt?: number | null, testsPassing?: number | null): Promise<unknown>;
  get(runId: string): Promise<RunIndexEntry | null>;
  list(opts?: { limit?: number }): Promise<RunIndexEntry[]>;
}

/** Seams for unit tests. Production uses the defaults (real actors, worker loop, retire, pytest). */
export interface RunManagerHooks {
  actorsFor?: (runId: RunId, libraryId: LibraryId) => RunActors;
  runIndex?: RunIndexStub;
  runAgentLoop?: (ctx: RunContext, slot: number, gen: number) => Promise<LoopOutcome>;
  resumeRetire?: (ctx: RunContext, slot: number) => Promise<{ newRef: { slot: number; gen: number; name: string } | null }>;
  /** Final ground truth per function at run end. */
  finalTest?: (ctx: RunContext, fn: TaskFn) => Promise<RunTestsResult>;
  newRunId?: () => RunId;
  /** Poll interval while waiting for a retire to finish (ms). */
  retirePollMs?: number;
}

export interface RunManagerDeps {
  cfg: Config;
  deps: RuntimeDeps;
  bus: EventBus;
  relay: RelayBus;
  /** Root for per-run work dirs (copy of bench/tasks/<id>/starter + tests). */
  workRoot: string;
  /** bench/tasks (default: <repo>/bench/tasks). */
  tasksRoot?: string;
  /** LLM concurrency (caps.concurrent_llm_calls_demo / _benchmark). Default "demo". */
  concurrency?: "demo" | "benchmark";
  hooks?: RunManagerHooks;
}

/** StartRunOpts plus orchestrator-only options (CLI / fault drill). */
export type StartRunOptsExt = StartRunOpts & {
  /** Load bench/tasks/<id>/faults.json schedule (fault drill). Default false. */
  faultDrill?: boolean;
};

/** What Fleet.startRun's config holds; enough to rebuild the RunContext after a restart. */
interface StoredRunConfig {
  taskId: TaskId;
  libraryId: LibraryId;
  mode: Mode;
  stepDelayMs: number;
  workDir: string;
  model: string;
  faultDrill: boolean;
  wardenToken: string | null;
}

interface LiveRun {
  ctx: RunContext;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** Final test result per function (set at run end). */
  finalPassing?: number;
  /** Process shutdown (SIGINT): loops stop, Fleet state is left as is for reconcile. */
  shuttingDown: boolean;
  drivers: Promise<LoopOutcome>[];
  banner?: string;
}

const now = () => Date.now();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function shortId(): RunId {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "r";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/** Loads bench/tasks/<taskId>: task.json, its spec text and (fault drill) faults.json. */
export function loadTask(tasksRoot: string, taskId: TaskId, faultDrill = false): TaskDef {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`bad taskId ${taskId}`);
  const dir = join(tasksRoot, taskId);
  const tj = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as {
    id?: string;
    spec?: string;
    functions: TaskFn[];
    traps?: TaskDef["traps"];
  };
  const spec = tj.spec ?? "SPEC.md";
  let faults: FaultScheduleEntry[] = [];
  if (faultDrill && existsSync(join(dir, "faults.json"))) {
    faults = (JSON.parse(readFileSync(join(dir, "faults.json"), "utf8")) as { schedule?: FaultScheduleEntry[] }).schedule ?? [];
  }
  return {
    id: tj.id ?? taskId,
    dir,
    spec,
    specText: readFileSync(join(dir, spec), "utf8"),
    functions: tj.functions,
    traps: tj.traps ?? [],
    faults,
  };
}

/** Copies starter/ (to the work dir root) and tests/ (to <workDir>/tests). Never _solution or _trap_variant. */
export function prepareWorkDir(task: TaskDef, workDir: string): void {
  mkdirSync(workDir, { recursive: true });
  cpSync(join(task.dir, "starter"), workDir, { recursive: true });
  cpSync(join(task.dir, "tests"), join(workDir, "tests"), { recursive: true });
}

const fleetMode = (m: Mode): "ours" | "baseline" => (m === "baseline" ? "baseline" : "ours");
const isMockDeps = (d: RuntimeDeps) => Object.values(d.mock).some(Boolean);

/**
 * Owns the live RunContexts. Holds no state that is not rebuildable from actors (rule 3).
 */
export class RunManager {
  private readonly live = new Map<RunId, LiveRun>();
  /** Summaries of ended runs (immutable once ended). */
  private readonly endedCache = new Map<RunId, RunSummary>();
  /** Relay feed per run (fed by bus "relay.message" events and the Relay listener). */
  private readonly feed = new Map<RunId, Map<number, RelayFeedItem>>();
  /** Case replies seen on the bus in this process ("case.reply"). */
  private readonly replies = new Map<CaseId, CaseReply[]>();
  private readonly processStartedAt = now();
  private readonly unsubs: (() => void)[] = [];
  private readonly h: Required<Omit<RunManagerHooks, "runIndex" | "actorsFor">> & Pick<RunManagerHooks, "runIndex" | "actorsFor">;

  constructor(readonly d: RunManagerDeps) {
    const hooks = d.hooks ?? {};
    this.h = {
      ...hooks,
      runAgentLoop: hooks.runAgentLoop ?? runAgentLoop,
      resumeRetire: hooks.resumeRetire ?? resumeRetire,
      finalTest: hooks.finalTest ?? ((ctx, fn) => runFnTests(ctx, fn, `final-${ctx.runId}`)),
      newRunId: hooks.newRunId ?? shortId,
      retirePollMs: hooks.retirePollMs ?? 1000,
    };
    this.unsubs.push(d.bus.subscribe((ev) => this.onBusEvent(ev)));
    this.unsubs.push(d.relay.onMessage((m) => this.onRelayMessage(m)));
  }

  // ---------- actors ----------

  private actorsFor(runId: RunId, libraryId: LibraryId): RunActors {
    return (this.h.actorsFor ?? runActors)(runId, libraryId);
  }
  private get index(): RunIndexStub {
    return this.h.runIndex ?? (actorsClient.RunIndex.get(RUN_INDEX_ID) as unknown as RunIndexStub);
  }
  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { onWait: () => this.d.deps.log("[runs] actors unavailable, retrying") });
  }
  private log(line: string) {
    this.d.deps.log(`[runs]${isMockDeps(this.d.deps) ? " [MOCK deps]" : ""} ${line}`);
  }

  // ---------- start ----------

  /**
   * Starts a run: fresh short runId (and fresh libraryId unless opts.libraryId), copies the task into
   * a work dir, Fleet.startRun + addSlot per function (caps.agents_per_run), Agent.init + Relay
   * registration per slot (token stored in the Agent actor), channels fleet-/cases-<runId>, warden
   * identity (token stored in the Fleet run config), then one worker loop per slot (not awaited).
   */
  async startRun(opts: StartRunOptsExt): Promise<RunSummary> {
    const { cfg } = this.d;
    const runId = this.h.newRunId();
    const libraryId = opts.libraryId ?? `lib-${runId}`;
    const task = loadTask(this.d.tasksRoot ?? DEFAULT_TASKS_ROOT, opts.taskId, opts.faultDrill ?? false);
    const workDir = join(this.d.workRoot, runId);
    prepareWorkDir(task, workDir);
    this.applyConcurrency();

    const fleetCh = relayNames.fleet(runId);
    const casesCh = relayNames.cases(runId);
    await this.d.relay.ensureChannel(fleetCh);
    await this.d.relay.ensureChannel(casesCh);
    const warden = await this.d.relay.registerAgent(relayNames.warden(runId), [fleetCh, casesCh]);

    const stored: StoredRunConfig = {
      taskId: task.id,
      libraryId,
      mode: opts.mode,
      stepDelayMs: Math.max(0, opts.stepDelayMs ?? 0),
      workDir,
      model: cfg.models.worker,
      faultDrill: opts.faultDrill ?? false,
      wardenToken: warden.token,
    };
    const a = this.actorsFor(runId, libraryId);
    const info = await this.retry(() => a.fleet.startRun({ runId, mode: fleetMode(opts.mode), config: { ...stored } }));
    await this.retry(() =>
      this.index.add({
        runId,
        taskId: task.id,
        mode: opts.mode,
        libraryId,
        model: stored.model,
        workDir,
        startedAt: info.startedAt,
        status: "starting",
        endedAt: null,
        testsPassing: null,
        testsTotal: task.functions.length,
      }),
    );

    const ctx = this.buildCtx(runId, stored, task, a);
    const run: LiveRun = { ctx, status: "starting", startedAt: info.startedAt, shuttingDown: false, drivers: [] };
    this.attachRestart(run);
    this.live.set(runId, run);

    const slots = Math.min(task.functions.length, cfg.caps.agents_per_run);
    for (let slot = 0; slot < slots; slot++) {
      const fn = task.functions[slot]!;
      const name = relayNames.agent(runId, slot, 1);
      const reg = await this.d.relay.registerAgent(name, [fleetCh, casesCh]);
      await this.retry(() =>
        a.agent(String(slot), 1).init({
          runId,
          slot: String(slot),
          gen: 1,
          task: fn.name,
          persona: persona(fn),
          relayName: name,
          relayToken: reg.token,
        }),
      );
      await this.retry(() => a.fleet.addSlot({ slot: String(slot), gen: 1, status: "trusted", relayName: name }));
    }
    if (ctx.herd) await this.loadLessons(ctx);

    run.status = "running";
    await this.retry(() => this.index.setStatus(runId, "running"));
    this.log(`run ${runId} started: task ${task.id} mode ${opts.mode} library ${libraryId} model ${ctx.model} slots ${slots} workDir ${workDir}`);
    await this.publishRunStatus(runId);
    await this.publishRoster(runId);
    ctx.ledger.totals().then(
      (t) => this.d.bus.publish({ type: "ledger.totals", runId, ts: now(), totals: t, ...this.mockFlag() }),
      () => {},
    );
    for (let slot = 0; slot < slots; slot++) run.drivers.push(this.driveSlot(run, slot, 1));
    this.watch(run);
    return this.summary(runId);
  }

  private applyConcurrency() {
    const llm = this.d.deps.llm as { setConcurrency?: (n: number) => void };
    const caps = this.d.cfg.caps;
    llm.setConcurrency?.(this.d.concurrency === "benchmark" ? caps.concurrent_llm_calls_benchmark : caps.concurrent_llm_calls_demo);
  }

  private buildCtx(runId: RunId, s: StoredRunConfig, task: TaskDef, a: RunActors): RunContext {
    const { cfg, deps, bus, relay } = this.d;
    let lessons: string[] = [];
    const ctx: RunContext = {
      runId,
      libraryId: s.libraryId,
      taskId: s.taskId,
      mode: s.mode,
      task,
      cfg,
      caps: cfg.caps,
      workDir: s.workDir,
      model: cfg.models.worker,
      bus,
      relay,
      actors: a,
      ledger: new LedgerWriter(runId, a.ledger, (totals) => bus.publish({ type: "ledger.totals", runId, ts: now(), totals, ...this.mockFlag() })),
      deps,
      stepDelayMs: s.stepDelayMs,
      // Default off: measured on v2 and v3 (bench ablation), note sharing cost more tokens than it saved.
      // SHARED_REASONING=1 turns it back on (the fleet demo keeps it on to show note revocation).
      sharedReasoning: s.mode === "ours" && process.env.SHARED_REASONING === "1",
      herd: s.mode !== "baseline",
      abort: new Map(),
      pendingFaults: new Map(),
      recovery: new Map(),
      rejectedFacts: new Set(),
      inboxCursor: new Map(),
      stopping: false,
      lessons: () => lessons,
      setLessons: (next) => {
        lessons = [...next].slice(-cfg.caps.max_lessons);
      },
    };
    if (s.model && s.model !== ctx.model) this.log(`run ${runId}: stored model ${s.model} differs from configured ${ctx.model}; using ${ctx.model}`);
    return ctx;
  }

  /** Lessons block from the case library (warm mode starts with earlier runs' lessons). */
  private async loadLessons(ctx: RunContext) {
    try {
      const cases = await this.retry(() => ctx.actors.cases.list());
      ctx.setLessons(lessonsFromCases(cases.map((c) => ({ id: c.id, lesson: c.lesson || null, revoked: c.revoked, createdAt: c.createdAt })), ctx.caps.max_lessons));
      if (ctx.lessons().length) this.log(`run ${ctx.runId}: ${ctx.lessons().length} lessons loaded from library ${ctx.libraryId}`);
    } catch (e) {
      this.log(`run ${ctx.runId}: lessons not loaded (${errMsg(e)})`);
    }
    await recallLessons(ctx); // cross-run immune memory (Supabase); no-op unless configured
  }

  // ---------- slot drivers ----------

  /** retire.failSlot may hand a function to a slot whose loop ended "done": this starts a new loop for it. */
  private attachRestart(run: LiveRun) {
    run.ctx.restartSlot = (slot, gen) => {
      if (run.shuttingDown || run.ctx.stopping || TERMINAL.has(run.status)) return;
      this.log(`run ${run.ctx.runId} slot ${slot}: restarting g${gen} loop for a reassigned function`);
      run.drivers.push(this.driveSlot(run, slot, gen));
    };
  }

  /** Runs a slot's generations: a loop that returns 'retired' continues with the new generation. */
  private async driveSlot(run: LiveRun, slot: number, gen: number): Promise<LoopOutcome> {
    const { ctx } = run;
    let g = gen;
    for (;;) {
      let outcome: LoopOutcome;
      try {
        outcome = await this.h.runAgentLoop(ctx, slot, g);
      } catch (e) {
        this.log(`run ${ctx.runId} slot ${slot} g${g}: loop threw: ${errMsg(e)}`);
        outcome = ctx.stopping ? "aborted" : "failed";
        if (outcome === "failed") {
          // A loop that crashed mid-retire leaves the slot retiring: finish that retire instead of failing.
          const s = await this.slotOf(ctx, slot).catch(() => null);
          if (s?.status === "retiring") outcome = "retired";
          else if (s && s.gen === g && ACTIVE.has(s.status)) await this.retry(() => ctx.actors.fleet.setStatus(String(slot), g, "failed")).catch(() => {});
        }
      }
      if (run.shuttingDown || ctx.stopping) return outcome === "retired" ? "aborted" : outcome;
      if (outcome === "capped") {
        const b = await ctx.ledger.overBudget(ctx.caps.usd_per_run).catch(() => ({ over: false, usd: 0 }));
        if (b.over) await this.stop(ctx.runId, `USD cap reached ($${b.usd.toFixed(4)} >= $${ctx.caps.usd_per_run})`);
        return outcome;
      }
      if (outcome !== "retired") return outcome;
      const next = await this.nextGeneration(run, slot, g);
      if (next === null) return "failed";
      g = next;
    }
  }

  private async slotOf(ctx: RunContext, slot: number): Promise<SlotSummary | null> {
    const snap = await this.retry(() => ctx.actors.fleet.snapshot());
    return snap.slots.find((s) => s.slot === String(slot)) ?? null;
  }

  /**
   * After a 'retired' outcome: the generation the slot moved to, or null if the slot failed. A slot
   * still retiring at gen g means the protocol did not finish (crash or error): resume it once.
   */
  private async nextGeneration(run: LiveRun, slot: number, g: number): Promise<number | null> {
    const { ctx } = run;
    let resumed = false;
    for (let i = 0; i < 120 && !ctx.stopping && !run.shuttingDown; i++) {
      const s = await this.slotOf(ctx, slot).catch(() => null);
      if (!s) return null;
      if (s.gen > g && ACTIVE.has(s.status)) return s.gen;
      if (s.status === "failed") return null;
      if (s.status === "retiring" && s.gen === g && !resumed) {
        resumed = true;
        try {
          const r = await this.h.resumeRetire(ctx, slot);
          if (r.newRef) return r.newRef.gen;
        } catch (e) {
          this.log(`run ${ctx.runId} slot ${slot}: resumeRetire failed: ${errMsg(e)}`);
        }
        continue;
      }
      if (s.gen === g && ACTIVE.has(s.status)) {
        this.log(`run ${ctx.runId} slot ${slot}: loop said retired but Fleet shows g${g} ${s.status}; ending this slot`);
        return null;
      }
      await Bun.sleep(this.h.retirePollMs);
    }
    return null;
  }

  /** When every slot driver settles: final pytest per function, run status, index update. */
  private watch(run: LiveRun) {
    // Drivers can be added while waiting (restartSlot after a reassignment): wait until the set is stable.
    const settleAll = async () => {
      for (;;) {
        const n = run.drivers.length;
        const outs = await Promise.allSettled(run.drivers.slice());
        if (run.drivers.length === n) return outs;
      }
    };
    settleAll().then(async (outs) => {
      const { ctx } = run;
      if (run.shuttingDown || TERMINAL.has(run.status)) return;
      const outcomes = outs.map((o) => (o.status === "fulfilled" ? o.value : "failed"));
      this.log(`run ${ctx.runId}: all slots ended (${outcomes.join(", ")}); running final tests`);
      let passing = 0;
      const results = await Promise.all(
        ctx.task.functions.map((fn) =>
          this.h.finalTest(ctx, fn).catch((e) => {
            this.log(`run ${ctx.runId}: final test ${fn.name} errored: ${errMsg(e)}`);
            return null;
          }),
        ),
      );
      for (const r of results) if (r?.passed) passing++;
      if (TERMINAL.has(run.status)) return; // stopped meanwhile
      const passingFns = new Set(ctx.task.functions.filter((_, i) => results[i]?.passed).map((f) => f.name));
      await closeRecoveriesOnFinalTests(ctx, passingFns).catch((e) => this.log(`run ${ctx.runId}: closing recoveries failed: ${errMsg(e)}`));
      run.finalPassing = passing;
      run.status = passing === ctx.task.functions.length ? "finished" : "failed";
      run.endedAt = now();
      await this.retry(() => ctx.actors.fleet.setRunStatus(run.status === "finished" ? "done" : "failed")).catch((e) => this.log(`setRunStatus: ${errMsg(e)}`));
      await this.retry(() => this.index.setStatus(ctx.runId, run.status, run.endedAt, passing)).catch((e) => this.log(`index: ${errMsg(e)}`));
      this.log(`run ${ctx.runId} ${run.status}: ${passing}/${ctx.task.functions.length} functions pass`);
      await this.publishRunStatus(ctx.runId);
    });
  }

  // ---------- reconcile ----------

  /**
   * On startup: rebuild every run the index lists as not ended from its Fleet actor. Slots in
   * "retiring" -> retire.resumeRetire; active slots -> runAgentLoop from their last logged step.
   * Uses withRetry (actors are unavailable ~30 s after kill -9).
   */
  async reconcile(): Promise<void> {
    const { reconcileRuns } = await import("./reconcile.ts");
    await reconcileRuns(this);
  }

  /** @internal used by reconcile.ts */
  async listIndex(): Promise<RunIndexEntry[]> {
    return this.retry(() => this.index.list());
  }

  /** @internal reconcile.ts: rebuilds one run and restarts its loops. */
  async resumeRun(entry: RunIndexEntry): Promise<"resumed" | "ended" | "skipped"> {
    if (this.live.has(entry.runId)) return "skipped";
    const a0 = this.actorsFor(entry.runId, entry.libraryId);
    const snap = await this.retry(() => a0.fleet.snapshot());
    if (!snap.run) {
      this.log(`reconcile ${entry.runId}: Fleet has no run; marking failed in index`);
      await this.retry(() => this.index.setStatus(entry.runId, "failed", now()));
      return "ended";
    }
    if (snap.run.status !== "running") {
      const st: RunStatus = snap.run.status === "done" ? "finished" : snap.run.status;
      await this.retry(() => this.index.setStatus(entry.runId, st, now()));
      return "ended";
    }
    const c = snap.run.config as Partial<StoredRunConfig>;
    const stored: StoredRunConfig = {
      taskId: c.taskId ?? entry.taskId,
      libraryId: c.libraryId ?? entry.libraryId,
      mode: (c.mode ?? entry.mode) as Mode,
      stepDelayMs: c.stepDelayMs ?? 0,
      workDir: c.workDir ?? entry.workDir,
      model: c.model ?? entry.model,
      faultDrill: c.faultDrill ?? false,
      wardenToken: c.wardenToken ?? null,
    };
    const task = loadTask(this.d.tasksRoot ?? DEFAULT_TASKS_ROOT, stored.taskId, stored.faultDrill);
    if (!existsSync(stored.workDir)) {
      this.log(`reconcile ${entry.runId}: work dir ${stored.workDir} missing; re-copying starter (agents keep their checkpoints in actors)`);
      prepareWorkDir(task, stored.workDir);
    }
    const a = this.actorsFor(entry.runId, stored.libraryId);
    const ctx = this.buildCtx(entry.runId, stored, task, a);
    const run: LiveRun = {
      ctx,
      status: "running",
      startedAt: snap.run.startedAt,
      shuttingDown: false,
      drivers: [],
      banner: "reconnected: state restored from actors",
    };
    this.attachRestart(run);
    this.live.set(entry.runId, run);
    // Reassigned functions of failed slots are stored in Fleet; reload them before any loop starts.
    await recomputeReassignments(ctx).catch((e) => this.log(`reconcile ${entry.runId}: reassignments not loaded (${errMsg(e)})`));
    this.applyConcurrency();
    if (ctx.herd) await this.loadLessons(ctx);

    // Relay identities: warden + every active slot's agent, by the tokens stored in actors.
    const fleetCh = relayNames.fleet(entry.runId);
    const casesCh = relayNames.cases(entry.runId);
    await this.d.relay.ensureChannel(fleetCh);
    await this.d.relay.ensureChannel(casesCh);
    await this.reconnectIdentity(relayNames.warden(entry.runId), stored.wardenToken, [fleetCh, casesCh]);
    for (const s of snap.slots) {
      if (s.possessed) {
        this.log(`reconcile ${entry.runId}: slot ${s.slot} was possessed; armed-but-unfired faults are in memory only and were dropped`);
        await this.retry(() => ctx.actors.fleet.clearPossessed(s.slot)).catch(() => {});
      }
      if (!ACTIVE.has(s.status)) continue; // done slots too: a reassignment may restart them
      const st = await this.retry(() => a.agent(s.slot, s.gen).state());
      const name = s.relayName ?? st.info?.relayName ?? relayNames.agent(entry.runId, Number(s.slot), s.gen);
      const token = await this.reconnectIdentity(name, st.info?.relayToken ?? null, [fleetCh, casesCh]);
      if (token && token !== st.info?.relayToken) await this.retry(() => a.agent(s.slot, s.gen).setRelay(s.gen, name, token)).catch(() => {});
    }

    // Loops: retiring -> finish the protocol, then drive the new generation; active -> resume.
    for (const s of snap.slots) {
      const slot = Number(s.slot);
      if (s.status === "retiring") {
        run.drivers.push(
          (async (): Promise<LoopOutcome> => {
            const next = await this.nextGeneration(run, slot, s.gen);
            return next === null ? "failed" : this.driveSlot(run, slot, next);
          })(),
        );
      } else if (ACTIVE.has(s.status) && !s.done) {
        run.drivers.push(this.driveSlot(run, slot, s.gen));
      }
    }
    // Cases filed before the crash whose delivery never finished (step 9 after completeRetire).
    if (ctx.herd) {
      const re = await rebroadcastPending(ctx).catch((e) => {
        this.log(`reconcile ${entry.runId}: re-broadcast check failed (${errMsg(e)})`);
        return [] as string[];
      });
      if (re.length) this.log(`reconcile ${entry.runId}: re-broadcast ${re.length} case(s): ${re.join(", ")}`);
    }
    this.log(`reconcile ${entry.runId}: resumed ${run.drivers.length} slot(s) (${snap.slots.map((s) => `${s.slot}:g${s.gen}:${s.status}`).join(" ")})`);
    await this.retry(() => this.index.setStatus(entry.runId, "running")).catch(() => {});
    await this.publishRunStatus(entry.runId, run.banner);
    await this.publishRoster(entry.runId);
    this.watch(run);
    return "resumed";
  }

  /** Reconnects a stored Relay identity; re-registers if there is no token (or the engine lost it). Returns the token in use. */
  private async reconnectIdentity(name: string, token: string | null, channels: string[]): Promise<string | null> {
    if (token) {
      try {
        await this.d.relay.reconnect(token, channels);
        return token;
      } catch (e) {
        this.log(`relay reconnect ${name} failed (${errMsg(e)}); trying to register`);
      }
    }
    try {
      return (await this.d.relay.registerAgent(name, channels)).token;
    } catch (e) {
      if (e instanceof RelayNameConflictError) this.log(`relay ${name}: name taken and no usable token; sends from it will fail`);
      else this.log(`relay register ${name}: ${errMsg(e)}`);
      return null;
    }
  }

  // ---------- stop / shutdown ----------

  /** Kill switch: ctx.stopping = true, abort every in-flight call, Fleet.setRunStatus("stopped"), publish "run.status". */
  async stop(runId: RunId, why = "stopped by user"): Promise<ActionResult> {
    const run = this.live.get(runId);
    if (!run) {
      const e = await this.retry(() => this.index.get(runId)).catch(() => null);
      return e ? { ok: false, error: "run_finished", detail: `run ${runId} is ${e.status}` } : { ok: false, error: "no_such_run" };
    }
    if (TERMINAL.has(run.status)) return { ok: false, error: "run_finished", detail: `run ${runId} is ${run.status}` };
    run.ctx.stopping = true;
    for (const c of run.ctx.abort.values()) c.abort(new Error(why));
    run.status = "stopped";
    run.endedAt = now();
    await this.retry(() => run.ctx.actors.fleet.setRunStatus("stopped")).catch((e) => this.log(`setRunStatus: ${errMsg(e)}`));
    await this.retry(() => this.index.setStatus(runId, "stopped", run.endedAt)).catch((e) => this.log(`index: ${errMsg(e)}`));
    this.log(`run ${runId} stopped: ${why}`);
    await this.publishRunStatus(runId, why);
    return { ok: true, detail: why };
  }

  /** Process exit: stop loops and in-flight calls, but leave Fleet state running so reconcile resumes it. */
  shutdown(): void {
    for (const run of this.live.values()) {
      if (TERMINAL.has(run.status)) continue;
      run.shuttingDown = true;
      run.ctx.stopping = true;
      for (const c of run.ctx.abort.values()) c.abort(new Error("orchestrator shutting down"));
    }
    for (const u of this.unsubs.splice(0)) u();
  }

  // ---------- reads ----------

  get(runId: RunId): RunContext | undefined {
    return this.live.get(runId)?.ctx;
  }

  /** Promise that settles when every slot driver of the run has returned (tests / CLI). */
  settled(runId: RunId): Promise<unknown> {
    return Promise.allSettled(this.live.get(runId)?.drivers ?? []);
  }

  isTerminal(runId: RunId): boolean {
    const r = this.live.get(runId);
    return !r || TERMINAL.has(r.status);
  }

  /** Current RunSummary per known run (index + live), newest first. */
  async list(): Promise<RunSummary[]> {
    let entries: RunIndexEntry[] = [];
    try {
      entries = await this.retry(() => this.index.list());
    } catch (e) {
      this.log(`run index unavailable (${errMsg(e)}); listing live runs only`);
    }
    const idsSeen = new Set<RunId>();
    const out: RunSummary[] = [];
    for (const runId of [...this.live.keys()].reverse()) {
      idsSeen.add(runId);
      out.push(await this.summary(runId));
    }
    for (const e of entries) {
      if (idsSeen.has(e.runId)) continue;
      idsSeen.add(e.runId);
      out.push(await this.summary(e.runId, e).catch(() => this.indexOnlySummary(e)));
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Work dir of a run (bench/ours reads the final .py files from it). */
  workDir(runId: RunId): string | null {
    return this.live.get(runId)?.ctx.workDir ?? null;
  }

  async workDirAsync(runId: RunId): Promise<string | null> {
    return this.workDir(runId) ?? (await this.retry(() => this.index.get(runId)).catch(() => null))?.workDir ?? null;
  }

  /** libraryId + taskId of any known run (live or indexed). */
  async runInfo(runId: RunId): Promise<{ libraryId: LibraryId; taskId: TaskId; functions: TaskFn[] } | null> {
    const live = this.live.get(runId);
    if (live) return { libraryId: live.ctx.libraryId, taskId: live.ctx.taskId, functions: live.ctx.task.functions };
    const e = await this.retry(() => this.index.get(runId)).catch(() => null);
    if (!e) return null;
    let functions: TaskFn[] = [];
    try {
      functions = loadTask(this.d.tasksRoot ?? DEFAULT_TASKS_ROOT, e.taskId).functions;
    } catch {}
    return { libraryId: e.libraryId, taskId: e.taskId, functions };
  }

  private indexOnlySummary(e: RunIndexEntry): RunSummary {
    return {
      runId: e.runId,
      taskId: e.taskId,
      mode: e.mode as Mode,
      libraryId: e.libraryId,
      status: (TERMINAL.has(e.status as RunStatus) ? e.status : "failed") as RunStatus,
      model: e.model,
      startedAt: e.startedAt,
      ...(e.endedAt ? { endedAt: e.endedAt } : {}),
      agents: 0,
      retires: 0,
      cases: 0,
      testsPassing: e.testsPassing ?? 0,
      testsTotal: e.testsTotal,
      usd: 0,
    };
  }

  /** Builds a RunSummary from actors (+ live state). Ended runs are cached. */
  async summary(runId: RunId, entry?: RunIndexEntry): Promise<RunSummary> {
    const cached = this.endedCache.get(runId);
    if (cached) return cached;
    const run = this.live.get(runId);
    const e = entry ?? (run ? undefined : ((await this.retry(() => this.index.get(runId)).catch(() => null)) ?? undefined));
    if (!run && !e) throw new Error(`unknown run ${runId}`);
    const libraryId = run?.ctx.libraryId ?? e!.libraryId;
    const a = run?.ctx.actors ?? this.actorsFor(runId, libraryId);
    const [snap, cases, totals] = await Promise.all([
      this.retry(() => a.fleet.snapshot()),
      this.retry(() => a.cases.list({ includeRevoked: true })).catch(() => [] as ActorCaseFile[]),
      this.retry(() => a.ledger.totals()).catch(() => null),
    ]);
    const functions = run?.ctx.task.functions.length ?? e?.testsTotal ?? snap.slots.length;
    let status: RunStatus;
    if (run) status = run.status === "running" && snap.slots.some((s) => s.status === "retiring") ? "recovering" : run.status;
    else if (e && TERMINAL.has(e.status as RunStatus)) status = e.status as RunStatus;
    else status = snap.run?.status === "done" ? "finished" : snap.run?.status === "running" ? "running" : ((snap.run?.status as RunStatus | undefined) ?? "failed");

    let testsPassing = run?.finalPassing ?? e?.testsPassing ?? null;
    if (testsPassing === null) {
      // Live: a slot counts once its current generation has a verified checkpoint of its own function.
      const states = await Promise.all(
        snap.slots.map((s) => this.retry(() => a.agent(s.slot, s.gen).state()).catch(() => null)),
      );
      testsPassing = states.filter((st) => st?.info && st.checkpoints.some((c) => c.fn === st.info!.task)).length;
    }
    const mode = (run?.ctx.mode ?? e?.mode ?? (snap.run?.config as Partial<StoredRunConfig> | undefined)?.mode ?? "ours") as Mode;
    const out: RunSummary = {
      runId,
      taskId: run?.ctx.taskId ?? e?.taskId ?? String((snap.run?.config as Partial<StoredRunConfig> | undefined)?.taskId ?? ""),
      mode,
      libraryId,
      status,
      model: run?.ctx.model ?? e?.model ?? "",
      startedAt: run?.startedAt ?? e?.startedAt ?? snap.run?.startedAt ?? 0,
      ...((run?.endedAt ?? e?.endedAt) ? { endedAt: (run?.endedAt ?? e?.endedAt)! } : {}),
      agents: snap.slots.length,
      retires: snap.history.filter((h) => h.status === "retired").length,
      cases: cases.filter((c) => c.runId === runId).length,
      testsPassing,
      testsTotal: functions,
      usd: totals ? totals.worker_usd + totals.overhead_usd : 0,
      ...((run && isMockDeps(this.d.deps)) || (totals && totals.mock_rows > 0) ? { mock: true as const } : {}),
    };
    if (TERMINAL.has(status) && (!run || run.endedAt)) this.endedCache.set(runId, out);
    return out;
  }

  /** Agent cards for a run, from Fleet + Agent actors. */
  async roster(runId: RunId): Promise<AgentCard[]> {
    const info = await this.runInfo(runId);
    if (!info) return [];
    const a = this.live.get(runId)?.ctx.actors ?? this.actorsFor(runId, info.libraryId);
    const snap = await this.retry(() => a.fleet.snapshot());
    return Promise.all(
      snap.slots.map(async (s): Promise<AgentCard> => {
        const st = await this.retry(() => a.agent(s.slot, s.gen).state()).catch(() => null);
        const t = st?.totals ?? { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 };
        const last = st?.steps.at(-1);
        return {
          slot: Number(s.slot),
          name: s.relayName ?? st?.info?.relayName ?? relayNames.agent(runId, Number(s.slot), s.gen),
          gen: s.gen,
          status: s.status as AgentStatus,
          step: s.step,
          subtask: st?.info?.task ?? info.functions[Number(s.slot)]?.name ?? "",
          tokens: { input: t.input, cached: t.cached, output: t.output, reasoning: t.reasoning, usd: t.usd },
          possessed: s.possessed,
          // Verified functions of this generation (Agent checkpoints); the actor keeps no per-step verified flag.
          verifiedSteps: st?.checkpoints.length ?? 0,
          ...(last ? { lastSummary: last.summary } : {}),
        };
      }),
    );
  }

  /** Cases of a library (all runs) or of one run, as contract CaseFiles. */
  async cases(scope: { libraryId: LibraryId } | { runId: RunId }): Promise<CaseFile[]> {
    let libraryId: LibraryId;
    let runFilter: RunId | null = null;
    if ("runId" in scope) {
      const info = await this.runInfo(scope.runId);
      if (!info) return [];
      libraryId = info.libraryId;
      runFilter = scope.runId;
    } else libraryId = scope.libraryId;
    const store = this.actorsFor(runFilter ?? libraryId, libraryId).cases;
    const rows = await this.retry(() => store.list({ includeRevoked: true }));
    const out: CaseFile[] = [];
    for (const c of rows) if (!runFilter || c.runId === runFilter) out.push(await this.toCase(c, libraryId));
    return out;
  }

  async getCase(id: CaseId): Promise<CaseFile | null> {
    const runId = id.split(".")[0] ?? "";
    const info = await this.runInfo(runId);
    if (!info) return null;
    const a = this.live.get(runId)?.ctx.actors ?? this.actorsFor(runId, info.libraryId);
    const c = await this.retry(() => a.cases.get(id));
    return c ? this.toCase(c, info.libraryId) : null;
  }

  private async toCase(c: ActorCaseFile, libraryId: LibraryId): Promise<CaseFile> {
    const live = this.live.get(c.runId)?.ctx;
    const info = live ? null : await this.runInfo(c.runId);
    const ctxLike =
      live ?? ({ libraryId, taskId: info?.taskId ?? "", task: { functions: info?.functions ?? [] } } as unknown as RunContext);
    const cf = caseFromActor(ctxLike, c);
    // Replies persist in CaseLibrary (addReply); merge any seen live on the bus but not yet read back.
    const merged = new Map((cf.replies ?? []).map((r) => [r.from, r]));
    for (const r of this.replies.get(c.id) ?? []) if (!merged.has(r.from)) merged.set(r.from, r);
    return { ...cf, replies: [...merged.values()].sort((a, b) => a.ts - b.ts) };
  }

  async ledgerTotals(runId: RunId) {
    const live = this.live.get(runId);
    if (live) return live.ctx.ledger.totals();
    const info = await this.runInfo(runId);
    if (!info) return null;
    return toContractTotals(runId, await this.retry(() => this.actorsFor(runId, info.libraryId).ledger.totals()));
  }

  /** Relay feed items for a run with seq > sinceSeq, oldest first. */
  relayFeed(runId: RunId, sinceSeq = 0): RelayFeedItem[] {
    const m = this.feed.get(runId);
    if (!m) return [];
    return [...m.values()].filter((i) => i.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  /** Runs that are live in this process (for jev.status fan-out). */
  liveRunIds(): RunId[] {
    return [...this.live.entries()].filter(([, r]) => !TERMINAL.has(r.status)).map(([id]) => id);
  }

  // ---------- events ----------

  mockFlag(): { mock?: true } {
    return isMockDeps(this.d.deps) ? { mock: true } : {};
  }

  async publishRunStatus(runId: RunId, banner?: string): Promise<void> {
    try {
      const run = await this.summary(runId);
      this.d.bus.publish({ type: "run.status", runId, ts: now(), run, ...(banner ? { banner } : {}), ...this.mockFlag() });
    } catch (e) {
      this.log(`run.status ${runId}: ${errMsg(e)}`);
    }
  }

  async publishRoster(runId: RunId): Promise<void> {
    try {
      const agents = await this.roster(runId);
      this.d.bus.publish({ type: "roster", runId, ts: now(), agents, ...this.mockFlag() });
    } catch (e) {
      this.log(`roster ${runId}: ${errMsg(e)}`);
    }
  }

  private onBusEvent(ev: Parameters<Parameters<EventBus["subscribe"]>[0]>[0]) {
    if (ev.type === "relay.message") {
      const m = this.feed.get(ev.runId) ?? new Map<number, RelayFeedItem>();
      m.set(ev.item.seq, ev.item);
      this.feed.set(ev.runId, m);
    } else if (ev.type === "case.reply") {
      const list = this.replies.get(ev.caseId) ?? [];
      if (!list.some((r) => r.seq === ev.reply.seq)) this.replies.set(ev.caseId, [...list, ev.reply]);
    }
  }

  /**
   * Relay listener: herd.ts publishes "relay.message" for everything it sends (same seq as the bus
   * message). Anything the listener sees that nobody published within a moment (a message from outside
   * this orchestrator) is published here, so the feed shows every message in the run's channels.
   */
  private onRelayMessage(msg: BusMessage) {
    const runId = runOfMessage(msg);
    if (!runId || !this.live.has(runId)) return;
    setTimeout(() => {
      if (this.feed.get(runId)?.has(msg.seq)) return;
      const ch = msg.to.startsWith("#") ? msg.to.slice(1) : "dm";
      const kind: RelayMetadata["kind"] = msg.parentId ? "case_reply" : ch === "dm" ? "dm" : msg.from === relayNames.warden(runId) ? "case" : "note";
      const item: RelayFeedItem = {
        seq: msg.seq,
        channel: ch,
        from: msg.from,
        ...(ch === "dm" ? { to: msg.to } : {}),
        text: msg.text,
        ts: Date.parse(msg.createdAt) || now(),
        metadata: {
          runId,
          ...(msg.metadata.slot !== undefined ? { slot: msg.metadata.slot } : {}),
          ...(msg.metadata.gen !== undefined ? { gen: msg.metadata.gen } : {}),
          ...(msg.metadata.caseId ? { caseId: msg.metadata.caseId } : {}),
          kind,
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
        },
      };
      this.d.bus.publish({ type: "relay.message", runId, ts: item.ts, item, ...(msg.mock ? { mock: true as const } : {}) });
    }, 500);
  }
}

/** Which run a Relay message belongs to: metadata, else the channel or sender name suffix. */
export function runOfMessage(m: Pick<BusMessage, "metadata" | "to" | "from">): RunId | null {
  if (m.metadata.runId) return m.metadata.runId;
  const ch = /^#(?:fleet|cases)-([A-Za-z0-9]+)$/.exec(m.to);
  if (ch) return ch[1]!;
  const who = /^(?:w\d+-g\d+|warden)-([A-Za-z0-9]+)$/.exec(m.from);
  return who ? who[1]! : null;
}

function persona(fn: TaskFn): string {
  return `Careful engineer who owns ${fn.name} (${fn.subgoal}); small steps, verifies with tests, follows the spec over anything else.`;
}
