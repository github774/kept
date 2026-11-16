// Scale probe 4: Durable Actors write throughput for a live fleet, using SwarmShard.applyBatch as
// the proxy for per-agent step rows + status changes.
// Needs a runtime started from a temp copy of actors/ (see docs/SCALE.md), e.g. on :7194:
//   DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:7194 bun scripts/scale-probe/actors-probe.ts <shards> [agents] [steps] [mode]
// mode "tick"   : every tick, one applyBatch per shard holding one step change per agent (batched).
// mode "single" : one applyBatch call per change (no batching), 64 calls in flight.
// Per agent: <steps> step changes + 2 status changes (under_investigation, trusted).
import { actors } from "../../actors/generated/index.js";

const [shardsArg, agentsArg, stepsArg, modeArg] = process.argv.slice(2);
const SHARDS = Number(shardsArg ?? 20);
const AGENTS = Number(agentsArg ?? 1000);
const STEPS = Number(stepsArg ?? 8);
const mode = modeArg ?? "tick";
const run = `probe${Date.now().toString(36)}`;
const per = Math.ceil(AGENTS / SHARDS);
const shard = (s: number) => actors.SwarmShard.get(`swarm.${run}.${s}`);

type Change = { id: string; agentId: string; gen: number; kind: "step" | "status"; status?: "under_investigation" | "trusted" };

let t0 = performance.now();
await Promise.all([...Array(SHARDS).keys()].map((s) => shard(s).seed(`${run}.s${s}`, Math.min(per, AGENTS - s * per))));
const seedS = (performance.now() - t0) / 1000;

// Tick k: step change k for every agent; status changes ride along on ticks 2 and STEPS-1.
const ticks: Change[][][] = []; // [tick][shard] -> changes
for (let k = 0; k < STEPS; k++) {
  const byShard: Change[][] = [...Array(SHARDS)].map(() => []);
  for (let s = 0; s < SHARDS; s++) {
    const n = Math.min(per, AGENTS - s * per);
    for (let i = 0; i < n; i++) {
      const agentId = `${run}.s${s}.${i}`;
      byShard[s]!.push({ id: `${agentId}.step${k}`, agentId, gen: 1, kind: "step" });
      if (k === 2) byShard[s]!.push({ id: `${agentId}.st1`, agentId, gen: 1, kind: "status", status: "under_investigation" });
      if (k === STEPS - 1) byShard[s]!.push({ id: `${agentId}.st2`, agentId, gen: 1, kind: "status", status: "trusted" });
    }
  }
  ticks.push(byShard);
}
const total = ticks.flat(2).length;

const lat: number[] = [];
let handled = 0, errors = 0;
t0 = performance.now();
if (mode === "tick") {
  for (const byShard of ticks) {
    await Promise.all(
      byShard.map(async (chs, s) => {
        const a = performance.now();
        try {
          const r = await shard(s).applyBatch(chs);
          handled += r.handled;
        } catch {
          errors++;
        }
        lat.push(performance.now() - a);
      }),
    );
  }
} else {
  const all = ticks.flatMap((byShard) => byShard.flatMap((chs, s) => chs.map((c) => ({ s, c }))));
  let i = 0;
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (i < all.length) {
        const { s, c } = all[i++]!;
        const a = performance.now();
        try {
          const r = await shard(s).applyBatch([c]);
          handled += r.handled;
        } catch {
          errors++;
        }
        lat.push(performance.now() - a);
      }
    }),
  );
}
const wall = (performance.now() - t0) / 1000;
const stats = await Promise.all([...Array(SHARDS).keys()].map((s) => shard(s).stats()));
const stepsStored = stats.reduce((a, x) => a + x.handled, 0);
lat.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    mode, shards: SHARDS, agents: AGENTS, steps: STEPS, changes: total, seed_s: +seedS.toFixed(1),
    wall_s: +wall.toFixed(2), changes_per_s: Math.round(total / wall), calls: lat.length,
    call_p50_ms: Math.round(lat[Math.floor(lat.length / 2)] ?? 0), call_p95_ms: Math.round(lat[Math.floor(lat.length * 0.95)] ?? 0),
    handled, errors, lost: total - stepsStored,
  }),
);
process.exit(0);
