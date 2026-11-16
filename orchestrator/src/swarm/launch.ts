// Starts one swarm-simulator run and streams its stats as `swarm.stats` events (DECISIONS #6, #13).
// Used by RuntimeService.startSwarm (live and mock). One swarm at a time.
import type { ActionResult } from "../contract.ts";
import type { EventBus } from "../events.ts";
import { runSwarm, loadSwarmCaps } from "./engine.ts";
import { mockShardFactory } from "./mock-shard.ts";
import { loadGeneratedActors, realShardFactory } from "./real.ts";

export interface StartSwarmOpts {
  agents: number;
  /** Default 500 for >1,000 agents (20 shards at 10k, measured 0 lost), else caps default. */
  agentsPerShard?: number;
  ticks?: number;
  /** Force the in-memory MOCK shards (labelled; stats carry measured=false). */
  mock?: boolean;
}

let running: Promise<unknown> | null = null;
let counter = 0;

export async function startSwarm(bus: EventBus, opts: StartSwarmOpts): Promise<ActionResult> {
  const caps = loadSwarmCaps();
  const agents = Math.floor(opts.agents);
  if (!Number.isFinite(agents) || agents < 1 || agents > caps.max_agents) {
    return { ok: false, error: "unsupported", detail: `agents must be 1..${caps.max_agents}` };
  }
  if (running) return { ok: false, error: "unsupported", detail: "a swarm run is already in progress" };

  const actors = opts.mock ? null : await loadGeneratedActors().catch(() => null);
  const mock = !actors;
  const factory = actors ? realShardFactory(actors) : mockShardFactory().factory;
  const runId = `swarm${++counter}-${agents}`;
  const agentsPerShard = opts.agentsPerShard ?? (agents > 1000 ? 500 : caps.agents_per_shard);

  running = runSwarm({
    runId,
    agents,
    factory,
    mock,
    agentsPerShard,
    ticks: opts.ticks,
    onStats: (stats) => bus.publish({ type: "swarm.stats", runId, ts: Date.now(), stats, ...(mock ? { mock: true as const } : {}) }),
    log: (line) => console.log(mock ? `[swarm MOCK] ${line}` : `[swarm] ${line}`),
  })
    .catch((err) => console.error(`[swarm] ${runId} failed:`, err))
    .finally(() => {
      running = null;
    });

  return { ok: true, detail: `${mock ? "MOCK " : ""}swarm ${runId}: ${agents} agents, ${Math.ceil(agents / agentsPerShard)} shards` };
}
