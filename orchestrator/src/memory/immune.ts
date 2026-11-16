// Immune memory on Supabase (DECISIONS: "Immune memory on Supabase"). Durable Actors stay the live roster and
// hot state; this is the cross-run memory of case files: one Postgres row per retired agent (lesson + pgvector
// embedding), written at retire right after CaseLibrary.add and recalled at run start to seed the Fleet lessons
// block. Opt-in: with SUPABASE_URL and a secret key absent, every function here is a no-op.
// Plain PostgREST over fetch (no SDK). Schema + match_cases RPC: supabase/migrations/*_immune_memory.sql.
import type { CaseFile } from "../contract.ts";
import { appendLesson } from "../lessons.ts";
import type { RunContext } from "../runtime/types.ts";

/** Column width of cases.embedding (config/models.json embedding.dimensions must match). */
export const MEMORY_DIMS = 256;
/** Lessons recalled per subtask at run start. */
export const RECALL_K = 3;
const TIMEOUT_MS = 5000;

/** One row of public.cases (snake_case = column names). */
export interface CaseRow {
  id: string;
  lesson: string | null;
  category: string;
  task: string;
  function: string;
  run_id: string;
  library_id: string;
  created_at: string;
  embedding: number[];
}
/** One row returned by match_cases. */
export interface CaseMatch {
  id: string;
  lesson: string;
  category: string;
  function: string;
  run_id: string;
  library_id: string;
  created_at: string;
  similarity: number;
}

export interface ImmuneMemory {
  /** Idempotent upsert on id. */
  upsert(rows: CaseRow[]): Promise<void>;
  /** Top-k non-revoked cases with a lesson for `task`, nearest first (cosine). */
  match(queryEmbedding: number[], task: string, k: number): Promise<CaseMatch[]>;
}

export type MemoryMode = "off" | "write" | "on";
type Env = Record<string, string | undefined>;
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * IMMUNE_MEMORY: "off" disables; "write" files cases but never recalls (use for cold benchmarks, so a
 * "cold" run cannot inherit earlier runs' lessons); "on" (default when credentials are set) does both.
 */
export function memoryMode(env: Env = process.env): MemoryMode {
  if (!env.SUPABASE_URL || !secretKey(env)) return "off";
  const m = (env.IMMUNE_MEMORY ?? "on").trim().toLowerCase();
  return m === "off" || m === "write" ? m : "on";
}

/** Server-side secret: new-style sb_secret_… (SUPABASE_SECRET_KEY) or legacy service_role JWT. Never the publishable key. */
function secretKey(env: Env): string | undefined {
  return env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || undefined;
}

/** pgvector text form; also what PostgREST casts to vector. */
const vec = (v: readonly number[]) => `[${v.join(",")}]`;

export function postgrestMemory(opts: { url: string; key: string; fetch?: FetchFn; timeoutMs?: number }): ImmuneMemory {
  const base = `${opts.url.replace(/\/$/, "")}/rest/v1`;
  const doFetch: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  // New API keys (sb_…) are not JWTs: send them as apikey only; legacy JWT keys also go in Authorization.
  const headers: Record<string, string> = {
    apikey: opts.key,
    "Content-Type": "application/json",
    ...(opts.key.startsWith("sb_") ? {} : { Authorization: `Bearer ${opts.key}` }),
  };
  async function post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`supabase ${path} ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    async upsert(rows) {
      if (!rows.length) return;
      const body = rows.map((r) => ({ ...r, embedding: vec(r.embedding) }));
      await post("/cases?on_conflict=id", body, { Prefer: "resolution=merge-duplicates,return=minimal" });
    },
    async match(queryEmbedding, task, k) {
      const out = await post("/rpc/match_cases", { query_embedding: vec(queryEmbedding), task, k });
      return Array.isArray(out) ? (out as CaseMatch[]) : [];
    },
  };
}

let envClient: { key: string; mem: ImmuneMemory } | undefined;
let override: { mem: ImmuneMemory | null; mode: MemoryMode } | undefined;

/** The active client and mode: the test override, else env (client cached per URL). mem is null when off. */
export function immuneMemory(env: Env = process.env): { mem: ImmuneMemory | null; mode: MemoryMode } {
  if (override) return override;
  const mode = memoryMode(env);
  if (mode === "off") return { mem: null, mode };
  const key = env.SUPABASE_URL!;
  if (envClient?.key !== key) envClient = { key, mem: postgrestMemory({ url: key, key: secretKey(env)! }) };
  return { mem: envClient.mem, mode };
}
/** Test hook: force a client and mode regardless of env; undefined restores env-driven behaviour. */
export function setImmuneMemory(o: { mem: ImmuneMemory | null; mode: MemoryMode } | undefined): void {
  override = o;
}

const isMock = (ctx: RunContext) => ctx.deps.mock.llm || ctx.deps.mock.embed;

/** Contract CaseFile + its stored embedding -> a cases row. */
export function caseRow(c: CaseFile, embedding: number[]): CaseRow {
  return {
    id: c.id,
    lesson: c.lesson,
    category: c.category,
    task: c.task,
    function: c.subtask,
    run_id: c.runId,
    library_id: c.libraryId,
    created_at: new Date(c.createdAt).toISOString(),
    embedding,
  };
}

/**
 * Retire hook (after CaseLibrary.add): upserts the case into immune memory. Never throws. Skipped when memory
 * is off, the case has no embedding of MEMORY_DIMS, or the lesson/embedding came from a MOCK adapter (a mock
 * lesson or hashed vector must not enter cross-run memory).
 */
export async function rememberCase(ctx: RunContext, c: CaseFile, embedding: number[] | undefined): Promise<boolean> {
  const { mem } = immuneMemory();
  if (!mem) return false;
  if (isMock(ctx)) return false;
  if (!embedding || embedding.length !== MEMORY_DIMS) {
    ctx.deps.log(`[memory] case ${c.id} not remembered (embedding ${embedding ? `${embedding.length}d` : "missing"}, need ${MEMORY_DIMS}d)`);
    return false;
  }
  try {
    await mem.upsert([caseRow(c, embedding)]);
    ctx.deps.log(`[memory] case ${c.id} remembered in Supabase (task ${c.task}, ${c.subtask || "-"})`);
    return true;
  } catch (e) {
    ctx.deps.log(`[memory] case ${c.id} not remembered: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Run-start hook (after the lessons block is built from CaseLibrary): embeds each function's subtask, asks
 * match_cases for the top RECALL_K lessons of this task per subtask, and puts the union (deduped, oldest first)
 * ahead of the library's own lessons, capped at caps.max_lessons. Never throws. Returns the lessons added.
 */
export async function recallLessons(ctx: RunContext): Promise<string[]> {
  const { mem, mode } = immuneMemory();
  if (!mem || mode !== "on" || isMock(ctx)) return [];
  const fns = ctx.task.functions;
  if (!fns.length) return [];
  try {
    const r = await ctx.deps.embedder.embed(
      fns.map((f) => `${f.name}: ${f.subgoal}`),
      { category: "embedding", slot: "memory", gen: 0, step: 0 },
    );
    await ctx.ledger.record({ slot: "memory", gen: 0, step: "recall" }, [r.usage]);
    const per = await Promise.all(r.vectors.map((v) => mem.match(v, ctx.taskId, RECALL_K)));
    const byId = new Map<string, CaseMatch>();
    for (const m of per.flat()) if (m.lesson && !byId.has(m.id)) byId.set(m.id, m);
    const recalled = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const own = ctx.lessons();
    let block: string[] = [];
    for (const m of recalled) block = appendLesson(block, m.lesson, ctx.caps.max_lessons);
    for (const l of own) block = appendLesson(block, l, ctx.caps.max_lessons);
    ctx.setLessons(block);
    const added = recalled.map((m) => m.lesson).filter((l) => block.includes(l) && !own.includes(l));
    ctx.deps.log(`[memory] run ${ctx.runId}: ${added.length} lessons recalled from Supabase for task ${ctx.taskId} (${byId.size} cases matched)`);
    return [...new Set(added)];
  } catch (e) {
    ctx.deps.log(`[memory] run ${ctx.runId}: recall failed (${e instanceof Error ? e.message : String(e)}); lessons from the case library only`);
    return [];
  }
}
