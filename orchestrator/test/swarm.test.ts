// Swarm engine unit tests. All shards here are MOCK (in-memory); numbers are not measured claims.
import { describe, expect, test } from "bun:test";
import { mockShardFactory, MockSwarmShard } from "../src/swarm/mock-shard.ts";
import { runSwarm, isRetryable } from "../src/swarm/engine.ts";
import { DEFAULT_RATES, newAgent, tickAgent } from "../src/swarm/sim.ts";
import { rand } from "../src/swarm/rng.ts";
import type { SwarmStats } from "../src/contract.ts";

describe("rng + state machine", () => {
  test("rand is deterministic and in [0,1)", () => {
    expect(rand(1, 2, 3)).toBe(rand(1, 2, 3));
    expect(rand(1, 2, 3)).not.toBe(rand(1, 2, 4));
    for (let i = 0; i < 1000; i++) {
      const r = rand(9, i, i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  test("same seed -> same change sequence; transitions follow the machine", () => {
    const run = () => {
      const a = newAgent("s", 5);
      return Array.from({ length: 200 }, (_, t) => tickAgent(a, "r", 42, t, { ...DEFAULT_RATES, flag: 0.2 }));
    };
    const x = run();
    expect(run()).toEqual(x);
    const kinds = new Set(x.map((e) => e.transition));
    expect(kinds.has("flag") && kinds.has("retire") && kinds.has("promote")).toBe(true);
    // retire bumps generation for subsequent writes
    const i = x.findIndex((e) => e.transition === "retire");
    expect(x[i + 1]!.change.gen).toBe(x[i]!.change.gen + 1);
    // ids unique
    expect(new Set(x.map((e) => e.change.id)).size).toBe(x.length);
  });
});

describe("MOCK shard semantics", () => {
  test("idempotent ids and stale-gen rejection", async () => {
    const s = new MockSwarmShard("k");
    await s.seed("k", 1);
    const c = { id: "1", agentId: "k.0", gen: 1, kind: "retire" as const };
    expect(await s.applyBatch([c])).toEqual({ handled: 1, rejected: 0, duplicates: 0 });
    expect(await s.applyBatch([c])).toEqual({ handled: 0, rejected: 0, duplicates: 1 });
    expect(await s.applyBatch([{ id: "2", agentId: "k.0", gen: 1, kind: "step" }])).toEqual({ handled: 0, rejected: 1, duplicates: 0 });
    expect((await s.stats()).byStatus).toEqual({ probation: 1 });
  });
});

describe("engine (MOCK shards)", () => {
  test("clean run: shards = agents/100, nothing lost, model matches shard state", async () => {
    const { factory, shards } = mockShardFactory();
    const emitted: SwarmStats[] = [];
    const r = await runSwarm({ runId: "t1", agents: 1000, ticks: 8, factory, mock: true, emitEveryMs: 0, onStats: (s) => emitted.push(s) });
    expect(shards.size).toBe(10);
    expect(r.stats).toMatchObject({ agents: 1000, shards: 10, handled: 8000, lost: 0, measured: false });
    expect(r.detail.rejected).toBe(0);
    expect(r.detail.statusMismatch).toBe(0);
    expect(r.detail.transitions.retire).toBeGreaterThan(0);
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.at(-1)).toEqual(r.stats);
  });

  test("deterministic across runs", async () => {
    const a = await runSwarm({ runId: "d", agents: 300, ticks: 6, factory: mockShardFactory().factory, mock: true });
    const b = await runSwarm({ runId: "d", agents: 300, ticks: 6, factory: mockShardFactory().factory, mock: true });
    expect(a.detail.byStatus).toEqual(b.detail.byStatus!);
    expect(a.detail.transitions).toEqual(b.detail.transitions);
  });

  test("outcome_unknown after apply: retries reuse ids, shard dedupes, nothing lost", async () => {
    const { factory } = mockShardFactory({ failAfter: 0.3, failBefore: 0.2, seed: 3 });
    const r = await runSwarm({ runId: "t2", agents: 500, ticks: 6, factory, mock: true, maxAttempts: 20, retryDelayMs: 0 });
    expect(r.detail.retries).toBeGreaterThan(0);
    expect(r.detail.duplicatesSeen).toBeGreaterThan(0);
    expect(r.stats.handled).toBe(3000);
    expect(r.stats.lost).toBe(0);
    expect(r.detail.statusMismatch).toBe(0);
  });

  test("silent drops are measured as lost from shard stats (acks alone would say 0)", async () => {
    const { factory } = mockShardFactory({ dropSilently: 0.05, seed: 11 });
    const r = await runSwarm({ runId: "t3", agents: 400, ticks: 5, factory, mock: true });
    expect(r.detail.gaveUp).toBe(0);
    expect(r.stats.lost).toBeGreaterThan(0);
    expect(r.stats.handled + r.detail.rejected + r.stats.lost).toBe(r.detail.sent);
  });

  test("exhausted retries: shard stops, lost measured", async () => {
    const { factory } = mockShardFactory({ failBefore: 1 });
    const r = await runSwarm({ runId: "t4", agents: 200, ticks: 3, factory, mock: true, maxAttempts: 2, retryDelayMs: 0 });
    expect(r.stats.handled).toBe(0);
    expect(r.stats.lost).toBe(200);
    expect(r.detail.gaveUp).toBe(200);
  });

  test("10,000 agents over 100 MOCK shards", async () => {
    const r = await runSwarm({ runId: "big", agents: 10_000, ticks: 3, factory: mockShardFactory().factory, mock: true, concurrency: 100 });
    expect(r.stats).toMatchObject({ agents: 10_000, shards: 100, handled: 30_000, lost: 0 });
  });

  test("agentsPerShard override: 10,000 agents over 20 MOCK shards of 500", async () => {
    const { factory, shards } = mockShardFactory();
    const r = await runSwarm({ runId: "wide", agents: 10_000, agentsPerShard: 500, ticks: 2, factory, mock: true });
    expect(shards.size).toBe(20);
    expect(r.stats).toMatchObject({ agents: 10_000, shards: 20, handled: 20_000, lost: 0 });
    expect(r.detail.statusMismatch).toBe(0);
  });

  test("retryable classification", () => {
    expect(isRetryable({ code: "outcome_unknown" })).toBe(true);
    expect(isRetryable({ code: "unavailable" })).toBe(true);
    expect(isRetryable({ code: "actor_error" })).toBe(false);
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
  });
});
