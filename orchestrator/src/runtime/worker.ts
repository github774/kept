// Worker loop (BUILD_SPEC "Worker loop"). Owner: worker implementer (with prompt.ts, faults.ts).
//
// Rebuildable state (rule 3): everything the loop needs across steps is read back from the Agent actor
// each step. Test outcomes are stored as marker strings in the step's claims ("@tests:pass",
// "@tests:fail", "@verified") so the stuck counter and probation count survive a restart.
// In-memory only (cosmetic or per-step): the last test output shown in the next prompt, and which
// reused chunks the current file came from.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { withRetry } from "../actors.ts";
import type { AgentCard, AgentStatus, FailureCategory, FaultId } from "../contract.ts";
import type { NoulCheck } from "../jev.ts";
import { checkCode } from "../codeguard.ts";
import type { LedgerDraft } from "../ledger-entry.ts";
import { StepFailed, WORKER_STEP_ACTION_FIELDS, WORKER_STEP_SCHEMA } from "../llm.ts";
import { relayNames } from "../relay/bus.ts";
import type { RunTestsResult } from "../testrunner.ts";
import { jevCheck, noul, runFnTests } from "../verify.ts";
import { applyPendingFault, fnForSlot, rememberGens, takeInboxFaults } from "./faults.ts";
import { caseRoutedTo, checkInbound, publishBlocked, readInbox, recordReply, sendMessage } from "./herd.ts";
import { notePassingRun, takeAlerts } from "./evidence.ts";
import { buildPrompt } from "./prompt.ts";
import { maybeCreateChunk, retrieveChunks, revokeChunk } from "./reasoning.ts";
import { markTestsPassing, noteVerifiedStep, reassignments, retireAgent } from "./retire.ts";
import type {
  AgentRef,
  Claim,
  Evidence,
  Handoff,
  InboxItem,
  LoopOutcome,
  PromptAgentState,
  RetireReason,
  RunContext,
  StepRecord,
  TaskFn,
  WorkerStep,
} from "./types.ts";

/**
 * Collaborators from other modules, behind one object so unit tests can swap them for labeled fakes
 * without mock.module (which would leak into other test files). Production code never reassigns it.
 */
export const workerDeps = {
  readInbox,
  checkInbound,
  sendMessage,
  recordReply,
  caseRoutedTo,
  publishBlocked,
  retrieveChunks,
  maybeCreateChunk,
  revokeChunk,
  retireAgent,
  noteVerifiedStep,
  markTestsPassing,
  runFnTests,
  jevCheck,
};

export const MARK = { pass: "@tests:pass", fail: "@tests:fail", verified: "@verified" } as const;
const ACTIVE: readonly string[] = ["trusted", "probation", "under_investigation"];
const MAX_CODE_LINES = 200;
const MAX_MESSAGE_CHARS = 300;
const SPEC_EXCERPT_CHARS = 6000;

// ---------- per-run in-memory caches (never needed after a restart) ----------

interface AgentMem {
  lastTestOutput?: string;
  /** Chunk ids that were in the prompt of the step that last wrote this agent's file. */
  fileChunks: string[];
}
const mem = new WeakMap<RunContext, Map<string, AgentMem>>();
function agentMem(ctx: RunContext, name: string): AgentMem {
  let m = mem.get(ctx);
  if (!m) mem.set(ctx, (m = new Map()));
  let a = m.get(name);
  if (!a) m.set(name, (a = { fileChunks: [] }));
  return a;
}

// ---------- helpers ----------

type AgentRaw = Awaited<ReturnType<ReturnType<RunContext["actors"]["agent"]>["state"]>>;
type Snapshot = Awaited<ReturnType<RunContext["actors"]["fleet"]["snapshot"]>>;
type SlotRow = Snapshot["slots"][number];

const specExcerpt = (ctx: RunContext) => ctx.task.specText.slice(0, SPEC_EXCERPT_CHARS);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length > 2));

/** Same fact? Normalized containment either way, or token Jaccard >= 0.6. */
export function sameFact(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.6;
}

function toHandoff(h: Record<string, unknown> | null | undefined): Handoff | null {
  if (!h || typeof h !== "object") return null;
  const cps = Array.isArray(h.checkpoints) ? (h.checkpoints as { fn?: unknown; code?: unknown; stale?: unknown }[]) : [];
  return {
    fromGen: typeof h.fromGen === "number" ? h.fromGen : 0,
    checkpoints: cps
      .filter((c) => typeof c?.fn === "string" && typeof c?.code === "string")
      .map((c) => ({ fn: c.fn as string, code: c.code as string, ...(typeof (c as { stale?: unknown }).stale === "string" ? { stale: (c as { stale: string }).stale } : {}) })),
    remaining: typeof h.remaining === "string" ? h.remaining : "",
    lesson: typeof h.lesson === "string" ? h.lesson : null,
    caseId: typeof h.caseId === "string" ? h.caseId : "",
  };
}

/** Consecutive failing test runs at the end of the step log (steps without a test run are skipped). */
export function consecutiveFails(claimsByStep: string[][]): number {
  let n = 0;
  for (let i = claimsByStep.length - 1; i >= 0; i--) {
    const c = claimsByStep[i]!;
    if (c.includes(MARK.pass)) break;
    if (c.includes(MARK.fail)) n++;
  }
  return n;
}

const sumUsage = (drafts: LedgerDraft[]) =>
  drafts.reduce(
    (t, d) => ({
      input: t.input + d.input_tokens,
      cached: t.cached + d.cached_input_tokens,
      output: t.output + d.output_tokens,
      reasoning: t.reasoning + d.reasoning_tokens,
      usd: t.usd + d.usd,
    }),
    { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 },
  );

function emptyStep(): WorkerStep {
  return { action: "run_tests", file: null, code: null, message: null, claims: [], approach_note: "", summary: "" };
}

function abortableSleep(ctx: RunContext, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => {
    const end = Date.now() + ms;
    const tick = () => (ctx.stopping || Date.now() >= end ? res() : setTimeout(tick, Math.min(250, end - Date.now())));
    tick();
  });
}

function publishStatus(
  ctx: RunContext,
  ref: AgentRef,
  status: AgentStatus,
  step: number,
  reason: string | undefined,
  agent?: AgentCard,
): void {
  ctx.bus.publish({ type: "agent.status", runId: ctx.runId, ts: Date.now(), slot: ref.slot, gen: ref.gen, status, step, ...(reason ? { reason } : {}), ...(agent ? { agent } : {}) });
}

/** Restores the slot's file to its last verified code (or the starter): nothing unverified carries over. */
function restoreFile(ctx: RunContext, fn: TaskFn, raw: AgentRaw | null): void {
  const cp = raw?.checkpoints.find((c) => c.fn === fn.name)?.code;
  const starter = join(ctx.task.dir, "starter", fn.file);
  const code = cp ?? (existsSync(starter) ? readFileSync(starter, "utf8") : null);
  if (code !== null) writeFileSync(join(ctx.workDir, fn.file), code);
}

async function readAll(ctx: RunContext, ref: AgentRef): Promise<{ raw: AgentRaw; snap: Snapshot; row: SlotRow | undefined }> {
  const [raw, snap] = await Promise.all([
    withRetry(() => ctx.actors.agent(String(ref.slot), ref.gen).state()),
    withRetry(() => ctx.actors.fleet.snapshot()),
  ]);
  rememberGens(ctx, snap.slots);
  return { raw, snap, row: snap.slots.find((s) => s.slot === String(ref.slot)) };
}

/**
 * The function this agent works on now: its own, or, once its own has verified code, a function
 * reassigned to this slot after another slot failed (retire.reassignments) that it has not verified yet.
 */
export function currentFn(ctx: RunContext, ref: AgentRef, raw: AgentRaw): { fn: TaskFn; remaining: TaskFn[] } {
  const own = fnForSlot(ctx, ref.slot, raw.info?.task);
  const done = new Set(raw.checkpoints.map((c) => c.fn));
  const extra = [...reassignments(ctx)]
    .filter(([, slot]) => slot === ref.slot)
    .map(([name]) => ctx.task.functions.find((f) => f.name === name))
    .filter((f): f is TaskFn => !!f && f.name !== own.name && !done.has(f.name));
  if (!done.has(own.name) || extra.length === 0) return { fn: own, remaining: extra };
  return { fn: extra[0]!, remaining: extra.slice(1) };
}

function toPromptState(ctx: RunContext, ref: AgentRef, raw: AgentRaw, row: SlotRow | undefined): PromptAgentState {
  return {
    ref,
    subtask: currentFn(ctx, ref, raw).fn,
    persona: raw.info?.persona ?? "",
    handoff: toHandoff(raw.info?.handoff),
    recentSteps: raw.steps.slice(-4).map((s) => ({ step: s.step, summary: s.summary })),
    probation: row?.status === "probation",
  };
}

// ---------- public API ----------

/**
 * Reads what prompt.buildPrompt needs from the Agent actor (state + handoff) and the Fleet roster
 * (probation). The slot's TaskFn is the Agent actor's task name, else functions[slot].
 */
export async function loadAgentState(ctx: RunContext, ref: AgentRef): Promise<PromptAgentState> {
  const { raw, row } = await readAll(ctx, ref);
  return toPromptState(ctx, ref, raw, row);
}

/**
 * Runs one agent generation until it finishes, is retired, or hits a cap. Never throws for a bad
 * model reply; three consecutive unexpected step errors end the loop as 'failed'.
 */
export async function runAgentLoop(ctx: RunContext, slot: number, gen: number): Promise<LoopOutcome> {
  const ref: AgentRef = { slot, gen, name: relayNames.agent(ctx.runId, slot, gen) };
  let step: number;
  try {
    const raw = await withRetry(() => ctx.actors.agent(String(slot), gen).state());
    if (raw.closed) return "retired";
    step = (raw.steps.at(-1)?.step ?? 0) + 1; // resume after a restart from the last logged step
  } catch (e) {
    ctx.deps.log(`[worker] ${ref.name}: cannot read agent state: ${(e as Error).message}`);
    return "failed";
  }
  let errors = 0;
  for (;; step++) {
    if (ctx.stopping) return "aborted";
    if (step > ctx.caps.steps_per_generation) {
      ctx.deps.log(`[worker] ${ref.name}: step cap ${ctx.caps.steps_per_generation} reached`);
      return "capped";
    }
    try {
      const budget = await ctx.ledger.overBudget(ctx.caps.usd_per_run);
      if (budget.over) {
        ctx.deps.log(`[worker] ${ref.name}: USD cap $${ctx.caps.usd_per_run} reached ($${budget.usd.toFixed(4)})`);
        return "capped";
      }
    } catch (e) {
      ctx.deps.log(`[worker] ${ref.name}: ledger totals unavailable: ${(e as Error).message}`);
    }
    await abortableSleep(ctx, ctx.stepDelayMs);
    if (ctx.stopping) return "aborted";
    try {
      const { outcome } = await runStep(ctx, ref, step);
      errors = 0;
      if (outcome === "done") {
        // Durable "done" marker: Fleet status stays trusted, so retire.pickReassignee needs this to know
        // the loop has ended (a reassigned function then restarts the loop instead of being dropped).
        await withRetry(() => ctx.actors.fleet.markDone(String(slot), gen)).catch((e: Error) =>
          ctx.deps.log(`[worker] ${ref.name}: markDone failed: ${e.message}`),
        );
      }
      if (outcome) return outcome;
    } catch (e) {
      errors++;
      ctx.deps.log(`[worker] ${ref.name} step ${step}: error ${(e as Error).message}`);
      if (errors >= 3) return "failed";
    }
  }
}

/**
 * Executes one step (BUILD_SPEC "One step, in order", parts 1-7) and returns its record.
 * outcome null = keep going.
 */
export async function runStep(ctx: RunContext, ref: AgentRef, step: number): Promise<{ record: StepRecord; outcome: LoopOutcome | null }> {
  const startedAt = Date.now();
  const scope = { slot: ref.slot, gen: ref.gen, step };
  const am = agentMem(ctx, ref.name);
  const usage: LedgerDraft[] = [];

  // 1. State and inbox.
  const { raw, row } = await readAll(ctx, ref);
  const state = toPromptState(ctx, ref, raw, row);
  const fn = state.subtask;
  const record: StepRecord = { ref, step, fn, output: emptyStep(), injected: [], verified: false, reusedChunkIds: [], usage, startedAt, endedAt: startedAt };
  const finish = (outcome: LoopOutcome | null) => ({ record: { ...record, endedAt: Date.now() }, outcome });

  if (raw.closed || !row || row.gen !== ref.gen || !ACTIVE.includes(row.status)) {
    return finish(row?.status === "failed" && row.gen === ref.gen ? "failed" : "retired");
  }
  await withRetry(() => ctx.actors.fleet.setStep(String(ref.slot), ref.gen, step)).catch(() => undefined);
  publishStatus(ctx, ref, row.status as AgentStatus, step, undefined);

  let inbox: InboxItem[] = [];
  try {
    inbox = await workerDeps.readInbox(ctx, ref, step);
  } catch (e) {
    ctx.deps.log(`[worker] ${ref.name} step ${step}: readInbox failed: ${(e as Error).message}`);
  }
  inbox = [...inbox, ...takeAlerts(ctx, ref.slot)]; // retire.pushLessonNow: case lessons for importers of a changed file
  const injectedInbox = takeInboxFaults(ctx, ref, step);
  for (const item of injectedInbox) {
    record.injected = [...record.injected, "F4"];
    const chk = await workerDeps.checkInbound(ctx, ref, step, item);
    if (chk.deliver) inbox = [...inbox, item];
    else {
      ctx.rejectedFacts.add(norm(item.text));
      ctx.bus.publish({
        type: "relay.message",
        runId: ctx.runId,
        ts: Date.now(),
        item: {
          seq: ctx.bus.lastSeq + 1,
          channel: "dm",
          from: item.from,
          to: `@${ref.name}`,
          text: item.text,
          ts: Date.now(),
          blocked: chk.blocked
            ? { reason: `F4 poisoned fact blocked: ${chk.blocked.reason}`, questionId: "fact_contradicts_spec", probability: chk.blocked.probability, source: chk.blocked.source }
            : { reason: "F4 poisoned fact blocked", questionId: "fact_contradicts_spec", probability: 1, source: "jev" },
          metadata: { runId: ctx.runId, slot: ref.slot, gen: ref.gen, kind: "dm" },
        },
      });
    }
  }
  inbox = inbox.slice(-ctx.caps.inbox_per_step);

  let notes: Awaited<ReturnType<typeof retrieveChunks>> = [];
  // Only while this agent's own function hasn't passed yet: notes cost prompt tokens every step (v3 ablation).
  if (ctx.sharedReasoning && !raw.checkpoints.some((c) => c.fn === fn.name)) {
    try {
      notes = await workerDeps.retrieveChunks(ctx, ref, fn.subgoal, step);
    } catch (e) {
      ctx.deps.log(`[worker] ${ref.name} step ${step}: retrieveChunks failed: ${(e as Error).message}`);
    }
  }
  record.reusedChunkIds = notes.map((n) => n.chunkId);

  // 2. Prompt.
  const messages = buildPrompt(ctx, state, { notes, inbox, lastTestOutput: am.lastTestOutput });
  // Opt-in debug: PROMPT_LOG_DIR=<dir> writes every worker prompt to <dir>/<runId>/<agent>.s<step>.txt.
  if (process.env.PROMPT_LOG_DIR) {
    try {
      const dir = join(process.env.PROMPT_LOG_DIR, ctx.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ref.name}.s${step}.txt`), messages.map((m) => `=== ${m.role}\n${m.content}`).join("\n\n"));
    } catch {
      /* debug only */
    }
  }

  // 3. Model call (abortable by retire).
  const ctrl = new AbortController();
  ctx.abort.set(ref.slot, ctrl);
  let output: WorkerStep;
  try {
    const r = await ctx.deps.llm.chatStructured<WorkerStep>({
      model: ctx.model,
      messages,
      schema: WORKER_STEP_SCHEMA,
      schemaName: "worker_step",
      actionFields: WORKER_STEP_ACTION_FIELDS,
      meta: { category: "worker", slot: String(ref.slot), gen: ref.gen, step },
      signal: ctrl.signal,
    });
    const drafts = [...r.extraUsages, r.usage];
    usage.push(...drafts);
    await ctx.ledger.record(scope, drafts);
    output = { ...r.data, claims: Array.isArray(r.data.claims) ? r.data.claims : [] };
  } catch (e) {
    if (!(e instanceof StepFailed)) throw e;
    usage.push(...e.usages);
    await ctx.ledger.record(scope, e.usages);
    if (e.kind === "aborted" || ctrl.signal.aborted) {
      return finish(ctx.stopping ? "aborted" : "retired");
    }
    // Schema/http failure after the adapter's retry: a failed step, never a crash.
    const summary = `step failed (${e.kind}): ${e.message.slice(0, 120)}`;
    const w = await withRetry(() =>
      ctx.actors.agent(String(ref.slot), ref.gen).appendStep(ref.gen, { step, summary, claims: [], usage: sumUsage(usage) }),
    );
    if (!w.ok && (w.reason === "stale_generation" || w.reason === "closed")) return finish("retired");
    ctx.deps.log(`[worker] ${ref.name} step ${step}: ${summary}`);
    return finish(null);
  }
  if (ctrl.signal.aborted) return finish(ctx.stopping ? "aborted" : "retired"); // retired meanwhile: drop the output

  // 4. Faults, then the action.
  const applied = await applyPendingFault(ctx, ref, step, output, fn);
  output = applied.output;
  const fired: FaultId[] = applied.fired;
  record.injected = [...record.injected, ...fired];
  record.output = output;
  if (fired.length) publishStatus(ctx, ref, row.status as AgentStatus, step, `fault ${fired.join("+")} fired`);

  const notesLog: string[] = [];
  let test: RunTestsResult | undefined;
  const runTests = async () => {
    test ??= await workerDeps.runFnTests(ctx, fn, ref.name);
    return test;
  };
  let conflict: { check: NoulCheck; text: string } | null = null;

  if (output.action === "write_code") {
    const file = output.file ? normalize(output.file).replace(/^\.\//, "") : "";
    const code = output.code ?? "";
    if (file !== fn.file) notesLog.push(`write rejected: ${output.file ?? "(no file)"} is not your file ${fn.file}`);
    else if (code.split("\n").length > MAX_CODE_LINES) notesLog.push(`write rejected: more than ${MAX_CODE_LINES} lines`);
    else {
      const g = checkCode(code);
      if (!g.ok) notesLog.push(`write rejected by code guard: ${g.violations.map((v) => `line ${v.line} ${v.rule}`).join("; ")}`);
      else {
        writeFileSync(join(ctx.workDir, fn.file), code);
        am.fileChunks = fired.length ? [] : record.reusedChunkIds;
        // Ground truth right after an accepted write: a passing run makes this a verified step (models often
        // keep writing without ever choosing run_tests). A failing run is only noted, so it never counts
        // toward the "stuck" retire trigger, which is about runs the agent asked for.
        const t = await workerDeps.runFnTests(ctx, fn, ref.name);
        if (t.passed) test = t;
        else notesLog.push(`tests after write: ${t.failedTests.length || "some"} failing`);
      }
    }
  } else if (output.action === "run_tests" || output.action === "claim_done") {
    await runTests();
  }

  // Message: the model's message action, or an F3 riding along with another action. One per step.
  // (caps.relay_messages_per_agent_per_step >= 1; a step carries at most one message by construction.)
  if (output.message && (output.action === "message" || fired.includes("F3"))) {
    const msg = { to: output.message.to, text: output.message.text.slice(0, MAX_MESSAGE_CHARS) };
    // A reply to a case: addressed to a case id this agent received (now or in an earlier step's inbox).
    const target = msg.to.replace(/^[#@]/, "").trim();
    const caseId =
      inbox.find((i) => i.kind === "case" && i.caseId && (target === i.caseId || target.includes(i.caseId)))?.caseId ??
      ((await workerDeps.caseRoutedTo(ctx, target, ref.name)) ? target : null);
    const instr = output.claims.filter((c) => c.kind === "instruction");
    if (caseId && !fired.includes("F3")) {
      // Replies get the same outgoing check as sendMessage: the reply text and every instruction claim.
      let blocked: NoulCheck | null = null;
      const texts = [...new Set([msg.text, ...instr.map((c) => c.text)].map((t) => t.trim()).filter(Boolean))];
      for (const t of texts) {
        const r = noul(await workerDeps.jevCheck(ctx, scope, "instruction_conflicts_spec", { spec_excerpt: specExcerpt(ctx), instruction: t }));
        usage.push(...r.ledger);
        if (r.value) {
          blocked = r;
          break;
        }
      }
      if (blocked) {
        conflict = { check: blocked, text: msg.text };
        notesLog.push(`case reply blocked (conflicts with spec)`);
        workerDeps.publishBlocked(ctx, {
          from: ref.name,
          to: `#${relayNames.cases(ctx.runId)}`,
          text: msg.text,
          slot: ref.slot,
          gen: ref.gen,
          caseId,
          kind: "case_reply",
          blocked: {
            reason: blocked.reason ?? `instruction_conflicts_spec p=${blocked.probability.toFixed(2)}`,
            questionId: "instruction_conflicts_spec",
            probability: blocked.probability,
            source: blocked.source === "fallback" ? "fallback" : "jev",
          },
          mock: blocked.source === "mock" || ctx.relay.mock,
        });
      } else {
        const reply = await workerDeps.recordReply(ctx, ref, step, caseId, msg.text);
        notesLog.push(reply ? `replied in case ${caseId}` : `case reply not allowed (${caseId})`);
      }
    } else {
      const to = msg.to === "#fleet" || msg.to === "fleet" ? `#${relayNames.fleet(ctx.runId)}` : msg.to;
      const res = await workerDeps.sendMessage(ctx, ref, step, { to, text: msg.text }, output.claims);
      if (res.conflict) conflict = { check: res.conflict, text: msg.text };
      notesLog.push(res.sent ? `message sent to ${to}` : `message blocked${res.conflict ? " (conflicts with spec)" : ""}`);
    }
  }

  // 5. Verify claims: ground truth first.
  let falseClaim: { claim: string } | null = null;
  const tp = output.claims.find((c) => c.kind === "tests_pass");
  if (tp) {
    const t = await runTests();
    if (!t.passed) falseClaim = { claim: tp.text };
  }

  let poison: { claim: Claim; check?: NoulCheck } | null = null;
  const rejectedBefore = [...ctx.rejectedFacts];
  for (const c of output.claims) {
    if (c.kind === "tests_pass") continue;
    if (!fired.includes("F3") && rejectedBefore.some((f) => sameFact(c.text, f))) {
      poison ??= { claim: c };
    }
    if (c.kind === "spec_fact") {
      const r = noul(await workerDeps.jevCheck(ctx, scope, "fact_contradicts_spec", { spec_excerpt: specExcerpt(ctx), fact: c.text }));
      usage.push(...r.ledger);
      if (r.value) {
        ctx.rejectedFacts.add(norm(c.text));
        notesLog.push(`spec_fact rejected: "${c.text.slice(0, 80)}"`);
        if (poison && poison.claim === c) poison = { claim: c, check: r };
      }
    }
  }
  if (!poison && output.message && output.action === "message" && !fired.includes("F3")) {
    const m = output.message.text;
    if (rejectedBefore.some((f) => sameFact(m, f))) poison = { claim: { kind: "instruction", text: m } };
  }

  // Test bookkeeping.
  const verified = !!test?.passed && !falseClaim;
  if (test?.passed) notePassingRun(ctx, ref.slot); // evidence.ts: what the shared folder looked like when this slot last passed
  record.test = test;
  record.verified = verified;
  if (test) am.lastTestOutput = test.output.slice(-1500);
  const claimStrings = [
    ...output.claims.map((c) => `${c.kind}: ${c.text}`),
    ...(test ? [test.passed ? MARK.pass : MARK.fail] : []),
    ...(verified ? [MARK.verified] : []),
    ...fired.map((f) => `@fault:${f}`),
  ];

  // 6. Persist (every write tagged with gen).
  if (ctrl.signal.aborted) return finish(ctx.stopping ? "aborted" : "retired");
  const summary = [output.summary.trim() || `${output.action}`, ...notesLog].join(" | ").slice(0, 400);
  const agentActor = ctx.actors.agent(String(ref.slot), ref.gen);
  const w = await withRetry(() => agentActor.appendStep(ref.gen, { step, summary, claims: claimStrings, usage: sumUsage(usage) }));
  if (!w.ok && (w.reason === "stale_generation" || w.reason === "closed")) return finish("retired");
  if (verified) {
    const code = readFileSync(join(ctx.workDir, fn.file), "utf8");
    const c = await withRetry(() => agentActor.checkpoint(ref.gen, fn.name, code));
    if (!c.ok && (c.reason === "stale_generation" || c.reason === "closed")) return finish("retired");
  }

  let status = row.status as AgentStatus;
  if (verified) {
    if (!state.probation && ctx.sharedReasoning) {
      try {
        await workerDeps.maybeCreateChunk(ctx, ref, { ...record, endedAt: Date.now() });
      } catch (e) {
        ctx.deps.log(`[worker] ${ref.name} step ${step}: maybeCreateChunk failed: ${(e as Error).message}`);
      }
    }
    const verifiedSteps = raw.steps.filter((s) => s.claims.includes(MARK.verified)).length + 1;
    try {
      const v = await workerDeps.noteVerifiedStep(ctx, ref, step, verifiedSteps);
      if (v.status) status = v.status;
    } catch (e) {
      ctx.deps.log(`[worker] ${ref.name} step ${step}: noteVerifiedStep failed: ${(e as Error).message}`);
    }
    // Recovery: the respawned slot's tests pass again (publishes the "recovery" event).
    workerDeps.markTestsPassing(ctx, ref);
  }
  const tokens = sumUsage(usage);
  const card: AgentCard = {
    slot: ref.slot,
    name: ref.name,
    gen: ref.gen,
    status,
    step,
    subtask: fn.name,
    tokens: {
      input: raw.totals.input + tokens.input,
      cached: raw.totals.cached + tokens.cached,
      output: raw.totals.output + tokens.output,
      reasoning: raw.totals.reasoning + tokens.reasoning,
      usd: raw.totals.usd + tokens.usd,
    },
    possessed: row.possessed || (ctx.pendingFaults.get(ref.slot)?.length ?? 0) > 0,
    verifiedSteps: raw.steps.filter((s) => s.claims.includes(MARK.verified)).length + (verified ? 1 : 0),
    lastSummary: output.summary.split(/\s+/).slice(0, 40).join(" "),
  };
  publishStatus(ctx, ref, status, step, test ? (test.passed ? "tests passed" : "tests failed") : undefined, card);

  // 7. Retire triggers (ground truth first). An honest failed test run is not one.
  const detectedAt = Date.now();
  let trigger: { reason: RetireReason; evidence: Evidence } | null = null;
  const faultOf = (f: FaultId[]) => f.find((x) => x === "F1" || x === "F2") ?? f[0];
  if (falseClaim && test) {
    const fault = faultOf(fired);
    const category: FailureCategory | undefined = fault === "F1" ? "false_success_claim" : fault === "F2" ? "invented_api" : "false_success_claim";
    trigger = {
      reason: "false_claim",
      evidence: {
        claim: falseClaim.claim,
        testOutput: test.output,
        failedTests: test.failedTests,
        ...(conflict ? { jev: { questionId: "instruction_conflicts_spec" as const, result: conflict.check } } : {}),
        category,
        ...(fault ? { fault } : {}),
        detectedAt,
      },
    };
  } else if (conflict) {
    trigger = {
      reason: "conflicting_instruction",
      evidence: {
        claim: conflict.text,
        jev: { questionId: "instruction_conflicts_spec", result: conflict.check },
        category: "conflicting_instruction",
        ...(fired.includes("F3") ? { fault: "F3" as const } : {}),
        detectedAt,
      },
    };
  } else if (poison) {
    trigger = {
      reason: "accepted_poison",
      evidence: {
        claim: poison.claim.text,
        ...(test ? { testOutput: test.output, failedTests: test.failedTests } : {}),
        ...(poison.check ? { jev: { questionId: "fact_contradicts_spec" as const, result: poison.check } } : {}),
        category: "spec_misread",
        detectedAt,
      },
    };
  } else if (test && !test.passed) {
    const fails = consecutiveFails([...raw.steps.map((s) => s.claims), claimStrings]);
    if (fails >= ctx.cfg.thresholds.stuck_test_runs) {
      trigger = {
        reason: "stuck",
        evidence: { claim: `${fails} test runs in a row failed on ${fn.name}`, testOutput: test.output, failedTests: test.failedTests, detectedAt },
      };
    }
  }

  // Code written from a reused chunk that now fails its tests -> revoke the chunk, retire or not
  // (an honest failed run is the usual case). Not for injected faults: the chunk did not cause those.
  if (test && !test.passed && !fired.length && am.fileChunks.length) {
    for (const id of am.fileChunks) {
      await workerDeps.revokeChunk(ctx, id, `code derived from it failed ${fn.test}`).catch((e: Error) => ctx.deps.log(`[worker] revokeChunk ${id}: ${e.message}`));
    }
    am.fileChunks = [];
  }

  if (trigger) {
    // Drop unverified code from the shared folder before the next generation starts, whatever the trigger
    // (an earlier step may have written code this step never tested). retire.ts repeats this for the
    // slot's own function in the protocol, so a resumed retire is covered too.
    if (!verified && !ctx.dirtyRespawn) restoreFile(ctx, fn, raw);
    ctx.deps.log(`[worker] ${ref.name} step ${step}: retire trigger ${trigger.reason}`);
    await workerDeps.retireAgent(ctx, ref, trigger.reason, trigger.evidence);
    return finish("retired");
  }

  // A Possess armed while this step was in flight must still fire: keep the loop going one more step.
  if (output.action === "claim_done" && verified && !(ctx.pendingFaults.get(ref.slot)?.length)) {
    // Done when the own function and every function reassigned here have verified code.
    const after = { ...raw, checkpoints: [...raw.checkpoints, { fn: fn.name, code: "", ts: 0 }] };
    const own = fnForSlot(ctx, ref.slot, raw.info?.task).name;
    if (after.checkpoints.some((c) => c.fn === own) && currentFn(ctx, ref, after).fn.name === own) return finish("done");
  }
  return finish(null);
}
