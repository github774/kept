// MOCK fleet script tests (mock/fleet.ts). Numbers are invented; these check shape and consistency.
import { describe, expect, test } from "bun:test";
import { buildFleetScript, FleetSim } from "../mock/fleet.ts";
import { MockRuntimeService } from "../mock/service.ts";
import { FLEET_GRID_CODES } from "../src/fleet-codes.ts";
import { type DashboardEvent, type FleetGridCode, type FleetStats, type SequencedEvent } from "../src/contract.ts";

type Of<T extends DashboardEvent["type"]> = Extract<DashboardEvent, { type: T }>;
const ofType = <T extends DashboardEvent["type"]>(evs: DashboardEvent[], t: T): Of<T>[] => evs.filter((e) => e.type === t) as Of<T>[];

const events = buildFleetScript();

describe("mock fleet script", () => {
  test("deterministic: same options -> identical events", () => {
    expect(JSON.stringify(buildFleetScript())).toBe(JSON.stringify(events));
    expect(JSON.stringify(buildFleetScript({ seed: 8 }))).not.toBe(JSON.stringify(events));
  });

  test("every event is mock:true", () => {
    expect(events.every((e) => e.mock === true)).toBe(true);
  });

  test("one grid + stats per tick, grid length === agents, byStatus matches grid at every tick", () => {
    const grids = ofType(events, "fleet.grid");
    const stats = ofType(events, "fleet.stats");
    expect(grids.length).toBe(150);
    expect(stats.length).toBe(150);
    grids.forEach((g, k) => {
      expect(g.grid.cells.length).toBe(1000);
      expect(g.grid.agents).toBe(1000);
      expect(g.grid.teams).toBe(250);
      expect(g.grid.agentsPerTeam).toBe(4);
      const s = stats[k]!.stats;
      for (const code of Object.keys(FLEET_GRID_CODES) as FleetGridCode[]) {
        const n = [...g.grid.cells].filter((c) => c === code).length;
        expect(s.byStatus[FLEET_GRID_CODES[code]] ?? 0).toBe(n);
      }
      expect([...g.grid.cells].every((c) => c in FLEET_GRID_CODES)).toBe(true);
      expect(s.subtasksPassing).toBe(s.byStatus.done ?? 0);
    });
  });

  test("counters are monotonic and consistent", () => {
    const stats = ofType(events, "fleet.stats").map((e) => e.stats);
    const mono: ((s: FleetStats) => number)[] = [
      (s) => s.elapsedMs, (s) => s.steps, (s) => s.poison.injected, (s) => s.poison.caught, (s) => s.poison.spread,
      (s) => s.falseClaimsCaught, (s) => s.messagesBlocked, (s) => s.poisonedFactsRejected, (s) => s.trapHits,
      (s) => s.repeatTrapHits, (s) => s.cases, (s) => s.lessons, (s) => s.lessonsDelivered, (s) => s.retired,
      (s) => s.respawned, (s) => s.tokens.input, (s) => s.tokens.output, (s) => s.usd, (s) => s.reuseEstTokens,
      (s) => s.chunks.created, (s) => s.chunks.reused, (s) => s.chunks.revoked, (s) => s.poisonedContextTokensDropped,
      (s) => s.caucus.threads, (s) => s.caucus.replies,
    ];
    for (let k = 1; k < stats.length; k++) for (const f of mono) expect(f(stats[k]!)).toBeGreaterThanOrEqual(f(stats[k - 1]!));
    for (const s of stats) {
      expect(s.poison.caught).toBeLessThanOrEqual(s.poison.injected);
      expect(s.respawned).toBeLessThanOrEqual(s.retired);
      expect(s.repeatTrapHits).toBeLessThanOrEqual(s.trapHits);
      expect(s.caucus.replies).toBeLessThanOrEqual(3 * s.caucus.threads);
      expect(s.tokens.cached).toBeLessThanOrEqual(s.tokens.input);
      expect(s.tokens.reasoning).toBeLessThanOrEqual(s.tokens.output);
      expect(s.measured).toBe(true);
    }
    const last = stats.at(-1)!;
    expect(last.poison.injected).toBe(50);
    expect(last.poison.caught).toBe(50);
    expect(last.byStatus.done).toBe(1000);
    expect(last.teamsPassing).toBe(250);
    expect(last.overheadShare!).toBeLessThan(0.15);
    // Trap-hit rate falls as lessons spread.
    const firstRate = stats.find((s) => s.trapHitRateRecent.rate !== null)!.trapHitRateRecent.rate!;
    expect(last.trapHitRateRecent.rate!).toBeLessThan(firstRate);
  });

  test("story beats: possessed at t=5, mostly caught within 20 s, agent-level drill-down events", () => {
    const grids = ofType(events, "fleet.grid").map((g) => g.grid.cells);
    const xs = (c: string): number => [...c].filter((ch) => ch === "X").length;
    expect(xs(grids[4]!)).toBe(0);
    expect(xs(grids[5]!)).toBe(50);
    expect(xs(grids[25]!)).toBeLessThan(10);
    const cases = ofType(events, "case.created");
    const stats = ofType(events, "fleet.stats").at(-1)!.stats;
    expect(cases.length).toBe(stats.cases);
    expect(ofType(events, "context.cleansed").length).toBe(stats.respawned);
    expect(ofType(events, "recovery").length).toBe(stats.cases);
    expect(ofType(events, "chunk.created").length).toBe(stats.chunks.created);
    expect(ofType(events, "chunk.revoked").length).toBe(stats.chunks.revoked);
    expect(stats.chunks.revoked).toBeGreaterThan(0);
    expect(ofType(events, "case.reply").length).toBe(stats.caucus.replies);
    expect(ofType(events, "relay.message").filter((e) => e.item.blocked).length).toBe(stats.messagesBlocked);
    const c = cases[0]!.case;
    expect(c.id).toBe(`${c.runId}.${c.slot}.g${c.gen}`);
    expect(c.recipients.length).toBeGreaterThan(0);
  });

  test("possess marks the agent X, then it is caught, retired and respawned", () => {
    const sim = new FleetSim({ agents: 40, ticks: 60 });
    for (let k = 0; k < 12; k++) sim.step();
    const slot = [...Array(40).keys()].find((i) => sim.agentCode(i) === "T")!;
    expect(sim.possess(slot).ok).toBe(true);
    const evs: DashboardEvent[] = [];
    evs.push(...sim.step());
    expect(sim.agentCode(slot)).toBe("X");
    expect(sim.possess(slot)).toEqual({ ok: false, error: "already_possessed" });
    for (let k = 0; k < 10; k++) evs.push(...sim.step());
    expect(ofType(evs, "case.created").some((e) => e.case.slot === slot)).toBe(true);
    expect(ofType(evs, "context.cleansed").some((e) => e.slot === slot && e.toGen === 2)).toBe(true);
    expect(["P", "T", "D"]).toContain(sim.agentCode(slot)!);
    expect(sim.possess(9999)).toEqual({ ok: false, error: "no_such_slot" });
  });
});

describe("MockRuntimeService fleet mode", () => {
  test("agents > 4 plays the fleet script; agents <= 4 keeps the recording", async () => {
    const svc = new MockRuntimeService({ speed: 1000 });
    const got: SequencedEvent[] = [];
    const off = svc.subscribe((e) => got.push(e));
    const run = await svc.startRun({ taskId: "invoice_parser", mode: "ours", agents: 1000, poisonRate: 0.05 });
    expect(run.agents).toBe(1000);
    expect(run.mock).toBe(true);
    const g = got.find((e) => e.type === "fleet.grid") as Of<"fleet.grid"> | undefined;
    expect(g?.grid.cells.length).toBe(1000);
    expect((await svc.getRoster(run.runId)).length).toBe(1000);
    // Run a few ticks, then possess an active agent.
    await Bun.sleep(30);
    const roster = await svc.getRoster(run.runId);
    const slot = roster.find((a) => a.status === "trusted" && !a.possessed)!.slot;
    expect((await svc.possess(run.runId, slot)).ok).toBe(true);
    svc.drain();
    expect(got.at(-1)!.type).toBe("fleet.stats");
    expect(got.every((e) => e.mock === true)).toBe(true);
    expect((await svc.possess(run.runId, slot)).ok).toBe(false);
    off();

    const small = await svc.startRun({ taskId: "invoice_parser", mode: "ours" });
    expect(small.agents).toBe(4);
    svc.drain();
    expect(svc.replay(0).some((e) => e.type === "roster")).toBe(true);
    svc.stop();
  });
});
