// Shared stores for fleet-scale mode: one CaseLibrary for every team, verified-chunk stores (per task or
// per team) and the fleet ledger. Each team sees them through a "view" that speaks the actor API the
// runtime calls (ctx.actors.cases / ctx.actors.chunks / LedgerWriter's stub).
//
// Slot mapping (why the views exist): the runtime compares a stored row's `slot` with the reader's local
// slot to skip its own case/chunk (herd.recordReply "own case", reasoning.retrieveChunks). Rows are stored
// with the GLOBAL agent index; a view returns the local slot for rows of its own team and a negative
// number (-(global+1)) for other teams, so no other team's row can equal a local slot 0..3.
import type { LedgerEntry } from "../actors.ts";

export const globalOf = (team: number, slot: number, apt: number) => team * apt + slot;
/** Slot as seen by `readerTeam` for a row stored with global index `g`. */
export function viewSlot(g: number, readerTeam: number, apt: number): string {
  return Math.floor(g / apt) === readerTeam ? String(g % apt) : String(-(g + 1));
}
/** Inverse of viewSlot for numbers that came back from a view (events, metadata). */
export function toGlobal(slot: number, team: number, apt: number): number {
  return slot < 0 ? -slot - 1 : globalOf(team, slot, apt);
}

// ---------- CaseLibrary ----------

export interface CaseRow {
  id: string;
  runId: string;
  slot: string; // global index
  gen: number;
  category: string;
  claim: string;
  evidence: Record<string, unknown>;
  lesson: string;
  driftTrace: number[];
  embedding: number[] | null;
  synthetic: boolean;
  revoked: boolean;
  revokedReason: string | null;
  receivers: string[];
  replies: { from: string; slot: number; gen: number; text: string; ts: number; seq: number }[];
  broadcast: boolean;
  rootMessageId: string | null;
  createdAt: number;
}
type CaseInputLike = {
  id: string;
  runId: string;
  slot: string;
  gen: number;
  category: string;
  claim: string;
  evidence: Record<string, unknown>;
  lesson: string;
  driftTrace?: number[];
  embedding?: number[];
  synthetic?: boolean;
};

/** The CaseLibrary actor API (real stub or MemoryCaseLibrary). */
export interface CaseLibStub {
  add(c: CaseInputLike): Promise<{ ok: true; created: boolean }>;
  list(opts?: { includeRevoked?: boolean; withEmbeddings?: boolean; limit?: number }): Promise<CaseRow[]>;
  get(id: string): Promise<CaseRow | null>;
  markReceived(caseId: string, agentId: string): Promise<{ ok: true; created: boolean } | { ok: false; reason: "not_found" }>;
  addReply(caseId: string, r: CaseRow["replies"][number]): Promise<{ ok: true; created: boolean } | { ok: false; reason: "not_found" }>;
  markBroadcast(caseId: string, rootMessageId: string | null): Promise<{ ok: true; created: boolean } | { ok: false; reason: "not_found" }>;
  revoke(id: string, reason: string): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
}

/** In-memory CaseLibrary with the actor's semantics (idempotent ids, one reply per agent per case). */
export class MemoryCaseLibrary implements CaseLibStub {
  private readonly rows = new Map<string, CaseRow>();
  private t = 0;
  private copy = (c: CaseRow, emb: boolean): CaseRow => ({ ...structuredClone(c), embedding: emb ? c.embedding : null });
  async add(c: CaseInputLike) {
    if (this.rows.has(c.id)) return { ok: true as const, created: false };
    this.rows.set(c.id, {
      id: c.id,
      runId: c.runId,
      slot: c.slot,
      gen: c.gen,
      category: c.category,
      claim: c.claim,
      evidence: c.evidence,
      lesson: c.lesson,
      driftTrace: c.driftTrace ?? [],
      embedding: c.embedding ?? null,
      synthetic: !!c.synthetic,
      revoked: false,
      revokedReason: null,
      receivers: [],
      replies: [],
      broadcast: false,
      rootMessageId: null,
      createdAt: Math.max(Date.now(), ++this.t),
    });
    return { ok: true as const, created: true };
  }
  async list(o?: { includeRevoked?: boolean; withEmbeddings?: boolean; limit?: number }) {
    return [...this.rows.values()]
      .filter((c) => o?.includeRevoked || !c.revoked)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .slice(0, o?.limit ?? 1000)
      .map((c) => this.copy(c, !!o?.withEmbeddings));
  }
  async get(id: string) {
    const c = this.rows.get(id);
    return c ? this.copy(c, true) : null;
  }
  async markReceived(caseId: string, agentId: string) {
    const c = this.rows.get(caseId);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    const created = !c.receivers.includes(agentId);
    if (created) c.receivers = [...c.receivers, agentId];
    return { ok: true as const, created };
  }
  async addReply(caseId: string, r: CaseRow["replies"][number]) {
    const c = this.rows.get(caseId);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    const created = !c.replies.some((x) => x.from === r.from);
    if (created) c.replies = [...c.replies, r];
    return { ok: true as const, created };
  }
  async markBroadcast(caseId: string, rootMessageId: string | null) {
    const c = this.rows.get(caseId);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    const created = !c.broadcast;
    if (created) this.rows.set(caseId, { ...c, broadcast: true, rootMessageId });
    else if (!c.rootMessageId && rootMessageId) this.rows.set(caseId, { ...c, rootMessageId });
    return { ok: true as const, created };
  }
  async revoke(id: string, reason: string) {
    const c = this.rows.get(id);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    this.rows.set(id, { ...c, revoked: true, revokedReason: c.revokedReason ?? reason });
    return { ok: true as const };
  }
  get size() {
    return this.rows.size;
  }
}

/** Team view: stores the global index, answers with the reader-relative slot (see header). */
export function caseLibView(lib: CaseLibStub, team: number, apt: number): CaseLibStub {
  const out = (c: CaseRow): CaseRow => ({ ...c, slot: viewSlot(Number(c.slot), team, apt) });
  return {
    add: (c) => lib.add({ ...c, slot: String(toGlobal(Number(c.slot), team, apt)) }),
    list: async (o) => (await lib.list(o)).map(out),
    get: async (id) => {
      const c = await lib.get(id);
      return c ? out(c) : null;
    },
    markReceived: (a, b) => lib.markReceived(a, b),
    addReply: (id, r) => lib.addReply(id, { ...r, slot: toGlobal(r.slot, team, apt) }),
    markBroadcast: (a, b) => lib.markBroadcast(a, b),
    revoke: (a, b) => lib.revoke(a, b),
  };
}

// ---------- ReasoningStore (verified chunks) ----------

export interface ChunkRow {
  id: string;
  sourceAgent: string;
  slot: string; // global index
  gen: number;
  step: number;
  fn: string | null;
  text: string;
  estTokens: number;
  embedding: number[] | null;
  revoked: boolean;
  reusers: string[];
  createdAt: number;
}
type ChunkInputLike = { id: string; sourceAgent: string; slot: string; gen: number; step: number; fn?: string; text: string; embedding?: number[]; estTokens?: number };

export interface ChunkStoreStub {
  add(c: ChunkInputLike): Promise<{ ok: true; created: boolean }>;
  list(o?: { includeRevoked?: boolean; withEmbeddings?: boolean }): Promise<ChunkRow[]>;
  markReused(chunkId: string, agentId: string): Promise<{ ok: true; created: boolean } | { ok: false; reason: "not_found" | "revoked" }>;
  revoke(chunkId: string): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
}

export class MemoryChunkStore implements ChunkStoreStub {
  private readonly rows = new Map<string, ChunkRow>();
  private t = 0;
  async add(c: ChunkInputLike) {
    if (this.rows.has(c.id)) return { ok: true as const, created: false };
    this.rows.set(c.id, { id: c.id, sourceAgent: c.sourceAgent, slot: c.slot, gen: c.gen, step: c.step, fn: c.fn ?? null, text: c.text, estTokens: c.estTokens ?? 0, embedding: c.embedding ?? null, revoked: false, reusers: [], createdAt: Math.max(Date.now(), ++this.t) });
    return { ok: true as const, created: true };
  }
  async list(o?: { includeRevoked?: boolean; withEmbeddings?: boolean }) {
    return [...this.rows.values()].filter((c) => o?.includeRevoked || !c.revoked).map((c) => ({ ...c, reusers: [...c.reusers], embedding: o?.withEmbeddings ? c.embedding : null }));
  }
  async markReused(chunkId: string, agentId: string) {
    const c = this.rows.get(chunkId);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    if (c.revoked) return { ok: false as const, reason: "revoked" as const };
    const created = !c.reusers.includes(agentId);
    if (created) c.reusers = [...c.reusers, agentId];
    return { ok: true as const, created };
  }
  async revoke(chunkId: string) {
    const c = this.rows.get(chunkId);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    c.revoked = true;
    return { ok: true as const };
  }
}

export interface ChunkEvents {
  created(team: number, row: { id: string; sourceAgent: string; globalSlot: number; gen: number; step: number; fn: string | null; text: string; estTokens: number }): void;
  reused(team: number, chunkId: string, byAgent: string, estTokens: number): void;
  revoked(team: number, chunkId: string, reusers: string[]): void;
}

/** Team view over a chunk store: global slots stored, reader-relative slots returned, events reported. */
export function chunkStoreView(store: ChunkStoreStub, team: number, apt: number, ev: ChunkEvents): ChunkStoreStub {
  const est = new Map<string, number>();
  return {
    add: async (c) => {
      const g = toGlobal(Number(c.slot), team, apt);
      const r = await store.add({ ...c, slot: String(g) });
      if (r.created) ev.created(team, { id: c.id, sourceAgent: c.sourceAgent, globalSlot: g, gen: c.gen, step: c.step, fn: c.fn ?? null, text: c.text, estTokens: c.estTokens ?? 0 });
      return r;
    },
    list: async (o) => {
      const rows = await store.list(o);
      for (const r of rows) est.set(r.id, r.estTokens);
      return rows.map((r) => ({ ...r, slot: viewSlot(Number(r.slot), team, apt) }));
    },
    markReused: async (id, agent) => {
      const r = await store.markReused(id, agent);
      if (r.ok && r.created) ev.reused(team, id, agent, est.get(id) ?? 0);
      return r;
    },
    revoke: async (id) => {
      const before = (await store.list({ includeRevoked: true })).find((c) => c.id === id);
      const r = await store.revoke(id);
      if (r.ok && before && !before.revoked) ev.revoked(team, id, before.reusers);
      return r;
    },
  };
}

// ---------- Ledger ----------

const CATS = ["worker", "jev", "fallback_judge", "embedding", "lesson_writer", "case_discussion"] as const;
type Cat = (typeof CATS)[number];
interface Agg {
  calls: number;
  usd: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}
const zero = (): Agg => ({ calls: 0, usd: 0, input: 0, cached: 0, output: 0, reasoning: 0 });

/** Actor-shaped totals (what LedgerWriter.totals()/overBudget() read). */
export interface LedgerTotalsLike {
  worker_usd: number;
  overhead_usd: number;
  by_category: Record<string, Agg>;
  calls: { jev: number; fallback: number };
  tokens: { input: number; cached: number; output: number; reasoning: number };
  reuse_est_tokens: number;
  rows: number;
  mock_rows: number;
  updatedAt: number;
}

class Book {
  by = new Map<string, Agg>();
  reuse = 0;
  rows = 0;
  mockRows = 0;
  /** Restart: start from the durable Ledger actor's totals. */
  seed(t: Pick<LedgerTotalsLike, "by_category" | "reuse_est_tokens" | "rows" | "mock_rows">) {
    for (const [c, a] of Object.entries(t.by_category)) this.by.set(c, { calls: a.calls ?? 0, usd: a.usd ?? 0, input: a.input ?? 0, cached: a.cached ?? 0, output: a.output ?? 0, reasoning: a.reasoning ?? 0 });
    this.reuse = t.reuse_est_tokens ?? 0;
    this.rows = t.rows ?? 0;
    this.mockRows = t.mock_rows ?? 0;
  }
  add(e: LedgerEntry) {
    this.rows++;
    if (e.mock) this.mockRows++;
    if (e.category === "reuse_est") {
      this.reuse += e.input_tokens;
      return;
    }
    const a = this.by.get(e.category) ?? zero();
    this.by.set(e.category, { calls: a.calls + 1, usd: a.usd + e.usd, input: a.input + e.input_tokens, cached: a.cached + e.cached_input_tokens, output: a.output + e.output_tokens, reasoning: a.reasoning + e.reasoning_tokens });
  }
  totals(): LedgerTotalsLike {
    const by: Record<string, Agg> = {};
    let worker = 0;
    let overhead = 0;
    const tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
    for (const [c, a] of this.by) {
      by[c] = { ...a };
      if (c === "worker") worker += a.usd;
      else overhead += a.usd;
      tokens.input += a.input;
      tokens.cached += a.cached;
      tokens.output += a.output;
      tokens.reasoning += a.reasoning;
    }
    return {
      worker_usd: worker,
      overhead_usd: overhead,
      by_category: by,
      calls: { jev: this.by.get("jev")?.calls ?? 0, fallback: this.by.get("fallback_judge")?.calls ?? 0 },
      tokens,
      reuse_est_tokens: this.reuse,
      rows: this.rows,
      mock_rows: this.mockRows,
      updatedAt: Date.now(),
    };
  }
}

/**
 * Fleet ledger: one book per team + the fleet book, rows deduped by id (Ledger.record is idempotent).
 * Every token count comes from the LedgerEntry usage fields (rule 7). `onEntry` feeds the aggregator
 * (context.cleansed prompt tokens, stats).
 */
export class FleetLedger {
  private readonly ids = new Set<string>();
  private readonly teams = new Map<number, Book>();
  private readonly fleet = new Book();
  /** Write-through to a durable Ledger actor (ledger.<fleetRunId>); ids are unique per team prefix. */
  persist: ((e: LedgerEntry) => Promise<unknown>) | null = null;
  /** Ledger.maxIndex of the durable actor, so a step replayed after a restart reuses its row ids (no double count). */
  maxIndexOf: ((prefix: string) => Promise<number>) | null = null;
  constructor(private readonly onEntry: (team: number, e: LedgerEntry) => void = () => {}) {}
  seed(t: LedgerTotalsLike) {
    this.fleet.seed(t);
  }
  forTeam(team: number) {
    return {
      record: async (e: LedgerEntry) => {
        if (this.ids.has(e.id)) return { ok: true, created: false };
        this.ids.add(e.id);
        if (this.persist) await this.persist(e);
        let b = this.teams.get(team);
        if (!b) this.teams.set(team, (b = new Book()));
        b.add(e);
        this.fleet.add(e);
        this.onEntry(team, e);
        return { ok: true, created: true };
      },
      totals: async () => (this.teams.get(team) ?? new Book()).totals(),
      maxIndex: async (prefix: string) => (this.maxIndexOf ? this.maxIndexOf(prefix) : 0),
    };
  }
  totals(): LedgerTotalsLike {
    return this.fleet.totals();
  }
  teamTotals(team: number): LedgerTotalsLike {
    return (this.teams.get(team) ?? new Book()).totals();
  }
  static readonly categories: readonly Cat[] = CATS;
}

/**
 * Read cache over an actor-backed chunk store: every agent step lists the store (with embeddings), which is
 * heavy at 1,000 agents. `list` answers from a cache up to `ttlMs` old; add/revoke invalidate it.
 * includeRevoked lists (the revoke path, which needs fresh reusers) always go to the store.
 */
export function cachedChunkStore(store: ChunkStoreStub, ttlMs = 1500): ChunkStoreStub {
  let cache: { at: number; emb: boolean; rows: Promise<ChunkRow[]> } | null = null;
  return {
    add: async (c) => {
      const r = await store.add(c);
      cache = null;
      return r;
    },
    list: (o) => {
      if (o?.includeRevoked) return store.list(o);
      const emb = !!o?.withEmbeddings;
      if (!cache || Date.now() - cache.at > ttlMs || (emb && !cache.emb)) {
        const rows = store.list({ withEmbeddings: true });
        cache = { at: Date.now(), emb: true, rows };
        rows.catch(() => (cache = null));
      }
      return cache.rows.then((rs) => rs.map((r) => ({ ...r, reusers: [...r.reusers], embedding: emb ? r.embedding : null })));
    },
    markReused: (id, a) => store.markReused(id, a),
    revoke: async (id) => {
      const r = await store.revoke(id);
      cache = null;
      return r;
    },
  };
}
