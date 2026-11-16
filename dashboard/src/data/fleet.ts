// Fleet-scale mode reducers (fleet.grid, fleet.stats, chunk.*, context.cleansed). Pure.
// Built for ~1 tick/s at 1,000 agents: no per-agent objects, one counting pass per grid.
import type * as W from "@contract/types";
import type {
  ChunksState,
  ChunkView,
  CleansingState,
  FleetCellCode,
  FleetGridView,
  FleetStatPoint,
  FleetStatsState,
  FleetStatsView,
} from "./model";

export const FLEET_HISTORY_CAP = 120;
export const CHUNKS_CAP = 200;
export const CLEANSING_CAP = 100;

/** Mirrors the wire FLEET_GRID_CODES (a runtime const the type-only re-export cannot carry). */
export const FLEET_CELL_STATUS = {
  ".": "queued",
  T: "trusted",
  P: "probation",
  I: "under_investigation",
  R: "retired",
  F: "failed",
  D: "done",
  X: "possessed",
} as const satisfies Record<FleetCellCode, string>;
export const FLEET_CELL_CODES = Object.keys(FLEET_CELL_STATUS) as FleetCellCode[];

export const EMPTY_FLEET_STATS: FleetStatsState = { current: null, history: [] };
export const EMPTY_CHUNKS: ChunksState = { recent: [], totals: { created: 0, reused: 0, revoked: 0, reuseEstTokens: 0 } };
export const EMPTY_CLEANSING: CleansingState = { recent: [], count: 0, totalDroppedTokens: 0, totalHandoffTokens: 0 };

const CODE_INDEX: Record<string, number> = Object.fromEntries(FLEET_CELL_CODES.map((c, i) => [c, i]));

/** Agents per code; unknown chars are ignored. */
export function countCells(cells: string): Record<FleetCellCode, number> {
  const n = new Array<number>(FLEET_CELL_CODES.length).fill(0);
  for (let i = 0; i < cells.length; i++) {
    const k = CODE_INDEX[cells[i]!];
    if (k !== undefined) n[k]! += 1;
  }
  const out = {} as Record<FleetCellCode, number>;
  FLEET_CELL_CODES.forEach((c, i) => (out[c] = n[i]!));
  return out;
}

export function diffCount(prev: string | null, next: string): number {
  if (prev === null) return next.length;
  const len = Math.max(prev.length, next.length);
  let changed = 0;
  for (let i = 0; i < len; i++) if (prev.charCodeAt(i) !== next.charCodeAt(i)) changed++;
  return changed;
}

export function applyGrid(prev: FleetGridView | null, runId: string, seq: number, ts: number, g: W.FleetGrid): FleetGridView {
  const prevCells = prev && prev.runId === runId ? prev.cells : null;
  return {
    runId,
    seq,
    ts,
    agents: g.agents,
    teams: g.teams,
    agentsPerTeam: g.agentsPerTeam,
    cells: g.cells,
    prevCells,
    changed: diffCount(prevCells, g.cells),
    counts: countCells(g.cells),
  };
}

export function toFleetStats(runId: string, seq: number, ts: number, s: W.FleetStats): FleetStatsView {
  return {
    runId,
    seq,
    ts,
    agents: s.agents,
    teams: s.teams,
    elapsedMs: s.elapsedMs,
    byStatus: s.byStatus,
    steps: s.steps,
    subtasksPassing: s.subtasksPassing,
    teamsPassing: s.teamsPassing,
    poison: s.poison,
    falseClaimsCaught: s.falseClaimsCaught,
    messagesBlocked: s.messagesBlocked,
    poisonedFactsRejected: s.poisonedFactsRejected,
    trapHits: s.trapHits,
    repeatTrapHits: s.repeatTrapHits,
    trapHitRateRecent: s.trapHitRateRecent,
    cases: s.cases,
    lessons: s.lessons,
    lessonsDelivered: s.lessonsDelivered,
    retired: s.retired,
    respawned: s.respawned,
    tokens: { input: s.tokens.input, cachedInput: s.tokens.cached, output: s.tokens.output, reasoning: s.tokens.reasoning },
    usd: s.usd,
    reuseEstTokens: s.reuseEstTokens,
    chunks: s.chunks,
    poisonedContextTokensDropped: s.poisonedContextTokensDropped,
    caucus: s.caucus,
    overheadShare: s.overheadShare,
    llmInFlight: s.llmInFlight,
    testsInFlight: s.testsInFlight,
    measured: true,
    est: { reuseEstTokens: true },
  };
}

function point(v: FleetStatsView): FleetStatPoint {
  return {
    ts: v.ts,
    elapsedMs: v.elapsedMs,
    trapHitRate: v.trapHitRateRecent.rate,
    trapHits: v.trapHits,
    poisonCaught: v.poison.caught,
    poisonSpread: v.poison.spread,
    falseClaimsCaught: v.falseClaimsCaught,
    messagesBlocked: v.messagesBlocked,
    cases: v.cases,
    lessonsDelivered: v.lessonsDelivered,
    chunksReused: v.chunks.reused,
    poisonedContextTokensDropped: v.poisonedContextTokensDropped,
    reuseEstTokens: v.reuseEstTokens,
    usd: v.usd,
  };
}

/** New current + history point. A tick older than the last one (replay overlap) is ignored. */
export function applyStats(prev: FleetStatsState, runId: string, seq: number, ts: number, s: W.FleetStats): FleetStatsState {
  const sameRun = prev.current?.runId === runId;
  if (sameRun && prev.current && seq <= prev.current.seq) return prev;
  const current = toFleetStats(runId, seq, ts, s);
  const base = sameRun ? prev.history : [];
  const history = base.length >= FLEET_HISTORY_CAP ? [...base.slice(base.length - FLEET_HISTORY_CAP + 1), point(current)] : [...base, point(current)];
  return { current, history };
}

function capPush<T>(list: T[], item: T, cap: number): T[] {
  return list.length >= cap ? [...list.slice(list.length - cap + 1), item] : [...list, item];
}

export function chunkCreated(st: ChunksState, c: W.ChunkInfo): ChunksState {
  if (st.recent.some((x) => x.id === c.id)) return st;
  const view: ChunkView = {
    id: c.id,
    runId: c.runId,
    sourceAgent: c.sourceAgent,
    slot: c.slot,
    gen: c.gen,
    step: c.step,
    fn: c.fn,
    note: c.note,
    sourceOutputTokens: c.sourceOutputTokens,
    createdAt: c.createdAt,
    reusedBy: [],
    reuseEstTokens: 0,
    revoked: null,
  };
  return { recent: capPush(st.recent, view, CHUNKS_CAP), totals: { ...st.totals, created: st.totals.created + 1 } };
}

function patchChunk(recent: ChunkView[], id: string, f: (c: ChunkView) => ChunkView): ChunkView[] {
  const i = recent.findIndex((c) => c.id === id);
  return i < 0 ? recent : recent.with(i, f(recent[i]!));
}

export function chunkReused(st: ChunksState, chunkId: string, byAgent: string, reuseEstTokens: number): ChunksState {
  return {
    recent: patchChunk(st.recent, chunkId, (c) => ({ ...c, reusedBy: [...c.reusedBy, byAgent], reuseEstTokens: c.reuseEstTokens + reuseEstTokens })),
    totals: { ...st.totals, reused: st.totals.reused + 1, reuseEstTokens: st.totals.reuseEstTokens + reuseEstTokens },
  };
}

export function chunkRevoked(st: ChunksState, chunkId: string, reason: string, notified: string[], ts: number): ChunksState {
  const known = st.recent.find((c) => c.id === chunkId);
  if (known?.revoked) return st;
  return {
    recent: patchChunk(st.recent, chunkId, (c) => ({ ...c, revoked: { reason, notified, ts } })),
    totals: { ...st.totals, revoked: st.totals.revoked + 1 },
  };
}

export function contextCleansed(
  st: CleansingState,
  ev: { runId: string; seq: number; ts: number; slot: number; fromGen: number; toGen: number; droppedPromptTokens: number; handoffPromptTokens: number },
): CleansingState {
  const id = `${ev.runId}:${ev.seq}`;
  if (st.recent.some((x) => x.id === id)) return st;
  const item = {
    id,
    seq: ev.seq,
    ts: ev.ts,
    runId: ev.runId,
    slot: ev.slot,
    fromGen: ev.fromGen,
    toGen: ev.toGen,
    droppedPromptTokens: ev.droppedPromptTokens,
    handoffPromptTokens: ev.handoffPromptTokens,
  };
  return {
    recent: capPush(st.recent, item, CLEANSING_CAP),
    count: st.count + 1,
    totalDroppedTokens: st.totalDroppedTokens + ev.droppedPromptTokens,
    totalHandoffTokens: st.totalHandoffTokens + ev.handoffPromptTokens,
  };
}
