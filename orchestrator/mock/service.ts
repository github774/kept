// MOCK RuntimeService: replays mock/events.jsonl through an EventBus and folds the events into
// queryable state. Every event and object it returns is flagged mock:true; the dashboard must
// show the MOCK badge (BUILD_SPEC rule 6). Nothing here calls a model, Jev, Relay or actors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../src/events.ts";
import { startSwarm as launchSwarm } from "../src/swarm/launch.ts";
import { buildMockScript, RECORDED_POSSESS_SLOT } from "./script.ts";
import { FleetSim } from "./fleet.ts";
import type {
  ActionResult,
  ActorSocketGrant,
  AgentCard,
  BenchmarkResultRow,
  CaseFile,
  DashboardEvent,
  FaultId,
  JevStatus,
  LedgerTotals,
  RelayFeedItem,
  RunId,
  RunSummary,
  RuntimeService,
  SequencedEvent,
  StartRunOpts,
} from "../src/contract.ts";

const DIR = import.meta.dir;

export function loadMockEvents(path = join(DIR, "events.jsonl")): DashboardEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ ...(JSON.parse(l) as DashboardEvent), mock: true }));
}

/** Moves the timestamps nested in a recorded event by the same offset as its `ts` (playback looks live). */
function shiftTimes(ev: DashboardEvent, d: number): DashboardEvent {
  const sh = (n: number): number => n + d;
  switch (ev.type) {
    case "relay.message":
      ev.item.ts = sh(ev.item.ts);
      break;
    case "case.created":
      ev.case.createdAt = sh(ev.case.createdAt);
      ev.case.replies = ev.case.replies?.map((r) => ({ ...r, ts: sh(r.ts) }));
      break;
    case "case.reply":
      ev.reply.ts = sh(ev.reply.ts);
      break;
    case "recovery":
      if (ev.stages) ev.stages = Object.fromEntries(Object.entries(ev.stages).map(([k, v]) => [k, v === null ? null : sh(v)])) as unknown as typeof ev.stages;
      break;
    case "jev.status":
      if (ev.status.fallbackUntil !== undefined) ev.status.fallbackUntil = sh(ev.status.fallbackUntil);
      break;
    default:
      break;
  }
  return ev;
}

export interface MockOptions {
  speed?: number; // 1 = real time of the recording; 10 = 10x faster
  loop?: boolean;
  autoStart?: boolean;
  /** Custom recording. Possess then cannot be remapped (it plays as recorded). */
  events?: DashboardEvent[];
  /**
   * Slot the recording possesses on its own when nobody presses Possess (default 3, as recorded).
   * false => playback pauses at the possession beat until possess(slot) is called.
   */
  autoPossess?: number | false;
}

export class MockRuntimeService implements RuntimeService {
  readonly mock = true;
  private readonly bus = new EventBus();
  private script: DashboardEvent[];
  /** Index of the possession beat in `script`; -1 when unknown (custom events). */
  private possessIndex: number;
  private readonly remappable: boolean;
  private readonly autoPossess: number | false;
  private possessedSlot: number | null = null;
  /** Possess pressed after the beat already played: used by the next play() (loop or startRun). */
  private queuedSlot: number | null = null;
  private readonly speed: number;
  private readonly loop: boolean;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Next script index to emit. */
  private cursor = 0;
  private playing = false;
  private paused = false;

  private runs = new Map<RunId, RunSummary>();
  private rosters = new Map<RunId, AgentCard[]>();
  private cases = new Map<string, CaseFile>();
  private ledgers = new Map<RunId, LedgerTotals>();
  private feeds = new Map<RunId, RelayFeedItem[]>();
  /** Fleet-scale MOCK (startRun with agents > 4); null => the 4-agent recording. */
  private fleet: FleetSim | null = null;
  private jev: JevStatus = { online: true, mode: "jev", consecutiveFailures: 0, model: "typesafe/jev-1.14", mock: true };

  constructor(opts: MockOptions = {}) {
    this.remappable = !opts.events;
    this.script = opts.events ?? loadMockEvents();
    this.possessIndex = this.remappable ? buildMockScript(RECORDED_POSSESS_SLOT).possessIndex : -1;
    this.autoPossess = opts.autoPossess ?? RECORDED_POSSESS_SLOT;
    if (this.remappable && this.autoPossess !== false && this.autoPossess !== RECORDED_POSSESS_SLOT) this.useScriptFor(this.autoPossess);
    this.speed = opts.speed ?? 1;
    this.loop = opts.loop ?? false;
    console.log(`[MOCK] RuntimeService replaying ${this.script.length} recorded events at ${this.speed}x`);
    if (opts.autoStart) this.play();
  }

  private useScriptFor(slot: number): void {
    const s = buildMockScript(slot);
    this.script = s.events.map((e) => ({ ...e, mock: true }) as DashboardEvent);
    this.possessIndex = s.possessIndex;
  }

  /** True when playback must stop before the possession beat and wait for possess(). */
  private holdAtPossess(): boolean {
    return this.remappable && this.autoPossess === false && this.possessedSlot === null && this.possessIndex >= 0;
  }

  /** (Re)start playback from the beginning. Timestamps are shifted so the recording looks live. */
  play(): void {
    this.reset();
    this.playing = true;
    this.scheduleFrom(0);
  }

  /** Schedules script[from..] relative to now (script[from] fires immediately). */
  private scheduleFrom(from: number): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    const first = this.script[from];
    if (!first) return;
    const t0 = first.ts;
    const now = Date.now();
    const end = this.holdAtPossess() && from <= this.possessIndex ? this.possessIndex : this.script.length;
    for (let i = from; i < end; i++) {
      const ev = this.script[i]!;
      const delay = (ev.ts - t0) / this.speed;
      this.timers.push(
        setTimeout(() => {
          this.cursor = i + 1;
          this.emit(ev, now + delay);
          if (i === end - 1 && end < this.script.length) {
            this.paused = true;
            console.log("[MOCK] paused at the possession beat: press Possess to continue");
          }
          if (this.loop && i === this.script.length - 1) this.timers.push(setTimeout(() => this.play(), 3000));
        }, delay),
      );
    }
  }

  /** Emit everything immediately (tests, or a dashboard that just wants the end state). Stops at the possession beat when autoPossess is false. */
  drain(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.playing = false;
    if (this.fleet) {
      while (!this.fleet.done) this.emitFleetTick();
      return;
    }
    const now = Date.now();
    const end = this.holdAtPossess() && this.cursor <= this.possessIndex ? this.possessIndex : this.script.length;
    for (; this.cursor < end; this.cursor++) this.emit(this.script[this.cursor]!, now);
    this.paused = end < this.script.length;
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.playing = false;
  }

  private reset(): void {
    this.stop();
    this.cursor = 0;
    this.paused = false;
    this.fleet = null;
    this.possessedSlot = this.queuedSlot;
    this.queuedSlot = null;
    if (this.remappable) this.useScriptFor(this.possessedSlot ?? (this.autoPossess === false ? RECORDED_POSSESS_SLOT : this.autoPossess));
    this.runs.clear();
    this.rosters.clear();
    this.cases.clear();
    this.ledgers.clear();
    this.feeds.clear();
  }

  private emit(ev: DashboardEvent, ts: number): void {
    const live = shiftTimes({ ...structuredClone(ev), ts, mock: true } as DashboardEvent, ts - ev.ts);
    this.fold(live);
    this.bus.publish(live);
  }

  private fold(ev: DashboardEvent): void {
    switch (ev.type) {
      case "run.status":
        this.runs.set(ev.runId, ev.run);
        break;
      case "roster":
        this.rosters.set(ev.runId, ev.agents);
        break;
      case "agent.status": {
        const roster = this.rosters.get(ev.runId) ?? [];
        const next = ev.agent ?? { ...roster.find((a) => a.slot === ev.slot)!, status: ev.status, step: ev.step };
        this.rosters.set(ev.runId, [...roster.filter((a) => a.slot !== ev.slot), next].sort((a, b) => a.slot - b.slot));
        break;
      }
      case "relay.message":
        this.feeds.set(ev.runId, [...(this.feeds.get(ev.runId) ?? []), ev.item]);
        break;
      case "case.created":
        this.cases.set(ev.case.id, ev.case);
        break;
      case "case.reply": {
        const c = this.cases.get(ev.caseId);
        if (c && !(c.replies ?? []).some((r) => r.seq === ev.reply.seq)) this.cases.set(c.id, { ...c, replies: [...(c.replies ?? []), ev.reply] });
        break;
      }
      case "ledger.totals":
        this.ledgers.set(ev.runId, ev.totals);
        break;
      case "jev.status":
        this.jev = ev.status;
        break;
      case "recovery":
      case "swarm.stats":
        break;
    }
  }

  /** MOCK fleet-scale run: one FleetSim tick per (1000 / speed) ms. See mock/fleet.ts. */
  playFleet(opts: { agents: number; poisonRate?: number }): RunSummary {
    this.reset();
    const fleet = new FleetSim({ agents: opts.agents, ...(opts.poisonRate !== undefined ? { poisonRate: opts.poisonRate } : {}) });
    this.fleet = fleet;
    this.playing = true;
    const tick = (): void => {
      if (this.fleet !== fleet) return;
      this.emitFleetTick();
      if (!fleet.done) this.timers.push(setTimeout(tick, 1000 / this.speed));
      else if (this.loop) this.timers.push(setTimeout(() => this.playFleet(opts), 3000));
    };
    tick();
    return this.runs.get(fleet.runId) ?? fleet.summary("starting");
  }

  private emitFleetTick(): void {
    const now = Date.now();
    for (const ev of this.fleet!.step()) this.emit(ev, now);
  }

  async startRun(opts: StartRunOpts): Promise<RunSummary> {
    if (opts.agents !== undefined && opts.agents > 4) {
      console.log(`[MOCK] startRun(${JSON.stringify(opts)}) -> fleet script (${opts.agents} agents)`);
      return this.playFleet({ agents: opts.agents, ...(opts.poisonRate !== undefined ? { poisonRate: opts.poisonRate } : {}) });
    }
    console.log(`[MOCK] startRun(${JSON.stringify(opts)}) -> replaying recording${opts.stepDelayMs ? ` (stepDelayMs ${opts.stepDelayMs} ignored in mock)` : ""}`);
    this.play();
    const runId = this.script[0]?.runId ?? "mock01";
    return (
      this.runs.get(runId) ?? {
        runId,
        taskId: opts.taskId,
        mode: opts.mode,
        libraryId: opts.libraryId ?? `lib-${runId}`,
        status: "starting",
        model: "openai/gpt-6-luna",
        startedAt: Date.now(),
        agents: 4,
        retires: 0,
        cases: 0,
        testsPassing: 0,
        testsTotal: 4,
        usd: 0,
        mock: true,
      }
    );
  }
  async listRuns(): Promise<RunSummary[]> {
    return [...this.runs.values()];
  }
  async getRoster(runId: RunId): Promise<AgentCard[]> {
    if (this.fleet && runId === this.fleet.runId) return this.fleet.cards(); // all agents, global slot index
    return this.rosters.get(runId) ?? [];
  }
  async listCases(scope: { libraryId: string } | { runId: RunId }): Promise<CaseFile[]> {
    const all = [...this.cases.values()];
    return "runId" in scope ? all.filter((c) => c.runId === scope.runId) : all.filter((c) => c.libraryId === scope.libraryId);
  }
  async getCase(id: string): Promise<CaseFile | null> {
    return this.cases.get(id) ?? null;
  }
  async getLedger(runId: RunId): Promise<LedgerTotals | null> {
    return this.ledgers.get(runId) ?? null;
  }
  async getRelayFeed(runId: RunId, sinceSeq = 0): Promise<RelayFeedItem[]> {
    return (this.feeds.get(runId) ?? []).filter((m) => m.seq > sinceSeq);
  }
  private checkSlot(runId: RunId, slot: number): ActionResult | null {
    if (!this.runs.has(runId)) return { ok: false, error: "no_such_run" };
    if (!(this.rosters.get(runId) ?? []).some((a) => a.slot === slot)) return { ok: false, error: "no_such_slot" };
    return null;
  }
  /**
   * MOCK possess: replays the recorded possession sequence on the chosen slot. Works while the
   * recording has not reached its possession beat yet (or is paused there with autoPossess:false);
   * the beat then fires right away. Pressed after the beat: the slot is queued and the next replay
   * (startRun() or loop) possesses it.
   */
  async possess(runId: RunId, slot: number): Promise<ActionResult> {
    if (this.fleet && runId === this.fleet.runId) {
      // Fleet MOCK: the agent turns X on the next tick and is caught ~3-4 ticks later.
      const r = this.fleet.possess(slot);
      console.log(`[MOCK] fleet possess(${runId}, ${slot}): ${JSON.stringify(r)}`);
      return r;
    }
    const bad = this.checkSlot(runId, slot);
    if (bad) return bad;
    const card = (this.rosters.get(runId) ?? []).find((a) => a.slot === slot);
    if (card && !["trusted", "probation", "under_investigation"].includes(card.status)) return { ok: false, error: "slot_not_active" };
    if (!this.remappable || this.possessIndex < 0) {
      console.log(`[MOCK] possess(${runId}, ${slot}): custom recording, plays as recorded`);
      return { ok: true, detail: "MOCK: custom recording; possession plays as recorded" };
    }
    if (this.possessedSlot !== null || this.cursor > this.possessIndex) {
      // The beat already played in this pass: queue the slot for the next replay (loop or startRun).
      const s = this.possessedSlot ?? (this.autoPossess === false ? RECORDED_POSSESS_SLOT : this.autoPossess);
      this.queuedSlot = slot;
      console.log(`[MOCK] possess(${runId}, ${slot}): possession already played on slot ${s}; queued for the next replay`);
      return { ok: true, detail: `MOCK: possession already played on slot ${s} in this pass; slot ${slot} is queued for the next replay (startRun or loop)` };
    }
    console.log(`[MOCK] possess(${runId}, ${slot}): replaying the recorded possession on slot ${slot}`);
    this.possessedSlot = slot;
    this.useScriptFor(slot); // identical prefix, so events already shown stay valid
    const now = Date.now();
    for (; this.cursor < this.possessIndex; this.cursor++) this.emit(this.script[this.cursor]!, now);
    this.paused = false;
    if (this.playing) this.scheduleFrom(this.possessIndex);
    else for (; this.cursor < this.script.length; this.cursor++) this.emit(this.script[this.cursor]!, now);
    return { ok: true, detail: `MOCK: recorded possession (F1 then F3) replayed on slot ${slot}` };
  }
  async injectFault(runId: RunId, slot: number, fault: FaultId): Promise<ActionResult> {
    console.log(`[MOCK] injectFault(${runId}, ${slot}, ${fault}): no-op`);
    return this.checkSlot(runId, slot) ?? { ok: true, detail: `MOCK: ${fault} accepted, recording unchanged` };
  }
  async stopRun(runId: RunId): Promise<ActionResult> {
    if (!this.runs.has(runId)) return { ok: false, error: "no_such_run" };
    this.stop();
    return { ok: true, detail: "MOCK: playback stopped" };
  }
  async getJevStatus(): Promise<JevStatus> {
    return this.jev;
  }
  async getBenchmarkResults(): Promise<BenchmarkResultRow[]> {
    const rows = JSON.parse(readFileSync(join(DIR, "bench-results.json"), "utf8")) as BenchmarkResultRow[];
    return rows.map((r) => ({ ...r, mock: true }));
  }
  async actorSocketGrant(kind: "fleet" | "ledger", runId: RunId): Promise<ActorSocketGrant> {
    // No actor runtime in mock mode: dashboard should fall back to SSE roster/ledger events.
    return { kind, actorId: `${kind === "fleet" ? "run" : "ledger"}.${runId}`, websocketUrl: "", mock: true };
  }
  /** MOCK: runs the real swarm engine on in-memory MOCK shards (stats.measured=false). */
  async startSwarm(opts: { agents: number; agentsPerShard?: number; ticks?: number }): Promise<ActionResult> {
    console.log(`[MOCK] startSwarm(${JSON.stringify(opts)})`);
    return launchSwarm(this.bus, { ...opts, mock: true });
  }
  subscribe(cb: (ev: SequencedEvent) => void): () => void {
    return this.bus.subscribe(cb);
  }
  replay(afterSeq: number): SequencedEvent[] {
    return this.bus.replay(afterSeq);
  }
}
