// Reducer tests with synthetic events. Run: cd dashboard && bun test src/data
// (bun injects test/expect as globals; declared here so the app tsconfig needs no bun types).
import type * as W from "@contract/types";
import { CHUNKS_CAP, countCells, diffCount, FLEET_HISTORY_CAP } from "./fleet";
import { applyEvent, emptyState, type DataState } from "./state";
import { toBenchHeadline } from "./adapt";

declare const test: (name: string, fn: () => void) => void;
declare const expect: (v: unknown) => {
  toBe(x: unknown): void;
  toEqual(x: unknown): void;
  toBeNull(): void;
  toBeGreaterThan(x: number): void;
  not: { toBe(x: unknown): void };
};

let seq = 0;
const ev = <T extends W.DashboardEvent["type"]>(type: T, body: Omit<Extract<W.DashboardEvent, { type: T }>, "type" | "runId" | "ts">, runId = "r1", ts = 1000 + seq): W.SequencedEvent =>
  ({ type, runId, ts, seq: ++seq, mock: true, ...body }) as unknown as W.SequencedEvent;

const run = (runId: string, startedAt: number, status: W.RunStatus = "running"): W.SequencedEvent =>
  ev("run.status", {
    run: { runId, taskId: "invoice_parser", mode: "ours", libraryId: `lib-${runId}`, status, model: "m", startedAt, agents: 1000, retires: 0, cases: 0, testsPassing: 0, testsTotal: 1000, usd: 0 },
  }, runId);

const grid = (cells: string, runId = "r1") => ev("fleet.grid", { grid: { agents: cells.length, teams: Math.ceil(cells.length / 4), agentsPerTeam: 4, cells } }, runId);

function stats(i: number, runId = "r1"): W.SequencedEvent {
  const s: W.FleetStats = {
    agents: 1000, teams: 250, elapsedMs: i * 1000, byStatus: { trusted: 990, possessed: 10 }, steps: i * 10,
    subtasksPassing: i, teamsPassing: 0, poison: { injected: 50, caught: i, spread: 1 }, falseClaimsCaught: i,
    messagesBlocked: i, poisonedFactsRejected: 0, trapHits: i, repeatTrapHits: 0, trapHitRateRecent: { window: 50, rate: i === 0 ? null : 1 / i },
    cases: i, lessons: i, lessonsDelivered: 2 * i, retired: i, respawned: i, tokens: { input: 100 * i, cached: 50 * i, output: 10 * i, reasoning: 5 * i },
    usd: i / 100, reuseEstTokens: 7 * i, chunks: { created: i, reused: 2 * i, revoked: 0 }, poisonedContextTokensDropped: 300 * i,
    caucus: { threads: i, replies: 2 * i }, overheadShare: 0.1, llmInFlight: 3, testsInFlight: 1, measured: true,
  };
  return ev("fleet.stats", { stats: s }, runId);
}

const apply = (st: DataState, ...evs: W.SequencedEvent[]) => evs.reduce(applyEvent, st);

test("countCells and diffCount", () => {
  expect(countCells("TTPX..IRFD?")).toEqual({ ".": 2, T: 2, P: 1, I: 1, R: 1, F: 1, D: 1, X: 1 });
  expect(diffCount(null, "TTTT")).toBe(4);
  expect(diffCount("TTTT", "TXTT")).toBe(1);
  expect(diffCount("TT", "TTPP")).toBe(2);
});

test("fleet.grid keeps the raw string, the previous string and counts", () => {
  let st = apply(emptyState(), run("r1", 1), grid("T".repeat(1000)));
  const g1 = st.snapshot.fleetGrid!;
  expect(g1.prevCells).toBeNull();
  expect(g1.counts.T).toBe(1000);
  expect(g1.agentsPerTeam).toBe(4);
  const cells2 = "X" + "T".repeat(998) + "I";
  st = apply(st, grid(cells2));
  const g2 = st.snapshot.fleetGrid!;
  expect(g2.cells).toBe(cells2);
  expect(g2.prevCells).toBe(g1.cells);
  expect(g2.changed).toBe(2);
  expect(g2.counts).toEqual({ ".": 0, T: 998, P: 0, I: 1, R: 0, F: 0, D: 0, X: 1 });
  // Unrelated events keep the grid reference (cheap re-renders).
  const before = st.snapshot.fleetGrid;
  st = apply(st, stats(1));
  expect(st.snapshot.fleetGrid).toBe(before);
});

test("fleet.stats: current, history capped at 120, est flag, token rename, stale seq ignored", () => {
  let st = apply(emptyState(), run("r1", 1));
  for (let i = 0; i < 130; i++) st = apply(st, stats(i));
  const fs = st.snapshot.fleetStats;
  expect(fs.history.length).toBe(FLEET_HISTORY_CAP);
  expect(fs.history[0]!.trapHits).toBe(10);
  expect(fs.history.at(-1)!.trapHits).toBe(129);
  expect(fs.current!.tokens).toEqual({ input: 12900, cachedInput: 6450, output: 1290, reasoning: 645 });
  expect(fs.current!.est.reuseEstTokens).toBe(true);
  expect(fs.history.at(-1)!.trapHitRate).toBe(1 / 129);
  // A replayed older tick does not change anything.
  const old = { ...stats(5), seq: 3 } as W.SequencedEvent;
  expect(applyEvent(st, old).snapshot.fleetStats).toBe(fs);
});

test("chunks: created, reused, revoked, totals, cap", () => {
  const chunk = (id: string): W.ChunkInfo => ({ id, runId: "r1", sourceAgent: "t0w1-g1-r1", slot: 1, gen: 1, step: 3, fn: "parse_amount", note: "dollars", sourceOutputTokens: 600, createdAt: 5 });
  let st = apply(emptyState(), run("r1", 1), ev("chunk.created", { chunk: chunk("c1") }));
  st = apply(st, ev("chunk.reused", { chunkId: "c1", byAgent: "t0w2-g1-r1", reuseEstTokens: 600 }), ev("chunk.reused", { chunkId: "c1", byAgent: "t1w0-g1-r1", reuseEstTokens: 600 }));
  st = apply(st, ev("chunk.revoked", { chunkId: "c1", reason: "trap test failed", notified: ["t0w2-g1-r1"] }));
  st = apply(st, ev("chunk.revoked", { chunkId: "c1", reason: "again", notified: [] })); // idempotent
  const c = st.snapshot.chunks;
  expect(c.recent[0]!.reusedBy).toEqual(["t0w2-g1-r1", "t1w0-g1-r1"]);
  expect(c.recent[0]!.reuseEstTokens).toBe(1200);
  expect(c.recent[0]!.revoked!.reason).toBe("trap test failed");
  expect(c.totals).toEqual({ created: 1, reused: 2, revoked: 1, reuseEstTokens: 1200 });
  for (let i = 0; i < CHUNKS_CAP + 5; i++) st = apply(st, ev("chunk.created", { chunk: chunk(`k${i}`) }));
  expect(st.snapshot.chunks.recent.length).toBe(CHUNKS_CAP);
  expect(st.snapshot.chunks.recent.at(-1)!.id).toBe(`k${CHUNKS_CAP + 4}`);
  expect(st.snapshot.chunks.totals.created).toBe(CHUNKS_CAP + 6);
});

test("context.cleansed accumulates dropped tokens", () => {
  const cl = (slot: number, dropped: number) => ev("context.cleansed", { slot, fromGen: 1, toGen: 2, droppedPromptTokens: dropped, handoffPromptTokens: 900 });
  const st = apply(emptyState(), run("r1", 1), cl(7, 12000), cl(9, 8000));
  expect(st.snapshot.cleansing.count).toBe(2);
  expect(st.snapshot.cleansing.totalDroppedTokens).toBe(20000);
  expect(st.snapshot.cleansing.totalHandoffTokens).toBe(1800);
  expect(st.snapshot.cleansing.recent.map((x) => x.slot)).toEqual([7, 9]);
});

test("a newer run resets the fleet slices; other runs' events are ignored", () => {
  let st = apply(emptyState(), run("r1", 1), grid("TTTT"), stats(1));
  st = apply(st, grid("PPPP", "other"));
  expect(st.snapshot.fleetGrid!.cells).toBe("TTTT");
  st = apply(st, run("r2", 2, "starting"));
  expect(st.snapshot.fleetGrid).toBeNull();
  expect(st.snapshot.fleetStats.current).toBeNull();
  st = apply(st, grid("DDDD", "r2"));
  expect(st.snapshot.fleetGrid!.prevCells).toBeNull();
});

test("agent.status faultAt starts the recovery timer at the fault and the end never moves it", () => {
  const card = (status: W.AgentStatus, gen = 1): W.AgentCard => ({ slot: 3, name: `w3-g${gen}-r1`, gen, status, step: 2, subtask: "f", tokens: { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 }, possessed: true, verifiedSteps: 0 });
  let st = apply(emptyState(), run("r1", 1), ev("roster", { agents: [card("trusted")] }));
  st = apply(st, ev("agent.status", { slot: 3, gen: 1, status: "trusted", step: 3, reason: "fault F1 fired", faultAt: 500, fault: "F1", agent: card("trusted") }));
  let r = st.snapshot.recoveries[0]!;
  expect(r.caseId).toBe("r1.3.g1");
  expect(r.faultAt).toBe(500);
  expect(r.startAt).toBe(500);
  st = apply(st, ev("agent.status", { slot: 3, gen: 1, status: "under_investigation", step: 3, agent: card("under_investigation") }));
  r = st.snapshot.recoveries[0]!;
  expect(r.startAt).toBe(500);
  expect(r.detectedAt).not.toBe(null);
  st = apply(st, ev("recovery", { caseId: "r1.3.g1", ms: 9000, slot: 3, stages: { faultAt: 500, detectedAt: 900, retireBeganAt: 950, caseFiledAt: 1000, respawnedAt: 1100, testsPassingAt: 9900 } }));
  r = st.snapshot.recoveries[0]!;
  expect(r.startAt).toBe(500);
  expect(r.testsPassAt).toBe(9900);
  expect(r.stagesFromServer).toBe(true);
});

test("fleet-mode team case ids (<runId>-t<team>.<local>.g<gen>) merge into the row the status stream opened", () => {
  const card = (status: W.AgentStatus, gen = 1): W.AgentCard => ({ slot: 18, name: `w2-g${gen}-r1-t4`, gen, status, step: 2, subtask: "f", tokens: { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 }, possessed: false, verifiedSteps: 0 });
  let st = apply(emptyState(), run("r1", 1), ev("roster", { agents: [card("trusted")] }));
  st = apply(st, ev("agent.status", { slot: 18, gen: 1, status: "trusted", step: 3, faultAt: 500, fault: "F3", agent: card("trusted") }));
  st = apply(st, ev("agent.status", { slot: 18, gen: 1, status: "retiring", step: 3, agent: card("retiring") }));
  st = apply(st, ev("recovery", { caseId: "r1-t4.2.g1", ms: 6000, slot: 18, stages: { faultAt: 500, detectedAt: 900, retireBeganAt: 950, caseFiledAt: 1000, respawnedAt: 1100, testsPassingAt: 6900 } }));
  expect(st.snapshot.recoveries.length).toBe(1);
  const r = st.snapshot.recoveries[0]!;
  expect(r.caseId).toBe("r1-t4.2.g1");
  expect(r.testsPassAt).toBe(6900);
  expect(r.startAt).toBe(500);
});

test("bench headline: one suite (most trials on both sides), never pooled across task versions", () => {
  const g = (mode: W.BenchMode, v: number, trials: number, tpp: number): W.BenchSummaryGroup => ({
    group: `${mode}@v${v}`, mode, task_version: v, label: "", trials, passes: trials, tasks: ["a", "b", "c"],
    success_rate: { mean: 1, min: 1, max: 1, n: trials }, tokens_per_passing_task: { mean: tpp, min: tpp, max: tpp, n: trials }, tokens_per_passing_task_pooled: tpp,
  });
  const s: W.BenchmarkSummary = { generated_at: "", mock: false, rows_used: 0, note: "", groups: [
    g("codex_baseline", 1, 9, 907172), g("codex_baseline", 2, 9, 852190.5556), g("ours_cold", 2, 9, 53092.7778), g("codex_baseline", 3, 9, 2143854), g("ours_cold", 3, 6, 263191.6667),
  ] };
  const h = toBenchHeadline(s)!;
  expect(h.taskVersion).toBe(2);
  expect(h.ratio.toFixed(2)).toBe("16.05");
  expect(h.suite).toBe("tasks v2");
  expect(toBenchHeadline({ ...s, groups: s.groups.filter((x) => x.task_version !== 2) })!.taskVersion).toBe(3);
  expect(toBenchHeadline(null)).toBeNull();
});
