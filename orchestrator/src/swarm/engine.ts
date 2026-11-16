// Swarm simulator engine (stretch, DECISIONS #6): N simulated agents spread over ~N/100 SwarmShard
// actors. Each tick every agent emits one change; changes are batched per shard and sent with
// SwarmShard.applyBatch. Ids are deterministic, so a retry after outcome_unknown resends the same ids
// and the shard dedupes. Lost is measured by reading shard stats after the run, never assumed.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SwarmStats } from "../contract.ts";
import { DEFAULT_RATES, newAgent, tickAgent, type SimAgent, type SimRates, type Transition } from "./sim.ts";
import type { ShardClient, ShardFactory, ShardStats, SwarmChange } from "./types.ts";

export type { SwarmStats };

export interface SwarmRunOptions {
  runId: string;
  agents: number;
  factory: ShardFactory;
  /** True when `factory` is a MOCK; stats are then emitted with measured=false and logs say MOCK. */
  mock: boolean;
  agentsPerShard?: number; // default 100 (DECISIONS #6)
  ticks?: number; // default 10
  seed?: number; // default 1
  /** Max shards with an applyBatch in flight at once. */
  concurrency?: number;
  /** Attempts per batch (first try + retries) before giving up; same ids every time. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Min ms between live stats emissions; the final emission always fires. */
  emitEveryMs?: number;
  rates?: Partial<SimRates>;
  onStats?: (stats: SwarmStats, detail: SwarmDetail) => void;
  log?: (line: string) => void;
}

export interface SwarmDetail {
  runId: string;
  phase: "running" | "final";
  mock: boolean;
  tick: number;
  ticks: number;
  sent: number; // unique change ids sent (not counting retries)
  acked: number; // unique change ids whose batch was acknowledged
  retries: number; // batch re-sends after outcome_unknown
  gaveUp: number; // changes in batches that exhausted retries
  rejected: number; // measured from shard stats (final) or acks (running)
  duplicatesSeen: number; // shard-side duplicate count (retries that had already landed)
  transitions: Record<Transition, number>;
  elapsedMs: number;
  /** final only: shards whose stats could not be read (their sent changes are counted as lost). */
  unverifiedShards?: number;
  /** final only: agents whose shard-side status/gen disagrees with the engine model. */
  statusMismatch?: number;
  byStatus?: Record<string, number>;
}

export interface SwarmRunResult {
  stats: SwarmStats;
  detail: SwarmDetail;
}

const SWARM_CAPS_DEFAULTS = { agents_per_shard: 100, max_agents: 10_000, ticks: 10, concurrency: 16, max_attempts: 5 };

/** Optional `swarm` block in config/caps.json (BUILD_SPEC rule 10); falls back to defaults above. */
export function loadSwarmCaps(): typeof SWARM_CAPS_DEFAULTS & { probation_verified_steps: number } {
  const dir = join(resolve(import.meta.dir, "..", "..", ".."), "config");
  const read = (f: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const caps = read("caps.json");
  const swarm = (typeof caps.swarm === "object" && caps.swarm ? caps.swarm : {}) as Partial<typeof SWARM_CAPS_DEFAULTS>;
  const pvs = read("thresholds.json").probation_verified_steps;
  return { ...SWARM_CAPS_DEFAULTS, ...swarm, probation_verified_steps: typeof pvs === "number" ? pvs : DEFAULT_RATES.probationSteps };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** outcome_unknown / unavailable / transport errors are retried with the same ids; others are not. */
export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return true; // network/protocol failure: outcome unknown
  return code === "outcome_unknown" || code === "unavailable";
}

export const shardKey = (runId: string, n: number) => `swarm.${runId}.${n}`;

async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number, onRetry: () => void): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === attempts - 1) break;
      onRetry();
      await sleep(delayMs * (i + 1));
    }
  }
  throw last;
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

interface ShardRun {
  n: number;
  key: string;
  client: ShardClient;
  agents: SimAgent[];
  baseline: { handled: number; rejected: number } | null;
  sent: number;
  acked: number;
  ackHandled: number;
  ackRejected: number;
  gaveUp: number;
  dead: boolean; // a batch exhausted retries; later ticks would build on unknown state, so stop
}

export async function runSwarm(opts: SwarmRunOptions): Promise<SwarmRunResult> {
  const caps = loadSwarmCaps();
  const agentsPerShard = opts.agentsPerShard ?? caps.agents_per_shard;
  if (opts.agents > caps.max_agents) throw new Error(`swarm: ${opts.agents} agents exceeds cap ${caps.max_agents}`);
  const ticks = opts.ticks ?? caps.ticks;
  const seed = opts.seed ?? 1;
  const concurrency = opts.concurrency ?? caps.concurrency;
  const maxAttempts = opts.maxAttempts ?? caps.max_attempts;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  const emitEveryMs = opts.emitEveryMs ?? 250;
  const rates: SimRates = { ...DEFAULT_RATES, probationSteps: caps.probation_verified_steps, ...opts.rates };
  const tag = opts.mock ? "[swarm MOCK]" : "[swarm]";
  const log = (l: string) => opts.log?.(`${tag} ${l}`);

  const shardCount = Math.max(1, Math.ceil(opts.agents / agentsPerShard));
  const shards: ShardRun[] = [];
  for (let n = 0; n < shardCount; n++) {
    const key = shardKey(opts.runId, n);
    const lo = n * agentsPerShard;
    const hi = Math.min(opts.agents, lo + agentsPerShard);
    const agents: SimAgent[] = [];
    for (let i = lo; i < hi; i++) agents.push(newAgent(key, i - lo));
    // Global index for randomness so a shard's agents don't all share a sequence.
    agents.forEach((a, j) => (a.index = lo + j));
    shards.push({ n, key, client: opts.factory(key), agents, baseline: null, sent: 0, acked: 0, ackHandled: 0, ackRejected: 0, gaveUp: 0, dead: false });
  }
  log(`run ${opts.runId}: ${opts.agents} agents over ${shardCount} shards, ${ticks} ticks`);

  const transitions: Record<Transition, number> = { step: 0, flag: 0, clear: 0, retire: 0, promote: 0 };
  let retries = 0;
  let duplicatesSeen = 0;
  let tickNow = 0;
  const t0 = performance.now();
  let lastEmit = 0;

  const liveDetail = (phase: "running" | "final"): SwarmDetail => ({
    runId: opts.runId,
    phase,
    mock: opts.mock,
    tick: tickNow,
    ticks,
    sent: shards.reduce((s, x) => s + x.sent, 0),
    acked: shards.reduce((s, x) => s + x.acked, 0),
    retries,
    gaveUp: shards.reduce((s, x) => s + x.gaveUp, 0),
    rejected: shards.reduce((s, x) => s + x.ackRejected, 0),
    duplicatesSeen,
    transitions: { ...transitions },
    elapsedMs: Math.round(performance.now() - t0),
  });
  const emitLive = (force = false) => {
    if (!opts.onStats) return;
    const now = performance.now();
    if (!force && now - lastEmit < emitEveryMs) return;
    lastEmit = now;
    const d = liveDetail("running");
    const handled = shards.reduce((s, x) => s + x.ackHandled, 0);
    // While running, "lost" = changes whose batch gave up (unconfirmed until final reconciliation).
    opts.onStats(
      { agents: opts.agents, shards: shardCount, handled, lost: d.gaveUp, ratePerSec: rate(handled, d.elapsedMs), measured: !opts.mock },
      d,
    );
  };

  // Seed agents and read baseline counters (shards may be reused across runs with the same key).
  await pool(shards, concurrency, async (s) => {
    try {
      const prefix = s.key;
      await withRetry(() => s.client.seed(prefix, s.agents.length), maxAttempts, retryDelayMs, () => retries++);
      const st = await withRetry(() => s.client.stats(), maxAttempts, retryDelayMs, () => retries++);
      s.baseline = { handled: st.handled, rejected: st.rejected };
    } catch (err) {
      s.dead = true;
      log(`shard ${s.key} seed failed: ${(err as Error).message}`);
    }
  });

  for (let tick = 0; tick < ticks; tick++) {
    tickNow = tick;
    await pool(
      shards.filter((s) => !s.dead),
      concurrency,
      async (s) => {
        const batch: SwarmChange[] = [];
        for (const a of s.agents) {
          const { change, transition } = tickAgent(a, opts.runId, seed, tick, rates);
          batch.push(change);
          transitions[transition]++;
        }
        s.sent += batch.length;
        try {
          const res = await withRetry(() => s.client.applyBatch(batch), maxAttempts, retryDelayMs, () => retries++);
          s.acked += batch.length;
          s.ackHandled += res.handled;
          s.ackRejected += res.rejected;
          duplicatesSeen += res.duplicates;
        } catch (err) {
          s.gaveUp += batch.length;
          s.dead = true;
          log(`shard ${s.key} batch tick ${tick} gave up after ${maxAttempts} attempts: ${(err as Error).message}`);
        }
        emitLive();
      },
    );
  }
  const sendMs = performance.now() - t0;

  // Final reconciliation: lost = sent ids not reflected in the shard's own counters.
  let handled = 0;
  let lost = 0;
  let rejected = 0;
  let unverified = 0;
  let statusMismatch = 0;
  const byStatus: Record<string, number> = {};
  await pool(shards, concurrency, async (s) => {
    let st: ShardStats;
    try {
      st = await withRetry(() => s.client.stats(), maxAttempts, retryDelayMs, () => retries++);
    } catch {
      unverified++;
      lost += s.sent;
      return;
    }
    const base = s.baseline ?? { handled: 0, rejected: 0 };
    const dh = st.handled - base.handled;
    const dr = st.rejected - base.rejected;
    handled += dh;
    rejected += dr;
    lost += Math.max(0, s.sent - (dh + dr));
    for (const [k, v] of Object.entries(st.byStatus)) byStatus[k] = (byStatus[k] ?? 0) + v;
    const expected: Record<string, number> = {};
    for (const a of s.agents) expected[a.status] = (expected[a.status] ?? 0) + 1;
    for (const k of new Set([...Object.keys(expected), ...Object.keys(st.byStatus)]))
      statusMismatch += Math.max(0, (expected[k] ?? 0) - (st.byStatus[k] ?? 0));
  });

  tickNow = ticks;
  const detail: SwarmDetail = {
    ...liveDetail("final"),
    rejected,
    elapsedMs: Math.round(sendMs),
    unverifiedShards: unverified,
    statusMismatch,
    byStatus,
  };
  const stats: SwarmStats = { agents: opts.agents, shards: shardCount, handled, lost, ratePerSec: rate(handled, sendMs), measured: !opts.mock };
  log(
    `final ${opts.runId}: handled=${handled} lost=${lost} rejected=${rejected} rate=${stats.ratePerSec}/s sent=${detail.sent} retries=${retries} dupes=${duplicatesSeen} mismatch=${statusMismatch} unverified=${unverified}`,
  );
  opts.onStats?.(stats, detail);
  return { stats, detail };
}

function rate(n: number, ms: number): number {
  return ms > 0 ? Math.round((n / ms) * 1000 * 10) / 10 : 0;
}

/** Scale steps 100 -> 1,000 -> 10,000 (each its own runId so shard counters start clean). */
export async function runScaleSteps(
  base: Omit<SwarmRunOptions, "agents" | "runId"> & { runIdPrefix: string; steps?: number[] },
): Promise<SwarmRunResult[]> {
  const out: SwarmRunResult[] = [];
  for (const agents of base.steps ?? [100, 1_000, 10_000]) {
    out.push(await runSwarm({ ...base, agents, runId: `${base.runIdPrefix}-${agents}` }));
  }
  return out;
}
