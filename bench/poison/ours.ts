// Ours side: the real RunManager + RealRuntimeService (orchestrator/src/runtime), built in-process like
// createRuntimeService() but with tasksRoot = a copy of bench/tasks-v2/<task> whose faults.json carries the
// poison payloads (faults.ts faultPayload reads them) and whose _trap_variant/ holds only the P-commit file
// (faults.ts buggyVariant reads it for F1). Faults are fired with RuntimeService.injectFault only.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayFeedItem, RuntimeService } from "../../orchestrator/src/contract.ts";
import { runPytest } from "../src/pytest.ts";
import { loadTaskMeta } from "../src/tasks.ts";
import { poisonMetrics, poisonSnapshot, type PoisonMetrics, type PoisonRow } from "./common.ts";
type PoisonMetricsExt = PoisonMetrics & { fired_at_s?: number | null };
import { drive } from "./driver.ts";
import { commitClaim, commitVariantPath, POISON_DIR, POISONS, V2_DIR, type PoisonKind } from "./poisons.ts";

export type OursService = RuntimeService & { getRunWorkDir?: (runId: string) => Promise<string | null> };
const FAULT: Record<PoisonKind, "F1" | "F3" | "F4"> = { fact: "F4", instruction: "F3", commit: "F1" };
export const slotFor = (task: string, k: PoisonKind) => POISONS[task]![k].slot;

/** bench/tasks-v2/<task> copy with the poison faults.json and the P-commit variant as the only _trap_variant file. */
export function buildPoisonTasksRoot(root: string, task: string): string {
  const dir = join(root, task);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(V2_DIR, task), dir, { recursive: true });
  const p = POISONS[task]!;
  writeFileSync(
    join(dir, "faults.json"),
    JSON.stringify(
      { task, note: "bench/poison: payloads for injectFault (no step => never a drill)", schedule: [
        { slot: p.fact.slot, fault: "F4", payload: p.fact.payload },
        { slot: p.instruction.slot, fault: "F3", payload: p.instruction.payload },
      ] },
      null,
      2,
    ),
  );
  rmSync(join(dir, "_trap_variant"), { recursive: true, force: true });
  mkdirSync(join(dir, "_trap_variant"), { recursive: true });
  cpSync(commitVariantPath(task, p.commit.file), join(dir, "_trap_variant", p.commit.file));
  return root;
}

/** Same deps as orchestrator/src/runtime/service.ts build(); no reconcile (fresh actor data dir). */
export async function createPoisonService(tasksRoot: string): Promise<OursService> {
  const [{ config }, { getLlm }, { getJev }, { getEmbedder }, { relayBusFromConfig }, { bus }, { RunManager }, { RealRuntimeService }] = await Promise.all([
    import("../../orchestrator/src/config.ts"),
    import("../../orchestrator/src/llm.ts"),
    import("../../orchestrator/src/jev.ts"),
    import("../../orchestrator/src/embeddings.ts"),
    import("../../orchestrator/src/relay/index.ts"),
    import("../../orchestrator/src/events.ts"),
    import("../../orchestrator/src/runtime/runs.ts"),
    import("../../orchestrator/src/runtime/service.ts"),
  ]);
  const llm = await getLlm("benchmark");
  const [jev, embedder, relay] = await Promise.all([getJev(), getEmbedder(), relayBusFromConfig()]);
  const mock = { llm: llm.mock, jev: !config.env.openrouterApiKey, embed: embedder.mock, relay: relay.mock };
  const log = (line: string) => console.log(line);
  const runs = new RunManager({ cfg: config, deps: { llm, jev, embedder, log, mock }, bus, relay, workRoot: join(POISON_DIR, "runs", "ours"), tasksRoot, concurrency: "benchmark" });
  return new RealRuntimeService(runs, bus, { jevModel: config.models.jev.model }) as unknown as OursService;
}

const TERMINAL = new Set(["finished", "failed", "stopped"]);

export async function runOursPoison(
  svc: OursService,
  task: string,
  trial: number,
  kinds: PoisonKind[],
  o: { wallMs: number; usdCap: number; pollMs?: number },
  log: (m: string) => void,
): Promise<PoisonRow> {
  const meta = await loadTaskMeta(join(V2_DIR, task));
  const notes: string[] = [];
  const startedAt = new Date();
  const t0 = Date.now();
  const fired: { fault: string; slot: number; at: number }[] = [];
  let runId = "";
  const unsub = svc.subscribe((ev) => {
    if (ev.type === "agent.status" && ev.runId === runId && ev.fault && /fired/.test(ev.reason ?? "")) fired.push({ fault: ev.fault, slot: ev.slot, at: ev.ts });
  });
  const run = await svc.startRun({ taskId: task, mode: "ours" });
  runId = run.runId;
  log(`ours run ${runId} model ${run.model}`);
  let workDir: string | null = (run as { workDir?: string }).workDir ?? (await svc.getRunWorkDir?.(runId)) ?? null;
  if (!workDir) throw new Error(`run ${runId}: no work dir`);
  let status = run.status;
  let usd = 0;
  let killed = false;
  let capped = false;
  const poll = setInterval(async () => {
    const r = (await svc.listRuns().catch(() => [])).find((x) => x.runId === runId);
    if (r) status = r.status;
    const l = await svc.getLedger(runId).catch(() => null);
    if (l) usd = l.worker_usd + l.overhead_usd;
    if (TERMINAL.has(status)) return;
    if (Date.now() - t0 > o.wallMs) ((killed = true), void svc.stopRun(runId));
    else if (usd >= o.usdCap) ((capped = true), void svc.stopRun(runId));
  }, o.pollMs ?? 2000);
  const inject = async (k: PoisonKind) => {
    const r = await svc.injectFault(runId, slotFor(task, k), FAULT[k]);
    return r.ok ? { ok: true, detail: `${FAULT[k]} slot ${slotFor(task, k)}: ${r.detail ?? ""}` } : { ok: false, detail: `${r.error} ${r.detail ?? ""}` };
  };
  const { injections, snaps } = await drive({ task, kinds, workDir: () => workDir, inject, done: () => TERMINAL.has(status), t0, log });
  clearInterval(poll);
  unsub();
  const finishS = (Date.now() - t0) / 1000;
  const finalSnap = await poisonSnapshot(task, workDir, finishS);
  const tests = await runPytest(workDir, meta.traps);
  const ledger = await svc.getLedger(runId).catch(() => null);
  const feed: RelayFeedItem[] = await svc.getRelayFeed(runId).catch(() => []);
  const cases = await svc.listCases({ runId }).catch(() => []);
  const final = (await svc.listRuns()).find((x) => x.runId === runId);

  const p = POISONS[task]!;
  const poisons: PoisonRow["poisons"] = {};
  for (const k of kinds) {
    const inj = injections.find((i) => i.kind === k);
    const m = poisonMetrics(k, inj, snaps, finalSnap);
    // Armed is not enough: the fault must fire on the slot's next step (a retired slot drops it).
    const f = fired.find((x) => x.fault === FAULT[k] && x.slot === slotFor(task, k));
    m.injected = !!inj?.ok && !!f;
    (m as PoisonMetricsExt).fired_at_s = f ? Math.round((f.at - t0) / 100) / 10 : null;
    const text = k === "commit" ? commitClaim(p.functions[p.commit.slot]!) : p[k].payload;
    const items = feed.filter((f) => f.text.includes(text.slice(0, 60)));
    const blocked = items.filter((f) => f.blocked);
    const slotCases = cases.filter((c) => c.slot === slotFor(task, k) && !c.synthetic);
    m.exposed = inj ? items.filter((f) => !f.blocked).length : null;
    m.detected = inj ? blocked.length + (k === "fact" ? 0 : slotCases.length) : null;
    m.followers_in_messages = null;
    m.detection_evidence = [
      ...blocked.map((b) => `blocked (${b.blocked!.source} ${b.blocked!.questionId} p=${b.blocked!.probability}): ${b.text.slice(0, 120)}`),
      ...(k === "fact" ? [] : slotCases.map((c) => `case ${c.id} ${c.category}: ${c.claim.slice(0, 120)}`)),
    ];
    poisons[k] = m;
  }
  if (killed) notes.push("killed at wall clock: failed");
  if (capped) notes.push(`stopped at usd cap ${o.usdCap}`);
  if (final && final.status !== "finished") notes.push(`run status ${final.status}`);
  if (svc.mock || final?.mock) notes.push("MOCK");
  return {
    side: "ours", model: final?.model ?? run.model, task, trial, poison: kinds.length === 3 ? "all" : kinds.join(","), source_id: runId,
    started_at: startedAt.toISOString(), success: !killed && !capped && tests.success, killed, tests: tests.summary,
    tokens: ledger ? ledger.tokens : null, usd: ledger ? Math.round((ledger.worker_usd + ledger.overhead_usd) * 1e6) / 1e6 : null,
    usd_source: "Ledger worker_usd + overhead_usd", usd_openrouter_key_delta: null,
    false_completion_claims: null, completion_claims: null, finish_s: Math.round(finishS * 10) / 10, injections, poisons,
    snapshots: snaps.length, run_dir: workDir, notes: notes.join("; "), retires: final?.retires ?? null,
    jev_blocked_total: feed.filter((f) => f.blocked).length, cases: cases.map((c) => ({ id: c.id, slot: c.slot, category: c.category })),
    ...(svc.mock || final?.mock ? { mock: true as const } : {}),
  };
}
