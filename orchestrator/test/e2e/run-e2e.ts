// End-to-end suite against a RUNNING orchestrator (REST + SSE). Encodes BUILD_SPEC "Done when" rows and
// the demo runbook beats. Talks HTTP only (except `crash`, which shells out to scripts/crash-test.sh on a
// live stack, and `swarm --direct-swarm`, which imports the swarm launcher in-process).
//
//   bun test/e2e/run-e2e.ts [scenario...] [--api URL] [options]      (from orchestrator/)
//
// Scenarios: fleet possess jev-block herd reuse ledger crash swarm runbook   (default: all except runbook)
// Every check prints PASS / FAIL / GAP (contract field optional and absent: never faked) / SKIP (not
// exposed by the API) / LIVE-ONLY (assertion only meaningful against the real stack; not met by the mock).
// See test/e2e/README.md.
import { resolve } from "node:path";
import type {
  AgentCard,
  AgentStatus,
  CaseFile,
  LedgerTotals,
  RecoveryStages,
  RelayFeedItem,
  RunSummary,
  SequencedEvent,
  SwarmStats,
} from "../../src/contract.ts";

// ------------------------------------------------------------------ CLI

const ALL = ["fleet", "possess", "jev-block", "herd", "reuse", "ledger", "crash", "swarm", "runbook"] as const;
type Scenario = (typeof ALL)[number];
/** Execution order when several scenarios share one run: possession must happen before the run finishes. */
const ORDER: Scenario[] = ["possess", "jev-block", "herd", "reuse", "ledger", "crash", "fleet", "swarm", "runbook"];

interface Opts {
  api: string;
  scenarios: Scenario[];
  task: string;
  slot: number;
  agents: number;
  stepDelayMs: number;
  scale: number;
  directSwarm: false | "auto" | "mock";
  swarmAgents: number;
  crashCmd: string | null;
  json: string | null;
  strict: boolean;
}

function usage(code: number): never {
  console.log(`usage: bun test/e2e/run-e2e.ts [scenario...] [options]
scenarios: ${ALL.join(" ")}   (default: all except runbook; 'all' = every scenario)
options:
  --api URL            orchestrator base URL (env E2E_API, default http://127.0.0.1:3000)
  --task ID            task for the demo run (default invoice_parser)
  --slot N             slot to Possess (default 3; pick one that does NOT own the trap function, so
                       another agent can meet the trap and adopt the lesson)
  --agents N           expected agents per run (default 4)
  --step-delay MS      StartRunOpts.stepDelayMs sent with POST /api/runs (env E2E_STEP_DELAY_MS, default 1500)
  --timeout-scale X    multiply every timeout (default 1; env E2E_TIMEOUT_SCALE)
  --direct-swarm[=mock] if POST /api/swarm/start is missing, start the swarm in-process via src/swarm/launch.ts
                       (the function RuntimeService.startSwarm delegates to); =mock forces MOCK shards
  --swarm-agents N     agents for the swarm scenario (default 1000)
  --crash-cmd CMD      live crash command (default: scripts/crash-test.sh --restart, ORCHESTRATOR_PORT from --api)
  --json FILE          also write results as JSON
  --strict             exit non-zero on GAP as well as FAIL`);
  process.exit(code);
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    api: process.env.E2E_API ?? "http://127.0.0.1:3000",
    scenarios: [],
    task: "invoice_parser",
    slot: 3,
    agents: 4,
    stepDelayMs: Number(process.env.E2E_STEP_DELAY_MS ?? 1500),
    scale: Number(process.env.E2E_TIMEOUT_SCALE ?? 1) || 1,
    directSwarm: false,
    swarmAgents: 1000,
    crashCmd: null,
    json: null,
    strict: false,
  };
  const val = (i: number, k: string) => {
    const v = argv[i + 1];
    if (v === undefined) {
      console.error(`missing value for ${k}`);
      usage(2);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [k, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const take = () => inline ?? val(i++, k);
    switch (k) {
      case "-h":
      case "--help":
        usage(0);
      case "--api":
        o.api = take().replace(/\/+$/, "");
        break;
      case "--task":
        o.task = take();
        break;
      case "--slot":
        o.slot = Number(take());
        break;
      case "--agents":
        o.agents = Number(take());
        break;
      case "--step-delay":
        o.stepDelayMs = Number(take());
        break;
      case "--timeout-scale":
        o.scale = Number(take()) || 1;
        break;
      case "--direct-swarm":
        o.directSwarm = inline === "mock" ? "mock" : "auto";
        break;
      case "--swarm-agents":
        o.swarmAgents = Number(take());
        break;
      case "--crash-cmd":
        o.crashCmd = take();
        break;
      case "--json":
        o.json = take();
        break;
      case "--strict":
        o.strict = true;
        break;
      default:
        if (a === "all") o.scenarios.push(...ALL);
        else if ((ALL as readonly string[]).includes(a)) o.scenarios.push(a as Scenario);
        else {
          console.error(`unknown argument ${a}`);
          usage(2);
        }
    }
  }
  if (o.scenarios.length === 0) o.scenarios = ALL.filter((s) => s !== "runbook");
  o.scenarios = ORDER.filter((s) => o.scenarios.includes(s));
  return o;
}

const OPTS = parseArgs(process.argv.slice(2));
const ROOT = resolve(import.meta.dir, "../../..");
const T0 = Date.now();
const sec = (ms: number) => Math.round(ms * OPTS.scale);
/** Timeouts (ms) before --timeout-scale. Live runs are LLM-paced; the mock recording is ~61 s per run. */
const T = {
  http: 15_000,
  firstTrusted: sec(120_000),
  midRun: sec(240_000),
  reuse: sec(300_000),
  possessChain: sec(420_000),
  reply: sec(180_000),
  finish: sec(900_000),
  restart: sec(240_000),
  restore: sec(120_000),
  resume: sec(90_000),
  swarm: sec(300_000),
  hard: {
    fleet: sec(1_200_000),
    possess: sec(900_000),
    "jev-block": sec(900_000),
    herd: sec(900_000),
    reuse: sec(600_000),
    ledger: sec(600_000),
    crash: sec(900_000),
    swarm: sec(600_000),
    runbook: sec(3_600_000),
  } as Record<Scenario, number>,
};

const log = (...a: unknown[]) => console.log(`[e2e +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: unknown, n = 140) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t === undefined ? "undefined" : t.length > n ? `${t.slice(0, n)}...` : t;
};

// ------------------------------------------------------------------ HTTP

interface HttpRes<T = unknown> {
  status: number;
  body: T;
  error?: string;
}

async function http<T = unknown>(method: string, path: string, body?: unknown): Promise<HttpRes<T>> {
  try {
    const r = await fetch(`${OPTS.api}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(T.http),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body
    }
    return { status: r.status, body: parsed as T };
  } catch (e) {
    return { status: 0, body: null as T, error: e instanceof Error ? e.message : String(e) };
  }
}

interface Meta {
  mock: boolean;
  bootId: string;
  lastSeq: number;
}

async function meta(): Promise<Meta | null> {
  const r = await http<Meta>("GET", "/api/meta");
  return r.status === 200 && r.body && typeof r.body === "object" ? r.body : null;
}

// ------------------------------------------------------------------ SSE

interface Rec {
  i: number;
  ev: SequencedEvent;
  boot: string;
  at: number;
}
interface Hello {
  bootId: string;
  mock: boolean;
  since: number;
  gap: boolean;
  restarted: boolean;
  at: number;
}

/** SSE client with Last-Event-ID resume across disconnects and restarts (same rules as the dashboard). */
class Sse {
  recs: Rec[] = [];
  hellos: Hello[] = [];
  disconnects = 0;
  connected = false;
  private lastSeq = 0;
  private boot: string | null = null;
  private seen = new Set<string>();
  private stopped = false;
  private ctrl: AbortController | null = null;

  async start(): Promise<void> {
    const m = await meta();
    if (m) {
      this.lastSeq = m.lastSeq;
      this.boot = m.bootId;
    }
    void this.loop();
    const until = Date.now() + 10_000;
    while (!this.connected && Date.now() < until) await sleep(50);
    if (!this.connected) throw new Error(`SSE ${OPTS.api}/api/events did not connect within 10 s`);
  }

  stop(): void {
    this.stopped = true;
    this.ctrl?.abort();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.once();
      } catch {
        // connection refused / reset: retry below
      }
      if (this.stopped) break;
      if (this.connected) this.disconnects++;
      this.connected = false;
      await sleep(500);
    }
  }

  private async once(): Promise<void> {
    this.ctrl = new AbortController();
    const q = new URLSearchParams({ since: String(this.lastSeq) });
    if (this.boot) q.set("boot", this.boot);
    const r = await fetch(`${OPTS.api}/api/events?${q}`, {
      headers: { Accept: "text/event-stream", "Last-Event-ID": String(this.lastSeq) },
      signal: this.ctrl.signal,
    });
    if (!r.ok || !r.body) throw new Error(`SSE status ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let k: number;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, k);
        buf = buf.slice(k + 2);
        this.frame(frame);
      }
    }
  }

  private frame(frame: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const f = c < 0 ? line : line.slice(0, c);
      const v = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (f === "event") event = v;
      else if (f === "data") data.push(v);
    }
    if (!data.length) return;
    let p: unknown;
    try {
      p = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (event === "hello") {
      const h = p as Hello;
      this.hellos.push({ ...h, at: Date.now() });
      if (this.boot !== h.bootId || h.gap) this.lastSeq = 0;
      this.boot = h.bootId;
      this.connected = true;
      return;
    }
    if (event === "live") return;
    const ev = p as SequencedEvent;
    if (typeof ev?.seq !== "number" || typeof ev.type !== "string") return;
    const key = `${this.boot}:${ev.seq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (ev.seq > this.lastSeq) this.lastSeq = ev.seq;
    this.recs.push({ i: this.recs.length, ev, boot: this.boot ?? "?", at: Date.now() });
  }

  get mark(): number {
    return this.recs.length;
  }

  /** First record at index >= from matching pred, waiting up to timeoutMs. */
  async waitFor(pred: (r: Rec) => boolean, from: number, timeoutMs: number): Promise<Rec | null> {
    const until = Date.now() + timeoutMs;
    let i = from;
    for (;;) {
      for (; i < this.recs.length; i++) if (pred(this.recs[i]!)) return this.recs[i]!;
      if (Date.now() >= until) return null;
      await sleep(100);
    }
  }

  find(pred: (r: Rec) => boolean, from = 0): Rec | undefined {
    for (let i = from; i < this.recs.length; i++) if (pred(this.recs[i]!)) return this.recs[i];
    return undefined;
  }
  filter(pred: (r: Rec) => boolean, from = 0): Rec[] {
    return this.recs.slice(from).filter(pred);
  }
}

const sse = new Sse();
let MOCK = false;

// ------------------------------------------------------------------ reporting

type CheckStatus = "PASS" | "FAIL" | "GAP" | "SKIP" | "LIVE-ONLY";
interface Check {
  name: string;
  status: CheckStatus;
  evidence: string;
}
interface CheckOpts {
  /** Only meaningful against the real stack: a miss on the mock is reported LIVE-ONLY, not FAIL. */
  liveOnly?: boolean;
}

class Report {
  checks: Check[] = [];
  facts: Record<string, unknown> = {};
  closed = false;
  constructor(readonly scenario: string) {}

  private add(name: string, status: CheckStatus, evidence: string): boolean {
    if (this.closed) return status === "PASS";
    this.checks.push({ name, status, evidence });
    console.log(`    ${status.padEnd(9)} ${name}${evidence ? ` -- ${evidence}` : ""}`);
    return status === "PASS";
  }
  check(name: string, ok: boolean, evidence = "", o: CheckOpts = {}): boolean {
    return this.add(name, ok ? "PASS" : o.liveOnly && MOCK ? "LIVE-ONLY" : "FAIL", evidence);
  }
  gap(name: string, evidence: string): false {
    this.add(name, "GAP", evidence);
    return false;
  }
  skip(name: string, evidence: string): false {
    this.add(name, "SKIP", evidence);
    return false;
  }
  fact(k: string, v: unknown): void {
    this.facts[k] = v;
  }
  get status(): "PASS" | "FAIL" | "GAP" | "SKIP" {
    if (this.checks.some((c) => c.status === "FAIL")) return "FAIL";
    if (this.checks.some((c) => c.status === "GAP")) return "GAP";
    if (this.checks.length > 0 && this.checks.every((c) => c.status === "SKIP")) return "SKIP";
    return "PASS";
  }
}

// ------------------------------------------------------------------ run helpers

interface PossessInfo {
  slot: number;
  gen: number;
  name: string;
  /** SSE index right before POST possess. */
  mark: number;
  at: number;
}
interface ChainInfo {
  caseId: string | null;
  replacement: string | null;
}

interface RunCtx {
  runId: string;
  libraryId: string;
  /** SSE index right before POST /api/runs. */
  mark: number;
  summary: RunSummary;
  label: string;
  possessP?: Promise<PossessInfo | null>;
  bound: { scanned: number; end: number | null; startedIn: Set<string> };
  chainP?: Promise<ChainInfo>;
}

/**
 * True when r belongs to this run: same runId, after the start mark, and before the run restarts within the
 * same boot (the mock loops its recording under the same runId; a second "starting" in one boot = new pass).
 * A restart across boots (crash test) stays the same run.
 */
function inRun(ctx: RunCtx, r: Rec): boolean {
  if (r.ev.runId !== ctx.runId || r.i < ctx.mark) return false;
  const b = ctx.bound;
  if (b.end !== null) return r.i < b.end;
  for (; b.scanned < sse.recs.length; b.scanned++) {
    const x = sse.recs[b.scanned]!;
    if (x.ev.runId !== ctx.runId || x.ev.type !== "run.status" || x.ev.run.status !== "starting") continue;
    if (b.startedIn.has(x.boot)) {
      b.end = x.i;
      log(`${ctx.label}: run ${ctx.runId} restarted in the same process at event #${x.i} (mock loop?); later events ignored`);
      break;
    }
    b.startedIn.add(x.boot);
  }
  return b.end === null || r.i < b.end;
}

/** Roster folded from roster + agent.status events of this run up to (inclusive) index `upto`. */
function rosterAt(ctx: RunCtx, upto: number): Map<number, AgentCard> {
  const m = new Map<number, AgentCard>();
  for (let i = ctx.mark; i <= upto && i < sse.recs.length; i++) {
    const ev = sse.recs[i]!.ev;
    if (!inRun(ctx, sse.recs[i]!)) continue;
    if (ev.type === "roster") {
      m.clear();
      for (const a of ev.agents) m.set(a.slot, a);
    } else if (ev.type === "agent.status") {
      const prev = m.get(ev.slot);
      if (ev.agent) m.set(ev.slot, ev.agent);
      else if (prev) m.set(ev.slot, { ...prev, gen: ev.gen, status: ev.status, step: ev.step });
      else m.set(ev.slot, { slot: ev.slot, gen: ev.gen, status: ev.status, step: ev.step } as AgentCard);
    }
  }
  return m;
}

function latestRun(ctx: RunCtx, from = ctx.mark): RunSummary | null {
  const r = sse.filter((x) => inRun(ctx, x) && x.ev.type === "run.status", from).at(-1);
  return r && r.ev.type === "run.status" ? r.ev.run : null;
}

async function startRun(rep: Report, label: string): Promise<RunCtx | null> {
  const mark = sse.mark;
  const body = { taskId: OPTS.task, mode: "ours", stepDelayMs: OPTS.stepDelayMs };
  log(`${label}: POST /api/runs ${JSON.stringify(body)}`);
  const r = await http<RunSummary>("POST", "/api/runs", body);
  const ok = r.status === 200 && !!r.body?.runId;
  rep.check(`${label}: POST /api/runs starts a run`, ok, ok ? `runId=${r.body.runId} status=${r.body.status} libraryId=${r.body.libraryId}` : `HTTP ${r.status} ${short(r.body ?? r.error)}`);
  if (!ok) return null;
  rep.fact("runId", r.body.runId);
  const libraryId = r.body.libraryId;
  const cases0 = await http<CaseFile[]>("GET", `/api/libraries/${encodeURIComponent(libraryId)}/cases`);
  if (cases0.status === 200 && Array.isArray(cases0.body))
    rep.check(`${label}: fresh case library at start`, cases0.body.filter((c) => !c.synthetic).length === 0, `${cases0.body.length} cases in ${libraryId}`);
  else rep.gap(`${label}: fresh case library at start`, `GET /api/libraries/${libraryId}/cases -> HTTP ${cases0.status}`);
  rep.check(`${label}: run is not flagged mock`, !r.body.mock, `mock=${r.body.mock ?? false}`, { liveOnly: true });
  return { runId: r.body.runId, libraryId: r.body.libraryId, mark, summary: r.body, label, bound: { scanned: mark, end: null, startedIn: new Set() } };
}

// One shared demo run for the standalone scenarios (cheaper live: one run, one possession).
let shared: Promise<RunCtx | null> | null = null;
function sharedRun(rep: Report): Promise<RunCtx | null> {
  shared ??= startRun(rep, "shared run");
  return shared;
}

// ------------------------------------------------------------------ checks (shared by scenarios and runbook)

async function checkPreflight(rep: Report): Promise<void> {
  const m = await meta();
  rep.check("GET /api/meta answers", !!m, m ? `bootId=${m.bootId} lastSeq=${m.lastSeq}` : "no answer");
  rep.check("orchestrator is not mock (no MOCK badge)", m?.mock === false, `mock=${m?.mock}`, { liveOnly: true });
  const j = await http<{ online: boolean; mode: string; model: string; mock?: true }>("GET", "/api/jev");
  rep.check("GET /api/jev: Jev online", j.status === 200 && j.body?.online === true, `HTTP ${j.status} ${short(j.body)}`);
  rep.check("Jev status not mock", j.status === 200 && !j.body?.mock, `mock=${j.body?.mock ?? false}`, { liveOnly: true });
}

/** Beat 1 / fleet: 4 agents appear, all trusted at once; the Relay feed is live. */
async function checkFleetStart(ctx: RunCtx, rep: Report): Promise<void> {
  const n = OPTS.agents;
  let rosterSeen: Map<number, AgentCard> | null = null;
  const hit = await sse.waitFor(
    (r) => {
      if (!inRun(ctx, r) || (r.ev.type !== "roster" && r.ev.type !== "agent.status")) return false;
      const m = rosterAt(ctx, r.i);
      if (m.size === n && [...m.values()].every((a) => a.status === "trusted")) {
        rosterSeen = m;
        return true;
      }
      return false;
    },
    ctx.mark,
    T.firstTrusted,
  );
  const m = rosterSeen as Map<number, AgentCard> | null;
  rep.check(
    `${n} agents appear, all trusted`,
    !!hit,
    hit && m ? [...m.values()].map((a) => `${a.name ?? `slot${a.slot}`}:${a.status}`).join(" ") : `last roster: ${short([...rosterAt(ctx, sse.recs.length).values()].map((a) => `${a.slot}:${a.status}`))}`,
  );
  if (m) {
    const names = [...m.values()].map((a) => a.name).filter(Boolean);
    rep.check("agent names follow w<slot>-g<gen>-<runId>", names.length === n && names.every((x) => /^w\d+-g\d+-/.test(x) && x.endsWith(ctx.runId)), short(names));
  }
  const rest = await http<AgentCard[]>("GET", `/api/runs/${ctx.runId}/roster`);
  rep.check("GET roster returns the agents", rest.status === 200 && Array.isArray(rest.body) && rest.body.length === n, `HTTP ${rest.status} ${Array.isArray(rest.body) ? `${rest.body.length} cards` : short(rest.body)}`);
  const msg = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "relay.message", ctx.mark, T.firstTrusted);
  rep.check("Relay feed shows fleet messages", !!msg && msg.ev.type === "relay.message", msg && msg.ev.type === "relay.message" ? `${msg.ev.item.channel} ${msg.ev.item.from}: ${short(msg.ev.item.text, 60)}` : "no relay.message");
  if (msg && msg.ev.type === "relay.message") rep.check("fleet channel is named fleet-<runId>", sse.find((r) => r.ev.type === "relay.message" && inRun(ctx, r) && r.ev.item.channel === `fleet-${ctx.runId}`, ctx.mark) !== undefined, `channel=${msg.ev.item.channel}`);
}

/** Beat 2 / Shared verified reasoning: a verified note is reused; reuse counter (est.) ticks. */
async function checkReuse(ctx: RunCtx, rep: Report): Promise<void> {
  const hit = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "ledger.totals" && r.ev.totals.reuse_est_tokens > 0, ctx.mark, T.reuse);
  let totals: LedgerTotals | null = hit && hit.ev.type === "ledger.totals" ? hit.ev.totals : null;
  if (!totals) {
    const g = await http<LedgerTotals | null>("GET", `/api/runs/${ctx.runId}/ledger`);
    if (g.status === 200 && g.body && g.body.reuse_est_tokens > 0) totals = g.body;
  }
  rep.fact("reuse_est_tokens", totals?.reuse_est_tokens ?? 0);
  rep.check("ledger reuse_est_tokens > 0 (reuse counter ticks)", !!totals, totals ? `reuse_est_tokens=${totals.reuse_est_tokens}` : `none within ${T.reuse / 1000}s`);
  if (totals) rep.check("reuse is labelled an estimate (est.reuse_est_tokens)", totals.est?.reuse_est_tokens === true, short(totals.est));
  const note = sse.find((r) => inRun(ctx, r) && r.ev.type === "relay.message" && /reus/i.test(r.ev.item.text), ctx.mark);
  if (note && note.ev.type === "relay.message") rep.check("chunk-reuse event visible in the Relay feed", true, `${note.ev.item.from}: ${short(note.ev.item.text, 80)}`);
  else rep.skip("chunk-reuse event visible", "the contract has no chunk.reused event and no feed message mentioned reuse");
  rep.skip("verified note appears in another agent's prompt", "prompt contents are not exposed over the API (check orchestrator logs)");
}

/** Beat 3: Possess the chosen slot mid-run. Memoized per run. */
function possessOnce(ctx: RunCtx, rep: Report): Promise<PossessInfo | null> {
  ctx.possessP ??= (async () => {
    const slot = OPTS.slot;
    // Mid-run: the slot is active and has completed at least one step.
    const ready = await sse.waitFor(
      (r) => {
        if (!inRun(ctx, r)) return false;
        const a = rosterAt(ctx, r.i).get(slot);
        return !!a && a.step >= 1 && (a.status === "trusted" || a.status === "probation");
      },
      ctx.mark,
      T.midRun,
    );
    const card = rosterAt(ctx, sse.recs.length).get(slot);
    rep.check(`slot ${slot} is mid-run before Possess`, !!ready, card ? `${card.name} gen=${card.gen} status=${card.status} step=${card.step}` : "no card for slot");
    if (!card) return null;
    const mark = sse.mark;
    const at = Date.now();
    const r = await http<{ ok: boolean; error?: string; detail?: string }>("POST", `/api/runs/${ctx.runId}/possess`, { slot });
    const ok = r.status === 200 && r.body?.ok === true;
    rep.check(`POST possess slot ${slot}`, ok, `HTTP ${r.status} ${short(r.body ?? r.error)}${r.body?.error === "run_finished" ? " (run finished before Possess: is stepDelayMs forwarded by POST /api/runs?)" : ""}`);
    if (MOCK && /queued/i.test(r.body?.detail ?? "")) rep.check("mock possession plays now (not queued)", false, r.body?.detail ?? "", { liveOnly: true });
    if (!ok) return null;
    rep.fact("possessed", `${card.name} (slot ${slot} g${card.gen})`);
    return { slot, gen: card.gen, name: card.name, mark, at };
  })();
  return ctx.possessP;
}

/** Beat 4 / Retire and respawn: false claim -> test failure -> retire -> case file -> replacement -> recovery. */
function chainOnce(ctx: RunCtx, rep: Report): Promise<ChainInfo> {
  ctx.chainP ??= (async () => {
    const out: ChainInfo = { caseId: null, replacement: null };
    const p = await possessOnce(ctx, rep);
    if (!p) return out;
    const { slot, gen, name, mark } = p;
    const deadline = Date.now() + T.possessChain;
    const left = () => Math.max(1000, deadline - Date.now());
    const mine = (r: Rec) => inRun(ctx, r);

    // False claim (F1): the possessed agent claims success; or the detection reason names the claim.
    const claim = sse.find((r) => mine(r) && r.ev.type === "relay.message" && (r.ev.item.from === name || r.ev.item.metadata.slot === slot) && !r.ev.item.blocked && /pass|done|✅/i.test(r.ev.item.text), mark);

    const detected = await sse.waitFor(
      (r) => mine(r) && r.ev.type === "agent.status" && r.ev.slot === slot && r.ev.gen === gen && ["under_investigation", "retiring", "retired"].includes(r.ev.status),
      mark,
      left(),
    );
    rep.check("possessed agent is caught (under_investigation/retiring)", !!detected, detected && detected.ev.type === "agent.status" ? `${detected.ev.status}: ${detected.ev.reason ?? "(no reason)"}` : "no status change");
    const retired = await sse.waitFor((r) => mine(r) && r.ev.type === "agent.status" && r.ev.slot === slot && r.ev.gen === gen && r.ev.status === "retired", mark, left());
    rep.check(`agent ${name} retired`, !!retired, retired && retired.ev.type === "agent.status" ? `reason=${retired.ev.reason ?? "-"} +${((retired.at - p.at) / 1000).toFixed(1)}s after Possess` : "never retired");

    const cRec = await sse.waitFor((r) => mine(r) && r.ev.type === "case.created" && r.ev.case.slot === slot && r.ev.case.gen === gen, mark, left());
    const cEv = cRec && cRec.ev.type === "case.created" ? cRec.ev.case : null;
    rep.check("case.created for the retired agent", !!cEv, cEv ? `caseId=${cEv.id}` : "no case.created");
    if (cEv) {
      out.caseId = cEv.id;
      rep.fact("caseId", cEv.id);
      rep.check("case id is <runId>.<slot>.g<gen>", cEv.id === `${ctx.runId}.${slot}.g${gen}`, cEv.id);
      const ev = cEv.evidence ?? {};
      const claimText = cEv.claim ?? "";
      rep.check("false claim recorded (relay claim or case.claim)", !!claim || claimText.length > 0, claim && claim.ev.type === "relay.message" ? `relay: ${short(claim.ev.item.text, 60)}; case.claim: ${short(claimText, 60)}` : `case.claim: ${short(claimText, 80)}`);
      if (ev.testOutput) rep.check("test failure in evidence (testOutput)", /fail|error|assert/i.test(ev.testOutput), short(ev.testOutput.split("\n").at(-1), 90));
      else rep.check("test failure in evidence (testOutput)", false, "evidence.testOutput absent: a Possess (F1) case must carry the failing pytest tail");
      rep.check("case category set", typeof cEv.category === "string", `category=${cEv.category}`);
      rep.check("case lesson present", typeof cEv.lesson === "string" && cEv.lesson.length > 0, short(cEv.lesson, 100));
      if (cEv.replacement) out.replacement = cEv.replacement;
      else rep.gap("case.replacement", "replacement field absent on case.created");
    }

    // Replacement on probation: gen+1 for the slot.
    const repl = await sse.waitFor(
      (r) => {
        if (!mine(r)) return false;
        if (r.ev.type === "agent.status") return r.ev.slot === slot && r.ev.gen === gen + 1 && r.ev.status === "probation";
        if (r.ev.type === "roster") return r.ev.agents.some((a) => a.slot === slot && a.gen === gen + 1 && a.status === "probation");
        return false;
      },
      mark,
      left(),
    );
    const replName = repl ? (rosterAt(ctx, repl.i).get(slot)?.name ?? out.replacement) : null;
    rep.check(`replacement g${gen + 1} on probation`, !!repl, repl ? `${replName ?? "?"} via ${repl.ev.type}` : "no gen+1 probation agent");
    if (replName && cEv?.replacement) rep.check("case.replacement names the new agent", cEv.replacement === replName, `${cEv.replacement} vs ${replName}`);
    if (replName) rep.check("replacement name is w<slot>-g<gen+1>-<runId>", replName === `w${slot}-g${gen + 1}-${ctx.runId}`, replName);

    // Recovery event with stages; tests passing again.
    const recov = await sse.waitFor((r) => mine(r) && r.ev.type === "recovery" && (out.caseId ? r.ev.caseId === out.caseId : r.ev.slot === slot), mark, left());
    rep.check("recovery event", !!recov, recov && recov.ev.type === "recovery" ? `caseId=${recov.ev.caseId} ms=${recov.ev.ms}` : "no recovery event");
    if (recov && recov.ev.type === "recovery") {
      rep.fact("recovery_ms", recov.ev.ms);
      const st = recov.ev.stages;
      if (!st) rep.gap("recovery.stages", "stages absent");
      else {
        const keys: (keyof RecoveryStages)[] = ["faultAt", "detectedAt", "retireBeganAt", "caseFiledAt", "respawnedAt", "testsPassingAt"];
        const missing = keys.filter((k) => st[k] === null || st[k] === undefined);
        rep.check("all recovery stages known (Possess run)", missing.length === 0, missing.length ? `null: ${missing.join(", ")}` : keys.map((k) => `${k}=+${((st[k]! - st.faultAt!) / 1000).toFixed(1)}s`).join(" "));
        const vals = keys.map((k) => st[k]).filter((v): v is number => typeof v === "number");
        rep.check("recovery stages in order", vals.every((v, i) => i === 0 || v >= vals[i - 1]!), short(st));
        if (typeof st.testsPassingAt === "number" && typeof st.detectedAt === "number")
          rep.check("recovery.ms == testsPassingAt - detectedAt", recov.ev.ms === st.testsPassingAt - st.detectedAt, `${recov.ev.ms} vs ${st.testsPassingAt - st.detectedAt}`);
      }
      if (retired) rep.check("recovery after retire", recov.i > retired.i, `retired #${retired.i}, recovery #${recov.i}`);
    }
    const passing = await sse.waitFor((r) => mine(r) && r.ev.type === "run.status" && r.ev.run.testsTotal > 0 && r.ev.run.testsPassing === r.ev.run.testsTotal && (!recov || r.i >= recov.i), recov ? recov.i : mark, left());
    rep.check("tests passing again after recovery", !!passing, passing && passing.ev.type === "run.status" ? `${passing.ev.run.testsPassing}/${passing.ev.run.testsTotal} status=${passing.ev.run.status}` : `latest: ${short(latestRun(ctx) && `${latestRun(ctx)!.testsPassing}/${latestRun(ctx)!.testsTotal}`)}`);
    const run = latestRun(ctx);
    if (run) rep.check("run counters: retires >= 1, cases >= 1", run.retires >= 1 && run.cases >= 1, `retires=${run.retires} cases=${run.cases}`);
    return out;
  })();
  return ctx.chainP;
}

/** Jev checks: the F3 conflicting instruction shows as a blocked relay.message with a reason. */
async function checkJevBlock(ctx: RunCtx, rep: Report): Promise<void> {
  const p = await possessOnce(ctx, rep);
  if (!p) return void rep.check("blocked F3 message", false, "Possess did not happen");
  const hit = await sse.waitFor(
    (r) => inRun(ctx, r) && r.ev.type === "relay.message" && !!r.ev.item.blocked && (r.ev.item.from === p.name || r.ev.item.metadata.slot === p.slot),
    p.mark,
    T.possessChain,
  );
  const item: RelayFeedItem | null = hit && hit.ev.type === "relay.message" ? hit.ev.item : null;
  rep.check("F3 conflicting message appears blocked", !!item, item ? `${item.from}: ${short(item.text, 70)}` : "no blocked relay.message from the possessed agent");
  if (!item?.blocked) return;
  const b = item.blocked;
  rep.fact("blocked", `${b.source} p=${b.probability}`);
  rep.check("blocked.reason non-empty", typeof b.reason === "string" && b.reason.trim().length > 0, short(b.reason, 90));
  rep.check("blocked by instruction_conflicts_spec", b.questionId === "instruction_conflicts_spec", `questionId=${b.questionId}`);
  rep.check("decided by Jev or the fallback judge", b.source === "jev" || b.source === "fallback", `source=${b.source}`);
  if (b.source === "jev") rep.check("Jev probability >= act threshold 0.62 (DECISIONS #10)", b.probability >= 0.62, `p=${b.probability}`);
  const feed = await http<RelayFeedItem[]>("GET", `/api/runs/${ctx.runId}/relay`);
  const inFeed = Array.isArray(feed.body) ? feed.body.find((x) => x.seq === item.seq) : undefined;
  rep.check("GET /relay keeps the blocked item with its reason", !!inFeed?.blocked?.reason, inFeed ? `seq=${inFeed.seq}` : `HTTP ${feed.status}, seq ${item.seq} not found`);
  const jev = sse.filter((r) => r.ev.type === "jev.status").at(-1);
  if (jev && jev.ev.type === "jev.status" && b.source === "fallback") rep.check("fallback decision coincides with Jev offline banner", jev.ev.status.mode === "fallback", short(jev.ev.status));
}

/** Herd immunity: case reaches related agents, they reply, lesson is stored. */
async function checkHerd(ctx: RunCtx, rep: Report): Promise<void> {
  const chain = await chainOnce(ctx, rep);
  if (!chain.caseId) return void rep.check("case to broadcast", false, "no case was created");
  const id = chain.caseId;
  const bcast = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "relay.message" && r.ev.item.channel === `cases-${ctx.runId}` && r.ev.item.metadata.caseId === id && r.ev.item.metadata.kind !== "case_reply", ctx.mark, T.reply);
  rep.check(`case posted to cases-${ctx.runId}`, !!bcast, bcast && bcast.ev.type === "relay.message" ? `${bcast.ev.item.from}: ${short(bcast.ev.item.text, 70)}` : "no case message on the cases channel");
  if (bcast && bcast.ev.type === "relay.message") rep.check("case posted by warden-<runId>", bcast.ev.item.from === `warden-${ctx.runId}`, `from=${bcast.ev.item.from}`, { liveOnly: true });

  const reply = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "case.reply" && r.ev.caseId === id, ctx.mark, T.reply);
  rep.check(">= 1 case.reply", !!reply, reply && reply.ev.type === "case.reply" ? `${reply.ev.reply.from}: ${short(reply.ev.reply.text, 70)}` : `none within ${T.reply / 1000}s`);

  const g = await http<CaseFile>("GET", `/api/cases/${encodeURIComponent(id)}`);
  const cf = g.status === 200 ? g.body : null;
  rep.check("GET /api/cases/:id", !!cf, `HTTP ${g.status}`);
  if (!cf) return;
  rep.fact("recipients", cf.recipients);
  rep.check("recipients non-empty", Array.isArray(cf.recipients) && cf.recipients.length > 0, short(cf.recipients));
  rep.check("recipients <= 3 and exclude the retired agent", (cf.recipients ?? []).length <= 3 && !(cf.recipients ?? []).includes(cf.agentName), `${(cf.recipients ?? []).length} recipients, author ${cf.agentName}`);
  rep.check("lesson present on the stored case", typeof cf.lesson === "string" && cf.lesson.length > 0, short(cf.lesson, 100));
  rep.check("evidence present on the stored case", !!cf.evidence && (!!cf.evidence.testOutput || !!cf.evidence.jev), short(Object.keys(cf.evidence ?? {})));
  if (!Array.isArray(cf.replies)) rep.gap("case.replies", "replies field absent on GET /api/cases/:id");
  else {
    rep.fact("replies", cf.replies.length);
    rep.check("stored case has >= 1 reply", cf.replies.length >= 1, `${cf.replies.length} replies`);
    rep.check("<= 3 replies, from recipients only, none from the author", cf.replies.length <= 3 && cf.replies.every((x) => x.from !== cf.agentName && (cf.recipients ?? []).includes(x.from)), short(cf.replies.map((x) => x.from)));
  }
  const byRun = await http<CaseFile[]>("GET", `/api/runs/${ctx.runId}/cases`);
  rep.check("case listed under the run", Array.isArray(byRun.body) && byRun.body.some((c) => c.id === id), `HTTP ${byRun.status}`);
  const byLib = await http<CaseFile[]>("GET", `/api/libraries/${encodeURIComponent(cf.libraryId)}/cases`);
  rep.check("case listed under its library", Array.isArray(byLib.body) && byLib.body.some((c) => c.id === id), `library ${cf.libraryId} HTTP ${byLib.status}`);

  // Immunity counters (optional in the contract: absent => GAP).
  const imm = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "run.status" && !!r.ev.run.immunity && r.ev.run.immunity.casesBroadcast >= 1, ctx.mark, T.reply);
  const run = latestRun(ctx);
  if (!run?.immunity && !imm) rep.gap("run.immunity counters", "RunSummary.immunity absent");
  else {
    const im = (imm && imm.ev.type === "run.status" ? imm.ev.run.immunity : run?.immunity)!;
    rep.check("immunity.casesBroadcast >= 1", im.casesBroadcast >= 1, short(im));
    // Adoption needs the recipient's next verified step: wait for it, but no longer than the run lasts.
    const adopted = await sse.waitFor(
      (r) => inRun(ctx, r) && r.ev.type === "run.status" && ((r.ev.run.immunity?.lessonsAdopted ?? 0) >= 1 || ["finished", "failed", "stopped"].includes(r.ev.run.status)),
      ctx.mark,
      T.finish,
    );
    const ad = adopted && adopted.ev.type === "run.status" ? adopted.ev.run.immunity : undefined;
    rep.check(
      "a recipient adopted the lesson (immunity.lessonsAdopted >= 1)",
      (ad?.lessonsAdopted ?? 0) >= 1,
      `${short(ad ?? latestRun(ctx)?.immunity)}${(ad?.lessonsAdopted ?? 0) >= 1 ? "" : " (if the possessed slot owns the trap function, nobody else meets the trap: Possess another slot)"}`,
    );
    const now = latestRun(ctx)?.immunity;
    if (now) rep.check("no repeat trap hits so far (recipients steered clear)", now.repeatTrapHits === 0, `repeatTrapHits=${now.repeatTrapHits} repeatFailures=${latestRun(ctx)?.repeatFailures ?? "-"}`);
  }
  rep.skip("lesson in later prompts", "prompt lessons block is not exposed over the API (check orchestrator logs)");
}

const LEDGER_ROW_PATHS = (runId: string) => [`/api/runs/${runId}/ledger/rows`, `/api/ledger/${runId}/rows`, `/api/runs/${runId}/ledger?rows=1`];

/** Token ledger: totals consistent with themselves and (when exposed) with the sum of rows. */
async function checkLedger(ctx: RunCtx, rep: Report): Promise<void> {
  const hit = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "ledger.totals" && r.ev.totals.by_category?.worker?.calls > 0, ctx.mark, T.midRun);
  const g = await http<LedgerTotals | null>("GET", `/api/runs/${ctx.runId}/ledger`);
  rep.check("GET /api/runs/:id/ledger returns totals", g.status === 200 && !!g.body, `HTTP ${g.status}${g.body ? ` worker_usd=${g.body.worker_usd} overhead_usd=${g.body.overhead_usd}` : ` ${short(g.body ?? g.error)}`}`);
  // Check the latest totals streamed for THIS run (the GET can belong to a later pass on a looping mock).
  const last = sse.filter((r) => inRun(ctx, r) && r.ev.type === "ledger.totals", ctx.mark).at(-1);
  const t = last && last.ev.type === "ledger.totals" ? last.ev.totals : g.status === 200 ? g.body : null;
  if (!hit) rep.check("ledger.totals streamed with worker calls", false, `none within ${T.midRun / 1000}s`);
  if (!t) return;
  const cats = Object.entries(t.by_category ?? {}) as [string, LedgerTotals["by_category"]["worker"]][];
  rep.check("worker calls > 0", (t.by_category?.worker?.calls ?? 0) > 0, `worker calls=${t.by_category?.worker?.calls}`);
  const sum = (f: (c: LedgerTotals["by_category"]["worker"]) => number, which = cats) => which.reduce((s, [, c]) => s + (f(c) || 0), 0);
  const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  for (const k of ["input", "cached", "output", "reasoning"] as const)
    rep.check(`tokens.${k} == sum over categories`, eq(t.tokens[k], sum((c) => c[k])), `${t.tokens[k]} vs ${sum((c) => c[k])}`);
  rep.check("cached <= input, reasoning <= output", t.tokens.cached <= t.tokens.input && t.tokens.reasoning <= t.tokens.output, short(t.tokens));
  rep.check("worker_usd == by_category.worker.usd", eq(t.worker_usd, t.by_category?.worker?.usd ?? NaN), `${t.worker_usd} vs ${t.by_category?.worker?.usd}`);
  const over = sum((c) => c.usd, cats.filter(([k]) => k !== "worker"));
  rep.check("overhead_usd == sum of non-worker categories", eq(t.overhead_usd, over), `${t.overhead_usd} vs ${over}`);
  rep.check("calls.jev == by_category.jev.calls", t.calls?.jev === (t.by_category?.jev?.calls ?? 0), `${t.calls?.jev} vs ${t.by_category?.jev?.calls}`);
  rep.check("calls.fallback == by_category.fallback_judge.calls", t.calls?.fallback === (t.by_category?.fallback_judge?.calls ?? 0), `${t.calls?.fallback} vs ${t.by_category?.fallback_judge?.calls}`);
  const run = latestRun(ctx);
  if (run) rep.check("run.usd == worker_usd + overhead_usd", Math.abs(run.usd - (t.worker_usd + t.overhead_usd)) <= 1e-4 + 0.01 * run.usd, `run.usd=${run.usd} ledger=${t.worker_usd + t.overhead_usd} (run.status may lag the ledger)`);
  if (t.net_savings_usd === undefined) rep.skip("net savings", "net_savings_usd appears only once a baseline run exists for the task");
  else rep.check("net savings has a baselineRunId", !!t.baselineRunId, `net_savings_usd=${t.net_savings_usd} baseline=${t.baselineRunId}`);
  rep.fact("ledger", `worker=$${t.worker_usd.toFixed(4)} overhead=$${t.overhead_usd.toFixed(4)} in=${t.tokens.input} out=${t.tokens.output}`);

  // Totals == sum of rows: only if a rows endpoint exists.
  for (const path of LEDGER_ROW_PATHS(ctx.runId)) {
    const r = await http<unknown>("GET", path);
    if (r.status !== 200 || !Array.isArray(r.body)) continue;
    const rows = r.body as Record<string, unknown>[];
    const num = (x: Record<string, unknown>, ...ks: string[]) => ks.reduce((v, k) => v || Number(x[k] ?? 0), 0);
    const s = { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 };
    for (const x of rows) {
      s.input += num(x, "input_tokens", "input");
      s.cached += num(x, "cached_input_tokens", "cached");
      s.output += num(x, "output_tokens", "output");
      s.reasoning += num(x, "reasoning_tokens", "reasoning");
      s.usd += num(x, "usd");
    }
    // Totals may move between the two GETs while the run is live; re-read and compare.
    const t2 = (await http<LedgerTotals>("GET", `/api/runs/${ctx.runId}/ledger`)).body ?? t;
    rep.check(`totals == sum of ${rows.length} rows (${path})`, s.input === t2.tokens.input && s.cached === t2.tokens.cached && s.output === t2.tokens.output && s.reasoning === t2.tokens.reasoning && eq(s.usd, t2.worker_usd + t2.overhead_usd), `rows ${short(s)} vs totals ${short({ ...t2.tokens, usd: t2.worker_usd + t2.overhead_usd })}`);
    return;
  }
  rep.skip("ledger totals == sum of rows", `no rows endpoint (tried ${LEDGER_ROW_PATHS(ctx.runId).join(", ")}); RuntimeService has no getLedgerRows`);
}

interface Snapshot {
  roster: AgentCard[];
  cases: CaseFile[];
  ledger: LedgerTotals | null;
  run: RunSummary | null;
}
async function snapshot(runId: string): Promise<Snapshot> {
  const [ro, ca, le, ru] = await Promise.all([
    http<AgentCard[]>("GET", `/api/runs/${runId}/roster`),
    http<CaseFile[]>("GET", `/api/runs/${runId}/cases`),
    http<LedgerTotals | null>("GET", `/api/runs/${runId}/ledger`),
    http<RunSummary[]>("GET", "/api/runs"),
  ]);
  return {
    roster: ro.status === 200 && Array.isArray(ro.body) ? ro.body : [],
    cases: ca.status === 200 && Array.isArray(ca.body) ? ca.body : [],
    ledger: le.status === 200 ? le.body : null,
    run: Array.isArray(ru.body) ? (ru.body.find((r) => r.runId === runId) ?? null) : null,
  };
}

const RANK: Record<AgentStatus, number> = { probation: 0, trusted: 1, under_investigation: 2, retiring: 3, retired: 4, failed: 5 };

/** Beat 6 / Durable actors: kill -9 both servers mid-run; statuses, cases and totals come back; SSE resumes. */
async function checkCrash(ctx: RunCtx, rep: Report): Promise<void> {
  const m0 = await meta();
  if (!m0) return void rep.check("API up before crash", false, "GET /api/meta failed");
  const pre = await snapshot(ctx.runId);
  rep.fact("pre", `roster=${pre.roster.length} cases=${pre.cases.length} usd=${pre.ledger ? (pre.ledger.worker_usd + pre.ledger.overhead_usd).toFixed(4) : "-"} run=${pre.run?.status}`);
  log(`crash: pre-crash roster=${short(pre.roster.map((a) => `${a.slot}:g${a.gen}:${a.status}:s${a.step}`))} cases=${pre.cases.length}`);
  const disc0 = sse.disconnects;
  const hellos0 = sse.hellos.length;

  if (m0.mock) {
    // Never shell out to crash-test.sh against a mock: it kills whatever holds ACTORS_PORT/ORCHESTRATOR_PORT.
    const r = await http("POST", "/api/demo/crash");
    rep.check("MOCK crash via POST /api/demo/crash", r.status === 200, `HTTP ${r.status} (real test: scripts/crash-test.sh --restart)`);
  } else {
    const port = new URL(OPTS.api).port || "80";
    const cmd = OPTS.crashCmd ?? `bash ${JSON.stringify(`${ROOT}/scripts/crash-test.sh`)} --restart`;
    log(`crash: running ${cmd} (ORCHESTRATOR_PORT=${port})`);
    const p = Bun.spawn(["bash", "-c", cmd], { cwd: ROOT, env: { ...process.env, ORCHESTRATOR_PORT: port }, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), T.restart);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(killer);
    for (const l of (out + err).trim().split("\n")) console.log(`      | ${l}`);
    rep.check("crash-test.sh: both servers killed (CRASH TEST: PASS)", /CRASH TEST: PASS/.test(out), `exit ${code}`);
    rep.check("crash-test.sh --restart: RESTART: OK", /RESTART: OK/.test(out), `exit ${code}`);
  }

  // API back with a new boot id.
  const until = Date.now() + T.restart;
  let m1: Meta | null = null;
  while (Date.now() < until) {
    m1 = await meta();
    if (m1 && m1.bootId !== m0.bootId) break;
    await sleep(500);
  }
  const back = !!m1 && m1.bootId !== m0.bootId;
  rep.check("API back after restart (new bootId)", back, back ? `boot ${m0.bootId} -> ${m1!.bootId}` : "same boot or no answer");
  if (!back) return;
  rep.check("restarted orchestrator is not mock", m1!.mock === false, `mock=${m1!.mock}`, { liveOnly: true });

  // SSE noticed and resumed.
  const sseUntil = Date.now() + 30_000;
  while (Date.now() < sseUntil && !sse.hellos.slice(hellos0).some((h) => h.bootId === m1!.bootId)) await sleep(200);
  const h = sse.hellos.slice(hellos0).find((x) => x.bootId === m1!.bootId);
  rep.check("SSE reconnected to the new process", !!h && sse.disconnects > disc0, h ? `restarted=${h.restarted} gap=${h.gap} disconnects=${sse.disconnects - disc0}` : "no hello from the new boot");
  if (h) rep.check("SSE hello flags the restart (client must refetch snapshots)", h.restarted || h.gap, `restarted=${h.restarted} gap=${h.gap}`);

  // State restored (actors may answer "unavailable" for ~30 s after kill -9: poll).
  const rUntil = Date.now() + T.restore;
  let post = await snapshot(ctx.runId);
  while (Date.now() < rUntil && (post.roster.length < pre.roster.length || post.cases.length < pre.cases.length || (pre.ledger && !post.ledger))) {
    await sleep(1000);
    post = await snapshot(ctx.runId);
  }
  rep.fact("post", `roster=${post.roster.length} cases=${post.cases.length} usd=${post.ledger ? (post.ledger.worker_usd + post.ledger.overhead_usd).toFixed(4) : "-"} run=${post.run?.status}`);
  const L = { liveOnly: true };
  rep.check("run still listed after restart", !!post.run, post.run ? `${post.run.runId} status=${post.run.status}` : `${ctx.runId} missing from GET /api/runs`, L);
  if (pre.run && post.run) rep.check("run counters not lost (retires, cases)", post.run.retires >= pre.run.retires && post.run.cases >= pre.run.cases && post.run.status !== "failed", `retires ${pre.run.retires}->${post.run.retires} cases ${pre.run.cases}->${post.run.cases} status ${pre.run.status}->${post.run.status}`, L);
  const rosterDiff: string[] = [];
  for (const a of pre.roster) {
    const b = post.roster.find((x) => x.slot === a.slot);
    if (!b) rosterDiff.push(`slot ${a.slot} missing`);
    else if (b.gen < a.gen) rosterDiff.push(`slot ${a.slot} gen ${a.gen}->${b.gen}`);
    else if (b.gen === a.gen && RANK[b.status] < RANK[a.status] && !(a.status === "under_investigation" && b.status === "trusted")) rosterDiff.push(`slot ${a.slot} ${a.status}->${b.status}`);
    else if (b.gen === a.gen && b.step < a.step - 1) rosterDiff.push(`slot ${a.slot} step ${a.step}->${b.step}`);
    else if (b.gen === a.gen && b.name !== a.name) rosterDiff.push(`slot ${a.slot} name ${a.name}->${b.name}`);
  }
  rep.check("roster restored (same gens/statuses, in-flight progress allowed)", pre.roster.length > 0 && rosterDiff.length === 0, rosterDiff.length ? rosterDiff.join("; ") : post.roster.map((a) => `${a.slot}:g${a.gen}:${a.status}:s${a.step}`).join(" "), L);
  const caseDiff: string[] = [];
  for (const c of pre.cases) {
    const d = post.cases.find((x) => x.id === c.id);
    if (!d) caseDiff.push(`${c.id} missing`);
    else if (d.lesson !== c.lesson || d.category !== c.category || d.revoked !== c.revoked) caseDiff.push(`${c.id} changed`);
    else if (!c.recipients.every((x) => d.recipients.includes(x))) caseDiff.push(`${c.id} lost recipients`);
    else if ((d.replies?.length ?? 0) < (c.replies?.length ?? 0)) caseDiff.push(`${c.id} lost replies`);
  }
  rep.check("cases restored (same ids, lessons, recipients, replies)", caseDiff.length === 0, caseDiff.length ? caseDiff.join("; ") : `${post.cases.length} cases (${pre.cases.length} before)`, L);
  if (pre.ledger) {
    const a = pre.ledger;
    const b = post.ledger;
    const ok =
      !!b &&
      b.tokens.input >= a.tokens.input &&
      b.tokens.output >= a.tokens.output &&
      b.worker_usd >= a.worker_usd - 1e-9 &&
      b.overhead_usd >= a.overhead_usd - 1e-9 &&
      b.calls.jev >= a.calls.jev &&
      b.reuse_est_tokens >= a.reuse_est_tokens;
    rep.check("ledger totals restored (never below pre-crash)", ok, b ? `in ${a.tokens.input}->${b.tokens.input} out ${a.tokens.output}->${b.tokens.output} usd ${(a.worker_usd + a.overhead_usd).toFixed(4)}->${(b.worker_usd + b.overhead_usd).toFixed(4)}` : "ledger null after restart", L);
  } else rep.skip("ledger totals restored", "ledger was null before the crash");

  // Events for the run flow again; if it was running, agents carry on.
  const mark = sse.mark;
  const again = await sse.waitFor((r) => inRun(ctx, r) && r.boot === m1!.bootId, Math.max(0, mark - 50), T.resume);
  rep.check("SSE delivers this run's events after restart", !!again, again ? `${again.ev.type} seq=${again.ev.seq}` : `none within ${T.resume / 1000}s`, L);
  if (pre.run && ["running", "recovering", "starting"].includes(pre.run.status)) {
    const prog = await sse.waitFor(
      (r) =>
        inRun(ctx, r) &&
        r.boot === m1!.bootId &&
        ((r.ev.type === "agent.status" && r.ev.step > (pre.roster.find((a) => a.slot === (r.ev as { slot: number }).slot)?.step ?? 0)) || (r.ev.type === "run.status" && r.ev.run.status === "finished")),
      mark,
      T.resume,
    );
    rep.check("agents carry on after restart (a step advances or the run finishes)", !!prog, prog ? `${prog.ev.type}${prog.ev.type === "agent.status" ? ` slot ${prog.ev.slot} step ${prog.ev.step}` : ""}` : "no progress", L);
  }
}

/** Worker loop: run finishes with tests passing. */
async function checkFleetFinish(ctx: RunCtx, rep: Report): Promise<void> {
  const end = await sse.waitFor((r) => inRun(ctx, r) && r.ev.type === "run.status" && ["finished", "failed", "stopped"].includes(r.ev.run.status), ctx.mark, T.finish);
  let run = end && end.ev.type === "run.status" ? end.ev.run : null;
  if (!run) {
    const l = await http<RunSummary[]>("GET", "/api/runs");
    run = Array.isArray(l.body) ? (l.body.find((r) => r.runId === ctx.runId && ["finished", "failed", "stopped"].includes(r.status)) ?? null) : null;
  }
  rep.check("run finishes", run?.status === "finished", run ? `status=${run.status} after ${(((run.endedAt ?? Date.now()) - run.startedAt) / 1000).toFixed(0)}s` : `not finished within ${T.finish / 1000}s`);
  if (!run) return;
  rep.fact("tests", `${run.testsPassing}/${run.testsTotal}`);
  rep.check("all tests passing at finish", run.testsTotal > 0 && run.testsPassing === run.testsTotal, `${run.testsPassing}/${run.testsTotal}`);
  rep.check("RunSummary.endedAt set", typeof run.endedAt === "number", `endedAt=${run.endedAt}`);
  if (run.cases > 0) {
    if (!run.immunity) rep.gap("immunity at finish", "RunSummary.immunity absent");
    else rep.check("herd immunity held: repeatTrapHits == 0 at finish", run.immunity.repeatTrapHits === 0, short(run.immunity));
  }
}

async function checkBench(rep: Report): Promise<void> {
  const b = await http<{ mock?: true; mode: string; recovery_ms: number | null }[]>("GET", "/api/bench");
  const rows = Array.isArray(b.body) ? b.body : [];
  rep.check("GET /api/bench returns benchmark rows", rows.length > 0, `HTTP ${b.status} ${rows.length} rows`);
  rep.check("benchmark rows are measured (no mock rows)", rows.length > 0 && rows.every((r) => !r.mock), `${rows.filter((r) => r.mock).length} mock rows`, { liveOnly: true });
  const modes = [...new Set(rows.map((r) => r.mode))];
  rep.check("benchmark has ours and codex_baseline rows", modes.some((m) => m.startsWith("ours")) && modes.includes("codex_baseline"), short(modes));
}

/** Swarm stretch: 1,000 agents, final swarm.stats lost == 0. */
async function checkSwarm(rep: Report): Promise<void> {
  const agents = OPTS.swarmAgents;
  const ticks = 10;
  const body = { agents, ticks };
  const mark = sse.mark;
  let source: "http" | "direct" = "http";
  let detail = "";
  let local: { ev: { type: string; runId: string; stats: SwarmStats; mock?: true }; at: number }[] | null = null;
  const r = await http<{ ok: boolean; detail?: string; error?: string }>("POST", "/api/swarm/start", body);
  if (r.status === 404 || r.status === 405) {
    if (!OPTS.directSwarm) return void rep.skip("swarm", `POST /api/swarm/start -> HTTP ${r.status} (no route in api.ts); rerun with --direct-swarm to call the launcher in-process`);
    rep.gap("POST /api/swarm/start route", `HTTP ${r.status}; using --direct-swarm (src/swarm/launch.ts, what RuntimeService.startSwarm delegates to)`);
    source = "direct";
    const { EventBus } = await import("../../src/events.ts");
    const { startSwarm } = await import("../../src/swarm/launch.ts");
    const bus = new EventBus();
    local = [];
    bus.subscribe((ev) => {
      if (ev.type === "swarm.stats") local!.push({ ev: ev as never, at: Date.now() });
    });
    const res = await startSwarm(bus, { ...body, mock: OPTS.directSwarm === "mock" });
    rep.check("startSwarm accepted (direct)", res.ok, short(res));
    if (!res.ok) return;
    detail = res.detail ?? "";
  } else {
    rep.check("POST /api/swarm/start accepted", r.status === 200 && r.body?.ok === true, `HTTP ${r.status} ${short(r.body ?? r.error)}`);
    if (r.status !== 200 || !r.body?.ok) return;
    detail = r.body.detail ?? "";
  }
  const swarmRun = /swarm (\S+?):/.exec(detail)?.[1] ?? null;
  rep.fact("swarm", `${source} ${swarmRun ?? "?"}`);
  const stream = () =>
    (local ?? sse.filter((x) => x.ev.type === "swarm.stats", mark).map((x) => ({ ev: x.ev as never as { type: string; runId: string; stats: SwarmStats; mock?: true }, at: x.at }))).filter(
      (x) => !swarmRun || x.ev.runId === swarmRun,
    );
  // Final = the last stats once the stream has been quiet for 5 s (engine emits a forced final after reconciliation).
  const until = Date.now() + T.swarm;
  let last: ReturnType<typeof stream>[number] | undefined;
  while (Date.now() < until) {
    last = stream().at(-1);
    if (last && Date.now() - last.at > 5000 && last.ev.stats.handled > 0) break;
    await sleep(250);
  }
  const s = last?.ev.stats;
  rep.check("swarm.stats received", !!s, s ? `${stream().length} events` : `none within ${T.swarm / 1000}s`);
  if (!s) return;
  rep.fact("final", `agents=${s.agents} shards=${s.shards} handled=${s.handled} lost=${s.lost} rate=${s.ratePerSec}/s measured=${s.measured}`);
  rep.check(`swarm ran ${agents} agents`, s.agents === agents, `agents=${s.agents} shards=${s.shards}`);
  rep.check("final swarm.stats lost == 0", s.lost === 0, `lost=${s.lost} handled=${s.handled}`);
  rep.check("all changes accounted (handled == agents x ticks, rejects aside)", s.handled > 0 && s.handled <= agents * ticks, `handled=${s.handled} of ${agents * ticks}`);
  rep.check("numbers are measured (real SwarmShard actors)", s.measured === true && !last!.ev.mock, `measured=${s.measured} mock=${last!.ev.mock ?? false}`, { liveOnly: true });
}

// ------------------------------------------------------------------ scenarios

async function scenario(name: Scenario, rep: Report): Promise<void> {
  switch (name) {
    case "fleet": {
      const ctx = await sharedRun(rep);
      if (!ctx) return;
      await checkFleetStart(ctx, rep);
      await checkFleetFinish(ctx, rep);
      return;
    }
    case "possess": {
      const ctx = await sharedRun(rep);
      if (ctx) await chainOnce(ctx, rep);
      return;
    }
    case "jev-block": {
      const ctx = await sharedRun(rep);
      if (ctx) await checkJevBlock(ctx, rep);
      return;
    }
    case "herd": {
      const ctx = await sharedRun(rep);
      if (ctx) await checkHerd(ctx, rep);
      return;
    }
    case "reuse": {
      const ctx = await sharedRun(rep);
      if (ctx) await checkReuse(ctx, rep);
      return;
    }
    case "ledger": {
      const ctx = await sharedRun(rep);
      if (ctx) await checkLedger(ctx, rep);
      return;
    }
    case "crash": {
      const ctx = await sharedRun(rep);
      if (ctx) await checkCrash(ctx, rep);
      return;
    }
    case "swarm":
      return checkSwarm(rep);
    case "runbook":
      for (const round of [1, 2]) {
        log(`runbook round ${round}/2`);
        const tag = `R${round}`;
        const sub = new Proxy(rep, {
          get(t, p) {
            if (p === "check") return (n: string, ok: boolean, e?: string, o?: CheckOpts) => t.check(`${tag} ${beat} ${n}`, ok, e, o);
            if (p === "gap") return (n: string, e: string) => t.gap(`${tag} ${beat} ${n}`, e);
            if (p === "skip") return (n: string, e: string) => t.skip(`${tag} ${beat} ${n}`, e);
            if (p === "fact") return (k: string, v: unknown) => t.fact(`${tag}.${k}`, v);
            return Reflect.get(t, p);
          },
        });
        let beat = "pre:";
        await checkPreflight(sub);
        const ctx = await startRun(sub, "demo run (fresh library)");
        if (!ctx) continue;
        if (round === 2) {
          const r1 = rep.facts["R1.runId"];
          rep.check(`${tag} pre: new runId for round 2`, ctx.runId !== r1, `${r1} -> ${ctx.runId}`, { liveOnly: true });
        }
        beat = "beat1 grid+feed:";
        await checkFleetStart(ctx, sub);
        beat = "beat2 reuse:";
        await checkReuse(ctx, sub);
        beat = "beat3 possess:";
        await possessOnce(ctx, sub);
        beat = "beat4 claim/fail/block/retire/case/replace:";
        await Promise.all([chainOnce(ctx, sub), checkJevBlock(ctx, sub)]);
        beat = "beat5 herd:";
        await checkHerd(ctx, sub);
        beat = "beat6 crash:";
        await checkCrash(ctx, sub);
        beat = "beat7 finish+chart:";
        await checkFleetFinish(ctx, sub);
        await checkLedger(ctx, sub);
        await checkBench(sub);
      }
      return;
  }
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  console.log(`e2e against ${OPTS.api}: ${OPTS.scenarios.join(", ")} (timeout scale ${OPTS.scale})`);
  const m = await meta();
  if (!m) {
    console.log(`FAIL preflight: GET ${OPTS.api}/api/meta does not answer. Start the stack (scripts/start-all.sh) or pass --api.`);
    return 1;
  }
  MOCK = m.mock;
  console.log(MOCK ? "server reports mock=true: LIVE-ONLY assertions are reported, not failed" : "server reports mock=false (live)");
  await sse.start();

  const results: { scenario: string; status: string; secs: number; facts: Record<string, unknown>; checks: Check[] }[] = [];
  for (const name of OPTS.scenarios) {
    const rep = new Report(name);
    const t = Date.now();
    console.log(`\n=== ${name}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), T.hard[name])));
    try {
      const r = await Promise.race([scenario(name, rep).then(() => "done" as const), timeout]);
      if (r === "timeout") rep.check("hard timeout", false, `${name} exceeded ${T.hard[name] / 1000}s`);
    } catch (e) {
      rep.check("no exception", false, e instanceof Error ? (e.stack ?? e.message).split("\n").slice(0, 3).join(" | ") : String(e));
    } finally {
      clearTimeout(timer);
      rep.closed = true;
    }
    const secs = (Date.now() - t) / 1000;
    const counts = (["PASS", "FAIL", "GAP", "SKIP", "LIVE-ONLY"] as const).map((s) => [s, rep.checks.filter((c) => c.status === s).length] as const).filter(([, n]) => n > 0);
    const facts = Object.entries(rep.facts).map(([k, v]) => `${k}=${short(v, 80)}`).join(" ");
    console.log(`${rep.status} ${name} (${secs.toFixed(1)}s) [${counts.map(([s, n]) => `${n} ${s}`).join(", ")}] ${facts}`);
    results.push({ scenario: name, status: rep.status, secs, facts: rep.facts, checks: rep.checks });
  }
  sse.stop();

  console.log(`\n=== summary (${MOCK ? "MOCK server" : "live"} ${OPTS.api})`);
  for (const r of results) console.log(`${r.status.padEnd(5)} ${r.scenario.padEnd(10)} ${r.secs.toFixed(1)}s`);
  if (OPTS.json) await Bun.write(OPTS.json, JSON.stringify({ api: OPTS.api, mock: MOCK, at: new Date().toISOString(), results }, null, 2));
  if (results.some((r) => r.status === "FAIL")) return 1;
  if (results.some((r) => r.status === "GAP")) return OPTS.strict ? 3 : 0;
  return 0;
}

process.exit(await main());
