// MOCK SwarmShard: in-memory twin of actors/src/actors.ts SwarmShard for unit tests only.
// Same semantics (idempotent change ids, stale-gen rejection, retire => gen+1 on probation).
// Optional deterministic fault injection. Never used for numbers shown as measured.
import { rand } from "./rng.ts";
import type { ShardBatchResult, ShardClient, ShardStats, SwarmChange } from "./types.ts";

export const MOCK_LABEL = "MOCK";

export interface MockFaults {
  /** P(call throws outcome_unknown BEFORE applying). */
  failBefore?: number;
  /** P(call applies the batch, then throws outcome_unknown, i.e. the ack is lost). */
  failAfter?: number;
  /** P(each change is acked as handled but silently NOT recorded) — simulates data loss. */
  dropSilently?: number;
  seed?: number;
}

export class MockOutcomeUnknown extends Error {
  readonly code = "outcome_unknown";
  readonly requestId = "MOCK";
  constructor() {
    super("MOCK outcome_unknown");
  }
}

type Row = { gen: number; status: string; steps: number };

export class MockSwarmShard implements ShardClient {
  readonly mock = MOCK_LABEL;
  private agents = new Map<string, Row>();
  private applied = new Map<string, "handled" | "rejected">();
  private counts = { handled: 0, rejected: 0, duplicates: 0 };
  private calls = 0;

  constructor(
    readonly key: string,
    private readonly faults: MockFaults = {},
  ) {}

  async seed(prefix: string, count: number): Promise<{ agents: number }> {
    for (let i = 0; i < count; i++) {
      const id = `${prefix}.${i}`;
      if (!this.agents.has(id)) this.agents.set(id, { gen: 1, status: "trusted", steps: 0 });
    }
    return { agents: this.agents.size };
  }

  async applyBatch(changes: SwarmChange[]): Promise<ShardBatchResult> {
    const call = this.calls++;
    const seed = this.faults.seed ?? 7;
    await Promise.resolve();
    if (rand(seed, call, 0, 1) < (this.faults.failBefore ?? 0)) throw new MockOutcomeUnknown();
    const out = { handled: 0, rejected: 0, duplicates: 0 };
    let dropped = 0;
    changes.forEach((c, i) => {
      if (this.applied.has(c.id)) {
        out.duplicates++;
        return;
      }
      if (rand(seed, call, i + 1, 3) < (this.faults.dropSilently ?? 0)) {
        out.handled++; // lies: acked but never recorded
        dropped++;
        return;
      }
      const a = this.agents.get(c.agentId);
      let ok = !!a && a.gen === c.gen && a.status !== "retired" && a.status !== "failed";
      if (ok && a && c.kind === "step") a.steps += 1;
      else if (ok && a && c.kind === "status" && c.status) a.status = c.status;
      else if (ok && a && c.kind === "retire") {
        a.gen += 1;
        a.status = "probation";
        a.steps = 0;
      } else ok = false;
      this.applied.set(c.id, ok ? "handled" : "rejected");
      if (ok) out.handled++;
      else out.rejected++;
    });
    // Dropped changes are not recorded, so they are not reflected in the shard's counters.
    this.counts = {
      handled: this.counts.handled + out.handled - dropped,
      rejected: this.counts.rejected + out.rejected,
      duplicates: this.counts.duplicates + out.duplicates,
    };
    if (rand(seed, call, 0, 2) < (this.faults.failAfter ?? 0)) throw new MockOutcomeUnknown();
    return out;
  }

  async stats(): Promise<ShardStats> {
    const byStatus: Record<string, number> = {};
    for (const a of this.agents.values()) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    return { agents: this.agents.size, byStatus, ...this.counts };
  }
}

export function mockShardFactory(faults: MockFaults = {}): { factory: (key: string) => MockSwarmShard; shards: Map<string, MockSwarmShard> } {
  const shards = new Map<string, MockSwarmShard>();
  return {
    shards,
    factory: (key) => {
      let s = shards.get(key);
      if (!s) shards.set(key, (s = new MockSwarmShard(key, faults)));
      return s;
    },
  };
}
