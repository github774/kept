// Wire (orchestrator/src/contract.ts) -> view model (model.ts). Pure functions.
import type * as W from "@contract/types";
import type {
  AgentSlot,
  BenchHeadline,
  BenchResults,
  BenchRow,
  CaseFile,
  CaseReply,
  CaseSummary,
  DataOrigin,
  FailureCategory,
  JevResult,
  JevView,
  LedgerTotals,
  RelayMessage,
  RunInfo,
  SwarmState,
} from "./model";

const CATEGORY: Record<W.FailureCategory, FailureCategory> = {
  false_success_claim: "false success claim",
  invented_api: "invented API",
  spec_misread: "spec misread",
  conflicting_instruction: "conflicting instruction",
  other: "other",
};

export function toRunStatus(s: W.RunStatus): RunInfo["status"] {
  if (s === "finished" || s === "stopped") return "done";
  if (s === "failed") return "failed";
  return "running";
}

export function toRun(r: W.RunSummary, origin: DataOrigin, banner: string | null = null): RunInfo {
  return {
    runId: r.runId,
    libraryId: r.libraryId,
    mode: r.mode,
    task: r.taskId,
    status: toRunStatus(r.status),
    rawStatus: r.status,
    startedAt: r.startedAt ?? null,
    endedAt: r.endedAt ?? null,
    origin: r.mock ? "mock" : origin,
    model: r.model,
    agents: r.agents,
    retires: r.retires,
    cases: r.cases,
    testsPassing: r.testsPassing,
    testsTotal: r.testsTotal,
    usd: r.usd,
    repeatFailures: r.repeatFailures ?? r.immunity?.repeatTrapHits ?? null,
    immunity: r.immunity
      ? { trapHits: r.immunity.trapHits, repeatTrapHits: r.immunity.repeatTrapHits, casesBroadcast: r.immunity.casesBroadcast, lessonsAdopted: r.immunity.lessonsAdopted }
      : null,
    banner,
  };
}

export function toAgent(a: W.AgentCard, statusReason: string | null = null): AgentSlot {
  return {
    slot: a.slot,
    gen: a.gen,
    name: a.name,
    status: a.status,
    subtask: a.subtask,
    step: a.step,
    verifiedSteps: a.verifiedSteps,
    possessed: a.possessed,
    lastSummary: a.lastSummary ?? "",
    tokens: { input: a.tokens.input, cachedInput: a.tokens.cached, output: a.tokens.output, reasoning: a.tokens.reasoning, usd: a.tokens.usd },
    statusReason,
    persona: null,
    maxSteps: null,
  };
}

function jevFromBlocked(b: W.BlockedInfo): JevResult {
  return { questionId: b.questionId, value: true, confidence: b.probability, source: b.source, latencyMs: null };
}
function jevFromEvidence(e: W.JevEvidence, reason?: string): JevResult {
  const r: JevResult = { questionId: e.questionId, value: null, confidence: e.probability, source: e.source, latencyMs: null };
  if (reason) r.reason = reason;
  return r;
}

function channelOf(name: string): RelayMessage["channel"] {
  if (name.startsWith("cases")) return "cases";
  if (name.startsWith("fleet")) return "fleet";
  return "dm";
}

export function toRelay(m: W.RelayFeedItem): RelayMessage {
  const md = m.metadata;
  const meta: RelayMessage["meta"] = { runId: md.runId, slot: md.slot ?? null, gen: md.gen ?? null };
  if (md.caseId) meta.caseId = md.caseId;
  if (md.threadId) meta.threadId = md.threadId;
  const out: RelayMessage = {
    id: `${md.runId}:${m.seq}`,
    seq: m.seq,
    ts: m.ts,
    channel: channelOf(m.channel),
    channelName: m.channel,
    from: m.from,
    text: m.text,
    meta,
  };
  if (m.to) out.to = m.to;
  if (md.kind) out.kind = md.kind === "revoke" ? "revocation" : md.kind;
  if (m.blocked) out.blocked = { reason: m.blocked.reason, check: jevFromBlocked(m.blocked) };
  return out;
}

export function toCaseSummary(c: CaseFile): CaseSummary {
  return {
    id: c.id,
    createdAt: c.createdAt,
    agentName: c.agentName,
    slot: c.slot,
    gen: c.gen,
    category: c.category,
    lesson: c.lesson,
    revoked: c.revoked,
    synthetic: c.synthetic,
    updatedAt: c.updatedAt,
  };
}

export function toCaseReply(r: W.CaseReply): CaseReply {
  return { from: r.from, slot: r.slot, gen: r.gen, text: r.text, ts: r.ts, seq: r.seq };
}

/**
 * `relayReplies` (agentName -> text of its case_reply relay message) is only used when the
 * payload has no `replies` (older or restarted-live payloads).
 */
export function toCaseFile(c: W.CaseFile, relayReplies: Map<string, string> = new Map()): CaseFile {
  const replies = c.replies ? c.replies.map(toCaseReply) : null;
  const replyOf = (name: string) => (replies ? replies.find((r) => r.from === name)?.text : relayReplies.get(name));
  const evidence: CaseFile["evidence"] = {};
  if (c.evidence.testOutput) evidence.testOutput = c.evidence.testOutput;
  if (c.evidence.jev) evidence.jev = jevFromEvidence(c.evidence.jev, c.evidence.fallbackReason);
  if (c.evidence.fallbackReason) evidence.fallbackReason = c.evidence.fallbackReason;
  if (c.evidence.escalationReason) evidence.escalation = c.evidence.escalationReason;
  const out: CaseFile = {
    id: c.id,
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
    agentName: c.agentName,
    slot: c.slot,
    gen: c.gen,
    category: CATEGORY[c.category] ?? "other",
    lesson: c.lesson,
    revoked: c.revoked,
    synthetic: c.synthetic,
    runId: c.runId,
    libraryId: c.libraryId,
    task: c.task,
    subtask: c.subtask,
    claim: c.claim,
    evidence,
    recipients: c.recipients.map((agentName) => {
      const r: CaseFile["recipients"][number] = { agentName, similarity: null };
      const reply = replyOf(agentName);
      if (reply) r.reply = reply;
      return r;
    }),
    replies,
    replacement: c.replacement ?? null,
  };
  if (c.driftTrace) out.driftTrace = c.driftTrace;
  return out;
}

const cat = (c: W.TokenSpend & { calls: number }) => ({
  calls: c.calls,
  usd: c.usd,
  input: c.input,
  cachedInput: c.cached,
  output: c.output,
  reasoning: c.reasoning,
});

export function toLedger(t: W.LedgerTotals): LedgerTotals {
  const b = t.by_category;
  return {
    workerUsd: t.worker_usd,
    overheadUsd: t.overhead_usd,
    byCategory: {
      worker: cat(b.worker),
      jev: cat(b.jev),
      fallback_judge: cat(b.fallback_judge),
      embedding: cat(b.embedding),
      lesson_writer: cat(b.lesson_writer),
      case_discussion: cat(b.case_discussion),
    },
    tokens: { input: t.tokens.input, cachedInput: t.tokens.cached, output: t.tokens.output, reasoning: t.tokens.reasoning },
    reuseTokensEst: t.reuse_est_tokens,
    reuseUsdEst: null,
    jevCalls: t.calls.jev,
    fallbackCalls: t.calls.fallback,
    baselineUsd: null,
    baselineRunId: t.baselineRunId ?? null,
    netSavingsUsd: typeof t.net_savings_usd === "number" ? t.net_savings_usd : null,
  };
}

export function toJev(s: W.JevStatus): JevView {
  return {
    online: s.online,
    mode: s.mode,
    consecutiveFailures: s.consecutiveFailures,
    fallbackUntil: s.fallbackUntil ?? null,
    lastLatencyMs: s.lastLatencyMs ?? null,
    model: s.model,
  };
}

export function toSwarm(s: W.SwarmStats, ts: number): SwarmState {
  return {
    running: null,
    agents: s.agents,
    shards: s.shards,
    stateChanges: s.handled,
    lost: s.lost,
    ratePerSec: s.ratePerSec,
    measured: s.measured,
    origin: s.measured ? "live" : "mock",
    startedAt: null,
    updatedAt: ts,
  };
}

export function toBenchRow(r: W.BenchmarkResultRow): BenchRow {
  return {
    mode: r.mode,
    model: r.model,
    task: r.task,
    trial: r.trial,
    success: r.success,
    tokensTotal: r.tokens.input + r.tokens.output,
    tokens: { input: r.tokens.input, cachedInput: r.tokens.cached, output: r.tokens.output, reasoning: r.tokens.reasoning },
    tokensPerPassingTask: r.tokens_per_passing_task,
    usd: r.usd,
    trapHits: r.trap_hits,
    repeatTrapHits: r.repeat_trap_hits,
    recoverySec: r.recovery_ms === null ? null : r.recovery_ms / 1000,
    finishMin: r.finish_ms / 60000,
    falseRetires: r.false_retires,
    subagentsSpawned: r.subagents_spawned ?? null,
    killed: r.killed ?? false,
    notes: r.notes ?? null,
    sourceId: r.sourceId,
    mock: r.mock === true,
  };
}

export function toBench(rows: W.BenchmarkResultRow[]): BenchResults {
  return {
    generatedAt: null,
    origin: rows.some((r) => r.mock) ? "mock" : "live",
    rows: rows.map(toBenchRow),
    raw: rows,
  };
}

/** Picks the suite for the benchmark headline from bench/results.summary.json (see BenchHeadline). */
export function toBenchHeadline(s: W.BenchmarkSummary | null): BenchHeadline | null {
  if (!s || !Array.isArray(s.groups)) return null;
  let best: BenchHeadline | null = null;
  for (const ours of s.groups) {
    if (ours.mode !== "ours_cold") continue;
    const base = s.groups.find((g) => g.mode === "codex_baseline" && g.task_version === ours.task_version);
    const o = ours.tokens_per_passing_task_pooled;
    const b = base?.tokens_per_passing_task_pooled;
    if (!base || !o || !b || o <= 0 || ours.passes === 0 || base.passes === 0) continue;
    const h: BenchHeadline = {
      taskVersion: ours.task_version,
      suite: `tasks v${ours.task_version}`,
      ratio: b / o,
      oursTokensPerPass: o,
      baseTokensPerPass: b,
      oursTrials: ours.trials,
      oursPasses: ours.passes,
      baseTrials: base.trials,
      basePasses: base.passes,
      oursSuccess: ours.success_rate?.mean ?? null,
      baseSuccess: base.success_rate?.mean ?? null,
      tasks: ours.tasks ?? [],
      origin: s.mock ? "mock" : "live",
    };
    const n = Math.min(h.oursTrials, h.baseTrials);
    const bestN = best ? Math.min(best.oursTrials, best.baseTrials) : -1;
    if (n > bestN || (n === bestN && best && h.taskVersion > best.taskVersion)) best = h;
  }
  return best;
}
