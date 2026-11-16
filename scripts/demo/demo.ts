#!/usr/bin/env bun
// On-stage demo driver (docs/BUILD_SPEC.md "Demo runbook", docs/SPEC.md "Demo script").
// Every number printed comes from the orchestrator API (REST + SSE /api/events) or, for the swarm
// fallback, from the swarm engine's own output. Nothing is invented; a MOCK service is labelled MOCK.
//
//   bun scripts/demo/demo.ts <beat|all> [options]
//   beats: start reuse possess recover herd crash swarm bench   (or 1..8)
//
// Options:
//   --api URL            orchestrator API (default http://127.0.0.1:$ORCHESTRATOR_PORT from .env, else :3000)
//   --auto               no Enter prompts; pause --pause-s seconds between beats (default 3)
//   --task ID            task for beat 1 (default invoice_parser)
//   --step-delay-ms N    demo pacing sent with startRun (default 8000)
//   --library ID         reuse a case library (default: fresh, cold)
//   --run ID             run to act on (default: the run started by beat 1, else the newest run)
//   --slot N             slot to possess (default: the slot whose subtask is most related to the trap)
//   --timeout-s N        max wait for each live beat (default 240)
//   --swarm 100,1000,10000   swarm sizes for beat 7
//   --swarm-route PATH   HTTP route for swarm start (default /api/swarm); falls back to the swarm CLI on 404
//   --no-crash           skip the kill in beat 6 (still prints the before/after snapshot)
//   --summary PATH       bench summary for beat 8 (default bench/results.summary.json; else GET /api/bench)
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentCard,
  BenchmarkResultRow,
  CaseFile,
  LedgerTotals,
  RecoveryStages,
  RelayFeedItem,
  RunSummary,
  SequencedEvent,
  SwarmStats,
} from "../../orchestrator/src/contract.ts";

const ROOT = resolve(import.meta.dir, "../..");

// ------------------------------------------------------------------ args / env
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
if (has("-h") || has("--help") || argv.length === 0) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(argv.length === 0 ? 2 : 0);
}

function dotenv(): Record<string, string> {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
const ENV = dotenv();
const API = (flag("--api") ?? `http://127.0.0.1:${process.env.ORCHESTRATOR_PORT ?? ENV.ORCHESTRATOR_PORT ?? 3000}`).replace(/\/$/, "");
const AUTO = has("--auto");
const PAUSE_S = Number(flag("--pause-s") ?? 3);
const TASK = flag("--task") ?? "invoice_parser";
const STEP_DELAY_MS = Number(flag("--step-delay-ms") ?? 8000);
const LIBRARY = flag("--library");
const TIMEOUT_MS = Number(flag("--timeout-s") ?? 240) * 1000;
const SWARM_SIZES = (flag("--swarm") ?? "100,1000,10000").split(",").map((s) => Number(s.replace(/_/g, "")));
const SWARM_ROUTE = flag("--swarm-route") ?? "/api/swarm";
const NO_CRASH = has("--no-crash");
const SUMMARY = resolve(flag("--summary") ?? join(ROOT, "bench/results.summary.json"));
let runId: string | undefined = flag("--run");
const slotArg = flag("--slot");

// ------------------------------------------------------------------ output
let MOCK = false;
const tag = () => (MOCK ? "[MOCK] " : "");
const t0 = Date.now();
const clock = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const say = (s: string) => console.log(`${clock()} ${tag()}${s}`);
const ev = (s: string) => console.log(`${clock()} ${tag()}  > ${s}`);
const cue = (n: number, title: string, line: string) => {
  console.log(`\n${"=".repeat(78)}\n BEAT ${n}: ${title}${MOCK ? "   [MOCK SERVICE: recorded, not measured]" : ""}\n SAY: ${line}\n${"=".repeat(78)}`);
};
const usd = (n: number | undefined) => (n === undefined ? "?" : `$${n.toFixed(n < 0.01 ? 5 : 4)}`);
const int = (n: number | undefined) => (n === undefined ? "?" : Math.round(n).toLocaleString("en-US"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class BeatFail extends Error {
  constructor(
    msg: string,
    readonly fallback: string,
  ) {
    super(msg);
  }
}

// ------------------------------------------------------------------ REST
async function api<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, data: data as T };
}
async function get<T>(path: string): Promise<T> {
  const r = await api<T>("GET", path);
  if (r.status !== 200) throw new Error(`GET ${path} -> HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

// ------------------------------------------------------------------ SSE (auto-reconnect, keeps history)
type Ev = SequencedEvent & { boot: string };
class EventStream {
  events: Ev[] = [];
  boot = "";
  connected = false;
  lastSeq = 0;
  reconnects: { at: number; from: string; to: string }[] = [];
  disconnectedAt: number | null = null;
  private waiters = new Set<() => void>();
  private stopped = false;
  private seen = new Set<string>();

  start() {
    void this.loop();
  }
  stop() {
    this.stopped = true;
  }
  private notify() {
    for (const w of this.waiters) w();
  }
  private async loop() {
    while (!this.stopped) {
      try {
        const q = this.boot ? `?since=${this.lastSeq}&boot=${encodeURIComponent(this.boot)}` : "?since=0";
        const res = await fetch(`${API}/api/events${q}`, { headers: { Accept: "text/event-stream" } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            this.frame(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
      } catch {
        // fall through to reconnect
      }
      if (this.connected) {
        this.connected = false;
        this.disconnectedAt = Date.now();
        this.notify();
      }
      if (!this.stopped) await sleep(1000);
    }
  }
  private frame(raw: string) {
    let type = "message";
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    const d = JSON.parse(data);
    if (type === "hello") {
      if (this.boot && d.bootId !== this.boot) this.reconnects.push({ at: Date.now(), from: this.boot, to: d.bootId });
      if (d.gap) this.lastSeq = 0;
      this.boot = d.bootId;
      this.connected = true;
      if (d.mock) MOCK = true;
      this.notify();
      return;
    }
    if (type === "live") return;
    const e = { ...(d as SequencedEvent), boot: this.boot } as Ev;
    const key = `${this.boot}:${e.seq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.lastSeq = Math.max(this.lastSeq, e.seq);
    if (e.mock) MOCK = true;
    this.events.push(e);
    this.notify();
  }
  /** Events of one run in its current pass: after the last run.status "starting" for that run, if any. */
  runEvents(id: string): Ev[] {
    const mine = this.events.filter((e) => e.runId === id);
    let from = 0;
    mine.forEach((e, i) => {
      if (e.type === "run.status" && e.run.status === "starting") from = i;
    });
    return mine.slice(from);
  }
  /** Resolves with pred()'s first non-undefined value, re-checked on every event; rejects on timeout. */
  waitFor<T>(pred: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise((res, rej) => {
      const check = () => {
        let v: T | undefined;
        try {
          v = pred();
        } catch (err) {
          done();
          return rej(err);
        }
        if (v !== undefined) {
          done();
          res(v);
        }
      };
      const timer = setTimeout(() => {
        done();
        rej(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }
}
const sse = new EventStream();

// ------------------------------------------------------------------ prompts
let rl: ReturnType<typeof createInterface> | null = null;
async function pause(next: string) {
  if (AUTO) {
    if (PAUSE_S > 0) say(`(auto) next: ${next} in ${PAUSE_S}s`);
    await sleep(PAUSE_S * 1000);
    return;
  }
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((r) => rl!.question(`\n[Enter] -> ${next} `, () => r()));
}

// ------------------------------------------------------------------ helpers
async function currentRun(): Promise<RunSummary> {
  const runs = await get<RunSummary[]>("/api/runs");
  if (runId) {
    const r = runs.find((x) => x.runId === runId);
    if (r) return r;
    throw new BeatFail(`run ${runId} not in GET /api/runs`, "start a run with beat 1 or pass --run");
  }
  const newest = runs.filter((r) => !r.runId.startsWith("swarm")).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!newest) throw new BeatFail("no runs in GET /api/runs", "run beat 1 (start) first");
  runId = newest.runId;
  return newest;
}
const latestRun = (id: string): RunSummary | undefined =>
  sse
    .runEvents(id)
    .filter((e): e is Ev & { type: "run.status" } => e.type === "run.status")
    .at(-1)?.run;

function statusLine(a: AgentCard) {
  return `slot ${a.slot}  ${a.name.padEnd(16)} ${a.subtask.padEnd(20)} ${a.status.padEnd(19)} step ${String(a.step).padStart(2)}  verified ${a.verifiedSteps}${a.possessed ? "  POSSESSED" : ""}`;
}

function rosterFromEvents(id: string): AgentCard[] {
  const m = new Map<number, AgentCard>();
  for (const e of sse.runEvents(id)) {
    if (e.type === "roster") for (const a of e.agents) m.set(a.slot, a);
    if (e.type === "agent.status") {
      const prev = m.get(e.slot);
      if (e.agent) m.set(e.slot, e.agent);
      else if (prev) m.set(e.slot, { ...prev, gen: e.gen, status: e.status, step: e.step });
    }
  }
  return [...m.values()].sort((a, b) => a.slot - b.slot);
}

function immunityLine(r: RunSummary | undefined): string {
  if (!r) return "run summary not seen yet";
  const im = r.immunity;
  const parts = [`tests ${r.testsPassing}/${r.testsTotal}`, `retires ${r.retires}`, `cases ${r.cases}`, `usd ${usd(r.usd)}`];
  if (r.repeatFailures !== undefined) parts.push(`repeat failures ${r.repeatFailures}`);
  if (im) parts.push(`trap hits ${im.trapHits}, repeat ${im.repeatTrapHits}, cases broadcast ${im.casesBroadcast}, lessons adopted ${im.lessonsAdopted}`);
  else parts.push("immunity counters not reported");
  return parts.join(" | ");
}

// ------------------------------------------------------------------ beats
let possessedSlot: number | undefined;
let possessGen: number | undefined;
let caseId: string | undefined;
let crashSnapshot: Snapshot | undefined;

async function beatStart() {
  cue(1, "Fleet at work", "Four agents are building an invoice parser together; every one starts Trusted.");
  const body: Record<string, unknown> = { taskId: TASK, mode: "ours", stepDelayMs: STEP_DELAY_MS };
  if (LIBRARY) body.libraryId = LIBRARY;
  const startMark = sse.events.length;
  const r = await api<RunSummary & { error?: string }>("POST", "/api/runs", body, 60_000);
  if (r.status !== 200) throw new BeatFail(`POST /api/runs -> HTTP ${r.status}: ${JSON.stringify(r.data)}`, "use the run started before going on stage: rerun with --run <id> from beat 2");
  runId = r.data.runId;
  if (r.data.mock) MOCK = true;
  say(`POST /api/runs {taskId:${TASK}, mode:ours, stepDelayMs:${STEP_DELAY_MS}${LIBRARY ? `, libraryId:${LIBRARY}` : ", fresh library"}} -> run ${runId} (${r.data.status}, model ${r.data.model}, library ${r.data.libraryId})`);
  const roster = await sse.waitFor(
    () => {
      const ro = sse.events.length > startMark ? rosterFromEvents(runId!) : [];
      return ro.length > 0 && ro.every((a) => a.step >= 1) ? ro : undefined;
    },
    Math.min(TIMEOUT_MS, 120_000),
    "every agent to finish its first step",
  ).catch(async () => {
    const ro = await get<AgentCard[]>(`/api/runs/${runId}/roster`);
    if (!ro.length) throw new BeatFail("no roster for the run yet", "keep talking; the grid fills in when the first steps land");
    return ro;
  });
  for (const a of roster) ev(statusLine(a));
  ev(immunityLine(latestRun(runId!)));
}

async function beatReuse() {
  cue(2, "Shared verified reasoning", "A note that passed tests is reused by another agent; the counter shows the output tokens it did not have to write (est.).");
  const run = await currentRun();
  const found = await sse
    .waitFor(
      () => {
        const evs = sse.runEvents(run.runId);
        const msg = evs.find((e): e is Ev & { type: "relay.message" } => e.type === "relay.message" && /reus/i.test(e.item.text));
        const led = evs.filter((e): e is Ev & { type: "ledger.totals" } => e.type === "ledger.totals").find((e) => e.totals.reuse_est_tokens > 0);
        return msg || led ? { msg, led } : undefined;
      },
      TIMEOUT_MS,
      "a verified-note reuse (relay message or ledger reuse_est_tokens > 0)",
    )
    .catch((e) => {
      throw new BeatFail(String(e.message), "say the chunk reuse has not happened yet; point at the verified notes in the feed and move on to Possess");
    });
  if (found.msg) ev(`relay ${found.msg.item.channel} ${found.msg.item.from}: "${found.msg.item.text}"`);
  const ledger = await get<LedgerTotals | null>(`/api/runs/${run.runId}/ledger`).catch(() => null);
  const t = ledger ?? found.led?.totals;
  if (t) ev(`ledger: reuse ${int(t.reuse_est_tokens)} output tokens (est.) | worker ${usd(t.worker_usd)} | overhead ${usd(t.overhead_usd)} | jev calls ${t.calls.jev}, fallback ${t.calls.fallback}${t.net_savings_usd !== undefined ? ` | net savings ${usd(t.net_savings_usd)} vs ${t.baselineRunId}` : ""}`);
}

/** Slot whose subtask is most related to the task's trap (task.json traps[].trap_test / description). */
function trapSlot(taskId: string, roster: AgentCard[]): { slot: number; why: string } | undefined {
  const p = join(ROOT, "bench/tasks", taskId, "task.json");
  if (!existsSync(p)) return undefined;
  const task = JSON.parse(readFileSync(p, "utf8")) as {
    functions: { name: string; file: string; test: string }[];
    traps?: { id: string; description: string; trap_test: string }[];
  };
  const trap = task.traps?.[0];
  if (!trap) return undefined;
  const score = (f: { name: string; file: string; test: string }) =>
    (trap.trap_test.startsWith(f.test) ? 10 : 0) + (trap.description.includes(f.file) ? 5 : 0) + (trap.description.includes(f.name) ? 3 : 0);
  const ranked = task.functions.map((f) => ({ f, s: score(f) })).sort((a, b) => b.s - a.s);
  for (const { f, s } of ranked) {
    const a = roster.find((x) => x.subtask === f.name);
    if (a && ["trusted", "probation"].includes(a.status))
      return { slot: a.slot, why: s > 0 ? `owns ${f.name}, which trap "${trap.id}" targets (${trap.trap_test})` : `first active slot (no ${trap.id} owner active)` };
  }
  return undefined;
}

async function beatPossess() {
  cue(3, "Possession", "We possess one agent: it will claim tests pass when they do not, and tell its teammates something that contradicts the spec.");
  const run = await currentRun();
  const roster = await get<AgentCard[]>(`/api/runs/${run.runId}/roster`);
  let slot: number;
  if (slotArg !== undefined) {
    slot = Number(slotArg);
    say(`slot ${slot} chosen with --slot`);
  } else {
    const pick = trapSlot(run.taskId, roster);
    if (!pick) throw new BeatFail("no active slot to possess", "skip Possess; say the fault drill could not arm and go to the crash test");
    slot = pick.slot;
    say(`slot ${slot} chosen: ${pick.why}`);
  }
  const card = roster.find((a) => a.slot === slot);
  if (card) ev(`before: ${statusLine(card)}`);
  possessGen = card?.gen;
  const mark = sse.events.length;
  const r = await api<{ ok: boolean; detail?: string; error?: string }>("POST", `/api/runs/${run.runId}/possess`, { slot });
  say(`POST /api/runs/${run.runId}/possess {slot:${slot}} -> HTTP ${r.status} ${JSON.stringify(r.data)}`);
  if (r.status !== 200 || !r.data.ok) throw new BeatFail(`possess refused: ${r.data.error ?? r.status}`, "press Possess on another Trusted agent in the dashboard, or skip to the crash test");
  possessedSlot = slot;
  // Evidence that it armed: an agent.status for a possessed agent (whichever slot the service actually used).
  const armed = await sse
    .waitFor(
      () =>
        sse.events
          .slice(mark)
          .find((e): e is Ev & { type: "agent.status" } => e.type === "agent.status" && e.runId === run.runId && (e.agent?.possessed === true || /possess/i.test(e.reason ?? ""))),
      Math.min(TIMEOUT_MS, 60_000),
      "the possessed agent's status",
    )
    .catch(() => undefined);
  if (armed) {
    if (armed.slot !== slot) say(`NOTE: the service possessed slot ${armed.slot}, not ${slot} (${r.data.detail ?? ""}); following slot ${armed.slot}`);
    possessedSlot = armed.slot;
    possessGen = armed.gen;
    ev(`slot ${armed.slot} gen ${armed.gen} ${armed.status}${armed.reason ? `: ${armed.reason}` : ""}`);
  } else say("no possessed status seen yet (it arms on the next step)");
}

async function beatRecover() {
  cue(4, "Catch, retire, replace", "The false claim fails a real test run, the bad message is checked, the agent is retired, its case file is written and a replacement spawns. Watch the recovery timer.");
  const run = await currentRun();
  const slot = possessedSlot ?? (slotArg !== undefined ? Number(slotArg) : undefined);
  const wantSlot = (s: number | undefined) => slot === undefined || s === slot;
  const printed = new Set<string>();
  const show = (k: string, s: string) => {
    if (!printed.has(k)) {
      printed.add(k);
      ev(s);
    }
  };
  const res = await sse
    .waitFor(
      () => {
        const evs = sse.runEvents(run.runId);
        for (const e of evs) {
          if (e.type === "agent.status" && wantSlot(e.slot) && ["under_investigation", "retiring", "retired"].includes(e.status))
            show(`st${e.slot}${e.gen}${e.status}`, `slot ${e.slot} gen ${e.gen} -> ${e.status}${e.reason ? `: ${e.reason}` : ""}`);
          if (e.type === "relay.message" && e.item.blocked && wantSlot(e.item.metadata.slot))
            show(`bl${e.item.seq}`, `BLOCKED ${e.item.from}: "${e.item.text}" (${e.item.blocked.reason}; ${e.item.blocked.questionId} p=${e.item.blocked.probability} via ${e.item.blocked.source})`);
          if (e.type === "relay.message" && !e.item.blocked && wantSlot(e.item.metadata.slot) && e.item.metadata.kind === "note" && /cent|divide/i.test(e.item.text))
            show(`fx${e.item.seq}`, `message from ${e.item.from}: "${e.item.text}"`);
        }
        const retired = evs.find((e): e is Ev & { type: "agent.status" } => e.type === "agent.status" && wantSlot(e.slot) && e.status === "retired");
        const created = evs.find((e): e is Ev & { type: "case.created" } => e.type === "case.created" && wantSlot(e.case.slot));
        if (created) show(`case${created.case.id}`, `case ${created.case.id} [${created.case.category}] claim: "${created.case.claim}"`);
        const s = retired?.slot ?? created?.case.slot;
        const replacement =
          s === undefined ? undefined : evs.find((e): e is Ev & { type: "agent.status" } => e.type === "agent.status" && e.slot === s && e.gen > (retired?.gen ?? created!.case.gen));
        if (replacement) show(`rep${s}`, `replacement ${replacement.agent?.name ?? `slot ${s} gen ${replacement.gen}`} is ${replacement.status}`);
        const recovery = evs.find((e): e is Ev & { type: "recovery" } => e.type === "recovery" && (created ? e.caseId === created.case.id : wantSlot(e.slot)));
        return retired && created && replacement && recovery ? { created, recovery } : undefined;
      },
      TIMEOUT_MS,
      "retire + case + replacement + recovery event",
    )
    .catch((e) => {
      throw new BeatFail(String(e.message), "say what the grid shows (which stage it reached) and move on; the case viewer still has whatever was filed");
    });
  caseId = res.created.case.id;
  const c = (await get<CaseFile>(`/api/cases/${encodeURIComponent(caseId)}`).catch(() => null)) ?? res.created.case;
  if (c.evidence.testOutput) ev(`test output: ${c.evidence.testOutput.split("\n").at(-1)}`);
  if (c.evidence.jev) ev(`check: ${c.evidence.jev.questionId} p=${c.evidence.jev.probability} via ${c.evidence.jev.source}${c.evidence.escalationReason ? ` (${c.evidence.escalationReason})` : ""}`);
  ev(`lesson: ${c.lesson === null ? "NO_LESSON" : `"${c.lesson}"`}`);
  ev(`recipients: ${c.recipients.join(", ") || "none"} | replacement: ${c.replacement ?? "?"}`);
  const st: RecoveryStages | undefined = res.recovery.stages;
  ev(`recovery: ${(res.recovery.ms / 1000).toFixed(1)} s (detected -> tests passing)`);
  if (st) {
    const base = st.faultAt ?? st.detectedAt;
    const rows: [string, number | null][] = [
      ["fault fired", st.faultAt],
      ["detected", st.detectedAt],
      ["retire began", st.retireBeganAt],
      ["case filed", st.caseFiledAt],
      ["respawned", st.respawnedAt],
      ["tests passing", st.testsPassingAt],
    ];
    for (const [k, v] of rows) ev(`  ${k.padEnd(14)} ${v === null || base === null ? "not recorded" : `+${((v - base) / 1000).toFixed(1)} s`}`);
  }
}

async function beatHerd() {
  cue(5, "Herd immunity", "The case file reached the related agents over Relay; one replies and steers clear of the same trap.");
  const run = await currentRun();
  const res = await sse
    .waitFor(
      () => {
        const evs = sse.runEvents(run.runId);
        const reply = evs.find((e): e is Ev & { type: "case.reply" } => e.type === "case.reply" && (!caseId || e.caseId === caseId) && e.reply.slot !== possessedSlot);
        return reply ? { reply } : undefined;
      },
      TIMEOUT_MS,
      "a case.reply from a recipient",
    )
    .catch(async (e) => {
      // A reply is optional per run; the immunity counters may still show adoption.
      const r = latestRun(run.runId) ?? (await currentRun());
      if (r.immunity && r.immunity.lessonsAdopted > 0) return { reply: undefined };
      throw new BeatFail(String(e.message), "show the case file's recipients in the case viewer and say the reply did not come in time");
    });
  if (res.reply) {
    const rp = res.reply.reply;
    ev(`case ${res.reply.caseId} reply from ${rp.from} (slot ${rp.slot}): "${rp.text}"`);
  }
  if (caseId) {
    const c = await get<CaseFile>(`/api/cases/${encodeURIComponent(caseId)}`).catch(() => null);
    if (c) ev(`case ${c.id}: ${c.recipients.length} recipient(s), ${(c.replies ?? []).length} repl${(c.replies ?? []).length === 1 ? "y" : "ies"}`);
  }
  // Give the run summary a moment to carry the adoption counter, then print it.
  await sse
    .waitFor(() => ((latestRun(run.runId)?.immunity?.lessonsAdopted ?? 0) > 0 ? true : undefined), Math.min(TIMEOUT_MS, 10_000), "lessonsAdopted > 0")
    .catch(() => undefined);
  ev(immunityLine(latestRun(run.runId) ?? (await currentRun())));
}

interface Snapshot {
  boot: string;
  run?: RunSummary;
  roster: AgentCard[];
  cases: CaseFile[];
  ledger: LedgerTotals | null;
  feed: number;
}
async function snapshot(id: string): Promise<Snapshot> {
  const meta = await get<{ bootId: string }>("/api/meta");
  const runs = await get<RunSummary[]>("/api/runs");
  const [roster, cases, ledger, feed] = await Promise.all([
    get<AgentCard[]>(`/api/runs/${id}/roster`).catch(() => []),
    get<CaseFile[]>(`/api/runs/${id}/cases`).catch(() => []),
    get<LedgerTotals | null>(`/api/runs/${id}/ledger`).catch(() => null),
    get<RelayFeedItem[]>(`/api/runs/${id}/relay`).catch(() => []),
  ]);
  return { boot: meta.bootId, run: runs.find((r) => r.runId === id), roster, cases, ledger, feed: feed.length };
}
function snapRows(s: Snapshot): Record<string, string> {
  return {
    run: s.run ? `${s.run.status}, tests ${s.run.testsPassing}/${s.run.testsTotal}, retires ${s.run.retires}` : "absent",
    statuses: s.roster.length ? s.roster.map((a) => `${a.slot}:${a.status}/g${a.gen}`).join(" ") : "absent",
    cases: s.cases.length ? s.cases.map((c) => c.id).join(", ") : "none",
    ledger: s.ledger ? `worker ${usd(s.ledger.worker_usd)}, overhead ${usd(s.ledger.overhead_usd)}, reuse ${int(s.ledger.reuse_est_tokens)} tok est.` : "absent",
    "relay feed": `${s.feed} messages`,
  };
}

async function beatCrash() {
  cue(6, "Crash test", "Now we kill -9 the actor runtime and the orchestrator. The dashboard says reconnecting. Then we restart both.");
  const run = await currentRun();
  const before = await snapshot(run.runId);
  crashSnapshot = before;
  say(`before (boot ${before.boot}):`);
  for (const [k, v] of Object.entries(snapRows(before))) ev(`${k.padEnd(11)} ${v}`);
  const killedAt = Date.now();
  if (NO_CRASH) {
    say("--no-crash: kill skipped");
  } else if (MOCK) {
    const r = await api("POST", "/api/demo/crash");
    say(`POST /api/demo/crash -> HTTP ${r.status} ${JSON.stringify(r.data)} (MOCK: real crash is scripts/crash-test.sh)`);
  } else {
    const port = new URL(API).port || "80";
    say(`scripts/crash-test.sh --restart (ORCHESTRATOR_PORT=${port})`);
    const p = Bun.spawn(["bash", join(ROOT, "scripts/crash-test.sh"), "--restart"], {
      cwd: ROOT,
      env: { ...process.env, ORCHESTRATOR_PORT: port },
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await p.exited;
    if (code !== 0) throw new BeatFail(`crash-test.sh exited ${code}`, "run scripts/start-all.sh actors orchestrator by hand and keep talking; switch to the backup video if it does not come up");
  }
  if (!NO_CRASH) {
    // New bootId on /api/meta = the orchestrator process restarted and serves again.
    const boot = await (async () => {
      const deadline = Date.now() + Math.max(TIMEOUT_MS, 120_000);
      while (Date.now() < deadline) {
        const m = await get<{ bootId: string }>("/api/meta").catch(() => null);
        if (m && m.bootId !== before.boot) return m.bootId;
        await sleep(500);
      }
      throw new BeatFail("orchestrator did not come back with a new boot id", "run scripts/start-all.sh actors orchestrator by hand; switch to the backup video");
    })();
    ev(`API back after ${((Date.now() - killedAt) / 1000).toFixed(1)} s (boot ${before.boot} -> ${boot})`);
    await sse.waitFor(() => (sse.boot === boot && sse.connected ? true : undefined), 30_000, "SSE reconnect").then(
      () => ev(`SSE reconnected to boot ${boot}${sse.disconnectedAt ? ` (${((Date.now() - sse.disconnectedAt) / 1000).toFixed(1)} s after the drop)` : ""}`),
      () => say("SSE has not reconnected yet"),
    );
  }
  // Real service: actors awake at the kill answer "unavailable" for ~30 s (lease), then reconcile restores them.
  // While leases expire the API can take longer than one request timeout to answer: retry until the settle deadline.
  const settleUntil = Date.now() + (MOCK || NO_CRASH ? 0 : 90_000);
  const trySnap = async () => {
    for (;;) {
      try {
        return await snapshot(run.runId);
      } catch (e) {
        if (Date.now() >= settleUntil) throw e;
        say(`API not answering yet (${e instanceof Error ? e.message : String(e)}); actor leases still expiring`);
        await sleep(2000);
      }
    }
  };
  let after = await trySnap();
  while (Date.now() < settleUntil && (!after.run || after.cases.length < before.cases.length || after.roster.length < before.roster.length)) {
    await sleep(2000);
    after = await trySnap();
  }
  say(`after (boot ${after.boot}):`);
  const a = snapRows(after);
  const b = snapRows(before);
  for (const k of Object.keys(a)) ev(`${k.padEnd(11)} ${a[k]}${a[k] === b[k] ? "  (same)" : ""}`);
  const kept = before.cases.filter((c) => after.cases.some((x) => x.id === c.id)).length;
  ev(`survived: run ${after.run ? "yes" : "NO"}, statuses ${after.roster.length}/${before.roster.length}, cases ${kept}/${before.cases.length}, ledger ${after.ledger ? "yes" : "NO"}`);
  if (MOCK) say("MOCK: the restarted mock replays its recording from the start; this shows reconnection only, not persistence");
}

async function beatSwarm() {
  cue(7, "Swarm simulator", "One actor per agent, in shards: 100, then 1,000, then 10,000 agents. We count every state change handled and any that were lost.");
  for (const n of SWARM_SIZES) {
    const mark = sse.events.length;
    const r = await api<{ ok?: boolean; detail?: string; error?: string }>("POST", SWARM_ROUTE, { agents: n }).catch(() => ({ status: 0, data: {} as { ok?: boolean; detail?: string; error?: string } }));
    let stats: SwarmStats | undefined;
    let source: string;
    if (r.status === 200 && r.data.ok) {
      source = `POST ${SWARM_ROUTE} -> ${r.data.detail ?? "ok"}; swarm.stats over SSE`;
      // Final stats = the last swarm.stats for this size once they stop arriving for 3 s.
      let last = Date.now();
      let count = 0;
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        const xs = sse.events.slice(mark).filter((e): e is Ev & { type: "swarm.stats" } => e.type === "swarm.stats" && e.stats.agents === n);
        if (xs.length !== count) {
          count = xs.length;
          last = Date.now();
          stats = xs.at(-1)!.stats;
        }
        if (count > 0 && Date.now() - last > 3000) break;
        await sleep(250);
      }
    } else {
      // No HTTP route (or refused): run the same engine through its CLI. Mock shards when the service is MOCK.
      source = `no swarm route (POST ${SWARM_ROUTE} -> HTTP ${r.status}${r.data?.error ? ` ${r.data.error}` : ""}); orchestrator/src/swarm/run.ts${MOCK ? " --mock" : ""}`;
      const p = Bun.spawn(["bun", "src/swarm/run.ts", ...(MOCK ? ["--mock"] : []), "--steps", String(n)], {
        cwd: join(ROOT, "orchestrator"),
        env: { ...ENV, ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      // The CLI logs lines like "[swarm ...]" first, then prints the result array as JSON starting with a lone "[" line.
      const m = /^\[$/m.exec(out);
      const at = m ? m.index : -1;
      if (code !== 0 || at < 0) {
        say(`swarm ${int(n)}: FAILED (${source}; exit ${code}) ${err.trim().split("\n").at(-1) ?? ""}`);
        continue;
      }
      const rows = JSON.parse(out.slice(at)) as (SwarmStats & { detail: { sent: number; acked: number; gaveUp: number; elapsedMs: number } })[];
      stats = rows[0];
      if (stats) source += ` (sent ${int(rows[0]!.detail.sent)}, acked ${int(rows[0]!.detail.acked)}, gave up ${rows[0]!.detail.gaveUp}, ${rows[0]!.detail.elapsedMs} ms)`;
    }
    if (!stats) {
      say(`swarm ${int(n)}: no stats received (${source})`);
      continue;
    }
    const label = stats.measured ? "measured" : "SIM (mock shards, not measured)";
    ev(`${int(stats.agents).padStart(6)} agents, ${stats.shards} shards: handled ${int(stats.handled)}, LOST ${stats.lost}, ${int(stats.ratePerSec)}/s  [${label}]`);
    ev(`  source: ${source}`);
  }
}

async function beatBench() {
  cue(8, "Close: benchmark", "Baseline Codex subagents vs ours on the same tasks: success rate, recovery time and net cost.");
  const p = SUMMARY;
  if (existsSync(p)) {
    const s = JSON.parse(readFileSync(p, "utf8")) as {
      mock?: boolean;
      generated_at: string;
      note?: string;
      modes: Record<string, { label: string; trials: number; passes: number; success_rate: Stat; usd: Stat; recovery_s: Stat; repeat_trap_hits: Stat; usd_per_passing_task_pooled: number | null }>;
      claim: { sentence: string | null; missing?: string[] };
    };
    type Stat = { mean: number | null; n: number };
    const f = (x: Stat, d = 2) => (x.mean === null ? "n/a" : x.mean.toFixed(d));
    say(`${p.replace(ROOT + "/", "")} (generated ${s.generated_at})${s.mock ? "  [MOCK rows included, not measured]" : ""}`);
    ev(`${"mode".padEnd(26)} trials pass  success  recovery_s  repeat_traps  usd/pass(pooled)`);
    for (const m of Object.values(s.modes))
      ev(`${m.label.padEnd(26)} ${String(m.trials).padStart(6)} ${String(m.passes).padStart(4)}  ${f(m.success_rate).padStart(7)}  ${f(m.recovery_s, 1).padStart(10)}  ${f(m.repeat_trap_hits).padStart(12)}  ${m.usd_per_passing_task_pooled === null ? "n/a" : usd(m.usd_per_passing_task_pooled)}`);
    if (s.claim.sentence) ev(`CLAIM: ${s.claim.sentence}`);
    else ev(`no claim sentence: ${(s.claim.missing ?? []).join("; ")}`);
    if (s.note) ev(s.note);
    return;
  }
  const rows = await get<BenchmarkResultRow[]>("/api/bench");
  if (!rows.length) throw new BeatFail("no bench/results.summary.json and GET /api/bench is empty", "show the chart screenshot from the backup deck and say the numbers are from the earlier runs");
  const mock = rows.some((r) => r.mock);
  say(`bench/results.summary.json not found; ${rows.length} rows from GET /api/bench${mock ? "  [MOCK rows, not measured]" : ""} (run bun bench/aggregate/aggregate.ts for the summary)`);
  ev(`${"mode".padEnd(16)} trials pass  mean_usd  mean_recovery_s  mean_repeat_traps`);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const by = new Map<string, BenchmarkResultRow[]>();
  for (const r of rows) by.set(r.mode, [...(by.get(r.mode) ?? []), r]);
  for (const [mode, rs] of by) {
    const rec = mean(rs.flatMap((r) => (r.recovery_ms === null ? [] : [r.recovery_ms / 1000])));
    ev(`${mode.padEnd(16)} ${String(rs.length).padStart(6)} ${String(rs.filter((r) => r.success).length).padStart(4)}  ${usd(mean(rs.map((r) => r.usd))!).padStart(8)}  ${(rec === null ? "n/a" : rec.toFixed(1)).padStart(15)}  ${mean(rs.map((r) => r.repeat_trap_hits))!.toFixed(2).padStart(17)}`);
  }
}

// ------------------------------------------------------------------ main
const BEATS: [string, string, () => Promise<void>][] = [
  ["start", "start the run", beatStart],
  ["reuse", "wait for a chunk reuse", beatReuse],
  ["possess", "possess an agent", beatPossess],
  ["recover", "retire, case, replacement", beatRecover],
  ["herd", "herd immunity", beatHerd],
  ["crash", "crash test", beatCrash],
  ["swarm", "swarm simulator", beatSwarm],
  ["bench", "benchmark summary", beatBench],
];

async function main() {
  const which = argv[0]!;
  const meta = await get<{ mock: boolean; bootId: string; lastSeq: number }>("/api/meta").catch((e) => {
    console.error(`cannot reach ${API}/api/meta: ${e.message}\n  start the stack (scripts/start-all.sh) or pass --api`);
    process.exit(1);
  });
  MOCK = meta.mock;
  say(`orchestrator ${API} boot ${meta.bootId}${MOCK ? "  ** MOCK SERVICE: everything below is a recording, not measured **" : " (live)"}`);
  sse.start();
  await sse.waitFor(() => (sse.connected ? true : undefined), 10_000, "SSE connect").catch(() => say("WARNING: SSE /api/events not connected; live beats will time out"));
  // Replayed history is in; give the buffer replay a moment to land.
  await sleep(300);

  const selected =
    which === "all"
      ? BEATS
      : BEATS.filter(([name], i) => which.split(",").some((w) => w === name || w === String(i + 1)));
  if (!selected.length) {
    console.error(`unknown beat "${which}"; use all or one of ${BEATS.map(([n], i) => `${i + 1}|${n}`).join(", ")}`);
    process.exit(2);
  }
  const results: [string, string][] = [];
  for (let i = 0; i < selected.length; i++) {
    const [name, , fn] = selected[i]!;
    try {
      await fn();
      results.push([name, "ok"]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      say(`BEAT ${name} FAILED: ${msg}`);
      if (e instanceof BeatFail) say(`FALLBACK: ${e.fallback}`);
      results.push([name, `FAILED: ${msg}`]);
    }
    if (which === "all" && i < selected.length - 1) await pause(selected[i + 1]![1]);
  }
  console.log(`\n${"-".repeat(78)}\n${tag()}summary${runId ? ` (run ${runId})` : ""}`);
  for (const [n, r] of results) console.log(`  ${n.padEnd(8)} ${r}`);
  sse.stop();
  rl?.close();
  process.exit(results.every(([, r]) => r === "ok") ? 0 : 1);
}

await main();
