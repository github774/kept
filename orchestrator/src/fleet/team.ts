// Per-team plumbing for fleet-scale mode: the RunActors-shaped adapter over a FleetShard (so the unchanged
// runtime worker / retire / herd code runs against sharded state) and the team event bus that rewrites
// team events into fleet events (fleet runId, global agent index) before the aggregator and the global bus.
import type { DashboardEvent, RunId, SequencedEvent } from "../contract.ts";
import type { RunActors } from "../runtime/types.ts";
import type { ShardOp } from "./shard-core.ts";
import { toGlobal, type CaseLibStub, type ChunkStoreStub } from "./stores.ts";
import type { ShardClient } from "./types.ts";

type LedgerStub = { record(e: unknown): Promise<unknown>; totals(): Promise<unknown>; maxIndex?(p: string): Promise<number> };

/**
 * ctx.actors for one team. fleet.* and agent(slot, gen).* go to the team's FleetShard (one RPC each);
 * cases / chunks are team views of the shared stores; ledger is the team's FleetLedger book.
 */
export function teamActors(shard: ShardClient, teamKey: string, stores: { cases: CaseLibStub; chunks: ChunkStoreStub; ledger: LedgerStub }): RunActors {
  const c = (op: ShardOp, ...args: unknown[]) => shard.call(op, [teamKey, ...args]);
  const fleet = {
    startRun: (input: unknown) => c("startRun", input),
    setRunStatus: (status: string) => c("setRunStatus", status),
    addSlot: (input: unknown) => c("addSlot", input),
    setStatus: (slot: string, gen: number, status: string) => c("setStatus", slot, gen, status),
    setStep: (slot: string, gen: number, step: number) => c("setStep", slot, gen, step),
    beginRetire: (slot: string, gen: number, reason: string) => c("beginRetire", slot, gen, reason),
    completeRetire: (slot: string, gen: number, next?: unknown) => c("completeRetire", slot, gen, next),
    markPossessed: (slot: string) => c("markPossessed", slot),
    clearPossessed: (slot: string) => c("clearPossessed", slot),
    markDone: (slot: string, gen: number) => c("markDone", slot, gen),
    clearDone: (slot: string) => c("clearDone", slot),
    reassign: (fn: string, toSlot: string, fromSlot: string) => c("reassign", fn, toSlot, fromSlot),
    snapshot: () => c("snapshot"),
  };
  const agent = (slot: string, gen: number) => ({
    init: (input: unknown) => c("agentInit", slot, gen, input),
    setRelay: (g: number, name: string, token: string) => c("agentSetRelay", slot, gen, g, name, token),
    appendStep: (g: number, step: unknown) => c("agentAppendStep", slot, gen, g, step),
    checkpoint: (g: number, fn: string, code: string) => c("agentCheckpoint", slot, gen, g, fn, code),
    close: (g: number, reason: string) => c("agentClose", slot, gen, g, reason),
    handoff: () => c("agentHandoff", slot, gen),
    state: () => c("agentState", slot, gen),
  });
  return {
    fleet,
    agent,
    cases: stores.cases,
    chunks: stores.chunks,
    ledger: stores.ledger,
    swarm: () => {
      throw new Error("fleet mode: no SwarmShard per team");
    },
  } as unknown as RunActors;
}

export interface TeamScope {
  team: number;
  apt: number;
  fleetRunId: RunId;
  libraryId: string;
}

const g = (s: TeamScope, slot: number | undefined) => (slot === undefined ? undefined : toGlobal(slot, s.team, s.apt));

/** Team event -> fleet event (runId = fleet, slots = global agent index). null = not forwarded. */
export function translate(ev: DashboardEvent, s: TeamScope): DashboardEvent | null {
  const base = { ...ev, runId: s.fleetRunId } as DashboardEvent;
  switch (ev.type) {
    case "agent.status":
      return { ...ev, runId: s.fleetRunId, slot: g(s, ev.slot)!, ...(ev.agent ? { agent: { ...ev.agent, slot: g(s, ev.agent.slot)! } } : {}) };
    case "relay.message":
      return { ...ev, runId: s.fleetRunId, item: { ...ev.item, metadata: { ...ev.item.metadata, runId: s.fleetRunId, ...(ev.item.metadata.slot !== undefined ? { slot: g(s, ev.item.metadata.slot) } : {}) } } };
    case "case.created":
      return { ...ev, runId: s.fleetRunId, case: { ...ev.case, runId: s.fleetRunId, libraryId: s.libraryId, slot: g(s, ev.case.slot)! } };
    case "case.reply":
      return { ...ev, runId: s.fleetRunId, reply: { ...ev.reply, slot: g(s, ev.reply.slot)! } };
    case "recovery":
      return { ...ev, runId: s.fleetRunId, ...(ev.slot !== undefined ? { slot: g(s, ev.slot) } : {}) };
    case "context.cleansed":
      return { ...ev, runId: s.fleetRunId, slot: g(s, ev.slot)! };
    case "ledger.totals":
    case "roster":
    case "run.status":
    case "jev.status":
    case "swarm.stats":
      return null; // team-level aggregates: the fleet emits its own
    default:
      return base;
  }
}

/**
 * EventBus-compatible object handed to a team's RunContext. Keeps a small ring buffer (faults.ts reads
 * replay(0) for the slot's last status). lastSeq reserves a seq on the FleetBus: worker.ts uses
 * `ctx.bus.lastSeq + 1` as the feed seq of a blocked F4 item, which must not collide with bus seqs.
 */
export class TeamEventBus {
  private seq = 0;
  private readonly buf: SequencedEvent[] = [];
  constructor(
    private readonly scope: TeamScope,
    private readonly sink: (team: number, fleetEv: DashboardEvent, raw: DashboardEvent) => void,
    private readonly reserveSeq: () => number,
    private readonly capacity = 100,
  ) {}
  get lastSeq(): number {
    return this.reserveSeq() - 1;
  }
  publish(ev: DashboardEvent): SequencedEvent {
    const out = { ...ev, seq: ++this.seq } as SequencedEvent;
    this.buf.push(out);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    const t = translate(ev, this.scope);
    if (t) this.sink(this.scope.team, t, ev);
    return out;
  }
  subscribe(_cb: (ev: SequencedEvent) => void): () => void {
    return () => {};
  }
  replay(afterSeq = 0): SequencedEvent[] {
    return this.buf.filter((e) => e.seq > afterSeq);
  }
  hasGap(): boolean {
    return false;
  }
}
