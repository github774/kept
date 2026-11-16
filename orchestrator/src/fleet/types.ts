// Fleet-scale mode types (DECISIONS #16, docs/FLEET.md).
import type { FaultId, TaskId } from "../contract.ts";
import { ShardCore, MemoryKV, type ShardOp } from "./shard-core.ts";

/** One FleetShard actor (or its in-memory stand-in): every op goes through one RPC method. */
export interface ShardClient {
  call(op: ShardOp, args: unknown[]): Promise<unknown>;
}
export type ShardFactory = (key: string) => ShardClient;

/**
 * In-memory FleetShard (same ShardCore the actor runs). Not a mock of agent work: it is the state store
 * when the FleetShard actor class is not deployed yet. Answers are JSON copies, like an RPC.
 */
export class MemoryFleetShard implements ShardClient {
  readonly core: ShardCore;
  calls = 0;
  constructor(now?: () => number) {
    this.core = new ShardCore(new MemoryKV(), now);
  }
  async call(op: ShardOp, args: unknown[]): Promise<unknown> {
    this.calls++;
    const r = this.core.apply(op, args);
    return r === undefined ? undefined : JSON.parse(JSON.stringify(r));
  }
}
export const memoryShardFactory = (): ShardFactory => {
  const shards = new Map<string, MemoryFleetShard>();
  return (key) => {
    let s = shards.get(key);
    if (!s) shards.set(key, (s = new MemoryFleetShard()));
    return s;
  };
};

export interface FleetLimits {
  /** Global cap on worker + lesson-writer LLM calls in flight (also applied to the shared llm limiter). */
  llm: number;
  /** pytest pool: test runs in flight across the fleet. */
  tests: number;
  /** Jev checks in flight across the fleet. */
  jev: number;
  /**
   * Agent Relay requests in flight. The local Relay engine crashes between 32 and 48-64 concurrent requests
   * (capacity probe), so anything that mirrors fleet traffic to Relay must go through this gate. Fleet
   * agents themselves talk over the in-process FleetBus and make no Relay requests.
   */
  relay: number;
}
export const DEFAULT_LIMITS: FleetLimits = { llm: 64, tests: 16, jev: 32, relay: 24 };

export interface FleetStartOpts {
  /** Total agents; rounded down to a multiple of agentsPerTeam (4 = task functions). */
  agents: number;
  /** Fraction of agents poisoned at poisonAtMs (F1/F3/F4 mix). */
  poisonRate?: number;
  /** Task ids rotated across teams (team i gets taskIds[i % n]). Default: the three v2 tasks. */
  taskIds?: TaskId[];
  /** One CaseLibrary shared by every team. Default lib-<fleetRunId>. */
  libraryId?: string;
  seed?: number;
  /** Agents per FleetShard actor (default 50). */
  agentsPerShard?: number;
  /** Team starts are spread evenly over this window (default 60 s). */
  rampMs?: number;
  /** When the poisoned slice is armed (default 5 s after start). */
  poisonAtMs?: number;
  /** Fault mix, cycled in poison order (default F1, F3, F4). */
  faultMix?: FaultId[];
  /** Fleet-wide USD cap; every loop stops when reached (default 15). */
  maxUsd?: number;
  /** Overrides caps.steps_per_generation for fleet teams. */
  stepsPerGeneration?: number;
  /** Extra wait before every worker step (StartRunOpts.stepDelayMs). */
  stepDelayMs?: number;
  /** Case-thread recipients per case across the fleet (replies are still capped at 3). Default 6. */
  caseRecipients?: number;
  /** Shared verified chunks: per team, or per task across teams (default "task"). */
  chunkScope?: "team" | "task";
  /** Routine agent.status / relay.message sampling rate for the global bus (default 0.02). */
  sampleRate?: number;
  /** fleet.grid + fleet.stats interval (default 1000 ms). */
  tickMs?: number;
  /** Window for FleetStats.trapHitRateRecent (default 25). */
  recentWindow?: number;
  /** Hard wall clock for the whole fleet (default 15 min). */
  wallClockMs?: number;
  /** Wave 2 re-poison probe time (default rampMs + 15 s); 0 disables it. */
  wave2Ms?: number;
}

export interface FleetPoisonPick {
  agent: number;
  fault: FaultId;
}
