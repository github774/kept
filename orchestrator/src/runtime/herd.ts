// Herd immunity over Agent Relay (BUILD_SPEC "Herd immunity"). Owner: herd/reasoning implementer.
//
// State notes (rule 3): everything kept in the WeakMaps below is a cache that can be rebuilt or safely
// lost on restart. Durable pieces: case files + receivers (CaseLibrary), lessons (re-derived from
// CaseLibrary via rebuildLessons), replies (CaseLibrary.addReply), and the broadcast marker + thread root
// id (CaseLibrary.markBroadcast), so replies and re-broadcasts work after an orchestrator restart.
//
// Delivery: the warden post goes to the cases channel (for the dashboard feed), but readInbox hands a
// case post or case reply only to that case's recipients; other agents get the lesson through the
// lessons block, not the post.
import type { CaseFile, CaseId, CaseReply, DashboardEvent, RelayFeedItem, BlockedInfo, JevQuestionId } from "../contract.ts";
import { withRetry } from "../actors.ts";
import { cosine } from "../embeddings.ts";
import type { NoulCheck } from "../jev.ts";
import { RelayCapError, RelayNameConflictError, StaleGenerationError, relayNames, type BusMessage, type RelayMeta } from "../relay/bus.ts";
import { jevCheck, noul } from "../verify.ts";
import { reactBlocked, reactLessonAdopted } from "../relay/reactions.ts";
import { wrapQuoted } from "./prompt.ts";
import type { AgentRef, Claim, InboxItem, RunContext, TaskFn } from "./types.ts";

// ---------- shared helpers (also used by reasoning.ts) ----------

interface HerdCache {
  /** caseId -> Relay message id of the warden's case post (thread root). */
  caseRoot: Map<string, string>;
  /** caseId -> replies recorded in this process (oldest first). */
  replies: Map<string, CaseReply[]>;
  /** caseId -> recipient names (from broadcastCase; CaseLibrary.receivers is the durable copy). */
  recipients: Map<string, string[]>;
  /** `<agent>.<step>` -> messages sent this step (caps.relay_messages_per_agent_per_step). */
  sentPerStep: Map<string, number>;
  /** Bus seqs already published as "relay.message" (a retried idempotent send returns the same message). */
  published: Set<number>;
  /** subgoal text -> embedding vector (cache; rebuildable). */
  subgoalVec: Map<string, number[]>;
}
const caches = new WeakMap<RunContext, HerdCache>();
export function herdCache(ctx: RunContext): HerdCache {
  let c = caches.get(ctx);
  if (!c) {
    c = { caseRoot: new Map(), replies: new Map(), recipients: new Map(), sentPerStep: new Map(), published: new Set(), subgoalVec: new Map() };
    caches.set(ctx, c);
  }
  return c;
}

const wardenReady = new WeakMap<object, Set<string>>();
/**
 * Registers warden-<runId> on the bus (once per bus + run). A 409 means it is already registered
 * (RunManager or an earlier call); sends then work only if this bus holds its client. After an
 * orchestrator restart on the real engine the warden token is not stored anywhere yet (see report).
 */
export async function ensureWarden(ctx: RunContext): Promise<string> {
  const name = relayNames.warden(ctx.runId);
  const set = wardenReady.get(ctx.relay) ?? new Set<string>();
  wardenReady.set(ctx.relay, set);
  if (set.has(ctx.runId)) return name;
  try {
    await ctx.relay.registerAgent(name, [relayNames.fleet(ctx.runId), relayNames.cases(ctx.runId)]);
  } catch (e) {
    if (!(e instanceof RelayNameConflictError)) throw e;
  }
  set.add(ctx.runId);
  return name;
}

/** Fleet check used as isCurrentGen on every agent send (rule 5). */
export async function isCurrentGen(ctx: RunContext, slot: number, gen: number): Promise<boolean> {
  const snap = await withRetry(() => ctx.actors.fleet.snapshot());
  const s = snap.slots.find((x) => x.slot === String(slot));
  return !!s && s.gen === gen && ACTIVE.has(s.status);
}
const ACTIVE = new Set(["trusted", "probation", "under_investigation"]);

/** The TaskFn a slot owns (slot index into ctx.task.functions). */
export function fnForSlot(ctx: RunContext, slot: number): TaskFn | undefined {
  return ctx.task.functions[slot];
}

const channelOf = (to: string): { channel: string; to?: string } => (to.startsWith("#") ? { channel: to.slice(1) } : { channel: "dm", to });

function publish(ctx: RunContext, ev: DashboardEvent) {
  ctx.bus.publish(ev);
}

/** Publishes one "relay.message" per bus message (deduped on seq). */
export function publishFeed(ctx: RunContext, m: BusMessage, kind: NonNullable<RelayMeta["kind"]>, extra: { threadId?: string } = {}) {
  const cache = herdCache(ctx);
  if (cache.published.has(m.seq)) return;
  cache.published.add(m.seq);
  const item: RelayFeedItem = {
    seq: m.seq,
    ...channelOf(m.to),
    from: m.from,
    text: m.text,
    ts: Date.parse(m.createdAt) || Date.now(),
    metadata: {
      runId: ctx.runId,
      slot: m.metadata.slot,
      gen: m.metadata.gen,
      ...(m.metadata.caseId ? { caseId: m.metadata.caseId } : {}),
      kind,
      ...(extra.threadId ?? m.parentId ? { threadId: extra.threadId ?? m.parentId } : {}),
    },
  };
  publish(ctx, { type: "relay.message", runId: ctx.runId, ts: item.ts, item, ...(m.mock ? { mock: true as const } : {}) });
}

/** Publishes a blocked (never delivered) message on the feed. Seq from the bus counter when available. */
export function publishBlocked(
  ctx: RunContext,
  p: { from: string; to: string; text: string; slot?: number; gen?: number; caseId?: string; kind: NonNullable<RelayMeta["kind"]>; blocked: BlockedInfo; mock: boolean },
) {
  const seq = ctx.relay.reserveSeq?.() ?? -Date.now(); // negative => fake bus without a counter (tests only)
  const ts = Date.now();
  const item: RelayFeedItem = {
    seq,
    ...channelOf(p.to),
    from: p.from,
    text: p.text,
    ts,
    blocked: p.blocked,
    metadata: { runId: ctx.runId, slot: p.slot, gen: p.gen, ...(p.caseId ? { caseId: p.caseId } : {}), kind: p.kind },
  };
  publish(ctx, { type: "relay.message", runId: ctx.runId, ts, item, ...(p.mock ? { mock: true as const } : {}) });
}

const sourceOf = (r: NoulCheck): "jev" | "fallback" => (r.source === "fallback" ? "fallback" : "jev");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function subgoalVectors(ctx: RunContext, texts: string[], scope: { slot: number; gen: number; step: number | string }): Promise<number[][]> {
  const cache = herdCache(ctx);
  const missing = [...new Set(texts.filter((t) => !cache.subgoalVec.has(t)))];
  if (missing.length) {
    const r = await ctx.deps.embedder.embed(missing, { category: "embedding", slot: String(scope.slot), gen: scope.gen, step: typeof scope.step === "number" ? scope.step : 0 });
    await ctx.ledger.record(scope, [r.usage]);
    missing.forEach((t, i) => cache.subgoalVec.set(t, r.vectors[i]!));
  }
  return texts.map((t) => cache.subgoalVec.get(t)!);
}
export { subgoalVectors as embedCached };

/**
 * Lessons block rebuilt from CaseLibrary (durable): non-revoked, non-synthetic cases with a lesson,
 * oldest first, last caps.max_lessons. RunManager.reconcile / startRun can call this.
 */
export async function rebuildLessons(ctx: RunContext): Promise<string[]> {
  const cases = await withRetry(() => ctx.actors.cases.list({}));
  const out: string[] = [];
  for (const c of cases) {
    const l = (c.lesson ?? "").trim();
    if (c.synthetic || !l || l === "NO_LESSON" || out.includes(l)) continue;
    out.push(l);
  }
  return out.slice(-ctx.caps.max_lessons);
}

function appendLesson(ctx: RunContext, lesson: string) {
  const l = lesson.trim();
  if (!l) return;
  const cur = ctx.lessons();
  if (cur.includes(l)) return;
  ctx.setLessons([...cur, l].slice(-ctx.caps.max_lessons)); // reassignment, never in place (rule 4)
}

/**
 * Warden post text. It never quotes the failed agent's claim or its test output: both are agent-controlled,
 * and for conflicting_instruction / spec_misread the claim IS the instruction Jev blocked, so quoting it
 * would deliver the blocked text to every reader. It describes what happened instead.
 */
export function caseSummary(c: CaseFile): string {
  const j = c.evidence.jev;
  const jev = j ? ` (${j.questionId} p=${j.probability.toFixed(2)})` : "";
  const what =
    c.category === "conflicting_instruction"
      ? `sent a message that was rejected as conflicting with the spec${jev}`
      : c.category === "spec_misread"
        ? `acted on a statement that contradicts the spec${jev}`
        : c.category === "false_success_claim" || c.category === "invented_api"
          ? "claimed its tests passed, but they failed"
          : "was retired after its checks failed";
  return `CASE ${c.id} [${c.category}] ${c.agentName} on ${c.subtask}: ${what}. Lesson: ${c.lesson ?? "(none)"}`;
}

// ---------- broadcastCase ----------

/**
 * Delivers a case (BUILD_SPEC "Delivery"):
 *  1. Post the case summary to relayNames.cases(runId) as relayNames.warden(runId) (metadata
 *     {runId, slot, gen, caseId, kind "case"}, idempotencyKey `<caseId>.broadcast`); the post's message id
 *     is the thread root (contract threadId).
 *  2. Recipients: active agents (Fleet snapshot) other than the case's slot whose fn.subgoal embedding has
 *     cosine >= thresholds.case_similarity with the case (claim + lesson), then Jev lesson_relevant
 *     >= thresholds.lesson_relevant (checked in similarity order); at most thresholds.max_recipients.
 *     No lesson => no recipients (nothing to learn). CaseLibrary.markReceived per recipient.
 *  3. ctx.setLessons(append lesson, keep last caps.max_lessons) when lesson !== null.
 *  4. Publish "relay.message" for the post and "case.created" with recipients filled. retire.ts should
 *     NOT publish a second "case.created" when ctx.herd is on.
 * Ledger scope {slot: caseFile.slot, gen: caseFile.gen, step: `herd.<caseId>`}.
 */
export async function broadcastCase(ctx: RunContext, caseFile: CaseFile): Promise<{ recipients: AgentRef[] }> {
  const cache = herdCache(ctx);
  const scope = { slot: caseFile.slot, gen: caseFile.gen, step: `herd.${caseFile.id}` };
  const lesson = caseFile.lesson && caseFile.lesson.trim() !== "NO_LESSON" ? caseFile.lesson.trim() : null;

  // 2. recipients
  const recipients: AgentRef[] = [];
  if (lesson) {
    const snap = await withRetry(() => ctx.actors.fleet.snapshot());
    const cands = snap.slots
      .filter((s) => ACTIVE.has(s.status) && Number(s.slot) !== caseFile.slot)
      .map((s) => ({ slot: Number(s.slot), gen: s.gen, fn: fnForSlot(ctx, Number(s.slot)) }))
      .filter((c): c is { slot: number; gen: number; fn: TaskFn } => !!c.fn);
    if (cands.length) {
      const caseText = `${caseFile.claim}\n${lesson}`;
      const vecs = await subgoalVectors(ctx, [caseText, ...cands.map((c) => c.fn.subgoal)], scope);
      const caseVec = vecs[0]!;
      const ranked = cands
        .map((c, i) => ({ ...c, sim: cosine(caseVec, vecs[i + 1]!) }))
        .filter((c) => c.sim >= ctx.cfg.thresholds.case_similarity)
        .sort((a, b) => b.sim - a.sim);
      for (const c of ranked) {
        if (recipients.length >= ctx.cfg.thresholds.max_recipients) break;
        const r = noul(await jevCheck(ctx, scope, "lesson_relevant", { lesson, subtask: `${c.fn.name}: ${c.fn.subgoal}` }));
        // lesson_relevant: true = "would change how someone does the subtask"; probability = P(true).
        if (r.probability >= ctx.cfg.thresholds.lesson_relevant) recipients.push({ slot: c.slot, gen: c.gen, name: relayNames.agent(ctx.runId, c.slot, c.gen) });
      }
    }
  } else {
    ctx.deps.log(`[herd] case ${caseFile.id} has no lesson; posted without recipients`);
  }

  // 1. post (after recipient selection so the summary can say who it is for). Recipients are cached before
  // the send so readInbox (which delivers case posts only to recipients) never sees the post first.
  const warden = await ensureWarden(ctx);
  cache.recipients.set(caseFile.id, recipients.map((r) => r.name));
  const text = caseSummary(caseFile) + (recipients.length ? ` For: ${recipients.map((r) => r.name).join(", ")}` : "");
  const meta: RelayMeta = { runId: ctx.runId, slot: caseFile.slot, gen: caseFile.gen, caseId: caseFile.id, kind: "case" };
  const msg = await ctx.relay.send({
    fromName: warden,
    to: `#${relayNames.cases(ctx.runId)}`,
    text,
    idempotencyKey: `${caseFile.id}.broadcast`,
    metadata: meta,
    gen: caseFile.gen,
    isCurrentGen: () => true, // system identity; the case itself is already filed
  });
  cache.caseRoot.set(caseFile.id, msg.id);
  for (const r of recipients) {
    const res = await withRetry(() => ctx.actors.cases.markReceived(caseFile.id, r.name));
    if (!res.ok) ctx.deps.log(`[herd] markReceived ${caseFile.id} ${r.name}: ${res.reason}`);
  }
  // Durable "delivery done" + thread root: reconcile re-runs broadcastCase for cases without it.
  const mb = await withRetry(() => ctx.actors.cases.markBroadcast(caseFile.id, msg.id));
  if (!mb.ok) ctx.deps.log(`[herd] markBroadcast ${caseFile.id}: ${mb.reason}`);

  // 3. lessons
  if (lesson) appendLesson(ctx, lesson);

  // 4. events
  publishFeed(ctx, msg, "case", { threadId: msg.id });
  const mock = ctx.relay.mock || ctx.deps.mock.jev || ctx.deps.mock.embed;
  publish(ctx, {
    type: "case.created",
    runId: ctx.runId,
    ts: Date.now(),
    case: { ...caseFile, recipients: recipients.map((r) => r.name), replies: cache.replies.get(caseFile.id) ?? caseFile.replies ?? [] },
    ...(mock ? { mock: true as const } : {}),
  });
  return { recipients };
}

// ---------- inbox ----------

function kindOf(ctx: RunContext, m: BusMessage): InboxItem["kind"] {
  const k = m.metadata.kind;
  if (k === "case" || k === "case_reply" || k === "dm" || k === "note" || k === "status") return k;
  if (m.parentId) return "case_reply";
  if (m.from === relayNames.warden(ctx.runId) && m.metadata.caseId) return "case";
  if (m.to.startsWith("@")) return "dm";
  if (m.to === `#${relayNames.fleet(ctx.runId)}`) return "status";
  return "note";
}

type Blocked = { reason: string; probability: number; source: "jev" | "fallback" };

async function inboundCheck(
  ctx: RunContext,
  reader: AgentRef,
  step: number,
  item: InboxItem,
): Promise<{ deliver: boolean; blocked?: Blocked; questionId?: JevQuestionId; mock?: boolean }> {
  // System messages (warden case posts, revocations) are orchestrator-authored; still delivered as quoted data.
  if (item.from === relayNames.warden(ctx.runId) && !item.injected) return { deliver: true };
  const scope = { slot: reader.slot, gen: reader.gen, step };
  const spec = ctx.task.specText;
  // A teammate message can state a fact, give an instruction, or both: check both, in parallel.
  const [fact, instr] = await Promise.all([
    jevCheck(ctx, scope, "fact_contradicts_spec", { spec_excerpt: spec, fact: item.text }).then(noul),
    item.kind === "fact" ? Promise.resolve(null) : jevCheck(ctx, scope, "instruction_conflicts_spec", { spec_excerpt: spec, instruction: item.text }).then(noul),
  ]);
  if (fact.value) ctx.rejectedFacts.add(item.text.trim().toLowerCase());
  const hit = fact.value ? { r: fact, q: "fact_contradicts_spec" as const } : instr?.value ? { r: instr, q: "instruction_conflicts_spec" as const } : null;
  if (!hit) return { deliver: true };
  return {
    deliver: false,
    questionId: hit.q,
    mock: hit.r.source === "mock",
    blocked: { reason: hit.r.reason ?? `${hit.q} p=${hit.r.probability.toFixed(2)}`, probability: hit.r.probability, source: sourceOf(hit.r) },
  };
}

/**
 * Step 1 of the worker loop: Relay messages for ref since ctx.inboxCursor.get(ref.name), at most
 * caps.inbox_per_step, never its own. Each teammate message is Jev checked BEFORE delivery
 * (fact_contradicts_spec + instruction_conflicts_spec); blocked ones are dropped and published as
 * "relay.message" with `blocked`. Delivered items are wrapped as quoted data. Advances the cursor.
 */
export async function readInbox(ctx: RunContext, ref: AgentRef, step: number): Promise<InboxItem[]> {
  const since = ctx.inboxCursor.get(ref.name) ?? 0;
  const msgs = ctx.relay.inbox(ref.name, since, ctx.caps.inbox_per_step);
  if (!msgs.length) return [];
  const out: InboxItem[] = [];
  for (const m of msgs) {
    const kind = kindOf(ctx, m);
    // Case posts and case replies go to the case's recipients only (no Jev spend on the rest).
    if ((kind === "case" || kind === "case_reply") && m.metadata.caseId && !(await caseRoutedTo(ctx, m.metadata.caseId, ref.name))) continue;
    const ch = channelOf(m.to).channel;
    const item: InboxItem = {
      seq: m.seq,
      from: m.from,
      channel: ch,
      kind,
      ...(m.metadata.caseId ? { caseId: m.metadata.caseId } : {}),
      text: m.text,
      wrapped: "",
    };
    const res = await inboundCheck(ctx, ref, step, item);
    if (!res.deliver) {
      publishBlocked(ctx, {
        from: m.from,
        to: `@${ref.name}`,
        text: m.text,
        slot: m.metadata.slot,
        gen: m.metadata.gen,
        caseId: m.metadata.caseId,
        kind: kind === "case_reply" ? "case_reply" : kind === "dm" ? "dm" : "note",
        blocked: { reason: `Blocked before delivery to ${ref.name}: ${res.blocked!.reason}`, questionId: res.questionId!, probability: res.blocked!.probability, source: res.blocked!.source },
        mock: !!res.mock || ctx.relay.mock,
      });
      void reactBlocked(ctx.relay, ctx.runId, m.id); // 🚫 on the blocked message (Relay reaction)
      continue;
    }
    const forMe = kind === "case" && !!item.caseId && (herdCache(ctx).recipients.get(item.caseId) ?? []).includes(ref.name);
    const hint = forMe
      ? `\n(Case ${item.caseId} was routed to you as relevant. Reply once: action "message" with to "${item.caseId}", saying in one or two sentences how its lesson applies to your function.)`
      : "";
    out.push({ ...item, wrapped: wrapQuoted(m.from, m.text, kind) + hint });
  }
  ctx.inboxCursor.set(ref.name, Math.max(since, ...msgs.map((m) => m.seq)));
  return out;
}

/**
 * Jev check of one inbound item: fact_contradicts_spec on stated facts (rejected -> ctx.rejectedFacts),
 * instruction_conflicts_spec on instructions (skipped for kind "fact"). Warden messages are not checked.
 * Returns {deliver:false, blocked} when decided as a problem. Ledger scope = the reader's {slot, gen, step}.
 * Callers that inject items themselves (faults.takeInboxFaults, F4) must call this before delivery.
 */
export async function checkInbound(
  ctx: RunContext,
  reader: AgentRef,
  step: number,
  item: InboxItem,
): Promise<{ deliver: boolean; blocked?: Blocked }> {
  const r = await inboundCheck(ctx, reader, step, item);
  return r.deliver ? { deliver: true } : { deliver: false, blocked: r.blocked };
}

// ---------- outgoing ----------

function normalizeTo(ctx: RunContext, to: string): string {
  const t = to.trim();
  if (t.startsWith("#") || t.startsWith("@")) return t;
  const low = t.toLowerCase();
  if (["", "all", "team", "fleet", "everyone", "teammates"].includes(low) || low === relayNames.fleet(ctx.runId)) return `#${relayNames.fleet(ctx.runId)}`;
  if (low === "cases" || low === relayNames.cases(ctx.runId)) return `#${relayNames.cases(ctx.runId)}`;
  return `@${t}`;
}

/**
 * Outgoing teammate message (worker "message" action, or F3): Jev instruction_conflicts_spec BEFORE
 * delivery on the text and every claim of kind "instruction". Decided problem -> not sent, "relay.message"
 * published with `blocked`, returns {sent:false, conflict} (retire trigger: conflicting_instruction).
 * Else ctx.relay.send (idempotencyKey relayNames.idempotencyKey, metadata {runId, slot, gen, kind},
 * isCurrentGen = Fleet check). Cap: caps.relay_messages_per_agent_per_step (over cap => {sent:false}).
 */
export async function sendMessage(
  ctx: RunContext,
  ref: AgentRef,
  step: number,
  msg: { to: string; text: string },
  claims: Claim[],
): Promise<{ sent: boolean; conflict?: NoulCheck }> {
  const cache = herdCache(ctx);
  const key = `${ref.name}.${step}`;
  const n = cache.sentPerStep.get(key) ?? 0;
  if (n >= ctx.caps.relay_messages_per_agent_per_step) {
    ctx.deps.log(`[herd] ${ref.name} step ${step}: message cap reached (${n})`);
    return { sent: false };
  }
  const to = normalizeTo(ctx, msg.to);
  const kind: NonNullable<RelayMeta["kind"]> = to.startsWith("@") ? "dm" : "note";
  const scope = { slot: ref.slot, gen: ref.gen, step };
  const texts = [...new Set([msg.text, ...claims.filter((c) => c.kind === "instruction").map((c) => c.text)].map((t) => t.trim()).filter(Boolean))];
  for (const t of texts) {
    const r = noul(await jevCheck(ctx, scope, "instruction_conflicts_spec", { spec_excerpt: ctx.task.specText, instruction: t }));
    if (r.value) {
      publishBlocked(ctx, {
        from: ref.name,
        to,
        text: msg.text,
        slot: ref.slot,
        gen: ref.gen,
        kind,
        blocked: { reason: r.reason ?? `instruction_conflicts_spec p=${r.probability.toFixed(2)}`, questionId: "instruction_conflicts_spec", probability: r.probability, source: sourceOf(r) },
        mock: r.source === "mock" || ctx.relay.mock,
      });
      return { sent: false, conflict: r };
    }
  }
  cache.sentPerStep.set(key, n + 1);
  const base = relayNames.idempotencyKey(ctx.runId, ref.slot, ref.gen, step);
  try {
    const m = await ctx.relay.send({
      fromName: ref.name,
      to,
      text: msg.text,
      idempotencyKey: n === 0 ? base : `${base}.m${n + 1}`,
      metadata: { runId: ctx.runId, slot: ref.slot, gen: ref.gen, kind },
      gen: ref.gen,
      isCurrentGen: (g) => isCurrentGen(ctx, ref.slot, g),
    });
    publishFeed(ctx, m, kind);
    return { sent: true };
  } catch (e) {
    if (e instanceof StaleGenerationError) {
      ctx.deps.log(`[herd] ${ref.name}: send rejected, generation not current`);
      return { sent: false };
    }
    // Unknown recipient (model addressed a name that is not registered): not sent, not a crashed step.
    const err = e instanceof Error ? e.message : String(e);
    if (/not found|unknown|no such/i.test(err)) {
      ctx.deps.log(`[herd] ${ref.name}: send to ${msg.to} failed: ${err}`);
      return { sent: false };
    }
    throw e;
  }
}

// ---------- case thread replies ----------

/** Persists a reply when CaseLibrary.addReply exists (actor change pending); else in-process only. */
async function persistReply(ctx: RunContext, caseId: CaseId, reply: CaseReply) {
  const lib = ctx.actors.cases as unknown as { addReply?: (caseId: string, r: CaseReply) => Promise<unknown> };
  if (typeof lib.addReply === "function") await withRetry(() => lib.addReply!(caseId, reply));
}

/** Replies known for a case (this process); dashboards should treat absence as unknown. */
export function repliesFor(ctx: RunContext, caseId: CaseId): CaseReply[] {
  return herdCache(ctx).replies.get(caseId) ?? [];
}

const CASE_ID_RE = /^[\w-]+\.\d+\.g\d+$/;

/**
 * True if caseId was routed to agent `name`: the in-process cache from broadcastCase, else the durable
 * CaseLibrary receivers (after a restart). Strings that are not case ids answer false without a read.
 */
export async function caseRoutedTo(ctx: RunContext, caseId: string, name: string): Promise<boolean> {
  const cache = herdCache(ctx);
  const known = cache.recipients.get(caseId);
  if (known) return known.includes(name);
  if (!CASE_ID_RE.test(caseId)) return false;
  const c = await withRetry(() => ctx.actors.cases.get(caseId)).catch(() => null);
  if (!c) return false;
  const receivers = c.receivers ?? [];
  if ((c as { broadcast?: boolean }).broadcast) cache.recipients.set(caseId, receivers);
  return receivers.includes(name);
}

/** Thread root id: this process's broadcast, else the id stored by markBroadcast, else the bus history. */
function findRootId(ctx: RunContext, caseId: CaseId, stored: string | null | undefined): string | undefined {
  const cache = herdCache(ctx);
  const id = cache.caseRoot.get(caseId) ?? stored ?? undefined;
  if (id) return id;
  const hist = ctx.relay.history?.() ?? [];
  return hist.find((m) => !m.parentId && m.metadata.caseId === caseId && m.from === relayNames.warden(ctx.runId))?.id;
}

/**
 * One reply by a recipient in a case thread (BUILD_SPEC Delivery 3-4): only recipients, once each,
 * never to their own case (same slot) or to a reply; the thread closes after caps.replies_per_case_thread.
 * Sends via ctx.relay.reply (thread root = the warden's case post, metadata kind "case_reply"), publishes
 * "relay.message" and "case.reply" (reply.seq = feed item seq). Returns null when not allowed.
 * The reply text comes from the worker's own LLM call, already in the ledger as that step's usage; no
 * extra API call is made here.
 */
export async function recordReply(ctx: RunContext, ref: AgentRef, step: number, caseId: CaseId, text: string): Promise<CaseReply | null> {
  const cache = herdCache(ctx);
  const deny = (why: string) => {
    ctx.deps.log(`[herd] reply by ${ref.name} on ${caseId} refused: ${why}`);
    return null;
  };
  const body = text.trim();
  if (!body) return deny("empty");
  const c = await withRetry(() => ctx.actors.cases.get(caseId));
  if (!c) return deny("no such case");
  if (Number(c.slot) === ref.slot) return deny("own case");
  const recips = new Set([...(c.receivers ?? []), ...(cache.recipients.get(caseId) ?? [])]);
  if (!recips.has(ref.name)) return deny("not a recipient");
  const rootId = findRootId(ctx, caseId, (c as { rootMessageId?: string | null }).rootMessageId);
  if (!rootId) return deny("case post not found (no stored thread root)");
  const root = { id: rootId };
  const hist = ctx.relay.history?.() ?? [];
  const threadReplies = hist.filter((m) => m.parentId === root.id);
  const known = cache.replies.get(caseId) ?? [];
  const durable = c.replies ?? [];
  if (threadReplies.some((m) => m.from === ref.name) || known.some((r) => r.from === ref.name) || durable.some((r) => r.from === ref.name)) return deny("already replied");
  if (Math.max(threadReplies.length, known.length, durable.length) >= ctx.caps.replies_per_case_thread) return deny("thread closed");
  let m: BusMessage;
  try {
    m = await ctx.relay.reply({
      fromName: ref.name,
      messageId: root.id,
      text: body,
      idempotencyKey: `${relayNames.idempotencyKey(ctx.runId, ref.slot, ref.gen, step)}.reply`,
      metadata: { runId: ctx.runId, slot: ref.slot, gen: ref.gen, caseId, kind: "case_reply" },
      gen: ref.gen,
      isCurrentGen: (g) => isCurrentGen(ctx, ref.slot, g),
    });
  } catch (e) {
    if (e instanceof RelayCapError) return deny(e.message);
    if (e instanceof StaleGenerationError) return deny("generation not current");
    throw e;
  }
  const reply: CaseReply = { from: ref.name, slot: ref.slot, gen: ref.gen, text: body, ts: Date.parse(m.createdAt) || Date.now(), seq: m.seq };
  if (!known.some((r) => r.seq === reply.seq)) cache.replies.set(caseId, [...known, reply]);
  await persistReply(ctx, caseId, reply);
  void reactLessonAdopted(ctx.relay, ctx.runId, root.id); // ✅ on the case post (Relay reaction)
  publishFeed(ctx, m, "case_reply", { threadId: root.id });
  publish(ctx, { type: "case.reply", runId: ctx.runId, ts: reply.ts, caseId, reply, ...(m.mock ? { mock: true as const } : {}) });
  return reply;
}
