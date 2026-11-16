// Fleet aggregator: turns live state (translated team events, ledger rows, prompts, test runs, shard rows)
// into fleet.grid + fleet.stats. Every number is counted from something that happened; tokens and USD come
// from ledger rows (API usage fields) only. Nothing here estimates except reuseEstTokens (labelled est.).
import type { DashboardEvent, FaultId, FleetGridCode, FleetStats, RunId } from "../contract.ts";
import { FLEET_GRID_CODES } from "../fleet-codes.ts";
import type { LedgerEntry } from "../actors.ts";
import type { RunTestsResult } from "../testrunner.ts";
import type { FleetLedger } from "./stores.ts";
import type { ShardSlot } from "./shard-core.ts";
import type { TaskTrap } from "../runtime/types.ts";

export interface Possession {
  agent: number;
  gen: number;
  fault: FaultId;
  armedAt: number;
  firedAt: number | null;
  firedStep: number | null;
  outcome: "pending" | "caught" | "spread";
  caughtBy?: string;
}

type Outcome = "done" | "retired" | "failed" | "capped" | "aborted";
/** Stable short key (FNV-1a, base36) so the lesson-pair set stays small in the persisted snapshot. */
function shortHash(s: string): string {
  if (/^h[0-9a-z]+$/.test(s)) return s;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `h${h.toString(36)}${s.length.toString(36)}`;
}
const LESSON_HEADER = "## Fleet lessons (from case files, oldest first)";

export class FleetAggregator {
  readonly startedAt = Date.now();
  private readonly started = new Set<number>(); // teams
  private readonly ended = new Map<number, Outcome>(); // agent -> last loop outcome (current gen)
  readonly possession = new Map<number, Possession>(); // agent -> current possession
  private readonly possessions: Possession[] = [];
  private readonly passing = new Map<string, boolean>(); // `${team}.${fn}` -> latest test
  private readonly teamFinal = new Map<number, boolean>();
  private readonly reached = new Set<string>(); // `${agent}.g${gen}` reached its trap fn
  private readonly recent: boolean[] = [];
  private readonly hitKeys = new Set<string>();
  private readonly agentTrapHits = new Map<string, Set<string>>(); // `${agent}.g${gen}` -> trap keys
  readonly trapsWithCase = new Set<string>(); // `${taskId}.${trapId}`
  private readonly chunkAuthor = new Map<string, number>();
  /** Agents whose verified chunks were reused at least once (poison candidates). */
  readonly reusedAuthors = new Set<number>();
  private readonly lessonPairs = new Set<string>();
  private readonly firstPrompt = new Map<string, number>();
  private readonly lastPrompt = new Map<string, number>();
  private readonly cleansedEmitted = new Set<string>();
  c = {
    steps: 0,
    falseClaimsCaught: 0,
    messagesBlocked: 0,
    poisonedFactsRejected: 0,
    trapHits: 0,
    repeatTrapHits: 0,
    cases: 0,
    lessons: 0,
    retired: 0,
    respawned: 0,
    chunks: { created: 0, reused: 0, revoked: 0 },
    reuseEvents: 0,
    poisonedContextTokensDropped: 0,
    cleansings: 0,
    caucus: { threads: 0, replies: 0 },
  };

  constructor(
    readonly o: {
      runId: RunId;
      teams: number;
      apt: number;
      taskOf: (team: number) => { id: string; traps: TaskTrap[]; fns: string[] };
      recentWindow: number;
      ledger: FleetLedger;
      inFlight: () => { llm: number; tests: number };
      /** Emitted for context.cleansed (measured from ledger rows). */
      emit: (ev: DashboardEvent) => void;
    },
  ) {}

  get agents() {
    return this.o.teams * this.o.apt;
  }
  private key = (agent: number, gen: number) => `${agent}.g${gen}`;

  teamStarted(team: number) {
    this.started.add(team);
  }
  loopEnded(agent: number, outcome: Outcome) {
    this.ended.set(agent, outcome);
  }
  loopStarted(agent: number) {
    this.ended.delete(agent);
  }
  /** The agent generation's worker prompts carried this lesson (measured from prompts as sent). */
  hadLesson(agent: number, gen: number, lesson: string): boolean {
    return this.lessonPairs.has(shortHash(`${agent}.g${gen}|${lesson.trim()}`));
  }
  isDone(agent: number) {
    return this.ended.get(agent) === "done";
  }
  /** Final pytest of one function at team end (ground truth for capped agents' cells). */
  finalTest(team: number, fn: string, passed: boolean) {
    this.passing.set(`${team}.${fn}`, passed);
  }
  teamFinished(team: number, allPass: boolean) {
    this.teamFinal.set(team, allPass);
  }

  // ---------- poisoning ----------

  armed(agent: number, gen: number, fault: FaultId) {
    const p: Possession = { agent, gen, fault, armedAt: Date.now(), firedAt: null, firedStep: null, outcome: "pending" };
    this.possession.set(agent, p);
    this.possessions.push(p);
  }
  private catchP(agent: number, gen: number | undefined, why: string) {
    const p = this.possession.get(agent);
    if (!p || p.outcome !== "pending") return;
    if (gen !== undefined && gen !== p.gen) return;
    p.outcome = "caught";
    p.caughtBy = why;
  }
  /** Run end: anything never caught counts as spread (conservative). */
  finalizePoison() {
    for (const p of this.possessions) if (p.outcome === "pending") p.outcome = "spread";
  }
  /** faultAt/fault for agent.status of a possessed agent (dashboard recovery timer). */
  faultFields(agent: number): { faultAt: number; fault: FaultId } | null {
    const p = this.possession.get(agent);
    return p && p.firedAt !== null ? { faultAt: p.firedAt, fault: p.fault } : null;
  }

  // ---------- event stream (already translated: global slots) ----------

  observe(ev: DashboardEvent) {
    switch (ev.type) {
      case "agent.status": {
        const a = ev.slot;
        if (ev.agent) this.c.steps++;
        const p = this.possession.get(a);
        if (p && p.gen === ev.gen) {
          if (ev.fault && p.firedAt === null) {
            p.firedAt = ev.faultAt ?? ev.ts;
            p.firedStep = ev.step;
          } else if (p.outcome === "pending" && p.firedStep !== null && !ev.agent && !ev.reason && ev.step > p.firedStep) {
            p.outcome = "spread"; // started another step after the fault without being caught
          }
        }
        if (ev.status === "retiring") {
          this.catchP(a, ev.gen, `retired: ${ev.reason ?? ""}`);
          if (ev.reason === "false_claim") this.c.falseClaimsCaught++;
        }
        if (ev.status === "retired") this.c.retired++;
        if (ev.status === "probation" && ev.reason?.startsWith("replaces ")) {
          this.c.respawned++;
          this.ended.delete(a);
        }
        break;
      }
      case "relay.message": {
        const b = ev.item.blocked;
        if (b) {
          this.c.messagesBlocked++;
          if (b.questionId === "fact_contradicts_spec") this.c.poisonedFactsRejected++;
          const s = ev.item.metadata.slot;
          if (s !== undefined) {
            this.catchP(s, ev.item.metadata.gen, `blocked: ${b.questionId}`);
            // F4 blocked before delivery to the receiver (metadata.slot is the possessed receiver).
          }
        }
        break;
      }
      case "case.created": {
        this.c.cases++;
        if (ev.case.lesson) this.c.lessons++;
        if (ev.case.recipients.length) this.c.caucus.threads++;
        const hits = this.agentTrapHits.get(this.key(ev.case.slot, ev.case.gen));
        for (const t of hits ?? []) this.trapsWithCase.add(t);
        break;
      }
      case "case.reply":
        this.c.caucus.replies++;
        break;
      case "chunk.created":
        this.c.chunks.created++;
        this.chunkAuthor.set(ev.chunk.id, ev.chunk.slot);
        break;
      case "chunk.reused": {
        this.c.chunks.reused++;
        const a = this.chunkAuthor.get(ev.chunkId);
        if (a !== undefined) this.reusedAuthors.add(a);
        break;
      }
      case "chunk.revoked":
        this.c.chunks.revoked++;
        break;
      case "context.cleansed":
        this.c.cleansings++;
        this.c.poisonedContextTokensDropped += ev.droppedPromptTokens - ev.handoffPromptTokens;
        break;
      default:
        break;
    }
  }

  // ---------- taps ----------

  /** Ledger row (usage fields): worker prompt tokens per agent generation -> context.cleansed. */
  onLedger(team: number, e: LedgerEntry) {
    if (e.category !== "worker" || e.slot === undefined || e.gen === undefined) return;
    const slot = Number(e.slot);
    if (!Number.isInteger(slot) || slot < 0) return;
    const agent = team * this.o.apt + slot;
    const k = this.key(agent, e.gen);
    if (!this.firstPrompt.has(k)) this.firstPrompt.set(k, e.input_tokens);
    this.lastPrompt.set(k, e.input_tokens);
    if (e.gen > 1 && !this.cleansedEmitted.has(k)) {
      const prev = this.lastPrompt.get(this.key(agent, e.gen - 1));
      if (prev !== undefined) {
        this.cleansedEmitted.add(k);
        this.o.emit({ type: "context.cleansed", runId: this.o.runId, ts: Date.now(), slot: agent, fromGen: e.gen - 1, toGen: e.gen, droppedPromptTokens: prev, handoffPromptTokens: e.input_tokens });
      }
    }
  }

  /** Worker / lesson-writer prompt as sent: lessons present in a worker prompt count as delivered. */
  onPrompt(team: number, call: { category: string; slot: string; gen: number; system: string }) {
    if (call.category !== "worker") return;
    const i = call.system.indexOf(LESSON_HEADER);
    if (i < 0) return;
    const block = call.system.slice(i + LESSON_HEADER.length).split("\n## ")[0]!;
    const agent = team * this.o.apt + Number(call.slot);
    for (const m of block.matchAll(/^\d+\. (.+)$/gm)) this.lessonPairs.add(shortHash(`${agent}.g${call.gen}|${m[1]!.trim()}`));
  }

  /** Every test run of a worker (pool-wrapped runFnTests). */
  onTest(team: number, slot: number, gen: number, fn: string, r: RunTestsResult) {
    const task = this.o.taskOf(team);
    this.passing.set(`${team}.${fn}`, r.passed);
    if (r.guard || r.timedOut) return;
    const traps = task.traps.filter((t) => (t as TaskTrap & { function?: string }).function === fn || t.trap_test.startsWith(`tests/test_${fn}.py::`));
    if (!traps.length) return;
    const agent = team * this.o.apt + slot;
    const ak = this.key(agent, gen);
    const failed = traps.filter((t) => r.failedTests.includes(t.trap_test));
    if (!this.reached.has(ak)) {
      this.reached.add(ak);
      this.recent.push(failed.length > 0);
    }
    for (const t of failed) {
      const tk = `${task.id}.${t.id}`;
      const hk = `${ak}.${t.id}`;
      if (this.hitKeys.has(hk)) continue;
      this.hitKeys.add(hk);
      this.c.trapHits++;
      if (this.trapsWithCase.has(tk)) this.c.repeatTrapHits++;
      const s = this.agentTrapHits.get(ak) ?? new Set<string>();
      s.add(tk);
      this.agentTrapHits.set(ak, s);
    }
  }

  /** Trap-hit outcomes in reach order (for curves / tests). */
  get trapSeries(): readonly boolean[] {
    return this.recent;
  }

  // ---------- grid + stats ----------

  cellFor(agent: number, row: ShardSlot | undefined): FleetGridCode {
    const team = Math.floor(agent / this.o.apt);
    if (!this.started.has(team) || !row) return ".";
    const p = this.possession.get(agent);
    if (p && p.gen === row.gen && p.outcome !== "caught" && (row.possessed || p.firedAt !== null)) return "X";
    const end = this.ended.get(agent);
    if (end === "done" || row.done) return "D";
    // Step cap reached with the function's tests passing: the subtask is finished (tests are ground truth).
    const fn = this.o.taskOf(team).fns[agent % this.o.apt];
    if (end === "capped" && fn && this.passing.get(`${team}.${fn}`)) return "D";
    switch (row.status) {
      case "trusted":
        return end === "failed" || end === "capped" ? "F" : "T";
      case "probation":
        return end === "failed" || end === "capped" ? "F" : "P";
      case "under_investigation":
        return "I";
      case "retiring":
      case "retired":
        return "R";
      case "failed":
        return "F";
      default:
        return "T";
    }
  }

  grid(rows: (team: number) => ShardSlot[] | undefined): string {
    let cells = "";
    for (let t = 0; t < this.o.teams; t++) {
      const rs = rows(t) ?? [];
      for (let s = 0; s < this.o.apt; s++) cells += this.cellFor(t * this.o.apt + s, rs.find((r) => r.slot === String(s)));
    }
    return cells;
  }

  stats(cells: string): FleetStats {
    const byStatus: FleetStats["byStatus"] = {};
    for (const code of Object.keys(FLEET_GRID_CODES) as FleetGridCode[]) byStatus[FLEET_GRID_CODES[code]] = 0;
    for (const ch of cells) byStatus[FLEET_GRID_CODES[ch as FleetGridCode]]!++;
    let subtasksPassing = 0;
    let teamsPassing = 0;
    for (let t = 0; t < this.o.teams; t++) {
      const fns = this.o.taskOf(t).fns;
      const n = fns.filter((f) => this.passing.get(`${t}.${f}`)).length;
      subtasksPassing += n;
      const fin = this.teamFinal.get(t);
      if (fin ?? (n === fns.length && fns.length > 0)) teamsPassing++;
    }
    const L = this.o.ledger.totals();
    const usd = L.worker_usd + L.overhead_usd;
    const w = this.recent.slice(-this.o.recentWindow);
    const caught = this.possessions.filter((p) => p.outcome === "caught").length;
    const spread = this.possessions.filter((p) => p.outcome === "spread").length;
    const fl = this.o.inFlight();
    return {
      agents: this.agents,
      teams: this.o.teams,
      elapsedMs: Date.now() - this.startedAt,
      byStatus,
      steps: this.c.steps,
      subtasksPassing,
      teamsPassing,
      poison: { injected: this.possessions.length, caught, spread },
      falseClaimsCaught: this.c.falseClaimsCaught,
      messagesBlocked: this.c.messagesBlocked,
      poisonedFactsRejected: this.c.poisonedFactsRejected,
      trapHits: this.c.trapHits,
      repeatTrapHits: this.c.repeatTrapHits,
      trapHitRateRecent: { window: this.o.recentWindow, rate: w.length ? Number((w.filter(Boolean).length / w.length).toFixed(3)) : null },
      cases: this.c.cases,
      lessons: this.c.lessons,
      lessonsDelivered: this.lessonPairs.size,
      retired: this.c.retired,
      respawned: this.c.respawned,
      tokens: { ...L.tokens },
      usd: Number(usd.toFixed(6)),
      reuseEstTokens: L.reuse_est_tokens,
      chunks: { ...this.c.chunks },
      poisonedContextTokensDropped: this.c.poisonedContextTokensDropped,
      caucus: { ...this.c.caucus },
      overheadShare: usd > 0 ? Number((L.overhead_usd / usd).toFixed(4)) : null,
      llmInFlight: fl.llm,
      testsInFlight: fl.tests,
      measured: true,
    };
  }

  get possessionList(): readonly Possession[] {
    return this.possessions;
  }

  // ---------- durability: counters snapshot (FleetShard index meta), restored after a restart ----------

  exportState() {
    return {
      v: 1,
      startedAt: this.startedAt,
      started: [...this.started],
      ended: [...this.ended],
      possessions: this.possessions,
      passing: [...this.passing],
      teamFinal: [...this.teamFinal],
      reached: [...this.reached],
      recent: this.recent,
      hitKeys: [...this.hitKeys],
      agentTrapHits: [...this.agentTrapHits].map(([k, v]) => [k, [...v]] as const),
      trapsWithCase: [...this.trapsWithCase],
      lessonPairs: [...this.lessonPairs].map(shortHash),
      firstPrompt: [...this.firstPrompt],
      lastPrompt: [...this.lastPrompt],
      cleansedEmitted: [...this.cleansedEmitted],
      chunkAuthor: [...this.chunkAuthor],
      reusedAuthors: [...this.reusedAuthors],
      c: this.c,
    };
  }

  importState(x: ReturnType<FleetAggregator["exportState"]> | null | undefined) {
    if (!x || x.v !== 1) return;
    (this as { startedAt: number }).startedAt = x.startedAt;
    for (const t of x.started) this.started.add(t);
    for (const [a, o] of x.ended) this.ended.set(a, o);
    for (const p of x.possessions) {
      this.possessions.push(p);
      this.possession.set(p.agent, p);
    }
    for (const [k, v] of x.passing) this.passing.set(k, v);
    for (const [k, v] of x.teamFinal) this.teamFinal.set(k, v);
    for (const k of x.reached) this.reached.add(k);
    this.recent.push(...x.recent);
    for (const k of x.hitKeys) this.hitKeys.add(k);
    for (const [k, v] of x.agentTrapHits) this.agentTrapHits.set(k, new Set(v));
    for (const k of x.trapsWithCase) this.trapsWithCase.add(k);
    for (const k of x.lessonPairs) this.lessonPairs.add(k);
    for (const [k, v] of x.firstPrompt) this.firstPrompt.set(k, v);
    for (const [k, v] of x.lastPrompt) this.lastPrompt.set(k, v);
    for (const k of x.cleansedEmitted) this.cleansedEmitted.add(k);
    for (const [k, v] of x.chunkAuthor ?? []) this.chunkAuthor.set(k, v);
    for (const a of x.reusedAuthors ?? []) this.reusedAuthors.add(a);
    this.c = x.c;
  }
}
