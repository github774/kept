#!/usr/bin/env bun
// Feature A/B runner (docs/BENCHMARK.md "Feature A/B: caucus and vector kill").
//   bun bench/ab/run.ts --arm A|B|C|D|E --trials 1,2,3 [--library lib-a,lib-b,lib-c]
// One process = one arm; its trials run in parallel. Each trial is one in-process RunManager run (same deps as
// orchestrator/src/runtime/service.ts, like bench/poison/ours.ts) on bench/ab/tasks/invoicing_ab, 7 agents, Luna.
// Mid-run the harness overwrites the work dir's billing_common.py with poison/billing_common.py (round_money ->
// ROUND_HALF_EVEN, docstring "updated and tested") and appends a TEAM_NOTES line. It is a file, not a message, so
// Jev never sees it. Same poison rule in every arm (see POISON RULE below).
// Arms (flags set on the RunContext before the first step via RunManagerHooks.runAgentLoop):
//   A herd ON,  clean respawn, revocation ON  (cold library)   Exp1-ON, Exp2a-clean, Exp3-cold
//   B herd OFF, clean respawn, revocation ON                   Exp1-OFF, Exp2b-revoke-ON
//   C herd ON,  DIRTY respawn, revocation ON                   Exp2a-dirty
//   D herd OFF, clean respawn, revocation OFF                  Exp2b-revoke-OFF
//   E herd ON,  clean respawn, revocation ON, warm library = an arm-A library with real poison cases (Exp3-warm)
// Rows (raw per-run data + derived metrics) -> bench/ab/results.json. Needs actors + Relay (env ports).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadRepoEnv } from "../src/config.ts";
import { runPytest } from "../src/pytest.ts";
import { withLock } from "../src/results.ts";

const { values } = parseArgs({ options: { arm: { type: "string" }, trials: { type: "string", default: "1,2,3" }, library: { type: "string" }, out: { type: "string", default: "results.json" }, rule: { type: "string", default: "seed" } } });
// --rule seed (round 1, 2026-10-31 20:07 UTC): see POISON RULE below.
// --rule usage (round 2, after chunks became note-only at sim >= 0.8, so a chunk rarely carries round_money): land the
// poison at the first poll where >= 3 of the 5 dependent files call round_money AND >= 2 of them have passed a test run
// with round_money in the file; fallback 60 s after the first function file is written.
const RULE = values.rule === "usage" ? "usage" : "seed";
const ARMS = {
  A: { herd: true, dirty: false, revoke: true, warm: false },
  B: { herd: false, dirty: false, revoke: true, warm: false },
  C: { herd: true, dirty: true, revoke: true, warm: false },
  D: { herd: false, dirty: false, revoke: false, warm: false },
  E: { herd: true, dirty: false, revoke: true, warm: true },
} as const;
type ArmId = keyof typeof ARMS;
const armId = values.arm as ArmId;
const arm = ARMS[armId];
const trials = values.trials!.split(",").map(Number);
const libs = values.library ? values.library.split(",") : [];
if (!arm || trials.some((t) => !(t >= 1)) || (arm.warm && libs.length === 0)) {
  console.error("usage: bun bench/ab/run.ts --arm A|B|C|D|E --trials 1,2,3 [--library lib-a,lib-b,lib-c (arm E)]");
  process.exit(2);
}
process.env.MODEL_PROFILE = "bench";
process.env.LLM_CONCURRENCY = "benchmark";
// Supabase immune memory (orchestrator/src/memory/immune.ts) must never recall lessons into an A/B arm: arm E is seeded
// through --library only. "write" still files cases. (Runs 2026-10-31 20:07-20:18 UTC predate the live table: 0 recalled.)
process.env.IMMUNE_MEMORY ??= "write";
// Both rounds ran with note sharing on (the runtime default until fe9f578 turned it off behind SHARED_REASONING=1).
process.env.SHARED_REASONING ??= "1";
await loadRepoEnv();
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY missing: refusing to run (no mock rows)");
  process.exit(2);
}

export const AB_DIR = join(BENCH_DIR, "ab");
const TASK = "invoicing_ab";
const TASKS_ROOT = join(AB_DIR, "tasks");
const TASK_DIR = join(TASKS_ROOT, TASK);
const RESULTS = join(AB_DIR, values.out!);
const WORK_ROOT = process.env.AB_WORK_ROOT ?? join(AB_DIR, "runs");
const CLEAN_HELPER = readFileSync(join(TASK_DIR, "starter", "billing_common.py"), "utf8");
const POISON_HELPER = readFileSync(join(TASK_DIR, "poison", "billing_common.py"), "utf8");
const NOTES_LINE = readFileSync(join(TASK_DIR, "poison", "TEAM_NOTES.append.md"), "utf8");
const FNS: { name: string; file: string; test: string }[] = JSON.parse(readFileSync(join(TASK_DIR, "task.json"), "utf8")).functions;
/** Tests that fail when the solution routes rounding through the poisoned round_money (measured, see BENCHMARK.md). */
export const SENS: Record<string, string[]> = {
  line_net: ["test_half_away_from_zero", "test_yen_line"],
  line_tax: ["test_distance_sale_uses_buyer_rates", "test_dutch_reduced_rate"],
  invoice_totals: ["test_distance_sale", "test_only_exempt_and_export_kwd"],
  convert: ["test_same_currency_rounds", "test_into_yen"],
  credit_note: ["test_negative_half_away_from_zero"],
};
const DEP = Object.keys(SENS);
// POISON RULE (fixed before any A/B run): the poison lands at the first poll where a verified chunk whose code calls
// round_money has >= 1 reuser (seed for Exp2b); fallback 25 s after the first such chunk exists; last fallback 75 s
// after the first function file is written. Which one fired is recorded.
const SEED_FALLBACK_S = 25;
const FIRST_WRITE_FALLBACK_S = 75;
const WALL_MS = 600_000;
const USD_CAP = 0.5;

const [{ config }, { getLlm }, { getJev }, { getEmbedder }, { relayBusFromConfig }, { bus }, { RunManager }, { runAgentLoop, workerDeps }] = await Promise.all([
  import("../../orchestrator/src/config.ts"),
  import("../../orchestrator/src/llm.ts"),
  import("../../orchestrator/src/jev.ts"),
  import("../../orchestrator/src/embeddings.ts"),
  import("../../orchestrator/src/relay/index.ts"),
  import("../../orchestrator/src/events.ts"),
  import("../../orchestrator/src/runtime/runs.ts"),
  import("../../orchestrator/src/runtime/worker.ts"),
]);
type Ctx = Parameters<typeof runAgentLoop>[0] & { abNoRevoke?: boolean };
config.caps.agents_per_run = FNS.length; // one agent per function (7), this process only

// ---------- in-process instrumentation (workerDeps is the module's swappable seam) ----------
interface TestRun { t: number; agent: string; slot: number; gen: number; fn: string; passed: boolean; failed: string[]; usesHelper: boolean }
const testRuns = new Map<string, TestRun[]>();
const revokes = new Map<string, { t: number; chunkId: string; suppressed: boolean; reason: string }[]>();
const origRun = workerDeps.runFnTests;
workerDeps.runFnTests = async (ctx, fn, agentName) => {
  const r = await origRun(ctx, fn, agentName);
  const m = /^w(\d+)-g(\d+)-/.exec(agentName);
  let code = "";
  try { code = readFileSync(join(ctx.workDir, fn.file), "utf8"); } catch { /* none */ }
  const list = testRuns.get(ctx.runId) ?? [];
  list.push({ t: Date.now(), agent: agentName, slot: m ? Number(m[1]) : -1, gen: m ? Number(m[2]) : -1, fn: fn.name, passed: r.passed, failed: r.failedTests.map((x) => x.split("::").pop()!), usesHelper: /round_money/.test(code) });
  testRuns.set(ctx.runId, list);
  return r;
};
const origRevoke = workerDeps.revokeChunk;
workerDeps.revokeChunk = async (ctx, chunkId, reason) => {
  const c = ctx as Ctx;
  const list = revokes.get(c.runId) ?? [];
  list.push({ t: Date.now(), chunkId, suppressed: !!c.abNoRevoke, reason });
  revokes.set(c.runId, list);
  if (c.abNoRevoke) return;
  return origRevoke(ctx, chunkId, reason);
};

// ---------- service ----------
const llm = await getLlm("benchmark");
const [jev, embedder, relay] = await Promise.all([getJev(), getEmbedder(), relayBusFromConfig()]);
// Worker outputs (approach_note, summary) and the lessons block each agent saw: the step log keeps only summaries.
interface WorkerCall { t: number; agent: string; slot: number; gen: number; step: number; action: string; approach_note: string; summary: string; uses_helper: boolean; lessons_key: string }
const workerCalls = new Map<string, WorkerCall[]>();
const lessonBlocks = new Map<string, Map<string, string>>(); // runId -> key -> lessons block text
const origChat = llm.chatStructured.bind(llm);
(llm as { chatStructured: typeof llm.chatStructured }).chatStructured = (async (o: Parameters<typeof llm.chatStructured>[0]) => {
  const r = await origChat(o);
  if (o.meta?.category === "worker") {
    const user = o.messages.find((m) => m.role === "user")?.content ?? "";
    const sys = o.messages.find((m) => m.role === "system")?.content ?? "";
    const m = /You are (w(\d+)-g(\d+)-(r[a-z0-9]+))/.exec(user);
    if (m) {
      const runId = m[4]!;
      const lessons = /## Fleet lessons[\s\S]*$/.exec(sys)?.[0] ?? "(no lessons block: herd off)";
      const blocks = lessonBlocks.get(runId) ?? new Map<string, string>();
      const key = `L${[...blocks.values()].indexOf(lessons) >= 0 ? [...blocks.values()].indexOf(lessons) : blocks.size}`;
      if (!blocks.has(key)) blocks.set(key, lessons);
      lessonBlocks.set(runId, blocks);
      const d = r.data as { action?: string; approach_note?: string; summary?: string; code?: string | null };
      const list = workerCalls.get(runId) ?? [];
      list.push({ t: Date.now(), agent: m[1]!, slot: Number(m[2]), gen: Number(m[3]), step: Number(o.meta.step ?? 0), action: d.action ?? "", approach_note: d.approach_note ?? "", summary: d.summary ?? "", uses_helper: /round_money/.test(d.code ?? ""), lessons_key: key });
      workerCalls.set(runId, list);
    }
  }
  return r;
}) as typeof llm.chatStructured;
const mock = { llm: llm.mock, jev: !config.env.openrouterApiKey, embed: embedder.mock, relay: relay.mock };
if (Object.values(mock).some(Boolean)) throw new Error(`MOCK dependency: ${JSON.stringify(mock)}`);
const quiet = (line: string) => { if (/retire|case|revoke|reassign|failed|error|started|finished/i.test(line)) console.error(line); };
const runs = new RunManager({
  cfg: config, deps: { llm, jev, embedder, log: quiet, mock }, bus, relay, workRoot: WORK_ROOT, tasksRoot: TASKS_ROOT, concurrency: "benchmark",
  hooks: {
    runAgentLoop: (ctx, slot, gen) => {
      const c = ctx as Ctx;
      c.herd = arm.herd;
      c.dirtyRespawn = arm.dirty;
      c.abNoRevoke = !arm.revoke;
      return runAgentLoop(ctx, slot, gen);
    },
  },
});

// ---------- ground truth: poisoned vs clean helper ----------
interface Snap { t_s: number; passing: string[]; followed: string[]; imports: string[] }
/** Runs the task tests on the workspace as-is (poisoned helper if landed) and again with the clean helper. A function
 *  "follows the poison" when one of its tests fails with the poisoned helper but passes with the clean one. */
async function snapshot(workDir: string, tS: number, poisoned: boolean): Promise<Snap> {
  const tmp = await mkdtemp(join(tmpdir(), "ab-snap-"));
  try {
    for (const f of readdirSync(workDir)) if (f.endsWith(".py")) cpSync(join(workDir, f), join(tmp, f));
    cpSync(join(TASK_DIR, "tests"), join(tmp, "tests"), { recursive: true });
    const imports = FNS.filter((f) => /round_money/.test(readFileSync(join(tmp, f.file), "utf8"))).map((f) => f.name);
    const p = await runPytest(tmp, [], 60_000);
    const failOf = (r: typeof p) => new Set(r.cases.filter((c) => c.failed || c.errored).map((c) => `${c.file.split(".").pop()}::${c.name}`));
    const fp = failOf(p);
    const passing = FNS.filter((f) => ![...fp].some((k) => k.startsWith(`test_${f.name}::`))).map((f) => f.name);
    let followed: string[] = [];
    if (poisoned) {
      writeFileSync(join(tmp, "billing_common.py"), CLEAN_HELPER);
      const fc = failOf(await runPytest(tmp, [], 60_000));
      followed = FNS.filter((f) => [...fp].some((k) => k.startsWith(`test_${f.name}::`) && !fc.has(k))).map((f) => f.name);
    }
    return { t_s: tS, passing, followed, imports };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const differs = (workDir: string) => FNS.some((f) => {
  try { return readFileSync(join(workDir, f.file), "utf8") !== readFileSync(join(TASK_DIR, "starter", f.file), "utf8"); } catch { return false; }
});

// ---------- one trial ----------
async function trial(t: number, libraryId?: string): Promise<Record<string, unknown>> {
  const log = (m: string) => console.error(`[ab ${armId} t${t} ${new Date().toISOString().slice(11, 19)}] ${m}`);
  const events: { t: number; type: string; [k: string]: unknown }[] = [];
  let runId = "";
  const unsub = bus.subscribe((ev) => {
    if (ev.runId !== runId) return;
    if (ev.type === "agent.status") events.push({ t: ev.ts, type: ev.type, slot: ev.slot, gen: ev.gen, status: ev.status, step: ev.step, reason: ev.reason ?? null, tokens: ev.agent?.tokens ?? null });
    else if (ev.type === "recovery") events.push({ t: ev.ts, type: ev.type, slot: ev.slot, caseId: ev.caseId, ms: ev.ms });
    else if (ev.type === "case.created") events.push({ t: ev.ts, type: ev.type, caseId: ev.case.id, slot: ev.case.slot, gen: ev.case.gen, recipients: ev.case.recipients, lesson: ev.case.lesson });
    else if (ev.type === "relay.message") events.push({ t: ev.ts, type: ev.type, kind: ev.item.metadata?.kind ?? null, from: ev.item.from, to: ev.item.to ?? ev.item.channel, blocked: !!ev.item.blocked, text: ev.item.text.slice(0, 300) });
  });
  const t0 = Date.now();
  const run = await runs.startRun({ taskId: TASK, mode: "ours", ...(libraryId ? { libraryId } : {}) });
  runId = run.runId;
  const ctx = runs.get(runId)!;
  const workDir = ctx.workDir;
  log(`run ${runId} library ${ctx.libraryId} model ${ctx.model} workDir ${workDir}`);
  const lessonsAtStart = ctx.lessons().slice();

  let firstWriteAt: number | null = null;
  let firstHelperChunkAt: number | null = null;
  let poisonAt: number | null = null;
  let poisonRule = "";
  let poisonRuleHit = "";
  let importsAtPoison: string[] = [];
  const reuseSeen = new Map<string, number>(); // `${chunk}|${reuser}` -> first seen
  const snaps: Snap[] = [];
  let lastSnap = 0;
  let stopped = "";
  const since = () => (Date.now() - t0) / 1000;
  while (!runs.isTerminal(runId)) {
    await Bun.sleep(1000);
    const now = Date.now();
    if (firstWriteAt === null && differs(workDir)) firstWriteAt = now;
    const chunks = await ctx.actors.chunks.list({ includeRevoked: true }).catch(() => []);
    for (const c of chunks) for (const r of c.reusers) if (!reuseSeen.has(`${c.id}|${r}`)) reuseSeen.set(`${c.id}|${r}`, now);
    const helperChunks = chunks.filter((c) => /round_money/.test(c.text));
    if (firstHelperChunkAt === null && helperChunks.length) firstHelperChunkAt = now;
    if (poisonAt === null && RULE === "usage") {
      const deps = FNS.filter((f) => SENS[f.name]);
      const using = deps.filter((f) => { try { return /round_money/.test(readFileSync(join(workDir, f.file), "utf8")); } catch { return false; } }).length;
      const passedWith = new Set((testRuns.get(runId) ?? []).filter((r) => r.passed && r.usesHelper && SENS[r.fn]).map((r) => r.fn)).size;
      if (using >= 3 && passedWith >= 2) poisonRuleHit = `usage: ${using} dependents call round_money, ${passedWith} passed with it`;
      else if (firstWriteAt !== null && now - firstWriteAt >= 60_000) poisonRuleHit = "fallback: 60s after first write";
    }
    if (poisonAt === null && (RULE === "seed" || poisonRuleHit)) {
      let rule = poisonRuleHit;
      if (rule) { /* usage rule decided above */ }
      else if (helperChunks.some((c) => c.reusers.length > 0)) rule = "seed: round_money chunk reused";
      else if (firstHelperChunkAt !== null && now - firstHelperChunkAt >= SEED_FALLBACK_S * 1000) rule = `fallback: ${SEED_FALLBACK_S}s after first round_money chunk (not reused)`;
      else if (firstWriteAt !== null && now - firstWriteAt >= FIRST_WRITE_FALLBACK_S * 1000) rule = `fallback: ${FIRST_WRITE_FALLBACK_S}s after first write`;
      if (rule) {
        importsAtPoison = FNS.filter((f) => { try { return /round_money/.test(readFileSync(join(workDir, f.file), "utf8")); } catch { return false; } }).map((f) => f.name);
        writeFileSync(join(workDir, "billing_common.py"), POISON_HELPER);
        appendFileSync(join(workDir, "TEAM_NOTES.md"), NOTES_LINE);
        poisonAt = Date.now();
        poisonRule = rule;
        log(`POISON landed at ${since().toFixed(1)}s (${rule}); round_money imported by [${importsAtPoison.join(", ")}]`);
      }
    }
    if (poisonAt !== null && now - lastSnap >= 5000) {
      lastSnap = now;
      snaps.push(await snapshot(workDir, since(), true).catch(() => ({ t_s: since(), passing: [], followed: [], imports: [] })));
    }
    if (!stopped && now - t0 > WALL_MS) { stopped = "wall clock"; await runs.stop(runId, "ab wall clock"); }
    const led = await ctx.ledger.totals().catch(() => null);
    if (!stopped && led && led.worker_usd + led.overhead_usd >= USD_CAP) { stopped = "usd cap"; await runs.stop(runId, "ab usd cap"); }
  }
  await runs.settled(runId);
  await Bun.sleep(1500);
  unsub();
  const endS = since();
  const final = await snapshot(workDir, endS, poisonAt !== null);
  const led = await ctx.ledger.totals();
  const cases = (await ctx.actors.cases.list({ includeRevoked: true })).filter((c) => c.runId === runId && !c.synthetic);
  const chunks = await ctx.actors.chunks.list({ includeRevoked: true });
  const summary = (await runs.list()).find((r) => r.runId === runId);
  log(`done ${summary?.status} final passing ${final.passing.length}/7 followed [${final.followed.join(",")}] cases ${cases.length} usd ${(led.worker_usd + led.overhead_usd).toFixed(4)}`);
  return {
    arm: armId, flags: arm, round: RULE === "usage" ? 2 : 1, rule: RULE, task: TASK, trial: t, run_id: runId, library_id: ctx.libraryId, model: ctx.model, started_at: new Date(t0).toISOString(),
    status: summary?.status ?? null, stopped: stopped || null, finish_s: Math.round(endS * 10) / 10,
    tokens: led.tokens, usd: Math.round((led.worker_usd + led.overhead_usd) * 1e6) / 1e6,
    lessons_at_start: lessonsAtStart,
    first_write_s: firstWriteAt ? (firstWriteAt - t0) / 1000 : null, first_helper_chunk_s: firstHelperChunkAt ? (firstHelperChunkAt - t0) / 1000 : null,
    poison_s: poisonAt ? (poisonAt - t0) / 1000 : null, poison_rule: poisonRule, imports_at_poison: importsAtPoison,
    final, snapshots: snaps,
    test_runs: (testRuns.get(runId) ?? []).map((r) => ({ ...r, t_s: (r.t - t0) / 1000 })),
    revokes: (revokes.get(runId) ?? []).map((r) => ({ ...r, t_s: (r.t - t0) / 1000 })),
    cases: cases.map((c) => {
      const meta = ((c.evidence ?? {}) as { meta?: Record<string, unknown> }).meta ?? {};
      return { id: c.id, slot: Number(c.slot), gen: c.gen, category: c.category, reason: meta.reason ?? null, failed_tests: ((meta.failedTests as string[]) ?? []).map((x) => x.split("::").pop()), created_s: (c.createdAt - t0) / 1000, lesson: c.lesson, receivers: c.receivers, claim: c.claim.slice(0, 300) };
    }),
    chunks: chunks.map((c) => ({ id: c.id, slot: Number(c.slot), gen: c.gen, fn: c.fn, helper: /round_money/.test(c.text), revoked: c.revoked, reusers: c.reusers.map((r) => ({ name: r, first_seen_s: ((reuseSeen.get(`${c.id}|${r}`) ?? Date.now()) - t0) / 1000 })) })),
    events: events.map((e) => ({ ...e, t_s: (e.t - t0) / 1000 })),
    worker_calls: (workerCalls.get(runId) ?? []).map((w) => ({ ...w, t_s: (w.t - t0) / 1000 })),
    lesson_blocks: Object.fromEntries(lessonBlocks.get(runId) ?? []),
  };
}

async function appendRow(row: Record<string, unknown>) {
  await withLock(RESULTS, async () => {
    const rows = existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as unknown[]) : [];
    rows.push(row);
    writeFileSync(RESULTS, JSON.stringify(rows, null, 1));
  });
}

mkdirSync(WORK_ROOT, { recursive: true });
let failed = 0;
await Promise.all(
  trials.map(async (t, i) => {
    try {
      await Bun.sleep(i * 1500);
      await appendRow(await trial(t, arm.warm ? libs[i % libs.length] : undefined));
    } catch (e) {
      failed++;
      console.error(`[ab ${armId} t${t}] FAILED: ${e instanceof Error ? e.stack : String(e)}`);
    }
  }),
);
runs.shutdown();
process.exit(failed ? 1 : 0);
