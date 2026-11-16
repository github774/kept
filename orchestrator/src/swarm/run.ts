// CLI: bun src/swarm/run.ts [--mock] [--steps 100,1000] [--ticks 10] [--agents-per-shard 100] [--client /abs/generated/index.js]
// Real mode needs a running durable-actors server (DURABLE_ACTORS_CONTROL_PLANE_URL) and a generated client.
import { loadGeneratedActors, realShardFactory } from "./real.ts";
import { mockShardFactory } from "./mock-shard.ts";
import { runScaleSteps } from "./engine.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mock = args.includes("--mock");
const steps = (flag("--steps") ?? "100,1000").split(",").map(Number);
const ticks = Number(flag("--ticks") ?? 10);
const concurrency = Number(flag("--concurrency") ?? 16);
const perShardFlag = flag("--agents-per-shard");
const agentsPerShard = perShardFlag === undefined ? undefined : Number(perShardFlag);
if (agentsPerShard !== undefined && !(Number.isInteger(agentsPerShard) && agentsPerShard > 0)) {
  console.error(`[swarm] --agents-per-shard must be a positive integer, got ${perShardFlag}`);
  process.exit(2);
}
const client = flag("--client");

let factory;
if (mock) factory = mockShardFactory().factory;
else {
  const actors = await loadGeneratedActors(client ? [client] : []);
  if (!actors) {
    console.error("[swarm] no generated client with SwarmShard found; run `bunx durable-actors generate` or pass --mock");
    process.exit(2);
  }
  factory = realShardFactory(actors);
}

const results = await runScaleSteps({
  runIdPrefix: `${mock ? "mock" : "real"}-${Date.now()}`,
  steps,
  ticks,
  concurrency,
  agentsPerShard,
  mock,
  factory,
  log: (l) => console.log(l),
});
console.log(JSON.stringify(results.map((r) => ({ ...r.stats, mock, detail: { ...r.detail, byStatus: r.detail.byStatus } })), null, 1));
process.exit(0);
