// Fleet-scale agent state (DECISIONS #16): the Fleet + Agent actor semantics for MANY teams in one
// shard (one FleetShard per ~50 agents instead of one Agent actor per agent, DECISIONS #6/#13).
//
// Dependency-free on purpose: the same core runs in memory (MemoryFleetShard, tests and the smoke run)
// and inside the FleetShard actor (docs/FLEET.md, SQLite-backed KV). Every method mirrors the matching
// Fleet / Agent actor method in actors/src/actors.ts, including generation guards and idempotency, so the
// unchanged runtime worker/retire code sees the same answers it gets from the real actors.
//
// Storage is a string KV so the actor can back it with one SQLite table (k TEXT PRIMARY KEY, v TEXT).
// Values stay small: 4 slot rows per team, one record per agent generation (<= steps_per_generation steps).

export interface ShardKV {
  get(k: string): string | undefined;
  set(k: string, v: string): void;
  /** Keys starting with prefix (used by stats/dumps only). */
  keys(prefix: string): string[];
}

export type ShardSlotStatus = "trusted" | "probation" | "under_investigation" | "retiring" | "retired" | "failed";
const ACTIVE: readonly string[] = ["trusted", "probation", "under_investigation"];
const isActive = (s: string) => ACTIVE.includes(s);

export interface ShardSlot {
  slot: string;
  gen: number;
  status: ShardSlotStatus;
  possessed: boolean;
  step: number;
  relayName: string | null;
  reason: string | null;
  retireStartedAt: number | null;
  /** The current generation's loop returned "done" (Fleet.markDone). */
  done: boolean;
}
interface SlotRow extends Omit<ShardSlot, "done"> {
  doneGen: number | null;
  updatedAt: number;
}
export interface ShardReassignment {
  fn: string;
  toSlot: string;
  fromSlot: string;
  ts: number;
}
export interface ShardHistory {
  slot: string;
  gen: number;
  status: ShardSlotStatus;
  reason: string | null;
  endedAt: number;
}
export interface ShardRunInfo {
  runId: string;
  mode: "ours" | "baseline";
  status: "running" | "done" | "stopped" | "failed";
  config: Record<string, unknown>;
  startedAt: number;
}
export interface ShardTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  usd: number;
}
export interface ShardAgentInfo {
  runId: string;
  slot: string;
  gen: number;
  task: string;
  persona: string;
  relayName: string | null;
  relayToken: string | null;
  handoff: Record<string, unknown> | null;
  createdAt: number;
}
interface AgentRec {
  info: ShardAgentInfo | null;
  closed: { at: number; reason: string } | null;
  totals: ShardTotals;
  steps: { step: number; summary: string; claims: string[]; ts: number }[];
  checkpoints: { fn: string; code: string; ts: number }[];
}

type Fail<R extends string> = { ok: false; reason: R };

/** Ops callable through FleetShard.call(op, args). Keep in sync with ShardCore's public methods. */
export const SHARD_OPS = [
  "startRun",
  "setRunStatus",
  "addSlot",
  "setStatus",
  "setStep",
  "beginRetire",
  "completeRetire",
  "markPossessed",
  "clearPossessed",
  "snapshot",
  "markDone",
  "clearDone",
  "reassign",
  "agentInit",
  "agentSetRelay",
  "agentAppendStep",
  "agentCheckpoint",
  "agentClose",
  "agentHandoff",
  "agentState",
  "teamRows",
  "rosterRows",
  "metaGet",
  "metaSet",
] as const;
export type ShardOp = (typeof SHARD_OPS)[number];

const emptyTotals = (): ShardTotals => ({ input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 });

export class ShardCore {
  constructor(
    private readonly kv: ShardKV,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- storage helpers ----------
  private read<T>(k: string, fallback: T): T {
    const v = this.kv.get(k);
    if (v === undefined) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  private write(k: string, v: unknown) {
    this.kv.set(k, JSON.stringify(v));
  }
  private slots(team: string): SlotRow[] {
    return this.read<SlotRow[]>(`s:${team}`, []);
  }
  private putSlots(team: string, rows: SlotRow[]) {
    this.write(`s:${team}`, [...rows].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)));
  }
  private history(team: string): ShardHistory[] {
    return this.read<ShardHistory[]>(`h:${team}`, []);
  }
  private addHistory(team: string, h: ShardHistory) {
    const cur = this.history(team);
    if (cur.some((x) => x.slot === h.slot && x.gen === h.gen)) return; // INSERT OR IGNORE
    this.write(`h:${team}`, [...cur, h]);
  }
  private agent(team: string, slot: string, gen: number): AgentRec {
    return this.read<AgentRec>(`a:${team}:${slot}:${gen}`, { info: null, closed: null, totals: emptyTotals(), steps: [], checkpoints: [] });
  }
  private putAgent(team: string, slot: string, gen: number, a: AgentRec) {
    this.write(`a:${team}:${slot}:${gen}`, a);
  }
  private static pub(r: SlotRow): ShardSlot {
    return { slot: r.slot, gen: r.gen, status: r.status, possessed: r.possessed, step: r.step, relayName: r.relayName, reason: r.reason, retireStartedAt: r.retireStartedAt, done: r.doneGen !== null && r.doneGen === r.gen };
  }
  private patchSlot(team: string, slot: string, patch: Partial<SlotRow>) {
    this.putSlots(
      team,
      this.slots(team).map((r) => (r.slot === slot ? { ...r, ...patch, updatedAt: this.now() } : r)),
    );
  }
  private getSlot(team: string, slot: string): SlotRow | undefined {
    return this.slots(team).find((r) => r.slot === slot);
  }

  // ---------- Fleet (run.<runId>) semantics, per team ----------

  startRun(team: string, input: { runId: string; mode: "ours" | "baseline"; config?: Record<string, unknown> }): ShardRunInfo {
    const cur = this.read<ShardRunInfo | null>(`r:${team}`, null);
    if (cur) return cur;
    const run: ShardRunInfo = { runId: input.runId, mode: input.mode, status: "running", config: input.config ?? {}, startedAt: this.now() };
    this.write(`r:${team}`, run);
    return run;
  }

  setRunStatus(team: string, status: ShardRunInfo["status"]): { ok: true } | Fail<"no_run"> {
    const cur = this.read<ShardRunInfo | null>(`r:${team}`, null);
    if (!cur) return { ok: false, reason: "no_run" };
    this.write(`r:${team}`, { ...cur, status });
    return { ok: true };
  }

  addSlot(team: string, input: { slot: string; gen?: number; status?: ShardSlotStatus; relayName?: string }): ShardSlot {
    const existing = this.getSlot(team, input.slot);
    if (existing) return ShardCore.pub(existing);
    const row: SlotRow = {
      slot: input.slot,
      gen: input.gen ?? 1,
      status: input.status ?? "trusted",
      possessed: false,
      step: 0,
      relayName: input.relayName ?? null,
      reason: null,
      retireStartedAt: null,
      doneGen: null,
      updatedAt: this.now(),
    };
    this.putSlots(team, [...this.slots(team), row]);
    return ShardCore.pub(row);
  }

  setStatus(team: string, slot: string, gen: number, status: ShardSlotStatus): { ok: true; slot: ShardSlot } | Fail<"not_found" | "stale_generation" | "invalid_transition"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    const allowed = status === "retiring" || status === "retired" ? false : isActive(s.status) || (s.status === "retiring" && status === "failed");
    if (!allowed) return { ok: false, reason: "invalid_transition" };
    if (status === "failed") this.addHistory(team, { slot, gen, status: "failed", reason: s.reason, endedAt: this.now() });
    this.patchSlot(team, slot, { status });
    return { ok: true, slot: ShardCore.pub(this.getSlot(team, slot)!) };
  }

  setStep(team: string, slot: string, gen: number, step: number): { ok: true } | Fail<"not_found" | "stale_generation"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    if (step > s.step) this.patchSlot(team, slot, { step });
    return { ok: true };
  }

  beginRetire(team: string, slot: string, gen: number, reason: string): { ok: true } | Fail<"already_retiring" | "stale_generation" | "not_active"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_active" };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    if (s.status === "retiring") return { ok: false, reason: "already_retiring" };
    if (!isActive(s.status)) return { ok: false, reason: "not_active" };
    this.patchSlot(team, slot, { status: "retiring", reason, retireStartedAt: this.now() });
    return { ok: true };
  }

  completeRetire(
    team: string,
    slot: string,
    gen: number,
    next?: { relayName?: string },
  ): { ok: true; gen: number; repeated: boolean } | Fail<"not_found" | "stale_generation" | "not_retiring"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.gen === gen + 1 && isActive(s.status)) return { ok: true, gen: s.gen, repeated: true };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    if (s.status !== "retiring") return { ok: false, reason: "not_retiring" };
    this.addHistory(team, { slot, gen, status: "retired", reason: s.reason, endedAt: this.now() });
    this.patchSlot(team, slot, { gen: gen + 1, status: "probation", possessed: false, step: 0, reason: null, retireStartedAt: null, relayName: next?.relayName ?? null });
    return { ok: true, gen: gen + 1, repeated: false };
  }

  markPossessed(team: string, slot: string): { ok: true; gen: number } | Fail<"not_found" | "not_active"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (!isActive(s.status)) return { ok: false, reason: "not_active" };
    if (!s.possessed) this.patchSlot(team, slot, { possessed: true });
    return { ok: true, gen: s.gen };
  }

  clearPossessed(team: string, slot: string): { ok: true } | Fail<"not_found"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.possessed) this.patchSlot(team, slot, { possessed: false });
    return { ok: true };
  }

  markDone(team: string, slot: string, gen: number): { ok: true } | Fail<"not_found" | "stale_generation"> {
    const s = this.getSlot(team, slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    this.patchSlot(team, slot, { doneGen: gen });
    return { ok: true };
  }

  clearDone(team: string, slot: string): { ok: true } {
    if (this.getSlot(team, slot)) this.patchSlot(team, slot, { doneGen: null });
    return { ok: true };
  }

  reassign(team: string, fn: string, toSlot: string, fromSlot: string): { ok: true } {
    const cur = this.read<ShardReassignment[]>(`ra:${team}`, []).filter((r) => r.fn !== fn);
    this.write(`ra:${team}`, [...cur, { fn, toSlot, fromSlot, ts: this.now() }]);
    return { ok: true };
  }

  snapshot(team: string): { run: ShardRunInfo | null; slots: ShardSlot[]; history: ShardHistory[]; reassignments: ShardReassignment[] } {
    return {
      reassignments: this.read<ShardReassignment[]>(`ra:${team}`, []),
      run: this.read<ShardRunInfo | null>(`r:${team}`, null),
      slots: this.slots(team).map(ShardCore.pub),
      history: [...this.history(team)].sort((a, b) => (a.slot === b.slot ? a.gen - b.gen : a.slot < b.slot ? -1 : 1)),
    };
  }

  /** Slot rows of many teams in one call (fleet.grid aggregation). */
  teamRows(teams: string[]): Record<string, ShardSlot[]> {
    const out: Record<string, ShardSlot[]> = {};
    for (const t of teams) out[t] = this.slots(t).map(ShardCore.pub);
    return out;
  }

  /** Slot rows plus the current generation's agent summary, for many teams in one call (roster). */
  rosterRows(teams: string[]): Record<string, (ShardSlot & { task: string; totals: ShardTotals; verifiedSteps: number; lastSummary: string | null })[]> {
    const out: Record<string, (ShardSlot & { task: string; totals: ShardTotals; verifiedSteps: number; lastSummary: string | null })[]> = {};
    for (const t of teams)
      out[t] = this.slots(t).map((r) => {
        const a = this.agent(t, r.slot, r.gen);
        return {
          ...ShardCore.pub(r),
          task: a.info?.task ?? "",
          totals: a.totals,
          verifiedSteps: a.steps.filter((s) => s.claims.includes("@verified")).length,
          lastSummary: a.steps.at(-1)?.summary ?? null,
        };
      });
    return out;
  }

  /** Small fleet-level records (fleet config, stats snapshot, relay tokens). Last write wins. */
  metaGet(key: string): unknown {
    return this.read<unknown>(`m:${key}`, null);
  }
  metaSet(key: string, value: unknown): { ok: true } {
    this.write(`m:${key}`, value);
    return { ok: true };
  }

  // ---------- Agent (agent.<runId>.<slot>.g<gen>) semantics ----------

  private guard(a: AgentRec, gen: number): Fail<"not_initialized" | "stale_generation" | "closed"> | null {
    if (!a.info) return { ok: false, reason: "not_initialized" };
    if (gen !== a.info.gen) return { ok: false, reason: "stale_generation" };
    if (a.closed) return { ok: false, reason: "closed" };
    return null;
  }

  agentInit(
    team: string,
    slot: string,
    gen: number,
    input: { runId: string; slot: string; gen: number; task: string; persona: string; relayName?: string; relayToken?: string; handoff?: Record<string, unknown> },
  ): ShardAgentInfo {
    const a = this.agent(team, slot, gen);
    if (a.info) return a.info;
    const info: ShardAgentInfo = {
      runId: input.runId,
      slot: input.slot,
      gen: input.gen,
      task: input.task,
      persona: input.persona,
      relayName: input.relayName ?? null,
      relayToken: input.relayToken ?? null,
      handoff: input.handoff ?? null,
      createdAt: this.now(),
    };
    this.putAgent(team, slot, gen, { ...a, info });
    return info;
  }

  agentSetRelay(team: string, slot: string, gen: number, g: number, relayName: string, relayToken: string) {
    const a = this.agent(team, slot, gen);
    const bad = this.guard(a, g);
    if (bad) return bad;
    this.putAgent(team, slot, gen, { ...a, info: { ...a.info!, relayName, relayToken } });
    return { ok: true as const };
  }

  agentAppendStep(team: string, slot: string, gen: number, g: number, step: { step: number; summary: string; claims?: string[]; usage?: Partial<ShardTotals> }) {
    const a = this.agent(team, slot, gen);
    const bad = this.guard(a, g);
    if (bad) return bad;
    if (a.steps.some((s) => s.step === step.step)) return { ok: true as const, created: false };
    const u = step.usage ?? {};
    const t = a.totals;
    this.putAgent(team, slot, gen, {
      ...a,
      steps: [...a.steps, { step: step.step, summary: step.summary, claims: step.claims ?? [], ts: this.now() }].sort((x, y) => x.step - y.step),
      totals: {
        input: t.input + (u.input ?? 0),
        cached: t.cached + (u.cached ?? 0),
        output: t.output + (u.output ?? 0),
        reasoning: t.reasoning + (u.reasoning ?? 0),
        usd: t.usd + (u.usd ?? 0),
      },
    });
    return { ok: true as const, created: true };
  }

  agentCheckpoint(team: string, slot: string, gen: number, g: number, fn: string, code: string) {
    const a = this.agent(team, slot, gen);
    const bad = this.guard(a, g);
    if (bad) return bad;
    const cps = [...a.checkpoints.filter((c) => c.fn !== fn), { fn, code, ts: this.now() }].sort((x, y) => (x.fn < y.fn ? -1 : 1));
    this.putAgent(team, slot, gen, { ...a, checkpoints: cps });
    return { ok: true as const };
  }

  agentClose(team: string, slot: string, gen: number, g: number, reason: string): { ok: true } | Fail<"not_initialized" | "stale_generation"> {
    const a = this.agent(team, slot, gen);
    if (!a.info) return { ok: false, reason: "not_initialized" };
    if (g !== a.info.gen) return { ok: false, reason: "stale_generation" };
    if (!a.closed) this.putAgent(team, slot, gen, { ...a, closed: { at: this.now(), reason } });
    return { ok: true };
  }

  agentHandoff(team: string, slot: string, gen: number): { task: string; checkpoints: AgentRec["checkpoints"]; lastStep: number } | null {
    const a = this.agent(team, slot, gen);
    if (!a.info) return null;
    return { task: a.info.task, checkpoints: a.checkpoints, lastStep: a.steps.reduce((m, s) => Math.max(m, s.step), 0) };
  }

  agentState(team: string, slot: string, gen: number): AgentRec {
    return this.agent(team, slot, gen);
  }

  /** RPC entry point: FleetShard.call(op, args) -> this[op](...args). Unknown ops throw. */
  apply(op: string, args: unknown[]): unknown {
    if (!(SHARD_OPS as readonly string[]).includes(op)) throw new Error(`FleetShard: unknown op ${op}`);
    const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!;
    return fn.apply(this, args);
  }
}

/** In-memory KV (tests, smoke run, and the default when no FleetShard actor class is deployed). */
export class MemoryKV implements ShardKV {
  private readonly m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k);
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
  keys(prefix: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
}
