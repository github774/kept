// Local mirrors of the SwarmShard actor's RPC shapes (actors/src/actors.ts, owned by the actors agent).
// Kept structural so the generated client (actors.SwarmShard.get(key)) satisfies ShardClient as-is.

export type SwarmAgentStatus = "trusted" | "probation" | "under_investigation";

/** One idempotent change. `id` is the idempotency key: retries resend the same id. */
export interface SwarmChange {
  id: string;
  agentId: string;
  gen: number;
  kind: "step" | "status" | "retire";
  status?: SwarmAgentStatus;
}

export interface ShardBatchResult {
  handled: number;
  rejected: number;
  duplicates: number;
}

/** What SwarmShard.stats() returns (actor-side "SwarmStats"; not the dashboard SwarmStats). */
export interface ShardStats {
  agents: number;
  byStatus: Record<string, number>;
  handled: number;
  rejected: number;
  duplicates: number;
}

/** The SwarmShard methods the engine uses. Real = generated client stub; tests = MockSwarmShard. */
export interface ShardClient {
  seed(prefix: string, count: number): Promise<{ agents: number }>;
  applyBatch(changes: SwarmChange[]): Promise<ShardBatchResult>;
  stats(): Promise<ShardStats>;
}

export type ShardFactory = (key: string) => ShardClient;
