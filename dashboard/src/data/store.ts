// One module-level store fed by one EventSource on /api/events (docs/DATA_CONTRACT.md).
//
// Protocol (orchestrator/src/http/api.ts): the server sends `hello` {bootId, mock, gap},
// then the replay (events after ?since=), then `live`, then live events (`id:` = seq).
// A fresh connect or a gap (buffer overflow, server restart = new bootId) means our
// state cannot be patched: we rebuild into a staging state from the replay plus REST
// snapshots (runs, roster, ledger, relay, cases, jev), then swap it in. Until the swap
// the screen keeps the old state and `connection` stays "connecting"/"reconnecting".
import type * as W from "@contract/types";
import { API_URL, DEMO_REPLAY, RECORDED, request } from "./http";
import type { CaseFile, Snapshot } from "./model";
import { applyEvent, emptyState, mergeRest, type DataState, type RestSnapshot } from "./state";

export type Connection = "connecting" | "open" | "reconnecting";

export interface DashboardState {
  snapshot: Snapshot | null;
  connection: Connection;
  selectedCaseId: string | null;
  selectCase(id: string | null): void;
}

const BACKOFF_MS = [1000, 2000, 4000];
const BACKOFF_STEADY_MS = 5000;
const EVENT_TYPES: W.DashboardEventType[] = [
  "roster",
  "agent.status",
  "relay.message",
  "case.created",
  "case.reply",
  "ledger.totals",
  "jev.status",
  "recovery",
  "run.status",
  "swarm.stats",
  "fleet.grid",
  "fleet.stats",
  "chunk.created",
  "chunk.reused",
  "chunk.revoked",
  "context.cleansed",
];

// ------------------------------------------------------------------ store
const listeners = new Set<() => void>();

function selectCase(id: string | null) {
  if (state.selectedCaseId === id) return;
  state = { ...state, selectedCaseId: id };
  notify();
}

let state: DashboardState = { snapshot: null, connection: "connecting", selectedCaseId: null, selectCase };
let data: DataState = emptyState();
let hasData = false;

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notify() {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = null;
  for (const l of listeners) l();
}
/** Bursts of SSE events coalesce into one render (~1 frame). */
function notifySoon() {
  notifyTimer ??= setTimeout(notify, 16);
}

/** Copy `data` into the public state, auto-selecting a newly arrived case. */
function publish(immediate: boolean, connection?: Connection) {
  const prev = state.snapshot;
  const snap = hasData ? data.snapshot : null;
  let selectedCaseId = state.selectedCaseId;
  if (snap && prev !== snap) {
    if (selectedCaseId !== null && !snap.cases.some((c) => c.id === selectedCaseId) && !data.caseFiles[selectedCaseId]) selectedCaseId = null;
    if (selectedCaseId === null) {
      const known = new Set(prev?.cases.map((c) => c.id));
      const fresh = snap.cases.filter((c) => !known.has(c.id));
      if (fresh.length) selectedCaseId = fresh.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id;
    }
  }
  const conn = connection ?? state.connection;
  if (snap === prev && selectedCaseId === state.selectedCaseId && conn === state.connection) return;
  state = { ...state, snapshot: snap, selectedCaseId, connection: conn };
  if (immediate) notify();
  else notifySoon();
}

export function getState(): DashboardState {
  return state;
}

/** Full CaseFile from events/REST, if the store has it. */
export function getCaseFile(id: string): CaseFile | undefined {
  return data.caseFiles[id];
}

/** Current run id (for run-scoped API calls). */
export function currentRunId(): string | null {
  return data.currentRunId;
}

const caseListeners = new Set<(caseId: string) => void>();
/** Called with a case id whenever case.created or case.reply touches that case (cache invalidation). */
export function onCaseChanged(fn: (caseId: string) => void): () => void {
  caseListeners.add(fn);
  return () => caseListeners.delete(fn);
}
function caseTouched(ev: W.SequencedEvent) {
  const id = ev.type === "case.reply" ? ev.caseId : ev.type === "case.created" ? ev.case.id : null;
  if (id) for (const fn of caseListeners) fn(id);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}

// ------------------------------------------------------------------ REST bootstrap
async function fetchRest(preferRunId: string | null, mock: boolean): Promise<RestSnapshot> {
  const soft = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const runs = await request<W.RunSummary[]>("GET", "/api/runs");
  const latest = runs.reduce<W.RunSummary | null>((a, b) => (!a || b.startedAt >= a.startedAt ? b : a), null);
  const runId = preferRunId && runs.some((r) => r.runId === preferRunId) ? preferRunId : (latest?.runId ?? preferRunId);
  const enc = runId ? encodeURIComponent(runId) : "";
  const [roster, ledger, relay, cases, jev] = await Promise.all([
    runId ? soft(request<W.AgentCard[]>("GET", `/api/runs/${enc}/roster`), []) : [],
    runId ? soft(request<W.LedgerTotals | null>("GET", `/api/runs/${enc}/ledger`), null) : null,
    runId ? soft(request<W.RelayFeedItem[]>("GET", `/api/runs/${enc}/relay`), []) : [],
    runId ? soft(request<W.CaseFile[]>("GET", `/api/runs/${enc}/cases`), []) : [],
    soft(request<W.JevStatus>("GET", "/api/jev"), null),
  ]);
  return { mock, runs, runId, roster, ledger, relay, cases, jev };
}

// ------------------------------------------------------------------ connection
let es: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let started = false;
let lastSeq = 0;
let bootId: string | null = null;
let serverMock = false;
let staging: DataState | null = null; // rebuilding after a fresh connect or gap
let bootstrapping = false;
let pendingLive: W.SequencedEvent[] = [];

function connect() {
  if (started || typeof EventSource === "undefined") return;
  started = true;
  if (DEMO_REPLAY) return void replayStart("invoice_parser");
  if (POLL_MS > 0) return void poll();
  open();
}

// Polling mode (VITE_POLL_MS > 0): for hosts whose proxy cannot stream SSE, e.g. a Cloudflare quick
// tunnel in front of the orchestrator. Rebuilds the view from the REST snapshot of the latest run
// every POLL_MS. Event-only data (recovery timer, swarm stats) is not available in this mode.
const POLL_MS = Number(import.meta.env.VITE_POLL_MS ?? 0) || 0;

async function poll() {
  retryTimer = null;
  try {
    const rest = await fetchRest(null, false);
    data = mergeRest(emptyState("live"), rest);
    hasData = true;
    publish(true, "open");
  } catch {
    publish(true, "reconnecting");
  }
  if (started) retryTimer = setTimeout(poll, POLL_MS);
}

function open() {
  retryTimer = null;
  const q = new URLSearchParams({ since: String(lastSeq) });
  if (bootId) q.set("boot", bootId);
  const source = new EventSource(`${API_URL}/api/events?${q}`);
  es = source;
  const mine = () => es === source;

  source.addEventListener("hello", (e) => {
    if (!mine()) return;
    const h = JSON.parse((e as MessageEvent<string>).data) as { bootId: string; mock: boolean; gap: boolean };
    attempt = 0;
    bootId = h.bootId;
    serverMock = h.mock;
    pendingLive = [];
    bootstrapping = false;
    staging = !hasData || h.gap ? emptyState(RECORDED ? "replay" : h.mock ? "mock" : "live") : null;
    if (h.gap) lastSeq = 0;
  });

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      if (!mine()) return;
      let ev: W.SequencedEvent;
      try {
        ev = JSON.parse((e as MessageEvent<string>).data) as W.SequencedEvent;
      } catch {
        return;
      }
      if (ev.seq > lastSeq) lastSeq = ev.seq;
      if (bootstrapping) return void pendingLive.push(ev);
      if (staging) {
        staging = applyEvent(staging, ev);
        return;
      }
      data = applyEvent(data, ev);
      publish(false);
      caseTouched(ev);
    });
  }

  source.addEventListener("live", () => {
    if (!mine()) return;
    if (!staging) return publish(true, "open");
    bootstrapping = true;
    const base = staging;
    fetchRest(base.currentRunId, serverMock)
      .then((rest) => mergeRest(base, rest))
      .catch((err: unknown) => {
        console.warn("[data] REST snapshot failed; using the event replay only", err);
        return base;
      })
      .then((built) => {
        if (!mine()) return;
        let next = built;
        for (const ev of pendingLive) next = applyEvent(next, ev);
        pendingLive = [];
        bootstrapping = false;
        staging = null;
        data = next;
        hasData = true;
        publish(true, "open");
      });
  });

  source.onerror = () => {
    if (!mine()) return;
    // A recording's stream is a static hello + live that ends at once. Keep this source so the
    // REST bootstrap it started still lands; the body's `retry:` spaces out the browser's re-request.
    if (RECORDED) return;
    source.close();
    es = null;
    if (staging) lastSeq = 0; // half-built state was discarded: start fresh next time
    staging = null;
    bootstrapping = false;
    pendingLive = [];
    publish(true, "reconnecting");
    const delay = BACKOFF_MS[attempt] ?? BACKOFF_STEADY_MS;
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };
}

// ------------------------------------------------------------------ demo replay (VITE_DEMO_REPLAY=1)
// The hosted demo replays real runs (real models, recorded by scripts/record-scenarios.ts into
// public/scenarios/<task>.s<slot>.json) at REPLAY_SPEED x instead of waiting on live models.
// Start run plays a recording up to its Possess and holds there; Possess(slot) rebuilds that slot's
// recording up to its Possess and plays the rest. Each event keeps its own internal durations
// (recovery stages, costs), so the numbers shown are the measured ones; only the waiting is shorter.
const REPLAY_SPEED = 3;
interface Scenario {
  task: string;
  slot: number;
  runId: string;
  possessTs: number | null;
  summary?: W.RunSummary;
  /** The run as it looked at its start: status running, every agent at generation 1, step 0. */
  summary0: W.RunSummary;
  roster0: W.AgentCard[];
  events: W.SequencedEvent[];
}
const scenarioCache = new Map<string, Promise<Scenario | null>>();
let replayTimers: ReturnType<typeof setTimeout>[] = [];
let replayTask: string | null = null;

function loadScenario(task: string, slot: number): Promise<Scenario | null> {
  const key = `${task}.s${slot}`;
  let p = scenarioCache.get(key);
  if (!p) {
    p = fetch(`/scenarios/${key}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Scenario>) : null))
      .then((sc) => (sc && sc.events.length ? sc : null))
      .catch(() => null);
    scenarioCache.set(key, p);
  }
  return p;
}

async function anyScenario(task: string, prefer: number[]): Promise<Scenario | null> {
  for (const s of prefer) {
    const sc = await loadScenario(task, s);
    if (sc) return sc;
  }
  return null;
}

/** Moves every epoch-ms timestamp field (ts, *At) of an event by delta, so it reads as happening now. */
function rebase<T>(v: T, delta: number, key = ""): T {
  if (typeof v === "number") return (/(^ts$|At$)/.test(key) && v > 1e12 ? v + delta : v) as T;
  if (Array.isArray(v)) return v.map((x) => rebase(x, delta)) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = rebase(x, delta, k);
    return o as T;
  }
  return v;
}

function clearReplay() {
  for (const t of replayTimers) clearTimeout(t);
  replayTimers = [];
}

function play(events: W.SequencedEvent[], fromTs: number) {
  let last = 0;
  for (const ev of events) {
    last = Math.max(last, (ev.ts - fromTs) / REPLAY_SPEED);
    replayTimers.push(
      setTimeout(() => {
        data = applyEvent(data, rebase(ev, Date.now() - ev.ts));
        hasData = true;
        publish(false, "open");
        caseTouched(ev);
      }, last),
    );
  }
}

function rebuild(sc: Scenario, events: W.SequencedEvent[]) {
  const now = Date.now();
  // The live dashboard gets the run and its cards from the REST snapshot; a replay seeds them from the recording.
  const t0 = sc.events[0].ts;
  let st = mergeRest(emptyState("replay"), {
    mock: false,
    runs: [rebase(sc.summary0, now - t0)],
    runId: sc.runId,
    roster: sc.roster0,
    ledger: null,
    relay: [],
    cases: [],
    jev: null,
  });
  for (const ev of events) st = applyEvent(st, rebase(ev, now - ev.ts));
  data = st;
  hasData = true;
  publish(true, "open");
}

/** Start run (demo): plays a recording of `task` up to its Possess. Null when nothing is recorded. */
export async function replayStart(task: string): Promise<W.RunSummary | null> {
  const sc = await anyScenario(task, [1, 2, 0, 3]);
  if (!sc) return null;
  clearReplay();
  replayTask = task;
  rebuild(sc, []);
  const pre = sc.possessTs == null ? sc.events : sc.events.filter((e) => e.ts < (sc.possessTs as number));
  play(pre, sc.events[0].ts);
  for (const s of [0, 1, 2, 3]) void loadScenario(task, s);
  return sc.summary ?? null;
}

/** Possess (demo): the recording where this slot was possessed, from its Possess to the end of the run. */
export async function replayPossess(slot: number): Promise<boolean> {
  if (!replayTask) return false;
  const sc = await loadScenario(replayTask, slot);
  if (!sc || sc.possessTs == null) return false;
  const at = sc.possessTs;
  clearReplay();
  rebuild(sc, sc.events.filter((e) => e.ts < at));
  play(sc.events.filter((e) => e.ts >= at), at);
  return true;
}

export function replayStop() {
  clearReplay();
}

function teardown() {
  clearReplay();
  es?.close();
  es = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  started = false;
}

// Vite HMR: drop the old socket when this module is replaced.
if (import.meta.hot) import.meta.hot.dispose(teardown);
