// RunManager + RealRuntimeService + reconcile, on labeled MOCKs only (rule 6): an in-memory actor store
// that mirrors actors/src/actors.ts semantics, the in-memory MockRelayBus, scripted worker loops, a fake
// final pytest and a fake socket grant. No servers, no network, no LLM calls.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Caps, Config, Thresholds } from "../src/config.ts";
import type { BenchmarkResultRow, SequencedEvent } from "../src/contract.ts";
import { EventBus } from "../src/events.ts";
import { MockRelayBus, relayNames } from "../src/relay/bus.ts";
import { RunManager, runOfMessage, type RunIndexStub } from "../src/runtime/runs.ts";
import { RealRuntimeService } from "../src/runtime/service.ts";
import type { LoopOutcome, RunActors, RunContext, RuntimeDeps } from "../src/runtime/types.ts";
import type { RunIndexEntry } from "../../actors/src/actors.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const CONFIG = join(REPO, "config");
const caps = JSON.parse(readFileSync(join(CONFIG, "caps.json"), "utf8")) as Caps;
const thresholds = JSON.parse(readFileSync(join(CONFIG, "thresholds.json"), "utf8")) as Thresholds;
const cfg = { caps, thresholds, models: { worker: "MOCK-worker", jev: { model: "MOCK-jev" } } } as unknown as Config;
const tmp = mkdtempSync(join(tmpdir(), "svc-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  return cond();
};

// ---------- MOCK actor store (same rules as actors/src/actors.ts, in memory) ----------

type Slot = { slot: string; gen: number; status: string; possessed: boolean; step: number; relayName: string | null; reason: string | null };
const ACTIVE = ["trusted", "probation", "under_investigation"];

class FakeFleet {
  run: { runId: string; mode: string; status: string; config: Record<string, unknown>; startedAt: number } | null = null;
  slots = new Map<string, Slot>();
  history: { slot: string; gen: number; status: string; reason: string | null; endedAt: number }[] = [];
  async startRun(i: { runId: string; mode: string; config?: Record<string, unknown> }) {
    this.run ??= { runId: i.runId, mode: i.mode, status: "running", config: i.config ?? {}, startedAt: Date.now() };
    return this.run;
  }
  async setRunStatus(status: string) {
    if (!this.run) return { ok: false, reason: "no_run" };
    this.run = { ...this.run, status };
    return { ok: true };
  }
  async addSlot(i: { slot: string; gen?: number; status?: string; relayName?: string }) {
    if (!this.slots.has(i.slot)) this.slots.set(i.slot, { slot: i.slot, gen: i.gen ?? 1, status: i.status ?? "trusted", possessed: false, step: 0, relayName: i.relayName ?? null, reason: null });
    return this.slots.get(i.slot)!;
  }
  async setStatus(slot: string, gen: number, status: string) {
    const s = this.slots.get(slot);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    this.slots.set(slot, { ...s, status });
    return { ok: true, slot: this.slots.get(slot) };
  }
  async setStep(slot: string, gen: number, step: number) {
    const s = this.slots.get(slot);
    if (s && s.gen === gen && step > s.step) this.slots.set(slot, { ...s, step });
    return { ok: true };
  }
  async beginRetire(slot: string, gen: number, reason: string) {
    const s = this.slots.get(slot);
    if (!s) return { ok: false, reason: "not_active" };
    if (s.gen !== gen) return { ok: false, reason: "stale_generation" };
    if (s.status === "retiring") return { ok: false, reason: "already_retiring" };
    this.slots.set(slot, { ...s, status: "retiring", reason });
    return { ok: true };
  }
  async completeRetire(slot: string, gen: number, next?: { relayName?: string }) {
    const s = this.slots.get(slot)!;
    this.history = [...this.history, { slot, gen, status: "retired", reason: s.reason, endedAt: Date.now() }];
    this.slots.set(slot, { ...s, gen: gen + 1, status: "probation", step: 0, possessed: false, reason: null, relayName: next?.relayName ?? null });
    return { ok: true, gen: gen + 1, repeated: false };
  }
  async markPossessed(slot: string) {
    const s = this.slots.get(slot);
    if (!s || !ACTIVE.includes(s.status)) return { ok: false, reason: "not_active" };
    this.slots.set(slot, { ...s, possessed: true });
    return { ok: true, gen: s.gen };
  }
  reassignments: { fn: string; toSlot: string; fromSlot: string; ts: number }[] = [];
  done = new Set<string>();
  async reassign(fn: string, toSlot: string, fromSlot: string) {
    this.reassignments = [...this.reassignments.filter((r) => r.fn !== fn), { fn, toSlot, fromSlot, ts: Date.now() }];
    return { ok: true };
  }
  async markDone(slot: string, gen: number) {
    this.done.add(`${slot}.g${gen}`);
    return { ok: true };
  }
  async clearDone(slot: string) {
    for (const k of [...this.done]) if (k.startsWith(`${slot}.g`)) this.done.delete(k);
    return { ok: true };
  }
  async clearPossessed(slot: string) {
    const s = this.slots.get(slot);
    if (s) this.slots.set(slot, { ...s, possessed: false });
    return { ok: true };
  }
  async snapshot() {
    const slots = [...this.slots.values()].sort((a, b) => a.slot.localeCompare(b.slot)).map((s) => ({ retireStartedAt: null, ...s, done: this.done.has(`${s.slot}.g${s.gen}`) }));
    return { run: this.run, slots, history: this.history, reassignments: this.reassignments };
  }
}

class FakeAgent {
  info: Record<string, unknown> | null = null;
  steps: { step: number; summary: string; claims: string[]; ts: number }[] = [];
  checkpoints: { fn: string; code: string; ts: number }[] = [];
  totals = { input: 100, cached: 40, output: 20, reasoning: 5, usd: 0.001 };
  async init(i: Record<string, unknown>) {
    this.info ??= { relayName: null, relayToken: null, handoff: null, ...i, createdAt: Date.now() };
    return this.info;
  }
  async setRelay(gen: number, relayName: string, relayToken: string) {
    this.info = { ...this.info!, relayName, relayToken };
    return { ok: true };
  }
  async state() {
    return { info: this.info, closed: null, totals: this.totals, steps: this.steps, checkpoints: this.checkpoints };
  }
}

class FakeCases {
  rows: Record<string, unknown>[] = [];
  async add(c: Record<string, unknown>) {
    if (!this.rows.some((r) => r.id === c.id)) this.rows = [...this.rows, { driftTrace: [], embedding: null, synthetic: false, revoked: false, revokedReason: null, receivers: [], createdAt: Date.now(), ...c }];
    return { ok: true, created: true };
  }
  async list() {
    return this.rows;
  }
  async get(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async markReceived(caseId: string, agentId: string) {
    const r = this.rows.find((x) => x.id === caseId);
    if (!r) return { ok: false, reason: "not_found" };
    r.receivers = [...new Set([...((r.receivers as string[]) ?? []), agentId])];
    return { ok: true, created: true };
  }
  async markBroadcast(caseId: string, rootMessageId: string | null) {
    const r = this.rows.find((x) => x.id === caseId);
    if (!r) return { ok: false, reason: "not_found" };
    r.broadcast = true;
    r.rootMessageId ??= rootMessageId;
    return { ok: true, created: true };
  }
}

class FakeLedger {
  rows: { id: string; category: string; usd: number; input_tokens: number; output_tokens: number }[] = [];
  async record(e: { id: string; category: string; usd: number; input_tokens: number; output_tokens: number }) {
    if (!this.rows.some((r) => r.id === e.id)) this.rows = [...this.rows, e];
    return { ok: true, created: true };
  }
  async totals() {
    const worker = this.rows.filter((r) => r.category === "worker").reduce((s, r) => s + r.usd, 0);
    const all = this.rows.reduce((s, r) => s + r.usd, 0);
    return {
      worker_usd: worker,
      overhead_usd: all - worker,
      by_category: { worker: { calls: this.rows.filter((r) => r.category === "worker").length, usd: worker } },
      calls: { jev: 0, fallback: 0 },
      tokens: { input: this.rows.reduce((s, r) => s + r.input_tokens, 0), cached: 0, output: this.rows.reduce((s, r) => s + r.output_tokens, 0), reasoning: 0 },
      reuse_est_tokens: 0,
      rows: this.rows.length,
      mock_rows: 0,
      updatedAt: Date.now(),
    };
  }
}

class FakeIndex implements RunIndexStub {
  rows = new Map<string, RunIndexEntry>();
  async add(e: RunIndexEntry) {
    if (!this.rows.has(e.runId)) this.rows.set(e.runId, e);
    return { ok: true };
  }
  async setStatus(runId: string, status: string, endedAt?: number | null, testsPassing?: number | null) {
    const e = this.rows.get(runId);
    if (!e) return { ok: false };
    this.rows.set(runId, { ...e, status, endedAt: e.endedAt ?? endedAt ?? null, testsPassing: testsPassing ?? e.testsPassing });
    return { ok: true };
  }
  async get(runId: string) {
    return this.rows.get(runId) ?? null;
  }
  async list() {
    return [...this.rows.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}

/** One durable store shared by "processes" (RunManagers), like the actor runtime. */
class Store {
  fleets = new Map<string, FakeFleet>();
  agents = new Map<string, FakeAgent>();
  libs = new Map<string, FakeCases>();
  ledgers = new Map<string, FakeLedger>();
  index = new FakeIndex();
  actorsFor = (runId: string, libraryId: string): RunActors => {
    const get = <T>(m: Map<string, T>, k: string, mk: () => T) => m.get(k) ?? (m.set(k, mk()), m.get(k)!);
    return {
      fleet: get(this.fleets, runId, () => new FakeFleet()),
      agent: (slot: string, gen: number) => get(this.agents, `${runId}.${slot}.g${gen}`, () => new FakeAgent()),
      cases: get(this.libs, libraryId, () => new FakeCases()),
      chunks: {},
      ledger: get(this.ledgers, runId, () => new FakeLedger()),
      swarm: () => ({}),
    } as unknown as RunActors;
  };
}

type LoopFn = (ctx: RunContext, slot: number, gen: number) => Promise<LoopOutcome>;

function makeManager(store: Store, loop: LoopFn, extra: { resumeRetire?: (ctx: RunContext, slot: number) => Promise<{ newRef: { slot: number; gen: number; name: string } | null }>; finalPass?: (fn: string) => boolean } = {}) {
  const logs: string[] = [];
  const bus = new EventBus();
  const relay = new MockRelayBus({ repliesPerThread: caps.replies_per_case_thread, log: (l) => logs.push(l) });
  const setConcurrency: number[] = [];
  const deps = {
    llm: { setConcurrency: (n: number) => setConcurrency.push(n) },
    jev: { jevStatus: () => ({ online: false, until: 123 }), onEvent: () => () => {} },
    embedder: { mock: true },
    log: (l: string) => logs.push(l),
    mock: { llm: false, jev: false, embed: false, relay: true },
  } as unknown as RuntimeDeps;
  const runs = new RunManager({
    cfg,
    deps,
    bus,
    relay,
    workRoot: join(tmp, "runs"),
    tasksRoot: join(REPO, "bench", "tasks"),
    concurrency: "benchmark",
    hooks: {
      actorsFor: store.actorsFor,
      runIndex: store.index,
      runAgentLoop: loop,
      resumeRetire: extra.resumeRetire ?? (async () => ({ newRef: null })),
      finalTest: async (_ctx, fn) => ({ passed: extra.finalPass ? extra.finalPass(fn.name) : true, failedTests: [], output: "MOCK pytest", durationMs: 1, timedOut: false }),
      retirePollMs: 5,
    },
  });
  return { runs, bus, relay, logs, setConcurrency, deps };
}

const events = (bus: EventBus) => bus.replay(0);
const terminal = (bus: EventBus, runId: string) =>
  events(bus).find((e): e is Extract<SequencedEvent, { type: "run.status" }> => e.type === "run.status" && e.runId === runId && ["finished", "failed", "stopped"].includes(e.run.status));

// ---------- tests ----------

describe("RunManager.startRun (MOCK actors/relay/loops)", () => {
  test("creates the run, slots, agents, relay identities, work dir; loops run; final tests finish it", async () => {
    const store = new Store();
    const calls: string[] = [];
    const { runs, bus, relay, setConcurrency } = makeManager(store, async (ctx, slot, gen) => {
      calls.push(`${slot}.g${gen}`);
      return "done";
    });
    const s = await runs.startRun({ taskId: "invoice_parser", mode: "ours", stepDelayMs: 50 });
    expect(s.runId).toMatch(/^r[a-z0-9]{4}$/);
    expect(s.libraryId).toBe(`lib-${s.runId}`);
    expect(s.taskId).toBe("invoice_parser");
    expect(s.testsTotal).toBe(4);
    expect(s.agents).toBe(4);
    expect(s.mock).toBe(true); // MOCK relay => run labeled
    expect(setConcurrency).toEqual([caps.concurrent_llm_calls_benchmark]);

    const ctx = runs.get(s.runId)!;
    expect(ctx.stepDelayMs).toBe(50);
    // Default off since the v2/v3 ablation (sharing cost more tokens than it saved); SHARED_REASONING=1 turns it on.
    expect(ctx.sharedReasoning).toBe(process.env.SHARED_REASONING === "1");
    expect(ctx.herd).toBe(true);
    const wd = runs.workDir(s.runId)!;
    expect(existsSync(join(wd, "parse_line.py"))).toBe(true);
    expect(existsSync(join(wd, "tests", "test_parse_line.py"))).toBe(true);
    expect(existsSync(join(wd, "_solution"))).toBe(false);

    const fleet = store.fleets.get(s.runId)!;
    expect(fleet.run!.config.wardenToken).toBeTruthy();
    expect(fleet.run!.config.workDir).toBe(wd);
    expect([...fleet.slots.values()].map((x) => x.relayName)).toEqual([0, 1, 2, 3].map((i) => relayNames.agent(s.runId, i, 1)));
    const a0 = store.agents.get(`${s.runId}.0.g1`)!;
    expect(a0.info!.task).toBe("format_invoice_id");
    expect(String(a0.info!.relayToken)).toMatch(/^mock_tok_/);
    // warden can post to the run's channels
    await relay.send({ fromName: relayNames.warden(s.runId), to: `#${relayNames.cases(s.runId)}`, text: "x", idempotencyKey: "k", metadata: { runId: s.runId, slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true });

    expect(await until(() => !!terminal(bus, s.runId))).toBe(true);
    expect(calls.sort()).toEqual(["0.g1", "1.g1", "2.g1", "3.g1"]);
    const end = terminal(bus, s.runId)!;
    expect(end.run.status).toBe("finished");
    expect(end.run.testsPassing).toBe(4);
    expect(fleet.run!.status).toBe("done");
    expect(store.index.rows.get(s.runId)!.status).toBe("finished");
    const types = events(bus).filter((e) => e.runId === s.runId).map((e) => e.type);
    expect(types).toContain("roster");
    expect(types).toContain("ledger.totals");
    expect(types.filter((t) => t === "run.status").length).toBeGreaterThanOrEqual(2);
    runs.shutdown();
  });

  test("ablation turns shared reasoning off; baseline turns herd off; failing final tests -> failed", async () => {
    const store = new Store();
    const { runs, bus } = makeManager(store, async () => "done", { finalPass: (fn) => fn !== "parse_line" });
    const ab = await runs.startRun({ taskId: "invoice_parser", mode: "ablation" });
    expect(runs.get(ab.runId)!.sharedReasoning).toBe(false);
    expect(runs.get(ab.runId)!.herd).toBe(true);
    const bl = await runs.startRun({ taskId: "invoice_parser", mode: "baseline", libraryId: "shared-lib" });
    expect(runs.get(bl.runId)!.herd).toBe(false);
    expect(bl.libraryId).toBe("shared-lib");
    expect(store.fleets.get(bl.runId)!.run!.mode).toBe("baseline");
    expect(await until(() => !!terminal(bus, ab.runId))).toBe(true);
    expect(terminal(bus, ab.runId)!.run.status).toBe("failed");
    expect(terminal(bus, ab.runId)!.run.testsPassing).toBe(3);
    runs.shutdown();
  });

  test("a 'retired' loop continues with the next generation from Fleet", async () => {
    const store = new Store();
    const seen: string[] = [];
    const { runs, bus } = makeManager(store, async (ctx, slot, gen) => {
      seen.push(`${slot}.g${gen}`);
      if (slot === 1 && gen === 1) {
        // what retire.retireAgent does, in short
        await ctx.actors.fleet.beginRetire("1", 1, "false_claim");
        await ctx.actors.fleet.completeRetire("1", 1, { relayName: relayNames.agent(ctx.runId, 1, 2) });
        return "retired";
      }
      return "done";
    });
    const s = await runs.startRun({ taskId: "invoice_parser", mode: "ours" });
    expect(await until(() => !!terminal(bus, s.runId))).toBe(true);
    expect(seen).toContain("1.g2");
    const sum = (await runs.list()).find((r) => r.runId === s.runId)!;
    expect(sum.retires).toBe(1);
    runs.shutdown();
  });

  test("a loop that ends with the slot still retiring gets retire.resumeRetire", async () => {
    const store = new Store();
    const seen: string[] = [];
    const resumed: number[] = [];
    const { runs, bus } = makeManager(
      store,
      async (ctx, slot, gen) => {
        seen.push(`${slot}.g${gen}`);
        if (slot === 2 && gen === 1) {
          await ctx.actors.fleet.beginRetire("2", 1, "stuck");
          throw new Error("MOCK crash mid-retire");
        }
        return "done";
      },
      {
        resumeRetire: async (ctx, slot) => {
          resumed.push(slot);
          await ctx.actors.fleet.completeRetire(String(slot), 1, {});
          return { newRef: { slot, gen: 2, name: relayNames.agent(ctx.runId, slot, 2) } };
        },
      },
    );
    const s = await runs.startRun({ taskId: "invoice_parser", mode: "ours" });
    expect(await until(() => !!terminal(bus, s.runId))).toBe(true);
    expect(resumed).toEqual([2]);
    expect(seen).toContain("2.g2");
    runs.shutdown();
  });

  test("stop: aborts in-flight calls, Fleet stopped, possess/inject then refused", async () => {
    const store = new Store();
    const aborted: number[] = [];
    const { runs, bus } = makeManager(store, async (ctx, slot) => {
      const ac = new AbortController();
      ctx.abort.set(slot, ac);
      await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r()));
      aborted.push(slot);
      return "aborted";
    });
    const svc = new RealRuntimeService(runs, bus, { possess: async () => ({ ok: true }) });
    const s = await svc.startRun({ taskId: "invoice_parser", mode: "ours" });
    expect(await svc.possess(s.runId, 0)).toEqual({ ok: true });
    expect(await svc.stopRun(s.runId)).toMatchObject({ ok: true });
    expect(await until(() => aborted.length === 4)).toBe(true);
    expect(store.fleets.get(s.runId)!.run!.status).toBe("stopped");
    expect(terminal(bus, s.runId)!.run.status).toBe("stopped");
    expect(await svc.possess(s.runId, 0)).toMatchObject({ ok: false, error: "run_finished" });
    expect(await svc.stopRun(s.runId)).toMatchObject({ ok: false, error: "run_finished" });
    expect(await svc.possess("nope", 0)).toMatchObject({ ok: false, error: "no_such_run" });
    expect(await svc.injectFault(s.runId, 0, "F9" as never)).toMatchObject({ ok: false, error: "unsupported" });
    await Bun.sleep(20); // let the final-test path (skipped on stop) settle
    expect(terminal(bus, s.runId)!.run.status).toBe("stopped");
    runs.shutdown();
  });

  test("capped by USD: the run is stopped", async () => {
    const store = new Store();
    const { runs, bus } = makeManager(store, async (ctx, slot) => {
      if (slot === 0) await (ctx.actors.ledger as unknown as FakeLedger).record({ id: "x", category: "worker", usd: caps.usd_per_run + 0.01, input_tokens: 1, output_tokens: 1 });
      return "capped";
    });
    const s = await runs.startRun({ taskId: "invoice_parser", mode: "ours" });
    expect(await until(() => !!terminal(bus, s.runId))).toBe(true);
    expect(terminal(bus, s.runId)!.run.status).toBe("stopped");
    runs.shutdown();
  });
});

describe("reconcile (restart from actors, MOCK)", () => {
  test("a new RunManager resumes active slots and half-done retires from Fleet + RunIndex", async () => {
    const store = new Store();
    const first = makeManager(store, async (ctx, slot) => {
      const ac = new AbortController();
      ctx.abort.set(slot, ac);
      await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r()));
      return "aborted";
    });
    const s = await first.runs.startRun({ taskId: "invoice_parser", mode: "ours", stepDelayMs: 7 });
    // crash: slot 3 was mid-retire, slot 1 is on gen 2
    await store.fleets.get(s.runId)!.beginRetire("3", 1, "false_claim");
    const f = store.fleets.get(s.runId)!;
    f.slots.set("1", { ...f.slots.get("1")!, gen: 2, status: "probation" });
    await store.actorsFor(s.runId, s.libraryId).agent("1", 2).init({ runId: s.runId, slot: "1", gen: 2, task: "parse_line", persona: "p" });
    first.runs.shutdown(); // kill: loops stop, Fleet stays running
    expect(store.fleets.get(s.runId)!.run!.status).toBe("running");

    const seen: string[] = [];
    const resumed: number[] = [];
    const second = makeManager(
      store,
      async (_ctx, slot, gen) => {
        seen.push(`${slot}.g${gen}`);
        return "done";
      },
      {
        resumeRetire: async (ctx, slot) => {
          resumed.push(slot);
          await ctx.actors.fleet.completeRetire(String(slot), 1, {});
          return { newRef: { slot, gen: 2, name: relayNames.agent(ctx.runId, slot, 2) } };
        },
      },
    );
    await second.runs.reconcile();
    const ctx = second.runs.get(s.runId)!;
    expect(ctx).toBeTruthy();
    expect(ctx.stepDelayMs).toBe(7);
    expect(ctx.workDir).toBe(first.runs.workDir(s.runId)!);
    expect(await until(() => !!terminal(second.bus, s.runId))).toBe(true);
    expect(resumed).toEqual([3]);
    expect(seen.sort()).toEqual(["0.g1", "1.g2", "2.g1", "3.g2"]);
    const banner = events(second.bus).find((e) => e.type === "run.status" && e.banner);
    expect(banner && banner.type === "run.status" && banner.banner).toContain("reconnected");
    // fresh MOCK relay has no tokens: identities were re-registered and the new token stored
    const a1 = store.agents.get(`${s.runId}.1.g2`)!;
    expect(String(a1.info!.relayToken)).toMatch(/^mock_tok_/);
    expect(second.logs.some((l) => l.includes("relay reconnect"))).toBe(true);
    // ended runs are not resumed again
    const third = makeManager(store, async () => {
      throw new Error("must not run");
    });
    await third.runs.reconcile();
    expect(third.runs.get(s.runId)).toBeUndefined();
    second.runs.shutdown();
    third.runs.shutdown();
  });
});

describe("RealRuntimeService reads (MOCK)", () => {
  test("roster, cases, ledger, relay feed, grants, jev, benchmark rows, work dir", async () => {
    const store = new Store();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { runs, bus, relay } = makeManager(store, async () => {
      await gate;
      return "done";
    });
    const resultsPath = join(tmp, "results.json");
    const row = { mode: "ours_cold", task: "invoice_parser", trial: 1 } as unknown as BenchmarkResultRow;
    writeFileSync(resultsPath, JSON.stringify([row]));
    const svc = new RealRuntimeService(runs, bus, {
      resultsPath,
      grant: async (kind, actorId) => ({ websocketUrl: `ws://MOCK/${kind}/${actorId}`, connectByMs: 99 }),
    });
    const s = await svc.startRun({ taskId: "invoice_parser", mode: "ours" });
    const a = store.actorsFor(s.runId, s.libraryId);

    const roster = await svc.getRoster(s.runId);
    expect(roster.map((c) => c.subtask)).toEqual(["format_invoice_id", "parse_line", "total_by_customer", "overdue_invoices"]);
    expect(roster[0]).toMatchObject({ slot: 0, gen: 1, status: "trusted", name: relayNames.agent(s.runId, 0, 1), tokens: { input: 100, cached: 40, output: 20, reasoning: 5 } });

    await a.cases.add({
      id: `${s.runId}.1.g1`,
      runId: s.runId,
      slot: "1",
      gen: 1,
      category: "false_success_claim",
      claim: "tests pass",
      evidence: { testOutput: "FAILED x", meta: { subtask: "parse_line", agentName: relayNames.agent(s.runId, 1, 1), replacement: relayNames.agent(s.runId, 1, 2) } },
      lesson: "",
    });
    bus.publish({ type: "case.reply", runId: s.runId, ts: 1, caseId: `${s.runId}.1.g1`, reply: { from: "w0", slot: 0, gen: 1, text: "ok", ts: 1, seq: 5 } });
    const cases = await svc.listCases({ runId: s.runId });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ subtask: "parse_line", lesson: null, replacement: relayNames.agent(s.runId, 1, 2), evidence: { testOutput: "FAILED x" }, task: "invoice_parser" });
    expect(cases[0]!.replies).toHaveLength(1);
    expect(await svc.listCases({ libraryId: s.libraryId })).toHaveLength(1);
    expect((await svc.getCase(`${s.runId}.1.g1`))!.id).toBe(`${s.runId}.1.g1`);
    expect(await svc.getCase("zzzz.0.g1")).toBeNull();

    await (a.ledger as unknown as FakeLedger).record({ id: "l1", category: "worker", usd: 0.002, input_tokens: 10, output_tokens: 3 });
    const led = await svc.getLedger(s.runId);
    expect(led).toMatchObject({ runId: s.runId, worker_usd: 0.002, est: { reuse_est_tokens: true } });
    expect(led!.net_savings_usd).toBeUndefined();
    expect(await svc.getLedger("nope")).toBeNull();

    // Relay listener publishes messages nobody else published (herd publishes its own with the same seq)
    const m = await relay.send({ fromName: relayNames.agent(s.runId, 0, 1), to: `#${relayNames.fleet(s.runId)}`, text: "hello team", idempotencyKey: "a", metadata: { runId: s.runId, slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true });
    expect(await until(() => svc.getRelayFeed(s.runId) !== undefined && runs.relayFeed(s.runId).length === 1, 2000)).toBe(true);
    const feed = await svc.getRelayFeed(s.runId);
    expect(feed[0]).toMatchObject({ seq: m.seq, channel: relayNames.fleet(s.runId), from: relayNames.agent(s.runId, 0, 1), metadata: { runId: s.runId, kind: "note" } });
    expect(await svc.getRelayFeed(s.runId, m.seq)).toHaveLength(0);
    expect(events(bus).some((e) => e.type === "relay.message" && e.mock)).toBe(true);

    expect(await svc.actorSocketGrant("ledger", s.runId)).toEqual({ kind: "ledger", actorId: `ledger.${s.runId}`, websocketUrl: `ws://MOCK/ledger/ledger.${s.runId}`, expiresAt: 99 });
    expect(await svc.getJevStatus()).toMatchObject({ online: false, mode: "fallback", fallbackUntil: 123, consecutiveFailures: thresholds.jev_fail_switch, model: "MOCK-jev" });
    expect(await svc.getBenchmarkResults()).toEqual([row]);
    expect(await svc.getRunWorkDir(s.runId)).toBe(runs.workDir(s.runId));
    const runsList = await svc.listRuns();
    expect(runsList[0]!.runId).toBe(s.runId);
    expect(runsList[0]!.status).toBe("running");

    const got: string[] = [];
    const unsub = svc.subscribe((e) => got.push(e.type));
    svc.swarmStatsHook(s.runId)({ agents: 10, shards: 1, handled: 5, lost: 0, ratePerSec: 1, measured: false });
    unsub();
    expect(got).toEqual(["swarm.stats"]);
    expect(svc.replay(0).at(-1)).toMatchObject({ type: "swarm.stats", mock: true });

    release();
    expect(await until(() => !!terminal(bus, s.runId))).toBe(true);
    runs.shutdown();
  });

  test("net savings appear only once a finished baseline run exists for the task", async () => {
    const store = new Store();
    const { runs, bus } = makeManager(store, async () => "done");
    const svc = new RealRuntimeService(runs, bus);
    const ours = await svc.startRun({ taskId: "invoice_parser", mode: "ours" });
    await until(() => !!terminal(bus, ours.runId));
    // a baseline run from an earlier (non-mock) process, known only through the index
    store.index.rows.set("rbase", { runId: "rbase", taskId: "invoice_parser", mode: "baseline", libraryId: "lib-rbase", model: "m", workDir: "/x", startedAt: 1, status: "finished", endedAt: 2, testsPassing: 4, testsTotal: 4 });
    await store.actorsFor("rbase", "lib-rbase").fleet.startRun({ runId: "rbase", mode: "baseline" });
    await (store.actorsFor("rbase", "lib-rbase").ledger as unknown as FakeLedger).record({ id: "b", category: "worker", usd: 0.5, input_tokens: 1, output_tokens: 1 });
    await (store.actorsFor(ours.runId, ours.libraryId).ledger as unknown as FakeLedger).record({ id: "o", category: "worker", usd: 0.2, input_tokens: 1, output_tokens: 1 });
    const led = await svc.getLedger(ours.runId);
    expect(led!.baselineRunId).toBe("rbase");
    expect(led!.net_savings_usd).toBeCloseTo(0.3, 6);
    runs.shutdown();
  });
});

test("runOfMessage attributes listener messages without metadata", () => {
  expect(runOfMessage({ metadata: {}, to: "#cases-r7k2", from: "x" })).toBe("r7k2");
  expect(runOfMessage({ metadata: {}, to: "@?", from: "w3-g2-rab9" })).toBe("rab9");
  expect(runOfMessage({ metadata: { runId: "r1" }, to: "@?", from: "x" })).toBe("r1");
  expect(runOfMessage({ metadata: {}, to: "@?", from: "orchestrator" })).toBeNull();
});
