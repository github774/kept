// MOCK smoke check: drains the recording through MockRuntimeService and asserts the demo beats exist.
import { MockRuntimeService } from "./service.ts";
import { EventBus } from "../src/events.ts";
import { buildMockScript } from "./script.ts";

const svc = new MockRuntimeService();
const seen: string[] = [];
const off = svc.subscribe((e) => seen.push(e.type));
svc.drain();
off();
const runs = await svc.listRuns();
const run = runs[0]!;
const roster = await svc.getRoster(run.runId);
const cases = await svc.listCases({ runId: run.runId });
const ledger = await svc.getLedger(run.runId);
const feed = await svc.getRelayFeed(run.runId);
const bench = await svc.getBenchmarkResults();
const must = ["roster", "agent.status", "relay.message", "case.created", "case.reply", "ledger.totals", "jev.status", "recovery", "run.status", "swarm.stats"];
const missing = must.filter((t) => !seen.includes(t));
const allMock = svc.replay(0).every((e) => e.mock === true) && bench.every((r) => r.mock === true);
const bus = new EventBus(3);
for (let i = 0; i < 5; i++) bus.publish({ type: "recovery", runId: "x", ts: i, caseId: "c", ms: i });
const recovery = svc.replay(0).find((e) => e.type === "recovery");
// Prefix invariant: everything before the possession beat is identical for every slot.
const ref = buildMockScript(3);
const prefixSame = [0, 1, 2].every((p) => JSON.stringify(buildMockScript(p).events.slice(0, ref.possessIndex)) === JSON.stringify(ref.events.slice(0, ref.possessIndex)));
// Possess remap: pause at the beat, possess slot 1, the case and respawn land on slot 1.
const svc2 = new MockRuntimeService({ autoPossess: false });
svc2.drain();
const paused = (await svc2.listCases({ runId: run.runId })).length === 0;
const pr = await svc2.possess(run.runId, 1);
const again = await svc2.possess(run.runId, 2);
const cases2 = await svc2.listCases({ runId: run.runId });
const roster2 = await svc2.getRoster(run.runId);
const remap = { paused, ok: pr.ok, again: again.ok ? again.detail : again.error, case: cases2[0]?.id, replies: cases2[0]?.replies?.length, slot1: roster2.find((a) => a.slot === 1)?.name };
await svc2.startRun({ taskId: "invoice_parser", mode: "ours" });
svc2.drain(); // queued slot 2 now plays without pausing
const queuedOk = (await svc2.listCases({ runId: run.runId }))[0]?.id === `${run.runId}.2.g1`;
svc2.stop();
const remapOk = queuedOk && paused && pr.ok && again.ok && /queued/.test(again.detail ?? "") && cases2.length === 1 && cases2[0]!.id === `${run.runId}.1.g1` && roster2.find((a) => a.slot === 1)?.gen === 2;
console.log(JSON.stringify({
  MOCK: true, events: seen.length, missing, allMock, run: run.status, retires: run.retires,
  roster: roster.map((a) => `${a.name}:${a.status}`), case: cases[0]?.id, recipients: cases[0]?.recipients,
  blocked: feed.filter((m) => m.blocked).length, ledger: { worker: ledger?.worker_usd.toFixed(5), overhead: ledger?.overhead_usd.toFixed(5), jev: ledger?.calls.jev, fallback: ledger?.calls.fallback, reuse_est: ledger?.reuse_est_tokens },
  replies: cases[0]?.replies?.length, immunity: run.immunity, repeatFailures: run.repeatFailures, recoveryStages: recovery?.type === "recovery" ? recovery.stages : null, taskId: run.taskId,
  prefixSame, remap,
  bench: bench.length, benchTasks: [...new Set(bench.map((r) => r.task))], replayAfter2: bus.replay(2).map((e) => e.seq), gap: bus.hasGap(0),
}));
if (missing.length || !allMock || cases.length !== 1 || !prefixSame || !remapOk || run.taskId !== "invoice_parser" || !cases[0]?.replies?.length) process.exit(1);
