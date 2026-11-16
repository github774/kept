// The real RuntimeService (contract.ts) that Amar's REST/SSE layer wraps. Owner: service implementer.
// orchestrator/src/service.ts re-exports from here (DECISIONS #8; bench/ours and http/serve-live load it).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ActionResult,
  ActorSocketGrant,
  AgentCard,
  BenchmarkResultRow,
  BenchmarkSummary,
  CaseFile,
  CaseId,
  FaultId,
  JevStatus,
  LedgerTotals,
  LibraryId,
  RelayFeedItem,
  RunId,
  RunSummary,
  RuntimeService,
  SequencedEvent,
  StartRunOpts,
  SwarmStats,
} from "../contract.ts";
import type { EventBus } from "../events.ts";
import { armFault, possess } from "./faults.ts";
import type { RunManager, StartRunOptsExt } from "./runs.ts";
import { FleetRunner } from "../fleet/runner.ts";
import { fleetLlm, loadFleetConfig } from "../fleet/pools.ts";
import { cachedChunkStore, type CaseLibStub, type ChunkStoreStub } from "../fleet/stores.ts";
import type { ShardClient } from "../fleet/types.ts";

/** Durable fleet state on the actor runtime (FleetShard actor + existing CaseLibrary / ReasoningStore / Ledger). */
async function fleetActorDeps() {
  const { actors, ids } = await import("../actors.ts");
  const api = actors as unknown as { FleetShard: { get(k: string): ShardClient } };
  return {
    shardFactory: (k: string) => api.FleetShard.get(k),
    index: api.FleetShard.get("fleetshard.index"),
    caseLibraryFor: (libraryId: string) => actors.CaseLibrary.get(ids.cases(libraryId)) as unknown as CaseLibStub,
    chunkStore: (k: string) => cachedChunkStore(actors.ReasoningStore.get(k) as unknown as ChunkStoreStub),
    ledgerActor: (k: string) => actors.Ledger.get(k) as never,
  };
}
import { toContractTotals } from "../ledger.ts";

const FAULTS: readonly FaultId[] = ["F1", "F2", "F3", "F4"];
const DEFAULT_RESULTS = resolve(import.meta.dir, "..", "..", "..", "bench", "results.json");

/** Socket grant issuer (generated client prepareWebsocket); injectable for tests. */
export type GrantFn = (kind: "fleet" | "ledger", actorId: string, runId: RunId) => Promise<{ websocketUrl: string; connectByMs?: number }>;

export interface ServiceOptions {
  resultsPath?: string;
  grant?: GrantFn;
  /** Jev model id shown in JevStatus. */
  jevModel?: string;
  /** Seams for tests (defaults call faults.ts). */
  possess?: typeof possess;
  armFault?: typeof armFault;
}

const defaultGrant: GrantFn = async (kind, actorId, runId) => {
  const { actors } = await import("../actors.ts");
  const api = kind === "fleet" ? actors.Fleet : actors.Ledger;
  return api.prepareWebsocket({ actorId, metadata: { runId, kind } });
};

/**
 * Thin adapter: every method maps to RunManager / actors / EventBus. mock === false; anything mocked
 * underneath (deps.mock.*) is labeled in events (mock:true) and logs (rule 6).
 */
export class RealRuntimeService implements RuntimeService {
  readonly mock = false;
  /** Settles when startup reconcile is done (createRuntimeService sets it). */
  ready: Promise<void> = Promise.resolve();
  private readonly o: ServiceOptions;
  /** Fleet-scale runs (DECISIONS #16, docs/FLEET.md), by fleet runId. */
  private readonly fleets = new Map<RunId, FleetRunner>();

  constructor(
    private readonly runs: RunManager,
    private readonly bus: EventBus,
    opts: ServiceOptions = {},
  ) {
    this.o = opts;
  }

  get runManager(): RunManager {
    return this.runs;
  }

  async startRun(opts: StartRunOpts | StartRunOptsExt): Promise<RunSummary> {
    if ((opts.agents ?? 4) > 4) return this.startFleet(opts);
    return this.runs.startRun(opts);
  }

  /** Fleet-scale mode: agents/4 teams on the rotating v2 trap tasks, one shared case library. */
  private async startFleet(opts: StartRunOpts): Promise<RunSummary> {
    const fleet = await this.newFleet();
    const sum = await fleet.startFleet({
      agents: opts.agents!,
      ...(opts.poisonRate !== undefined ? { poisonRate: opts.poisonRate } : {}),
      ...(opts.libraryId ? { libraryId: opts.libraryId } : {}),
      ...(opts.stepDelayMs ? { stepDelayMs: opts.stepDelayMs } : {}),
      ...(process.env.FLEET_MAX_USD ? { maxUsd: Number(process.env.FLEET_MAX_USD) } : {}),
      ...(process.env.FLEET_WALL_MS ? { wallClockMs: Number(process.env.FLEET_WALL_MS) } : {}),
    });
    this.fleets.set(sum.runId, fleet);
    return sum;
  }

  /**
   * A FleetRunner on durable actors (FleetShard, CaseLibrary, ReasoningStore, Ledger, fleetshard.index) and the
   * real Relay bus for case threads. FLEET_STATE=memory keeps everything in-process (no actor runtime needed).
   */
  private async newFleet(): Promise<FleetRunner> {
    const { cfg, deps, workRoot, tasksRoot, relay } = this.runs.d;
    const llm = fleetLlm(deps.llm, loadFleetConfig(resolve(import.meta.dir, "..", "..", "..", "config")), cfg.prices, deps.log);
    const durable = process.env.FLEET_STATE !== "memory";
    const durableDeps = durable ? await fleetActorDeps() : {};
    return new FleetRunner({
      cfg,
      deps: { ...deps, llm },
      out: this.bus,
      tasksRoot: process.env.FLEET_TASKS_ROOT ?? resolve(tasksRoot ?? resolve(import.meta.dir, "..", "..", "..", "bench", "tasks"), "..", "tasks-v2"),
      workRoot: resolve(workRoot, "fleet"),
      // FLEET_LLM / FLEET_TESTS / FLEET_JEV / FLEET_RELAY override the global fleet gates (defaults 64/16/32/24).
      limits: Object.fromEntries(
        (["llm", "tests", "jev", "relay"] as const).flatMap((k) => (process.env[`FLEET_${k.toUpperCase()}`] ? [[k, Number(process.env[`FLEET_${k.toUpperCase()}`])]] : [])),
      ),
      ...durableDeps,
      ...(relay.mock ? {} : { relay }),
      stateLabel: durable ? "durable actors" : "in-memory",
    });
  }

  /** Restart recovery for fleets (called after RunManager.reconcile). */
  async resumeFleets(): Promise<void> {
    if (process.env.FLEET_STATE === "memory") return;
    const { index } = await fleetActorDeps();
    const open = await FleetRunner.listOpen(index);
    for (const meta of open) {
      if (this.fleets.has(meta.runId)) continue;
      try {
        const fleet = await this.newFleet();
        this.fleets.set(meta.runId, fleet);
        await fleet.resume(meta);
      } catch (e) {
        this.runs.d.deps.log(`[fleet] resume ${meta.runId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async listRuns(): Promise<RunSummary[]> {
    return [...[...this.fleets.values()].map((f) => f.summary()).reverse(), ...(await this.runs.list())];
  }
  async getRoster(runId: RunId): Promise<AgentCard[]> {
    const fleet = this.fleets.get(runId);
    if (fleet) return fleet.roster();
    return this.runs.roster(runId);
  }
  async listCases(scope: { libraryId: LibraryId } | { runId: RunId }): Promise<CaseFile[]> {
    const fleet = "runId" in scope ? this.fleets.get(scope.runId) : [...this.fleets.values()].find((f) => f.libraryId === scope.libraryId);
    if (fleet) return fleet.listCases();
    return this.runs.cases(scope);
  }
  async getCase(id: CaseId): Promise<CaseFile | null> {
    return this.runs.getCase(id);
  }
  async getLedger(runId: RunId): Promise<LedgerTotals | null> {
    const fleet = this.fleets.get(runId);
    if (fleet) return toContractTotals(runId, fleet.ledger.totals() as never);
    const t = await this.runs.ledgerTotals(runId);
    if (!t) return null;
    const net = await this.netSavings(runId, t.worker_usd + t.overhead_usd).catch(() => null);
    return net ? { ...t, net_savings_usd: net.usd, baselineRunId: net.baselineRunId } : t;
  }

  /** Present only when a finished baseline run exists for the same task (BUILD_SPEC "Token ledger"). */
  private async netSavings(runId: RunId, ourUsd: number): Promise<{ usd: number; baselineRunId: string } | null> {
    const idx = await this.runs.listIndex(); // newest first
    const me = idx.find((e) => e.runId === runId);
    if (!me || me.mode === "baseline") return null;
    const baseEntry = idx.find((e) => e.mode === "baseline" && e.taskId === me.taskId && e.status === "finished");
    if (!baseEntry) return null;
    const base = await this.runs.summary(baseEntry.runId, baseEntry);
    if (base.mock) return null;
    return { usd: base.usd - ourUsd, baselineRunId: base.runId };
  }

  async getRelayFeed(runId: RunId, sinceSeq?: number): Promise<RelayFeedItem[]> {
    return this.runs.relayFeed(runId, sinceSeq ?? 0);
  }
  async possess(runId: RunId, slot: number): Promise<ActionResult> {
    const fleet = this.fleets.get(runId);
    if (fleet) return fleet.possess(slot); // slot = global agent index
    const ctx = this.runs.get(runId);
    if (!ctx) return this.missingRun(runId);
    if (ctx.stopping || this.runs.isTerminal(runId)) return { ok: false, error: "run_finished" };
    return (this.o.possess ?? possess)(ctx, slot);
  }
  async injectFault(runId: RunId, slot: number, fault: FaultId): Promise<ActionResult> {
    if (!FAULTS.includes(fault)) return { ok: false, error: "unsupported", detail: `unknown fault ${String(fault)}` };
    const fleet = this.fleets.get(runId);
    if (fleet) return fleet.injectFault(slot, fault);
    const ctx = this.runs.get(runId);
    if (!ctx) return this.missingRun(runId);
    if (ctx.stopping || this.runs.isTerminal(runId)) return { ok: false, error: "run_finished" };
    return (this.o.armFault ?? armFault)(ctx, slot, fault);
  }
  private async missingRun(runId: RunId): Promise<ActionResult> {
    const info = await this.runs.runInfo(runId).catch(() => null);
    return info ? { ok: false, error: "run_finished", detail: `run ${runId} is not live in this orchestrator` } : { ok: false, error: "no_such_run" };
  }
  async stopRun(runId: RunId): Promise<ActionResult> {
    const fleet = this.fleets.get(runId);
    if (fleet) {
      await fleet.stop("stopped by user");
      return { ok: true };
    }
    return this.runs.stop(runId);
  }
  async getJevStatus(): Promise<JevStatus> {
    const { deps, cfg } = this.runs.d;
    const s = await deps.jev.jevStatus();
    return {
      online: s.online,
      mode: s.online ? "jev" : "fallback",
      // The adapter does not expose its running failure count; offline means it reached the switch count.
      consecutiveFailures: s.online ? 0 : cfg.thresholds.jev_fail_switch,
      ...(s.until ? { fallbackUntil: s.until } : {}),
      model: this.o.jevModel ?? cfg.models.jev.model,
      ...(deps.mock.jev ? { mock: true as const } : {}),
    };
  }
  /** jev adapter event -> "jev.status" on every live run. */
  async publishJevStatus(): Promise<void> {
    const status = await this.getJevStatus();
    for (const runId of this.runs.liveRunIds()) this.bus.publish({ type: "jev.status", runId, ts: Date.now(), status, ...(status.mock ? { mock: true as const } : {}) });
  }
  async getBenchmarkResults(): Promise<BenchmarkResultRow[]> {
    const path = this.o.resultsPath ?? DEFAULT_RESULTS;
    if (!existsSync(path)) return [];
    const rows = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(rows) ? (rows as BenchmarkResultRow[]) : [];
  }
  async getBenchmarkSummary(): Promise<BenchmarkSummary | null> {
    const path = (this.o.resultsPath ?? DEFAULT_RESULTS).replace(/\.json$/, ".summary.json");
    if (!existsSync(path)) return null;
    const s = JSON.parse(readFileSync(path, "utf8")) as BenchmarkSummary;
    return s && Array.isArray(s.groups) ? s : null;
  }
  async actorSocketGrant(kind: "fleet" | "ledger", runId: RunId): Promise<ActorSocketGrant> {
    const actorId = kind === "fleet" ? `run.${runId}` : `ledger.${runId}`;
    const g = await (this.o.grant ?? defaultGrant)(kind, actorId, runId);
    return { kind, actorId, websocketUrl: g.websocketUrl, ...(g.connectByMs ? { expiresAt: g.connectByMs } : {}) };
  }
  /** bench/ours/service.ts extension: folder holding the run's final .py files. */
  async getRunWorkDir(runId: RunId): Promise<string | null> {
    return this.runs.workDirAsync(runId);
  }
  /**
   * Swarm simulator hook (stretch): pass as swarm/engine.ts runSwarm({ onStats }). Publishes
   * "swarm.stats"; stats with measured=false (MOCK shards) are flagged mock (rule 6).
   */
  swarmStatsHook(runId: RunId): (stats: SwarmStats) => void {
    return (stats) => this.bus.publish({ type: "swarm.stats", runId, ts: Date.now(), stats, ...(stats.measured ? {} : { mock: true as const }) });
  }
  subscribe(cb: (ev: SequencedEvent) => void): () => void {
    return this.bus.subscribe(cb);
  }
  replay(afterSeq: number): SequencedEvent[] {
    return this.bus.replay(afterSeq);
  }
  /** Stops loops and closes the Relay bus; Fleet state stays "running" so the next start reconciles it. */
  async shutdown(): Promise<void> {
    this.runs.shutdown();
    await this.runs.d.relay.close().catch(() => {});
  }
}

let singleton: Promise<RealRuntimeService> | undefined;

/**
 * Factory used by the HTTP layer and bench/ours (process singleton): builds deps (getLlm, getJev,
 * getEmbedder, relayBusFromConfig), the process EventBus (events.ts `bus`), a RunManager, starts
 * reconcile() in the background (service.ready settles when it is done), and returns the service.
 * Imports config.ts lazily so importing this module has no side effects.
 * Env: LLM_CONCURRENCY=benchmark selects caps.concurrent_llm_calls_benchmark (bench/ours sets it).
 */
export function createRuntimeService(): Promise<RealRuntimeService> {
  singleton ??= build().catch((e) => {
    singleton = undefined;
    throw e;
  });
  return singleton;
}

async function build(): Promise<RealRuntimeService> {
  const [{ config, REPO_ROOT }, { getLlm }, { getJev }, { getEmbedder }, { relayBusFromConfig }, { bus }, { RunManager }] = await Promise.all([
    import("../config.ts"),
    import("../llm.ts"),
    import("../jev.ts"),
    import("../embeddings.ts"),
    import("../relay/index.ts"),
    import("../events.ts"),
    import("./runs.ts"),
  ]);
  const concurrency = process.env.LLM_CONCURRENCY === "benchmark" ? "benchmark" : "demo";
  const llm = await getLlm(concurrency);
  const [jev, embedder, relay] = await Promise.all([getJev(), getEmbedder(), relayBusFromConfig()]);
  const mock = { llm: llm.mock, jev: !config.env.openrouterApiKey, embed: embedder.mock, relay: relay.mock };
  const log = (line: string) => console.log(line);
  for (const [k, v] of Object.entries(mock)) if (v) log(`[MOCK] ${k} adapter is a labeled MOCK (no key / engine down); runs are flagged mock`);
  const runs = new RunManager({
    cfg: config,
    deps: { llm, jev, embedder, log, mock },
    bus,
    relay,
    workRoot: resolve(REPO_ROOT, "bench", "runs"),
    tasksRoot: resolve(REPO_ROOT, "bench", "tasks"),
    concurrency,
  });
  const svc = new RealRuntimeService(runs, bus, { resultsPath: resolve(REPO_ROOT, "bench", "results.json"), jevModel: config.models.jev.model });
  jev.onEvent(() => void svc.publishJevStatus().catch(() => {}));
  svc.ready = runs
    .reconcile()
    .catch((e) => log(`[reconcile] failed: ${e instanceof Error ? e.message : String(e)}`))
    .then(() => svc.resumeFleets())
    .catch((e) => log(`[fleet] resume failed: ${e instanceof Error ? e.message : String(e)}`));
  log(`[service] RealRuntimeService up: worker model ${config.models.worker}, concurrency ${concurrency}, relay ${relay.mock ? "MOCK" : config.env.relayBaseUrl}`);
  return svc;
}
