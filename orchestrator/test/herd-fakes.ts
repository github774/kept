// Test-only fakes for herd.test.ts and reasoning.test.ts. Everything here is a labeled MOCK (rule 6):
// in-memory actors, a keyword embedder, a scripted Jev and the in-memory MockRelayBus.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Caps, Config, JevQuestionId, Thresholds } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import type { NoulCheck } from "../src/jev.ts";
import { LedgerWriter } from "../src/ledger.ts";
import type { LedgerDraft } from "../src/ledger-entry.ts";
import type { LedgerEntry } from "../src/actors.ts";
import { MockRelayBus, relayNames } from "../src/relay/bus.ts";
import type { AgentRef, RunContext, TaskFn } from "../src/runtime/types.ts";

const CONFIG = resolve(import.meta.dir, "..", "..", "config");
export const thresholds = JSON.parse(readFileSync(join(CONFIG, "thresholds.json"), "utf8")) as Thresholds;
export const caps = JSON.parse(readFileSync(join(CONFIG, "caps.json"), "utf8")) as Caps;

export const RUN = "tst1";
export const FNS: TaskFn[] = [
  { name: "parse_line", file: "parse_line.py", test: "tests/test_parse_line.py", subgoal: "parse invoice amount dollars line" },
  { name: "total_by_customer", file: "total_by_customer.py", test: "tests/test_total.py", subgoal: "parse amount dollars per customer" },
  { name: "overdue_invoices", file: "overdue.py", test: "tests/test_overdue.py", subgoal: "due date weekend overdue" },
  { name: "format_invoice_id", file: "format_id.py", test: "tests/test_format.py", subgoal: "format invoice id prefix" },
];

/** MOCK embedder: one dimension per keyword, so similarity is predictable. */
const KEYS = ["amount", "dollars", "cents", "customer", "date", "weekend", "overdue", "id", "prefix", "parse", "sum", "line"];
export function keywordVec(text: string): number[] {
  const t = text.toLowerCase();
  const v = KEYS.map((k) => (t.includes(k) ? 1 : 0));
  return v.some((x) => x) ? v : KEYS.map((_, i) => (i === KEYS.length - 1 ? 0.01 : 0));
}

export function noulResult(value: boolean, probability: number, source: NoulCheck["source"] = "jev"): NoulCheck {
  return { kind: "noul", value, probability, decision: value ? "act" : "pass", source, confidence: Math.max(probability, 1 - probability), latencyMs: 1, inputTokens: 10, ledger: [], reason: `MOCK ${value ? "problem" : "ok"}` };
}

type JevRule = (q: JevQuestionId, state: Record<string, unknown>) => NoulCheck;

export interface Fakes {
  ctx: RunContext;
  relay: MockRelayBus;
  events: ReturnType<EventBus["replay"]>;
  ledgerRows: LedgerEntry[];
  jevCalls: { q: JevQuestionId; state: Record<string, unknown> }[];
  embedCalls: string[][];
  slots: { slot: string; gen: number; status: string; relayName: string | null }[];
  cases: Map<string, { id: string; slot: string; gen: number; lesson: string; synthetic: boolean; revoked: boolean; receivers: string[]; createdAt: number; broadcast?: boolean; rootMessageId?: string | null }>;
  chunks: Map<string, { id: string; sourceAgent: string; slot: string; gen: number; step: number; fn: string | null; text: string; embedding: number[] | null; estTokens: number; revoked: boolean; reusers: string[]; createdAt: number }>;
  agents: AgentRef[];
  logs: string[];
  register(): Promise<void>;
}

export function makeFakes(opts: { jev?: JevRule; sharedReasoning?: boolean; herd?: boolean } = {}): Fakes {
  const logs: string[] = [];
  const relay = new MockRelayBus({ repliesPerThread: caps.replies_per_case_thread, log: (l) => logs.push(l) });
  const bus = new EventBus();
  const ledgerRows: LedgerEntry[] = [];
  const seenIds = new Set<string>();
  const ledger = new LedgerWriter(RUN, {
    record: async (e) => {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        ledgerRows.push(e);
      }
    },
    totals: async () => ({}) as never,
  }, () => {});
  const jevCalls: Fakes["jevCalls"] = [];
  const embedCalls: string[][] = [];
  const rule: JevRule = opts.jev ?? ((q) => (q === "lesson_relevant" ? noulResult(true, 0.9) : noulResult(false, 0.1)));
  const slots = FNS.map((_, i) => ({ slot: String(i), gen: 1, status: "trusted", relayName: relayNames.agent(RUN, i, 1) }));
  const agents = slots.map((s) => ({ slot: Number(s.slot), gen: s.gen, name: s.relayName! }));
  const cases: Fakes["cases"] = new Map();
  const chunks: Fakes["chunks"] = new Map();
  let lessons: string[] = [];
  let t = 0;

  const actors = {
    fleet: {
      snapshot: async () => ({ run: null, slots: slots.map((s) => ({ ...s, possessed: false, step: 0, reason: null })), history: [] }),
    },
    cases: {
      add: async (c: { id: string; slot: string; gen: number; lesson: string; synthetic?: boolean }) => {
        if (!cases.has(c.id)) cases.set(c.id, { id: c.id, slot: c.slot, gen: c.gen, lesson: c.lesson, synthetic: !!c.synthetic, revoked: false, receivers: [], createdAt: ++t });
        return { ok: true, created: true };
      },
      get: async (id: string) => cases.get(id) ?? null,
      list: async () => [...cases.values()].filter((c) => !c.revoked).sort((a, b) => a.createdAt - b.createdAt),
      markBroadcast: async (caseId: string, rootMessageId: string | null) => {
        const c = cases.get(caseId);
        if (!c) return { ok: false, reason: "not_found" };
        const created = !c.broadcast;
        c.broadcast = true;
        c.rootMessageId ??= rootMessageId;
        return { ok: true, created };
      },
      markReceived: async (caseId: string, agentId: string) => {
        const c = cases.get(caseId);
        if (!c) return { ok: false, reason: "not_found" };
        if (!c.receivers.includes(agentId)) c.receivers = [...c.receivers, agentId];
        return { ok: true, created: true };
      },
    },
    chunks: {
      add: async (c: { id: string; sourceAgent: string; slot: string; gen: number; step: number; fn?: string; text: string; embedding?: number[]; estTokens?: number }) => {
        if (chunks.has(c.id)) return { ok: true, created: false };
        chunks.set(c.id, { ...c, fn: c.fn ?? null, embedding: c.embedding ?? null, estTokens: c.estTokens ?? 0, revoked: false, reusers: [], createdAt: ++t });
        return { ok: true, created: true };
      },
      list: async (o?: { includeRevoked?: boolean; withEmbeddings?: boolean }) =>
        [...chunks.values()].filter((c) => o?.includeRevoked || !c.revoked).map((c) => ({ ...c, embedding: o?.withEmbeddings ? c.embedding : null })),
      markReused: async (id: string, agent: string) => {
        const c = chunks.get(id);
        if (!c) return { ok: false, reason: "not_found" };
        if (c.revoked) return { ok: false, reason: "revoked" };
        const created = !c.reusers.includes(agent);
        if (created) c.reusers = [...c.reusers, agent];
        return { ok: true, created };
      },
      revoke: async (id: string) => {
        const c = chunks.get(id);
        if (!c) return { ok: false, reason: "not_found" };
        c.revoked = true;
        return { ok: true };
      },
    },
  };

  const draft = (meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }): LedgerDraft => ({
    category: meta.category, model: "MOCK", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0, slot: meta.slot, gen: meta.gen, step: meta.step, ts: Date.now(),
  });

  const ctx = {
    runId: RUN,
    libraryId: RUN,
    taskId: "invoice_parser",
    mode: "ours",
    task: { id: "invoice_parser", dir: "/nonexistent", spec: "SPEC.md", specText: "SPEC: amounts are always dollars with two decimals.", functions: FNS.map((x) => ({ ...x })), traps: [], faults: [] },
    cfg: { thresholds, caps } as unknown as Config,
    caps,
    workDir: "/nonexistent",
    model: "MOCK",
    bus,
    relay,
    actors,
    ledger,
    deps: {
      llm: {} as never,
      jev: {
        check: async (q: JevQuestionId, state: Record<string, unknown>, meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }) => {
          jevCalls.push({ q, state });
          return { ...rule(q, state), ledger: [draft({ ...meta, category: "jev" })] };
        },
      } as never,
      embedder: {
        mock: true,
        embed: async (texts: string[], meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }) => {
          embedCalls.push(texts);
          return { vectors: texts.map(keywordVec), usage: draft({ ...meta, category: "embedding" }), model: "MOCK" };
        },
      } as never,
      log: (l: string) => logs.push(l),
      mock: { llm: true, jev: true, embed: true, relay: true },
    },
    stepDelayMs: 0,
    sharedReasoning: opts.sharedReasoning ?? true,
    herd: opts.herd ?? true,
    abort: new Map(),
    pendingFaults: new Map(),
    recovery: new Map(),
    rejectedFacts: new Set<string>(),
    inboxCursor: new Map(),
    stopping: false,
    lessons: () => lessons,
    setLessons: (next: string[]) => {
      lessons = next;
    },
  } as unknown as RunContext;

  const f: Fakes = {
    ctx,
    relay,
    get events() {
      return bus.replay(0);
    },
    ledgerRows,
    jevCalls,
    embedCalls,
    slots,
    cases,
    chunks,
    agents,
    logs,
    async register() {
      await relay.ensureWorkspace();
      for (const ch of [relayNames.fleet(RUN), relayNames.cases(RUN)]) await relay.ensureChannel(ch);
      for (const a of agents) await relay.registerAgent(a.name, [relayNames.fleet(RUN), relayNames.cases(RUN)]);
    },
  };
  return f;
}
