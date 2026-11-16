// Real fleet smoke run: bun --env-file=../.env run src/fleet/smoke.ts [agents=20] [poisonRate=0.15] [maxUsd=0.5]
// MODEL_PROFILE=bench for the demo model. No servers: in-memory FleetShards + in-process FleetBus.
import { resolve } from "node:path";
import { FleetRunner } from "./runner.ts";
import { fleetLlm, loadFleetConfig } from "./pools.ts";

const [agents = "20", rate = "0.15", maxUsd = "0.5"] = process.argv.slice(2);
const { config, REPO_ROOT } = await import("../config.ts");
const { getLlm } = await import("../llm.ts");
const { getJev } = await import("../jev.ts");
const { getEmbedder } = await import("../embeddings.ts");
const baseLlm = await getLlm("demo");
const llm = fleetLlm(baseLlm, loadFleetConfig(resolve(REPO_ROOT, "config")), config.prices, console.log);
const [jev, embedder] = await Promise.all([getJev(), getEmbedder()]);
const mock = { llm: llm.mock, jev: !config.env.openrouterApiKey, embed: embedder.mock, relay: false };
const quiet = new Set(["[relay", "[MOCK"]);
const log = (l: string) => {
  if (process.env.FLEET_VERBOSE || /\[fleet|retire trigger|fired|armed|failed|error/i.test(l)) console.log(l);
  void quiet;
};
const events: { type: string; [k: string]: unknown }[] = [];
const r = new FleetRunner({
  cfg: config,
  deps: { llm, jev, embedder, log, mock },
  out: {
    publish: (ev) => {
      events.push(ev as never);
      if (ev.type === "case.created") console.log(`[case] ${ev.case.id} ${ev.case.category} on ${ev.case.subtask}: ${ev.case.lesson} -> ${ev.case.recipients.length} recipients`);
      if (ev.type === "context.cleansed") console.log(`[cleansed] agent ${ev.slot} g${ev.fromGen}->g${ev.toGen}: ${ev.droppedPromptTokens} -> ${ev.handoffPromptTokens} prompt tokens`);
      if (ev.type === "chunk.revoked") console.log(`[revoked] ${ev.chunkId} notified ${ev.notified.length}`);
      if (ev.type === "relay.message" && ev.item.blocked) console.log(`[blocked] ${ev.item.from}: ${ev.item.text.slice(0, 90)} (${ev.item.blocked.questionId})`);
      if (ev.type === "fleet.stats" && (events.filter((e) => e.type === "fleet.stats").length % 15 === 0)) console.log(`[stats] ${JSON.stringify({ t: Math.round(ev.stats.elapsedMs / 1000), usd: ev.stats.usd, steps: ev.stats.steps, byStatus: ev.stats.byStatus, poison: ev.stats.poison, trapHits: ev.stats.trapHits })}`);
    },
  },
  tasksRoot: resolve(REPO_ROOT, "bench", "tasks-v2"),
  workRoot: resolve(REPO_ROOT, "bench", "runs", "fleet"),
});
console.log(`[smoke] model ${config.models.worker}; mock ${JSON.stringify(mock)}`);
await r.startFleet({ agents: Number(agents), poisonRate: Number(rate), maxUsd: Number(maxUsd), rampMs: 20_000, poisonAtMs: 5_000, stepsPerGeneration: 8, wallClockMs: 8 * 60_000 });
const sum = await r.done;
const grid = events.filter((e) => e.type === "fleet.grid").at(-1) as { grid: { cells: string } } | undefined;
const stats = events.filter((e) => e.type === "fleet.stats").at(-1) as { stats: unknown } | undefined;
console.log(JSON.stringify({ pools: (llm as { counts?: unknown }).counts ?? null, summary: sum, grid: grid?.grid.cells, stats: stats?.stats, possessions: r.agg.possessionList, trapSeries: r.agg.trapSeries, gates: { llm: r.gates.llm.peak, tests: r.gates.tests.peak, jev: r.gates.jev.peak } }, null, 2));
process.exit(0);
