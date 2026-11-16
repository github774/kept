// Shared verified reasoning (BUILD_SPEC "Shared verified reasoning"). Owner: herd/reasoning implementer.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withRetry } from "../actors.ts";
import { cosine } from "../embeddings.ts";
import { jevCheck, noul } from "../verify.ts";
import { embedCached, ensureWarden, publishFeed } from "./herd.ts";
import type { AgentRef, RetrievedChunk, RunContext, StepRecord, TaskFn } from "./types.ts";

const MAX_HELPER_LINES = 40;
const ACTIVE = new Set(["trusted", "probation", "under_investigation"]);

/** Process-local cache (rebuildable): chunk ids already created, so a replayed step skips the Jev call. */
const created = new WeakMap<RunContext, Set<string>>();
const createdSet = (ctx: RunContext) => {
  let s = created.get(ctx);
  if (!s) created.set(ctx, (s = new Set()));
  return s;
};

export const chunkId = (runId: string, ref: Pick<AgentRef, "slot" | "gen">, step: number) => `${runId}.${ref.slot}.g${ref.gen}.s${step}`;

/** First `def <fn>(...)` line (Python tasks), else the first def line. */
export function signatureOf(code: string, fnName: string): string | null {
  const lines = code.split("\n");
  const own = lines.find((l) => new RegExp(`^\\s*def\\s+${fnName}\\s*\\(`).test(l));
  return (own ?? lines.find((l) => /^\s*def\s+\w+\s*\(/.test(l)))?.trim() ?? null;
}

/** Chunk text: note + signature + up to 40 lines of helper code. */
export function chunkText(note: string, fn: TaskFn, code: string | null): string {
  const sig = code ? signatureOf(code, fn.name) : null;
  const lines = code ? code.replace(/\s+$/, "").split("\n") : [];
  const helper = lines.slice(0, MAX_HELPER_LINES).join("\n");
  return [
    `Note: ${note.trim()}`,
    sig ? `Signature: ${sig}` : null,
    helper ? `Code (${Math.min(lines.length, MAX_HELPER_LINES)} of ${lines.length} lines):\n\`\`\`python\n${helper}\n\`\`\`` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function codeOf(ctx: RunContext, step: StepRecord): string | null {
  if (step.output.code) return step.output.code;
  const p = join(ctx.workDir, step.fn.file);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/** Output tokens of the step's worker call(s), from usage fields only (rule 7). */
const outputTokensOf = (step: StepRecord) => step.usage.filter((u) => u.category === "worker").reduce((n, u) => n + u.output_tokens, 0);

/**
 * Makes a chunk when (1) step.verified (the step's code passed its tests) and (2) its approach_note passes
 * Jev note_consistent_with_spec, and (3) the agent is not on probation (Fleet) and ctx.sharedReasoning is on.
 * Stores ReasoningStore.add({id: `<runId>.<slot>.g<gen>.s<step>`, sourceAgent, slot, gen, step, fn,
 * text: note + signature + up to 40 lines of code, embedding of (subgoal + note), estTokens: worker output
 * tokens of that step}). Idempotent on id. Returns the chunk id or null.
 */
export async function maybeCreateChunk(ctx: RunContext, ref: AgentRef, step: StepRecord): Promise<string | null> {
  if (!ctx.sharedReasoning || !step.verified) return null;
  const note = step.output.approach_note?.trim();
  if (!note) return null;
  const id = chunkId(ctx.runId, ref, step.step);
  const done = createdSet(ctx);
  if (done.has(id)) return id;

  const snap = await withRetry(() => ctx.actors.fleet.snapshot());
  const s = snap.slots.find((x) => x.slot === String(ref.slot));
  if (!s || s.gen !== ref.gen || !ACTIVE.has(s.status)) return null; // stale generation (rule 5)
  if (s.status === "probation") return null;

  const scope = { slot: ref.slot, gen: ref.gen, step: step.step };
  const r = noul(await jevCheck(ctx, scope, "note_consistent_with_spec", { spec_excerpt: ctx.task.specText, note }));
  if (r.value) {
    ctx.deps.log(`[reasoning] note of ${ref.name} s${step.step} not shared: inconsistent with spec (p=${r.probability.toFixed(2)}, ${r.source})`);
    return null;
  }

  const text = chunkText(note, step.fn, codeOf(ctx, step));
  const e = await ctx.deps.embedder.embed([`${step.fn.subgoal}\n${note}`], { category: "embedding", slot: String(ref.slot), gen: ref.gen, step: step.step });
  await ctx.ledger.record(scope, [e.usage]);
  await withRetry(() =>
    ctx.actors.chunks.add({
      id,
      sourceAgent: ref.name,
      slot: String(ref.slot),
      gen: ref.gen,
      step: step.step,
      fn: step.fn.name,
      text,
      embedding: e.vectors[0],
      estTokens: outputTokensOf(step),
    }),
  );
  done.add(id);
  if (ctx.deps.mock.embed || ctx.deps.mock.jev) ctx.deps.log(`[MOCK] chunk ${id} created with mock ${ctx.deps.mock.embed ? "embedding" : "jev"}`);
  return id;
}

/**
 * Before each step: embed the subgoal (cached) and return up to caps.max_chunks_in_prompt non-revoked
 * chunks of this run with cosine >= thresholds.chunk_similarity, excluding ref's own slot. Each use calls
 * ReasoningStore.markReused(chunkId, ref.name); the first use per (chunk, agent) writes one reuse_est
 * ledger row (labeled est., never spend) with scope label "reuse", so repeats and restarts never double count.
 * `step` (optional, added) scopes the embedding's ledger row; without it the label "retrieve" is used.
 */
export async function retrieveChunks(ctx: RunContext, ref: AgentRef, subgoal: string, step?: number): Promise<RetrievedChunk[]> {
  if (!ctx.sharedReasoning) return [];
  const all = await withRetry(() => ctx.actors.chunks.list({ withEmbeddings: true }));
  const others = all.filter((c) => !c.revoked && c.slot !== String(ref.slot) && c.embedding?.length);
  if (!others.length) return [];
  const [q] = await embedCached(ctx, [subgoal], { slot: ref.slot, gen: ref.gen, step: step ?? "retrieve" });
  const ranked = others
    .filter((c) => c.embedding!.length === q!.length)
    .map((c) => ({ c, sim: cosine(q!, c.embedding!) }))
    .filter((x) => x.sim >= ctx.cfg.thresholds.chunk_similarity)
    .sort((a, b) => b.sim - a.sim);
  const out: RetrievedChunk[] = [];
  for (const { c, sim } of ranked) {
    if (out.length >= ctx.caps.max_chunks_in_prompt) break;
    const res = await withRetry(() => ctx.actors.chunks.markReused(c.id, ref.name));
    if (!res.ok) continue; // revoked or gone since list
    if (res.created) await ctx.ledger.recordReuseEstimate({ slot: ref.slot, gen: ref.gen, step: "reuse" }, c.id, c.estTokens);
    out.push({ chunkId: c.id, sourceAgent: c.sourceAgent, fn: c.fn, text: c.text, similarity: sim, estTokens: c.estTokens });
  }
  return out;
}

/**
 * Revokes a chunk whose derived code later failed its tests: ReasoningStore.revoke(chunkId) and a Relay
 * DM from warden-<runId> to every reuser (metadata kind "revoke"), published as "relay.message".
 * Idempotent: the revoke is idempotent and each DM has idempotency key `<chunkId>.revoke.<reuser>`.
 */
export async function revokeChunk(ctx: RunContext, chunkId: string, reason: string): Promise<void> {
  const all = await withRetry(() => ctx.actors.chunks.list({ includeRevoked: true }));
  const c = all.find((x) => x.id === chunkId);
  if (!c) {
    ctx.deps.log(`[reasoning] revoke ${chunkId}: not found`);
    return;
  }
  await withRetry(() => ctx.actors.chunks.revoke(chunkId));
  if (!c.reusers.length) return;
  const warden = await ensureWarden(ctx);
  const text = `Verified note ${chunkId} from ${c.sourceAgent}${c.fn ? ` (${c.fn})` : ""} is REVOKED: ${reason}. Do not rely on it; re-check your code against the spec and your tests.`;
  for (const reuser of c.reusers) {
    const m = await ctx.relay.send({
      fromName: warden,
      to: `@${reuser}`,
      text,
      idempotencyKey: `${chunkId}.revoke.${reuser}`,
      metadata: { runId: ctx.runId, slot: Number(c.slot), gen: c.gen, kind: "revoke" },
      gen: c.gen,
      isCurrentGen: () => true, // system identity
    });
    publishFeed(ctx, m, "revoke");
  }
}
