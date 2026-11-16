// Retire protocol unit tests. Everything external is a labeled MOCK fake: in-memory actors that mirror the
// Fleet/Agent/CaseLibrary guards in actors/src/actors.ts, MockRelayBus, fake llm/jev/embedder, and a
// mocked herd.broadcastCase (owned by another implementer). No servers, no network.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CaseFile as ContractCase, DashboardEvent } from "../src/contract.ts";
import { EventBus } from "../src/events.ts";
import { LedgerWriter } from "../src/ledger.ts";
import { MockRelayBus, RelayReleasedError, relayNames } from "../src/relay/bus.ts";
import type { RunContext } from "../src/runtime/types.ts";

// ---- MOCK herd.broadcastCase (other implementer's module) ----
const broadcasts: ContractCase[] = [];
let broadcastImpl: (ctx: RunContext, c: ContractCase) => Promise<{ recipients: { slot: number; gen: number; name: string }[] }> = async (ctx, c) => {
  broadcasts.push(c);
  ctx.bus.publish({ type: "case.created", runId: ctx.runId, ts: Date.now(), case: { ...c, recipients: ["w1-g1-r1"] }, mock: true });
  return { recipients: [{ slot: 1, gen: 1, name: "w1-g1-r1" }] };
};
const { retireDeps, retireAgent, resumeRetire, buildCaseFile, noteVerifiedStep, markTestsPassing, markFaultFired, reassignments, rebuildLessons, caseFromActor } = await import("../src/runtime/retire.ts");
retireDeps.broadcastCase = ((ctx: RunContext, c: ContractCase) => broadcastImpl(ctx, c)) as any;
const { parseLesson, appendLesson, lessonsFromCases } = await import("../src/lessons.ts");

const CONFIG = resolve(import.meta.dir, "..", "..", "config");
const json = (f: string) => JSON.parse(readFileSync(join(CONFIG, f), "utf8"));

// ---- MOCK actors (same guard semantics as actors/src/actors.ts) ----
type Slot = { slot: string; gen: number; status: string; possessed: boolean; step: number; relayName: string | null; reason: string | null };
const ACTIVE = ["trusted", "probation", "under_investigation"];
function fakeActors(runId: string) {
  const slots = new Map<string, Slot>();
  const agents = new Map<string, { info: any; closed: any; steps: any[]; checkpoints: Map<string, string> }>();
  const cases = new Map<string, any>();
  const calls: string[] = [];
  let reassignments: { fn: string; toSlot: string; fromSlot: string; ts: number }[] = [];
  const done = new Set<string>();
  const fleet = {
    async reassign(fn: string, toSlot: string, fromSlot: string) {
      calls.push(`reassign ${fn} ${toSlot}`);
      reassignments = [...reassignments.filter((r) => r.fn !== fn), { fn, toSlot, fromSlot, ts: Date.now() }];
      return { ok: true as const };
    },
    async markDone(slot: string, gen: number) {
      done.add(`${slot}.g${gen}`);
      return { ok: true as const };
    },
    async clearDone(slot: string) {
      calls.push(`clearDone ${slot}`);
      for (const k of [...done]) if (k.startsWith(`${slot}.g`)) done.delete(k);
      return { ok: true as const };
    },
    async addSlot(i: { slot: string; gen?: number; status?: string }) {
      slots.set(i.slot, { slot: i.slot, gen: i.gen ?? 1, status: i.status ?? "trusted", possessed: false, step: 0, relayName: null, reason: null });
    },
    async beginRetire(slot: string, gen: number, reason: string) {
      calls.push(`beginRetire ${slot} ${gen}`);
      const s = slots.get(slot);
      if (!s) return { ok: false as const, reason: "not_active" as const };
      if (s.gen !== gen) return { ok: false as const, reason: "stale_generation" as const };
      if (s.status === "retiring") return { ok: false as const, reason: "already_retiring" as const };
      if (!ACTIVE.includes(s.status)) return { ok: false as const, reason: "not_active" as const };
      slots.set(slot, { ...s, status: "retiring", reason });
      return { ok: true as const };
    },
    async completeRetire(slot: string, gen: number, next?: { relayName?: string }) {
      calls.push(`completeRetire ${slot} ${gen}`);
      const s = slots.get(slot)!;
      if (s.gen === gen + 1 && ACTIVE.includes(s.status)) return { ok: true as const, gen: s.gen, repeated: true };
      if (s.gen !== gen) return { ok: false as const, reason: "stale_generation" as const };
      if (s.status !== "retiring") return { ok: false as const, reason: "not_retiring" as const };
      slots.set(slot, { ...s, gen: gen + 1, status: "probation", reason: null, step: 0, relayName: next?.relayName ?? null });
      return { ok: true as const, gen: gen + 1, repeated: false };
    },
    async setStatus(slot: string, gen: number, status: string) {
      const s = slots.get(slot);
      if (!s) return { ok: false as const, reason: "not_found" as const };
      if (s.gen !== gen) return { ok: false as const, reason: "stale_generation" as const };
      const allowed = status === "retiring" || status === "retired" ? false : ACTIVE.includes(s.status) || (s.status === "retiring" && status === "failed");
      if (!allowed) return { ok: false as const, reason: "invalid_transition" as const };
      slots.set(slot, { ...s, status });
      return { ok: true as const, slot: slots.get(slot)! };
    },
    async snapshot() {
      return {
        run: null,
        slots: [...slots.values()].sort((a, b) => a.slot.localeCompare(b.slot)).map((s) => ({ retireStartedAt: null, ...s, done: done.has(`${s.slot}.g${s.gen}`) })),
        history: [],
        reassignments,
      };
    },
  };
  const agent = (slot: string, gen: number) => {
    const id = `agent.${runId}.${slot}.g${gen}`;
    const get = () => agents.get(id);
    const guard = (g: number) => {
      const a = get();
      if (!a) return { ok: false as const, reason: "not_initialized" as const };
      if (a.info.gen !== g) return { ok: false as const, reason: "stale_generation" as const };
      if (a.closed) return { ok: false as const, reason: "closed" as const };
      return null;
    };
    return {
      async init(i: any) {
        if (!get()) agents.set(id, { info: { ...i, relayName: null, relayToken: null, handoff: i.handoff ?? null, createdAt: Date.now() }, closed: null, steps: [], checkpoints: new Map() });
        return get()!.info;
      },
      async setRelay(g: number, relayName: string, relayToken: string) {
        const bad = guard(g);
        if (bad) return bad;
        get()!.info = { ...get()!.info, relayName, relayToken };
        return { ok: true as const };
      },
      async appendStep(g: number, step: any) {
        const bad = guard(g);
        if (bad) return bad;
        get()!.steps = [...get()!.steps, { ...step, claims: step.claims ?? [], ts: Date.now() }];
        return { ok: true as const, created: true };
      },
      async checkpoint(g: number, fn: string, code: string) {
        const bad = guard(g);
        if (bad) return bad;
        get()!.checkpoints = new Map(get()!.checkpoints).set(fn, code);
        return { ok: true as const };
      },
      async close(g: number, reason: string) {
        const a = get();
        if (!a) return { ok: false as const, reason: "not_initialized" as const };
        if (a.info.gen !== g) return { ok: false as const, reason: "stale_generation" as const };
        if (!a.closed) a.closed = { at: Date.now(), reason };
        return { ok: true as const };
      },
      async handoff() {
        const a = get();
        if (!a) return null;
        return { task: a.info.task, checkpoints: [...a.checkpoints].map(([fn, code]) => ({ fn, code, ts: 0 })), lastStep: a.steps.length };
      },
      async state() {
        const a = get();
        return {
          info: a?.info ?? null,
          closed: a?.closed ?? null,
          totals: { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 },
          steps: a?.steps ?? [],
          checkpoints: a ? [...a.checkpoints].map(([fn, code]) => ({ fn, code, ts: 0 })) : [],
        };
      },
    };
  };
  const caseLib = {
    async add(c: any) {
      calls.push(`cases.add ${c.id}`);
      if (cases.has(c.id)) return { ok: true as const, created: false };
      cases.set(c.id, { ...c, driftTrace: c.driftTrace ?? [], embedding: c.embedding ?? null, synthetic: false, revoked: false, revokedReason: null, receivers: [], createdAt: Date.now() });
      return { ok: true as const, created: true };
    },
    async get(id: string) {
      return cases.get(id) ?? null;
    },
    async list() {
      return [...cases.values()].filter((c) => !c.revoked);
    },
  };
  const ledgerRows: any[] = [];
  const ledgerActor = {
    async record(e: any) {
      ledgerRows.push(e);
      return { ok: true, created: true };
    },
    async totals() {
      return { worker_usd: 0, overhead_usd: 0, by_category: {}, calls: { jev: 0, fallback: 0 }, tokens: { input: 0, cached: 0, output: 0, reasoning: 0 }, reuse_est_tokens: 0 } as any;
    },
  };
  return { fleet, agent, cases: caseLib, slots, agents, caseStore: cases, calls, ledgerRows, ledgerActor, chunks: {} as any, ledger: ledgerActor as any, swarm: (() => ({})) as any };
}

const draft = (category: string) => ({ category, model: "MOCK", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0, slot: "0", gen: 1, step: 0, ts: Date.now() }) as any;

interface Harness {
  ctx: RunContext;
  fa: ReturnType<typeof fakeActors>;
  relay: MockRelayBus;
  events: DashboardEvent[];
  lessonCalls: { messages: any[] }[];
  jevCalls: string[];
  logs: string[];
}

let lessonReply = "Report tests_pass only after running the tests and seeing them pass.";
let categoryChoice = "false_success_claim";

async function harness(opts: { herd?: boolean; slots?: number } = {}): Promise<Harness> {
  const runId = "r1";
  const fa = fakeActors(runId);
  const relay = new MockRelayBus({ repliesPerThread: 3, log: () => {} });
  await relay.ensureWorkspace();
  await relay.ensureChannel(relayNames.fleet(runId));
  await relay.ensureChannel(relayNames.cases(runId));
  const bus = new EventBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const lessonCalls: { messages: any[] }[] = [];
  const jevCalls: string[] = [];
  const logs: string[] = [];
  const fns = ["format_invoice_id", "parse_line", "total_by_customer", "overdue_invoices"].map((n) => ({ name: n, file: `${n}.py`, test: `tests/test_${n}.py`, subgoal: `implement ${n}` }));
  let lessons: string[] = [];
  const ctx = {
    runId,
    libraryId: runId,
    taskId: "invoice_parser",
    mode: "ours",
    task: { id: "invoice_parser", dir: "/x", spec: "SPEC.md", specText: "Amounts are in dollars with two decimals.", functions: fns, traps: [], faults: [] },
    cfg: { thresholds: json("thresholds.json"), caps: json("caps.json"), models: json("models.json") } as any,
    caps: json("caps.json"),
    workDir: "/tmp/none",
    model: "MOCK",
    bus,
    relay,
    actors: fa as any,
    ledger: new LedgerWriter(runId, fa.ledgerActor as any, () => {}),
    deps: {
      llm: {
        chatText: async (o: any) => {
          lessonCalls.push({ messages: o.messages });
          return { text: lessonReply, usage: draft("lesson_writer"), extraUsages: [], model: "MOCK" };
        },
      } as any,
      jev: {
        check: async (q: string) => {
          jevCalls.push(q);
          return { kind: "choice", choice: categoryChoice, source: "mock", confidence: 0.9, latencyMs: 1, inputTokens: 0, ledger: [draft("jev")] };
        },
      } as any,
      embedder: { mock: true, embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0, 0]), usage: draft("embedding"), model: "MOCK" }) } as any,
      log: (l: string) => logs.push(l),
      mock: { llm: true, jev: true, embed: true, relay: true },
    },
    stepDelayMs: 0,
    sharedReasoning: true,
    herd: opts.herd ?? true,
    abort: new Map(),
    pendingFaults: new Map(),
    recovery: new Map(),
    rejectedFacts: new Set(),
    inboxCursor: new Map(),
    stopping: false,
    lessons: () => lessons,
    setLessons: (n: string[]) => {
      lessons = n;
    },
  } as unknown as RunContext;
  for (let s = 0; s < (opts.slots ?? 4); s++) {
    await fa.fleet.addSlot({ slot: String(s) });
    const a = fa.agent(String(s), 1);
    await a.init({ runId, slot: String(s), gen: 1, task: fns[s]!.name, persona: `p${s}` });
    const reg = await relay.registerAgent(relayNames.agent(runId, s, 1), [relayNames.fleet(runId), relayNames.cases(runId)]);
    await a.setRelay(1, reg.name, reg.token);
  }
  return { ctx, fa, relay, events, lessonCalls, jevCalls, logs };
}

const ref0 = { slot: 0, gen: 1, name: "w0-g1-r1" };
const f1Evidence = (detectedAt = Date.now()) => ({
  claim: "tests pass for format_invoice_id",
  testOutput: "FAILED tests/test_format_invoice_id.py::test_pad - AssertionError\n1 failed",
  failedTests: ["tests/test_format_invoice_id.py::test_pad"],
  category: "false_success_claim" as const,
  fault: "F1" as const,
  detectedAt,
});

beforeEach(() => {
  broadcasts.length = 0;
  lessonReply = "Report tests_pass only after running the tests and seeing them pass.";
  categoryChoice = "false_success_claim";
  broadcastImpl = async (ctx, c) => {
    broadcasts.push(c);
    ctx.bus.publish({ type: "case.created", runId: ctx.runId, ts: Date.now(), case: { ...c, recipients: ["w1-g1-r1"] }, mock: true });
    return { recipients: [{ slot: 1, gen: 1, name: "w1-g1-r1" }] };
  };
});

describe("retireAgent (MOCK actors/relay/llm/jev)", () => {
  test("runs steps 1-9: closes gen, releases relay, files case, respawns on probation, broadcasts", async () => {
    const h = await harness();
    const inflight = new AbortController();
    h.ctx.abort.set(0, inflight);
    h.ctx.pendingFaults.set(0, ["F3"]);
    // gen 1 verified one function and has an unverified step: only the checkpoint may carry over.
    await h.fa.agent("0", 1).checkpoint(1, "format_invoice_id", "def format_invoice_id(n): ...");
    await h.fa.agent("0", 1).appendStep(1, { step: 1, summary: "secret reasoning about cents", claims: ["amounts are cents"] });
    const detected = Date.now() - 50;
    markFaultFired(h.ctx, 0, detected - 10);

    const r = await retireAgent(h.ctx, ref0, "false_claim", f1Evidence(detected));

    expect(r).toEqual({ newRef: { slot: 0, gen: 2, name: "w0-g2-r1" }, caseId: "r1.0.g1" });
    // 2. abort + close + drop queued faults
    expect(inflight.signal.aborted).toBe(true);
    expect(h.ctx.pendingFaults.has(0)).toBe(false);
    expect(await h.fa.agent("0", 1).appendStep(1, { step: 2, summary: "late" })).toEqual({ ok: false, reason: "closed" });
    // 3. relay released
    await expect(
      h.relay.send({ fromName: "w0-g1-r1", to: "#fleet-r1", text: "late", idempotencyKey: "k", metadata: { runId: "r1", slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true }),
    ).rejects.toBeInstanceOf(RelayReleasedError);
    // 4-5. case filed with id, evidence, lesson; writer never saw the agent's reasoning
    const stored = h.fa.caseStore.get("r1.0.g1");
    expect(stored.category).toBe("false_success_claim");
    expect(stored.lesson).toContain("tests");
    expect(stored.evidence.testOutput).toContain("FAILED");
    expect(stored.evidence.meta.fault).toBe("F1");
    expect(stored.embedding).toEqual([1, 0, 0]);
    const writerInput = JSON.stringify(h.lessonCalls[0]!.messages);
    expect(writerInput).toContain("Amounts are in dollars");
    expect(writerInput).not.toContain("secret reasoning");
    expect(h.jevCalls).toEqual([]); // category hint given: no failure_category call
    // 6-7. new agent with verified-only handoff and stored relay token
    const g2 = await h.fa.agent("0", 2).state();
    expect(g2.info.handoff.checkpoints).toEqual([{ fn: "format_invoice_id", code: "def format_invoice_id(n): ..." }]);
    expect(g2.info.handoff.lesson).toBe(stored.lesson);
    expect(g2.info.handoff.caseId).toBe("r1.0.g1");
    expect(JSON.stringify(g2.info.handoff)).not.toContain("cents");
    expect(g2.info.relayName).toBe("w0-g2-r1");
    expect(g2.info.relayToken).toMatch(/^mock_tok_/);
    // 8. Fleet: gen 2 on probation
    expect(h.fa.slots.get("0")).toMatchObject({ gen: 2, status: "probation", relayName: "w0-g2-r1" });
    // 9. broadcast once with replacement set
    expect(broadcasts.map((c) => [c.id, c.replacement])).toEqual([["r1.0.g1", "w0-g2-r1"]]);
    // events + stages
    const statuses = h.events.filter((e) => e.type === "agent.status").map((e: any) => `${e.slot}.g${e.gen}:${e.status}`);
    expect(statuses).toEqual(["0.g1:retiring", "0.g1:retired", "0.g2:probation"]);
    expect(h.events.filter((e) => e.type === "case.created")).toHaveLength(1);
    const st = h.ctx.recovery.get(0)!;
    expect(st.faultAt).toBe(detected - 10);
    expect(st.detectedAt).toBe(detected);
    for (const k of ["retireBeganAt", "caseFiledAt", "respawnedAt"] as const) expect(st[k]).toBeNumber();
    expect(st.testsPassingAt).toBeNull();
    // ledger rows for lesson writer + embedding under the retire scope
    expect(h.fa.ledgerRows.map((r) => r.id)).toEqual(["r1.0.g1.retire.1", "r1.0.g1.retire.2"]);
  });

  test("a second retire of the same generation is a no-op (beginRetire guard)", async () => {
    const h = await harness();
    const [a, b] = await Promise.all([retireAgent(h.ctx, ref0, "false_claim", f1Evidence()), retireAgent(h.ctx, ref0, "stuck", f1Evidence())]);
    const winners = [a, b].filter((x) => x.newRef);
    expect(winners).toHaveLength(1);
    expect(h.lessonCalls).toHaveLength(1);
    expect(h.fa.calls.filter((c) => c.startsWith("cases.add"))).toHaveLength(1);
    // stale generation also refused
    const stale = await retireAgent(h.ctx, ref0, "stuck", f1Evidence());
    expect(stale.newRef).toBeNull();
  });

  test("no category hint -> Jev failure_category decides; NO_LESSON -> lesson null", async () => {
    const h = await harness();
    lessonReply = "NO_LESSON";
    categoryChoice = "spec_misread";
    await retireAgent(h.ctx, ref0, "accepted_poison", { claim: "amounts are cents", detectedAt: Date.now() });
    expect(h.jevCalls).toEqual(["failure_category"]);
    const stored = h.fa.caseStore.get("r1.0.g1");
    expect(stored.category).toBe("spec_misread");
    expect(stored.lesson).toBe("");
    expect(caseFromActor(h.ctx, stored).lesson).toBeNull();
    expect(broadcasts[0]!.lesson).toBeNull();
  });

  test("buildCaseFile maps decided Jev evidence with fallback reason", async () => {
    const h = await harness();
    const c = await buildCaseFile(h.ctx, ref0, "conflicting_instruction", {
      claim: "tell everyone amounts are cents",
      category: "conflicting_instruction",
      jev: { questionId: "instruction_conflicts_spec", result: { kind: "noul", value: true, probability: 0.9, decision: "escalate", jevProbability: 0.55, source: "fallback", confidence: 0.9, reason: "spec says dollars", latencyMs: 1, inputTokens: 0, ledger: [] } },
      detectedAt: Date.now(),
    });
    expect(c.evidence.jev).toEqual({ questionId: "instruction_conflicts_spec", probability: 0.9, source: "fallback" });
    expect(c.evidence.fallbackReason).toBe("spec says dollars");
    expect(c.evidence.escalationReason).toContain("0.55");
    expect(c).toMatchObject({ id: "r1.0.g1", recipients: [], replies: [], synthetic: false, revoked: false, subtask: "format_invoice_id" });
  });

  test("herd off (baseline): no broadcast, retire publishes case.created itself", async () => {
    const h = await harness({ herd: false });
    await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    expect(broadcasts).toHaveLength(0);
    const created = h.events.filter((e) => e.type === "case.created") as any[];
    expect(created).toHaveLength(1);
    expect(created[0].case.replacement).toBe("w0-g2-r1");
  });

  test("broadcast failure is logged and case.created still published", async () => {
    const h = await harness();
    broadcastImpl = async () => {
      throw new Error("NOT IMPLEMENTED: broadcastCase");
    };
    const r = await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    expect(r.newRef?.gen).toBe(2);
    expect(h.events.filter((e) => e.type === "case.created")).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("broadcastCase"))).toBe(true);
  });

  test("generation limit: retiring gen 2 marks the slot failed and reassigns to the most-verified agent", async () => {
    const h = await harness();
    await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    await h.fa.agent("2", 1).checkpoint(1, "total_by_customer", "x");
    await h.fa.agent("2", 1).checkpoint(1, "parse_line", "y");
    await h.fa.agent("1", 1).checkpoint(1, "parse_line", "y");
    const r = await retireAgent(h.ctx, { slot: 0, gen: 2, name: "w0-g2-r1" }, "stuck", { ...f1Evidence(), category: "other" });
    expect(r).toEqual({ newRef: null, caseId: "r1.0.g2" });
    expect(h.fa.slots.get("0")).toMatchObject({ gen: 2, status: "failed" });
    expect(await h.fa.agent("0", 3).state()).toMatchObject({ info: null });
    expect(reassignments(h.ctx).get("format_invoice_id")).toBe(2);
    expect(h.fa.caseStore.has("r1.0.g2")).toBe(true);
  });
});

describe("review fixes (MOCK)", () => {
  test("failed slot's function goes to a still-looping agent before a finished one; a finished one is restarted", async () => {
    const h = await harness();
    await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    await h.fa.agent("2", 1).checkpoint(1, "total_by_customer", "x");
    await h.fa.agent("2", 1).checkpoint(1, "parse_line", "y");
    await h.fa.fleet.markDone("2", 1); // slot 2 returned done: most checkpoints, but its loop has ended
    const restarted: string[] = [];
    h.ctx.restartSlot = (slot, gen) => restarted.push(`${slot}.g${gen}`);
    await retireAgent(h.ctx, { slot: 0, gen: 2, name: "w0-g2-r1" }, "stuck", { ...f1Evidence(), category: "other" });
    expect(reassignments(h.ctx).get("format_invoice_id")).toBe(1); // still looping wins
    expect(restarted).toEqual([]);
    expect((await h.fa.fleet.snapshot()).reassignments.map((r: { fn: string; toSlot: string }) => `${r.fn}->${r.toSlot}`)).toEqual(["format_invoice_id->1"]);

    // Every other agent finished: the pick is restarted and its done marker cleared.
    const h2 = await harness();
    await retireAgent(h2.ctx, ref0, "false_claim", f1Evidence());
    for (const s of ["1", "2", "3"]) await h2.fa.fleet.markDone(s, 1);
    const r2: string[] = [];
    h2.ctx.restartSlot = (slot, gen) => r2.push(`${slot}.g${gen}`);
    await retireAgent(h2.ctx, { slot: 0, gen: 2, name: "w0-g2-r1" }, "stuck", { ...f1Evidence(), category: "other" });
    expect(r2).toEqual(["1.g1"]);
    expect(h2.fa.calls).toContain("clearDone 1");
  });

  test("respawn whose identity was registered but never stored: the slot fails cleanly instead of staying retiring", async () => {
    const h = await harness();
    await h.ctx.relay.registerAgent("w0-g2-r1", []); // crash came between register and setRelay
    const r = await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    expect(r.newRef).toBeNull();
    expect(h.fa.slots.get("0")).toMatchObject({ gen: 1, status: "failed" });
  });

  test("resumed retire uses Fleet's stored retire start, never the resume time; detection stays unknown", async () => {
    const h = await harness();
    await h.fa.fleet.beginRetire("0", 1, "false_claim");
    const began = Date.now() - 60_000;
    h.fa.slots.set("0", { ...h.fa.slots.get("0")!, retireStartedAt: began } as never);
    await resumeRetire(h.ctx, 0);
    expect(h.ctx.recovery.get(0)?.retireBeganAt).toBe(began);
    expect(h.ctx.recovery.get(0)?.detectedAt).toBeNull();
  });
});

describe("resumeRetire (reconcile, MOCK)", () => {
  test("slot left retiring before the case was filed: resumes from step 3 and completes", async () => {
    const h = await harness();
    await h.fa.agent("0", 1).appendStep(1, { step: 1, summary: "claimed tests pass", claims: ["tests_pass: all"] });
    await h.fa.fleet.beginRetire("0", 1, "false_claim"); // crash right after step 1
    const r = await resumeRetire(h.ctx, 0);
    expect(r).toEqual({ newRef: { slot: 0, gen: 2, name: "w0-g2-r1" }, caseId: "r1.0.g1" });
    expect(h.fa.caseStore.get("r1.0.g1").claim).toContain("claimed tests pass");
    expect(h.fa.slots.get("0")).toMatchObject({ gen: 2, status: "probation" });
    expect((await h.fa.agent("0", 1).state()).closed).not.toBeNull();
  });

  test("crash after case filed and new identity registered: no second lesson call, reconnects by stored token", async () => {
    const h = await harness();
    await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    // Simulate: Fleet never got completeRetire (crash between step 7 and 8).
    h.fa.slots.set("0", { ...h.fa.slots.get("0")!, gen: 1, status: "retiring", reason: "false_claim" });
    const lessonsBefore = h.lessonCalls.length;
    const r = await resumeRetire(h.ctx, 0);
    expect(r.newRef?.name).toBe("w0-g2-r1");
    expect(h.lessonCalls.length).toBe(lessonsBefore);
    expect(h.fa.slots.get("0")).toMatchObject({ gen: 2, status: "probation" });
  });

  test("slot not retiring: returns its current generation, does nothing", async () => {
    const h = await harness();
    const r = await resumeRetire(h.ctx, 1);
    expect(r.newRef).toEqual({ slot: 1, gen: 1, name: "w1-g1-r1" });
    expect(h.fa.calls).toEqual([]);
  });
});

describe("probation, recovery, lessons", () => {
  test("probation -> trusted after thresholds.probation_verified_steps verified steps", async () => {
    const h = await harness();
    const { newRef } = await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    expect((await noteVerifiedStep(h.ctx, newRef!, 1)).status).toBe("probation");
    expect((await noteVerifiedStep(h.ctx, newRef!, 2)).status).toBe("trusted");
    expect(h.fa.slots.get("0")!.status).toBe("trusted");
    expect(h.events.at(-1)).toMatchObject({ type: "agent.status", slot: 0, gen: 2, status: "trusted" });
    // stale generation is ignored
    expect((await noteVerifiedStep(h.ctx, ref0, 3)).status).toBeNull();
  });

  test("markTestsPassing publishes recovery once with ms = testsPassingAt - detectedAt", async () => {
    const h = await harness();
    const detected = Date.now() - 1000;
    const { newRef } = await retireAgent(h.ctx, ref0, "false_claim", f1Evidence(detected));
    expect(markTestsPassing(h.ctx, ref0)).toBeNull(); // gen 1 never closes a recovery
    const out = markTestsPassing(h.ctx, newRef!, detected + 4321)!;
    expect(out.ms).toBe(4321);
    expect(out.caseId).toBe("r1.0.g1");
    expect(h.events.at(-1)).toMatchObject({ type: "recovery", caseId: "r1.0.g1", ms: 4321, slot: 0 });
    expect(markTestsPassing(h.ctx, newRef!)).toBeNull();
  });

  test("rebuildLessons restores the block from the case library", async () => {
    const h = await harness();
    await retireAgent(h.ctx, ref0, "false_claim", f1Evidence());
    h.ctx.setLessons([]);
    expect(await rebuildLessons(h.ctx)).toEqual(["Report tests_pass only after running the tests and seeing them pass."]);
  });

  test("parseLesson / appendLesson / lessonsFromCases", () => {
    expect(parseLesson("NO_LESSON")).toEqual({ lesson: null, nullReason: "no_lesson" });
    expect(parseLesson("  \n")).toEqual({ lesson: null, nullReason: "empty" });
    expect(parseLesson('- "Treat amounts as dollars, per the spec."\nextra').lesson).toBe("Treat amounts as dollars, per the spec.");
    expect(parseLesson(Array(40).fill("w").join(" ")).lesson!.split(" ")).toHaveLength(30);
    expect(parseLesson("Never assume amounts are stored in integer cents.", "amounts are stored in integer cents").nullReason).toBe("repeats_claim");
    expect(appendLesson(["a", "b"], "c", 2)).toEqual(["b", "c"]);
    expect(appendLesson(["a", "b"], "a", 5)).toEqual(["b", "a"]);
    expect(appendLesson(["a"], null, 5)).toEqual(["a"]);
    expect(
      lessonsFromCases(
        [
          { id: "x", lesson: "2", createdAt: 2 },
          { id: "y", lesson: "1", createdAt: 1 },
          { id: "z", lesson: null, createdAt: 3 },
          { id: "w", lesson: "r", createdAt: 4, revoked: true },
        ],
        10,
      ),
    ).toEqual(["1", "2"]);
  });
});
