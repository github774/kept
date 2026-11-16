// Pure state transitions: SequencedEvents and REST snapshots -> view Snapshot.
// Every change returns new objects only for the slices it touched, so selector
// hooks keep stable references.
import type * as W from "@contract/types";
import { toAgent, toCaseFile, toCaseReply, toCaseSummary, toJev, toLedger, toRelay, toRun, toSwarm } from "./adapt";
import {
  applyGrid,
  applyStats,
  chunkCreated,
  chunkReused,
  chunkRevoked,
  contextCleansed,
  EMPTY_CHUNKS,
  EMPTY_CLEANSING,
  EMPTY_FLEET_STATS,
} from "./fleet";
import type { AgentSlot, CaseFile, DataOrigin, Metrics, Recovery, RunInfo, Snapshot } from "./model";

export const RELAY_CAP = 200;

export interface DataState {
  snapshot: Snapshot;
  currentRunId: string | null;
  caseFiles: Record<string, CaseFile>; // full case files seen in events or REST
}

const NO_METRICS: Metrics = {
  repeatFailures: null,
  trapHits: null,
  casesBroadcast: null,
  lessonsAdopted: null,
  chunksShared: null,
  chunksReused: null,
  retires: null,
  cases: null,
};

export function emptyState(origin: DataOrigin = "live"): DataState {
  return {
    currentRunId: null,
    caseFiles: {},
    snapshot: {
      run: null,
      runs: [],
      roster: [],
      ledger: null,
      cases: [],
      relay: [],
      recoveries: [],
      metrics: NO_METRICS,
      health: { jevOffline: false, jev: null, actorsConnected: null, relayConnected: null },
      swarm: null,
      fleetGrid: null,
      fleetStats: EMPTY_FLEET_STATS,
      chunks: EMPTY_CHUNKS,
      cleansing: EMPTY_CLEANSING,
      origin,
    },
  };
}

// ------------------------------------------------------------------ helpers
const setSnap = (st: DataState, patch: Partial<Snapshot>): DataState => ({ ...st, snapshot: { ...st.snapshot, ...patch } });

function markMock(st: DataState, mock: boolean | undefined): DataState {
  return mock && st.snapshot.origin !== "mock" ? setSnap(st, { origin: "mock" }) : st;
}

function metricsFor(run: RunInfo | null, prev: Metrics): Metrics {
  if (!run) return { ...prev, repeatFailures: null, trapHits: null, casesBroadcast: null, lessonsAdopted: null, retires: null, cases: null };
  return {
    ...prev,
    repeatFailures: run.repeatFailures,
    trapHits: run.immunity?.trapHits ?? null,
    casesBroadcast: run.immunity?.casesBroadcast ?? null,
    lessonsAdopted: run.immunity?.lessonsAdopted ?? null,
    retires: run.retires,
    cases: run.cases,
  };
}

function resetRun(st: DataState, runId: string): DataState {
  const caseFiles = Object.fromEntries(Object.entries(st.caseFiles).filter(([, c]) => c.runId !== runId));
  return {
    ...st,
    currentRunId: runId,
    caseFiles,
    snapshot: {
      ...st.snapshot,
      roster: [],
      ledger: null,
      cases: [],
      relay: [],
      recoveries: [],
      fleetGrid: null,
      fleetStats: EMPTY_FLEET_STATS,
      chunks: EMPTY_CHUNKS,
      cleansing: EMPTY_CLEANSING,
    },
  };
}

/** Per-run events for another run are ignored; the first run seen becomes current. */
function forCurrent(st: DataState, runId: string): DataState | null {
  if (st.currentRunId === null) return { ...st, currentRunId: runId };
  return st.currentRunId === runId ? st : null;
}

const newRecovery = (caseId: string, slot: number, gen: number): Recovery => ({
  caseId,
  slot,
  gen,
  startAt: null,
  faultAt: null,
  detectedAt: null,
  retireBeganAt: null,
  retiredAt: null,
  caseFiledAt: null,
  respawnedAt: null,
  trustedAt: null,
  testsPassAt: null,
  ms: null,
  stagesFromServer: false,
  caseFiled: false,
  replacement: null,
});

function parseCaseId(id: string): { slot: number; gen: number } | null {
  const m = /\.(\d+)\.g(\d+)$/.exec(id);
  return m ? { slot: Number(m[1]), gen: Number(m[2]) } : null;
}

/**
 * Rows are keyed by case id. Status transitions only know `<runId>.<slot>.g<gen>`, but fleet-mode case ids
 * are per team (`<runId>-t<team>.<localSlot>.g<gen>`, with the global slot in the payload), so a row is
 * also matched by slot + gen; an id from the server (case.created, recovery) then replaces the derived one.
 */
function upsertRecovery(st: DataState, caseId: string, slot: number, gen: number, patch: (r: Recovery) => Partial<Recovery>, serverId = false): DataState {
  const list = st.snapshot.recoveries;
  let i = list.findIndex((r) => r.caseId === caseId);
  if (i < 0 && slot >= 0 && gen > 0) i = list.findIndex((r) => r.slot === slot && r.gen === gen);
  const found = i < 0 ? newRecovery(caseId, slot, gen) : list[i]!;
  const base = serverId && found.caseId !== caseId ? { ...found, caseId } : found;
  const merged = { ...base, ...patch(base) };
  const next = { ...merged, startAt: merged.faultAt ?? merged.detectedAt };
  if (i >= 0 && (Object.keys(next) as (keyof Recovery)[]).every((k) => next[k] === found[k])) return st;
  return setSnap(st, { recoveries: i < 0 ? [...list, next] : list.with(i, next) });
}

/** First observation wins; a stage set by the server is never overwritten. */
const first = (cur: number | null, v: number): number => cur ?? v;

/** Recovery stages observed from one card transition (prev may be undefined). */
function trackAgent(st: DataState, prev: AgentSlot | undefined, next: AgentSlot, ts: number): DataState {
  const runId = st.currentRunId;
  if (!runId) return st;
  const id = (gen: number) => `${runId}.${next.slot}.g${gen}`;
  const s = next.status;
  if (s === "under_investigation" || s === "retiring" || s === "retired" || s === "failed") {
    st = upsertRecovery(st, id(next.gen), next.slot, next.gen, (r) => ({
      detectedAt: s === "under_investigation" ? first(r.detectedAt, ts) : r.detectedAt,
      retireBeganAt: s === "retiring" ? first(r.retireBeganAt, ts) : r.retireBeganAt,
      retiredAt: s === "retired" || s === "failed" ? first(r.retiredAt, ts) : r.retiredAt,
    }));
  }
  if (next.gen > 1) {
    const prevId = id(next.gen - 1);
    const known = st.snapshot.recoveries.some((r) => r.caseId === prevId);
    const respawned = prev !== undefined && prev.gen < next.gen;
    if (known || respawned) {
      st = upsertRecovery(st, prevId, next.slot, next.gen - 1, (r) => ({
        respawnedAt: respawned ? first(r.respawnedAt, ts) : r.respawnedAt,
        replacement: r.replacement ?? next.name,
        trustedAt: s === "trusted" ? first(r.trustedAt, ts) : r.trustedAt,
      }));
    }
  }
  return st;
}

function setRoster(st: DataState, roster: AgentSlot[], ts: number): DataState {
  const prev = new Map(st.snapshot.roster.map((a) => [a.slot, a]));
  for (const a of roster) {
    const p = prev.get(a.slot);
    if (!p || p.status !== a.status || p.gen !== a.gen) st = trackAgent(st, p, a, ts);
  }
  return setSnap(st, { roster });
}

function upsertRun(st: DataState, run: RunInfo): DataState {
  const runs = st.snapshot.runs;
  const i = runs.findIndex((r) => r.runId === run.runId);
  const list = i < 0 ? [...runs, run] : runs.with(i, run);
  const patch: Partial<Snapshot> = { runs: list };
  if (st.currentRunId === run.runId) {
    patch.run = run;
    patch.metrics = metricsFor(run, st.snapshot.metrics);
  }
  return setSnap(st, patch);
}

function relayRepliesFor(relay: Snapshot["relay"], caseId: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of relay) if (r.kind === "case_reply" && r.meta.caseId === caseId && !m.has(r.from)) m.set(r.from, r.text);
  return m;
}

/** Replace a case file and its summary (if the case belongs to the current run). */
function putCase(st: DataState, cf: CaseFile): DataState {
  st = { ...st, caseFiles: { ...st.caseFiles, [cf.id]: cf } };
  if (cf.runId !== st.currentRunId) return st;
  const cases = st.snapshot.cases;
  const i = cases.findIndex((x) => x.id === cf.id);
  const summary = toCaseSummary(cf);
  return setSnap(st, { cases: i < 0 ? [...cases, summary] : cases.with(i, summary) });
}

function addCase(st: DataState, c: W.CaseFile): DataState {
  const prev = st.caseFiles[c.id];
  let cf = toCaseFile(c, relayRepliesFor(st.snapshot.relay, c.id));
  // Keep replies we already got from case.reply events if this payload has fewer.
  if (prev?.replies && (!cf.replies || cf.replies.length < prev.replies.length)) cf = withReplies(cf, prev.replies);
  st = putCase(st, cf);
  return upsertRecovery(st, c.id, c.slot, c.gen, (r) => ({
    caseFiled: true,
    caseFiledAt: r.stagesFromServer ? r.caseFiledAt : first(r.caseFiledAt, c.createdAt),
    replacement: c.replacement ?? r.replacement,
  }), true);
}

function withReplies(cf: CaseFile, replies: NonNullable<CaseFile["replies"]>): CaseFile {
  const text = new Map(replies.map((r) => [r.from, r.text]));
  return {
    ...cf,
    replies,
    recipients: cf.recipients.map((r) => (text.has(r.agentName) ? { ...r, reply: text.get(r.agentName) ?? r.reply } : r)),
  };
}

function addReply(st: DataState, caseId: string, reply: W.CaseReply, ts: number): DataState {
  const cf = st.caseFiles[caseId];
  if (!cf) return st; // the case arrives later (REST or case.created) with its replies
  const replies = cf.replies ?? [];
  if (replies.some((r) => r.seq === reply.seq && r.from === reply.from)) return st;
  const next = withReplies({ ...cf, updatedAt: Math.max(cf.updatedAt, reply.ts || ts) }, [...replies, toCaseReply(reply)].sort((a, b) => a.seq - b.seq));
  return putCase(st, next);
}

function addRelay(st: DataState, item: W.RelayFeedItem): DataState {
  const msg = toRelay(item);
  const list = st.snapshot.relay;
  const i = list.findIndex((m) => m.id === msg.id);
  const relay = i >= 0 ? list.with(i, msg) : list.length >= RELAY_CAP ? [...list.slice(list.length - RELAY_CAP + 1), msg] : [...list, msg];
  st = setSnap(st, { relay });
  // Older payloads without CaseFile.replies: take the recipient's reply from the relay.
  const caseId = msg.meta.caseId;
  const cf = caseId ? st.caseFiles[caseId] : undefined;
  if (msg.kind === "case_reply" && cf && cf.replies === null) {
    const recipients = cf.recipients.map((r) => (r.agentName === msg.from && !r.reply ? { ...r, reply: msg.text } : r));
    st = putCase(st, { ...cf, recipients, updatedAt: Math.max(cf.updatedAt, msg.ts) });
  }
  return st;
}

function applyRecovery(st: DataState, ev: Extract<W.SequencedEvent, { type: "recovery" }>): DataState {
  const parsed = parseCaseId(ev.caseId);
  const slot = ev.slot ?? parsed?.slot ?? -1;
  const gen = parsed?.gen ?? 0;
  const s = ev.stages;
  return upsertRecovery(st, ev.caseId, slot, gen, (r) => {
    if (!s) return { testsPassAt: r.testsPassAt ?? ev.ts, ms: ev.ms };
    // Server stages are authoritative; a null server stage keeps what the event stream showed.
    return {
      faultAt: s.faultAt ?? r.faultAt,
      detectedAt: s.detectedAt ?? r.detectedAt,
      retireBeganAt: s.retireBeganAt ?? r.retireBeganAt,
      caseFiledAt: s.caseFiledAt ?? r.caseFiledAt,
      respawnedAt: s.respawnedAt ?? r.respawnedAt,
      testsPassAt: s.testsPassingAt ?? r.testsPassAt ?? ev.ts,
      ms: ev.ms,
      stagesFromServer: true,
    };
  }, true);
}

// ------------------------------------------------------------------ events
export function applyEvent(st0: DataState, ev: W.SequencedEvent): DataState {
  let st = markMock(st0, ev.mock);
  if (ev.type === "run.status") {
    const run = toRun(ev.run, st.snapshot.origin, ev.banner ?? null);
    const cur = st.snapshot.run;
    const newer = !cur || (run.startedAt ?? 0) >= (cur.startedAt ?? 0);
    if (st.currentRunId !== run.runId && newer) st = resetRun(st, run.runId);
    else if (st.currentRunId === run.runId && ev.run.status === "starting" && cur?.rawStatus !== "starting") st = resetRun(st, run.runId); // replayed or restarted run
    return upsertRun(st, run);
  }
  if (ev.type === "jev.status") {
    const jev = toJev(ev.status);
    return setSnap(markMock(st, ev.status.mock), { health: { ...st.snapshot.health, jev, jevOffline: jev.mode === "fallback" } });
  }
  if (ev.type === "swarm.stats") return setSnap(st, { swarm: toSwarm(ev.stats, ev.ts) });

  const cur = forCurrent(st, ev.runId);
  if (!cur) return st;
  st = cur;
  switch (ev.type) {
    case "roster":
      return setRoster(st, ev.agents.map((a) => toAgent(a)).sort((x, y) => x.slot - y.slot), ev.ts);
    case "agent.status": {
      const roster = st.snapshot.roster;
      const prev = roster.find((a) => a.slot === ev.slot);
      let next: AgentSlot;
      if (ev.agent) next = toAgent(ev.agent, ev.reason ?? null);
      else if (prev) next = { ...prev, gen: ev.gen, status: ev.status, step: ev.step, statusReason: ev.reason ?? null };
      else return st; // no card to patch yet
      // An injected fault fired: start the recovery timer at the fault, not at detection.
      if (ev.faultAt !== undefined) {
        const faultAt = ev.faultAt;
        const id = `${ev.runId}.${ev.slot}.g${ev.gen}`;
        st = upsertRecovery(st, id, ev.slot, ev.gen, (r) => ({ faultAt: r.faultAt ?? faultAt }));
      }
      st = trackAgent(st, prev, next, ev.ts);
      const list = st.snapshot.roster;
      const j = list.findIndex((a) => a.slot === ev.slot);
      const updated = j < 0 ? [...list, next].sort((x, y) => x.slot - y.slot) : list.with(j, next);
      return setSnap(st, { roster: updated });
    }
    case "relay.message":
      return addRelay(st, ev.item);
    case "case.created":
      return addCase(st, ev.case);
    case "case.reply":
      return addReply(st, ev.caseId, ev.reply, ev.ts);
    case "ledger.totals":
      return setSnap(st, { ledger: toLedger(ev.totals) });
    case "recovery":
      return applyRecovery(st, ev);
    case "fleet.grid":
      return setSnap(st, { fleetGrid: applyGrid(st.snapshot.fleetGrid, ev.runId, ev.seq, ev.ts, ev.grid) });
    case "fleet.stats": {
      const fleetStats = applyStats(st.snapshot.fleetStats, ev.runId, ev.seq, ev.ts, ev.stats);
      return fleetStats === st.snapshot.fleetStats ? st : setSnap(st, { fleetStats });
    }
    case "chunk.created":
      return setSnap(st, { chunks: chunkCreated(st.snapshot.chunks, ev.chunk) });
    case "chunk.reused":
      return setSnap(st, { chunks: chunkReused(st.snapshot.chunks, ev.chunkId, ev.byAgent, ev.reuseEstTokens) });
    case "chunk.revoked": {
      const chunks = chunkRevoked(st.snapshot.chunks, ev.chunkId, ev.reason, ev.notified, ev.ts);
      return chunks === st.snapshot.chunks ? st : setSnap(st, { chunks });
    }
    case "context.cleansed": {
      const cleansing = contextCleansed(st.snapshot.cleansing, ev);
      return cleansing === st.snapshot.cleansing ? st : setSnap(st, { cleansing });
    }
  }
  return st;
}

// ------------------------------------------------------------------ REST snapshot
export interface RestSnapshot {
  mock: boolean;
  runs: W.RunSummary[];
  runId: string | null;
  roster: W.AgentCard[];
  ledger: W.LedgerTotals | null;
  relay: W.RelayFeedItem[];
  cases: W.CaseFile[];
  jev: W.JevStatus | null;
}

/**
 * Merge a REST snapshot (newest state) into a state built from replayed events.
 * Replace-type slices (runs, roster, ledger, jev) take the REST value; relay and
 * cases are unioned by key; recovery stages from events are kept.
 */
export function mergeRest(st: DataState, r: RestSnapshot): DataState {
  if (r.mock) st = markMock(st, true);
  const origin = st.snapshot.origin;
  if (r.runId && st.currentRunId !== r.runId) st = resetRun(st, r.runId);
  const banner = (id: string) => st.snapshot.runs.find((x) => x.runId === id)?.banner ?? null;
  const runs = r.runs.map((x) => toRun(x, x.mock ? "mock" : origin, banner(x.runId)));
  const run = runs.find((x) => x.runId === st.currentRunId) ?? null;
  st = setSnap(st, { runs, run, metrics: metricsFor(run, st.snapshot.metrics) });
  if (r.roster.length) {
    const roster = r.roster
      .map((a) => toAgent(a, st.snapshot.roster.find((x) => x.slot === a.slot && x.gen === a.gen)?.statusReason ?? null))
      .sort((x, y) => x.slot - y.slot);
    st = setRoster(st, roster, Date.now());
  }
  if (r.ledger) st = setSnap(st, { ledger: toLedger(r.ledger) });
  if (r.jev) {
    const jev = toJev(r.jev);
    st = setSnap(markMock(st, r.jev.mock), { health: { ...st.snapshot.health, jev, jevOffline: jev.mode === "fallback" } });
  }
  for (const item of r.relay) st = addRelay(st, item);
  st = setSnap(st, { relay: [...st.snapshot.relay].sort((a, b) => a.seq - b.seq) });
  for (const c of r.cases) st = addCase(st, c);
  return st;
}
