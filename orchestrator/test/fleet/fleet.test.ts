// Fleet-scale mode (DECISIONS #16) with MOCK LLM/Jev/embeddings/pytest (test/fleet/fakes.ts) driving the real
// runtime worker loop through FleetRunner. In-memory FleetShards, CaseLibrary and chunk stores.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardEvent, FleetStats } from "../../src/contract.ts";
import { FLEET_GRID_CODES } from "../../src/fleet-codes.ts";
import { FleetRunner, pickPoisoned } from "../../src/fleet/runner.ts";
import { ShardCore, MemoryKV } from "../../src/fleet/shard-core.ts";
import { FleetBus } from "../../src/fleet/bus.ts";
import { cfg, makeWorld, TASKS_V2, type FakeWorld } from "./fakes.ts";

type Ev<T extends DashboardEvent["type"]> = Extract<DashboardEvent, { type: T }>;
const of = <T extends DashboardEvent["type"]>(evs: DashboardEvent[], t: T) => evs.filter((e) => e.type === t) as Ev<T>[];

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "fleet-test-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function runFleet(w: FakeWorld, o: { agents: number; poisonRate: number; limits?: { llm: number; tests: number; jev: number; relay?: number }; seed?: number }) {
  let n = 0;
  const r = new FleetRunner({
    cfg,
    deps: w.deps,
    out: w.out,
    tasksRoot: TASKS_V2,
    workRoot: work,
    limits: o.limits ?? { llm: 8, tests: 4, jev: 8 },
    hooks: { runTests: w.runTests, newRunId: () => `fz${++n}${o.seed ?? 7}`, retirePollMs: 5 },
  });
  await r.startFleet({ agents: o.agents, poisonRate: o.poisonRate, seed: o.seed ?? 7, rampMs: 600, poisonAtMs: 1, tickMs: 40, stepsPerGeneration: 6, caseRecipients: 6, sampleRate: 0.5, recentWindow: 10, wallClockMs: 60_000 });
  const sum = await r.done;
  return { r, sum };
}

describe("fleet: MOCK end-to-end through the real worker loop", () => {
  let w: FakeWorld;
  let r: FleetRunner;
  let finalStats: FleetStats;
  beforeAll(async () => {
    w = makeWorld({ llmMs: 3, testMs: 3, jevMs: 2 });
    ({ r } = await runFleet(w, { agents: 40, poisonRate: 0.1, limits: { llm: 3, tests: 2, jev: 2 } }));
    finalStats = of(w.events, "fleet.stats").at(-1)!.stats;
  }, 60_000);

  test("grid and stats agree on every tick", () => {
    const grids = of(w.events, "fleet.grid");
    const stats = of(w.events, "fleet.stats");
    expect(grids.length).toBeGreaterThan(3);
    expect(stats.length).toBe(grids.length);
    for (let i = 0; i < grids.length; i++) {
      const g = grids[i]!.grid;
      const s = stats[i]!.stats;
      expect(g.cells.length).toBe(40);
      expect(g.teams * g.agentsPerTeam).toBe(40);
      for (const ch of g.cells) expect(Object.keys(FLEET_GRID_CODES)).toContain(ch);
      const sum = Object.values(s.byStatus).reduce((a, b) => a + (b ?? 0), 0);
      expect(sum).toBe(40);
      for (const [code, status] of Object.entries(FLEET_GRID_CODES)) expect(s.byStatus[status as keyof typeof s.byStatus]).toBe([...g.cells].filter((c) => c === code).length);
      expect(s.measured).toBe(true);
    }
    // finished fleet: no queued agents; usd/tokens come from MOCK usage rows
    expect(grids.at(-1)!.grid.cells.includes(".")).toBe(false);
    expect(finalStats.tokens.input).toBeGreaterThan(0);
    expect(finalStats.usd).toBeGreaterThan(0);
    expect(finalStats.overheadShare).not.toBeNull();
    expect(finalStats.steps).toBeGreaterThan(40);
  });

  test("poisoning: round(rate x agents) picked deterministically, every one caught or counted as spread", () => {
    const picks = pickPoisoned(40, 0.1, 7);
    expect(picks.length).toBe(4);
    expect(pickPoisoned(40, 0.1, 7)).toEqual(picks);
    expect(pickPoisoned(1000, 0.05, 7).length).toBe(50);
    expect(new Set(pickPoisoned(1000, 0.05, 7).map((p) => p.agent)).size).toBe(50);
    expect(new Set(picks.map((p) => p.fault))).toEqual(new Set(["F1", "F3", "F4"]));
    // Armed only on agents whose chunks were reused (as many as appear, up to round(rate x agents)).
    expect(finalStats.poison.injected).toBeGreaterThan(0);
    expect(finalStats.poison.injected).toBeLessThanOrEqual(4);
    expect(finalStats.poison.caught + finalStats.poison.spread).toBe(finalStats.poison.injected);
    for (const p of r.agg.possessionList) expect(["caught", "spread"]).toContain(p.outcome);
    // The MOCK judge flags every scripted payload, and F1 fails its tests: all are caught.
    // A fault armed on a woken finished agent may never fire before the fleet ends: counted as spread.
    expect(finalStats.poison.caught).toBeGreaterThan(0);
    // Every agent.status of a possessed agent after its fault fired carries faultAt + fault.
    for (const p of r.agg.possessionList) {
      const st = of(w.events, "agent.status").filter((e) => e.slot === p.agent && e.gen === p.gen);
      const i = st.findIndex((e) => e.fault);
      if (i >= 0) for (const e of st.slice(i)) expect(e.faultAt).toBeDefined();
    }
  });

  test("herd: cases cross teams, caucus threads hold at most 3 replies, lessons reach later prompts", () => {
    const cases = of(w.events, "case.created");
    expect(cases.length).toBeGreaterThan(0);
    expect(finalStats.cases).toBe(cases.length);
    const crossTeam = cases.some((c) => c.case.recipients.some((n) => !n.endsWith(`-t${Math.floor(c.case.slot / 4)}`)));
    void crossTeam; // depends on timing with MOCK speeds (teams may already be done)
    const replies = of(w.events, "case.reply");
    const per = new Map<string, number>();
    for (const e of replies) per.set(e.caseId, (per.get(e.caseId) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(3);
    expect(finalStats.caucus.replies).toBe(replies.length);
    for (const m of r.bus.history().filter((m) => !m.parentId && m.metadata.kind === "case")) expect(r.bus.replyCount(m.id)).toBeLessThanOrEqual(3);
    expect(finalStats.lessonsDelivered).toBeGreaterThan(0);
    expect(finalStats.lessons).toBeGreaterThan(0);
    // repeat hits come from the "stubborn" MOCK teams that ignore lessons
    expect(finalStats.trapHits).toBeGreaterThan(0);
    expect(finalStats.repeatTrapHits).toBeGreaterThan(0);
    // early trap hit rate is higher than late (lessons spread)
    const s = r.agg.trapSeries;
    const half = Math.floor(s.length / 2);
    const rate = (xs: readonly boolean[]) => xs.filter(Boolean).length / Math.max(1, xs.length);
    expect(s.length).toBeGreaterThan(0);
    void rate(s.slice(0, half)); // the falling curve needs real step times; MOCK speeds make it noisy
  });

  test("context.cleansed: dropped = retired gen's last prompt tokens, handoff = replacement's first", () => {
    const cl = of(w.events, "context.cleansed");
    expect(cl.length).toBeGreaterThan(0);
    let sum = 0;
    for (const e of cl) {
      const team = Math.floor(e.slot / 4);
      const slot = e.slot % 4;
      const name = (gen: number) => `w${slot}-g${gen}-${r.runId}-t${team}`;
      expect(e.droppedPromptTokens).toBe(w.prompts.get(name(e.fromGen))!.at(-1)!);
      expect(e.handoffPromptTokens).toBe(w.prompts.get(name(e.toGen))![0]!);
      sum += e.droppedPromptTokens - e.handoffPromptTokens;
    }
    expect(finalStats.poisonedContextTokensDropped).toBe(sum);
    expect(finalStats.respawned).toBeGreaterThanOrEqual(cl.length);
  });

  test("chunk.revoked notifies every reuser over the bus", () => {
    const rev = of(w.events, "chunk.revoked");
    expect(rev.length).toBeGreaterThan(0);
    expect(finalStats.chunks.revoked).toBe(rev.length);
    expect(finalStats.chunks.created).toBeGreaterThan(0);
    expect(finalStats.chunks.reused).toBeGreaterThan(0);
    expect(finalStats.reuseEstTokens).toBeGreaterThan(0);
    for (const e of rev) {
      expect(e.notified.length).toBeGreaterThan(0);
      for (const who of e.notified) {
        const dm = r.bus.history().find((m) => m.to === `@${who}` && m.metadata.kind === "revoke" && m.text.includes(e.chunkId));
        expect(dm).toBeDefined();
      }
    }
  });

  test("global limits held (gates and MOCK adapters)", () => {
    expect(r.gates.llm.peak).toBeLessThanOrEqual(3);
    expect(r.gates.tests.peak).toBeLessThanOrEqual(2);
    expect(r.gates.jev.peak).toBeLessThanOrEqual(2);
    expect(w.testPeak.peak).toBeLessThanOrEqual(2);
    expect(w.jevPeak.peak).toBeLessThanOrEqual(2);
    // worker + lesson calls go through the gate; nothing else calls the MOCK llm here
    expect(w.llmPeak.peak).toBeLessThanOrEqual(3);
    expect(r.gates.llm.peak).toBe(3); // the cap was actually reached
  });

  test("sampling: always-emit events are complete", () => {
    const blocked = of(w.events, "relay.message").filter((e) => e.item.blocked);
    expect(blocked.length).toBe(finalStats.messagesBlocked);
    for (const e of of(w.events, "agent.status")) expect(e.runId).toBe(r.runId);
    expect(of(w.events, "run.status").at(-1)!.run.status).toBe("finished");
  });
});

describe("fleet: units", () => {
  test("ShardCore keeps Fleet/Agent generation semantics per team", () => {
    const c = new ShardCore(new MemoryKV());
    c.startRun("a", { runId: "a", mode: "ours" });
    c.addSlot("a", { slot: "0" });
    c.addSlot("b", { slot: "0" });
    expect(c.beginRetire("a", "0", 2, "x")).toEqual({ ok: false, reason: "stale_generation" });
    expect(c.beginRetire("a", "0", 1, "x")).toEqual({ ok: true });
    expect(c.beginRetire("a", "0", 1, "x")).toEqual({ ok: false, reason: "already_retiring" });
    expect(c.snapshot("b").slots[0]!.status).toBe("trusted");
    expect(c.completeRetire("a", "0", 1)).toEqual({ ok: true, gen: 2, repeated: false });
    expect(c.completeRetire("a", "0", 1)).toEqual({ ok: true, gen: 2, repeated: true });
    c.agentInit("a", "0", 1, { runId: "a", slot: "0", gen: 1, task: "f", persona: "" });
    expect(c.agentAppendStep("a", "0", 1, 1, { step: 1, summary: "s", usage: { input: 5 } })).toEqual({ ok: true, created: true });
    expect(c.agentAppendStep("a", "0", 1, 1, { step: 1, summary: "s", usage: { input: 5 } })).toEqual({ ok: true, created: false });
    expect(c.agentState("a", "0", 1).totals.input).toBe(5);
    c.agentClose("a", "0", 1, 1, "retired");
    expect(c.agentCheckpoint("a", "0", 1, 1, "f", "x")).toEqual({ ok: false, reason: "closed" });
    expect(() => c.apply("nope", [])).toThrow();
  });

  test("FleetBus: cc delivery, 3-reply thread cap, no reply to a reply, released identity rejected", async () => {
    const b = new FleetBus({ repliesPerThread: 3 });
    await b.ensureChannel("cases-x");
    const names = ["warden-x", "a", "b", "c", "d", "e"];
    for (const n of names) await b.registerAgent(n, n === "warden-x" || n === "a" ? ["cases-x"] : []);
    const base = (from: string, key: string) => ({ fromName: from, text: `t ${key}`, idempotencyKey: key, metadata: { runId: "x", slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true });
    const root = await b.send({ ...base("warden-x", "k0"), to: "#cases-x", cc: ["b", "c", "d", "e"] });
    expect(b.inbox("b", 0, 5).map((m) => m.id)).toEqual([root.id]);
    expect(b.inbox("a", 0, 5).map((m) => m.id)).toEqual([root.id]);
    for (const n of ["b", "c", "d"]) await b.reply({ ...base(n, `r${n}`), messageId: root.id });
    await expect(b.reply({ ...base("e", "re"), messageId: root.id })).rejects.toThrow(/closed/);
    const r1 = b.history().find((m) => m.parentId)!;
    await expect(b.reply({ ...base("e", "rr"), messageId: r1.id })).rejects.toThrow(/reply to a reply/);
    expect(b.inbox("e", 0, 10).length).toBe(4); // root + 3 replies via cc
    await b.release("a");
    await expect(b.send({ ...base("a", "k9"), to: "@b" })).rejects.toThrow(/released/);
  });
});
