// Dashboard view model. Built from the wire contract (orchestrator/src/contract.ts,
// re-exported as @contract/types) by adapt.ts. Panels read these shapes, never the
// wire types. A field with no source in the contract is `null` (or absent), never
// invented; each such field says "no source" below.
import type {
  AgentStatus,
  BenchMode,
  BenchmarkResultRow,
  DecisionSource,
  FleetGridCode,
  JevQuestionId,
  LedgerCategory,
  Mode,
  RunStatus,
} from "@contract/types";

export type { AgentStatus, BenchMode, JevQuestionId, LedgerCategory, Mode, RunStatus };

/** "mock" when the service or any event/row says mock: true (DATA_CONTRACT badge rule). */
export type DataOrigin = "live" | "mock" | "replay";

export interface RunInfo {
  runId: string;
  libraryId: string;
  mode: Mode;
  task: string; // RunSummary.taskId
  /** Coarse status for simple UI: starting/running/recovering -> running; finished/stopped -> done. */
  status: "idle" | "running" | "done" | "failed";
  rawStatus: RunStatus;
  startedAt: number | null;
  endedAt: number | null;
  origin: DataOrigin; // never "replay": the contract has no replay flag yet
  model: string;
  agents: number;
  retires: number;
  cases: number;
  testsPassing: number;
  testsTotal: number;
  usd: number;
  /** Same trap failing again after its first case file. null = not known yet (show nothing, never 0). */
  repeatFailures: number | null;
  /** Herd-immunity counters. null = not known yet (show nothing). */
  immunity: ImmunityView | null;
  /** run.status banner, e.g. "reconnecting" or "reconnected: state restored from actors". */
  banner: string | null;
}

export interface ImmunityView {
  trapHits: number;
  repeatTrapHits: number;
  casesBroadcast: number;
  lessonsAdopted: number;
}

/** Token counts: cachedInput ⊂ input, reasoning ⊂ output. Total = input + output; never add the subsets. */
export interface TokenTotals {
  input: number;
  cachedInput: number; // wire: cached
  output: number;
  reasoning: number;
  usd: number;
}

export interface AgentSlot {
  slot: number; // 0-based, as on the wire
  gen: number;
  name: string;
  status: AgentStatus;
  subtask: string;
  step: number;
  verifiedSteps: number;
  possessed: boolean;
  lastSummary: string; // "" when the wire card has none
  tokens: TokenTotals;
  /** Reason from the last agent.status event, e.g. "Possess armed: F1 then F3". */
  statusReason: string | null;
  persona: string | null; // no source
  maxSteps: number | null; // no source
}

export interface JevResult {
  questionId: JevQuestionId;
  value: boolean | string | null; // true for a block; null when only P(problem) is known
  confidence: number; // P(problem), 0..1 (wire: probability)
  source: DecisionSource;
  latencyMs: number | null; // no source per check
  reason?: string;
}

export interface RelayMessage {
  id: string; // `${runId}:${seq}`
  seq: number;
  ts: number;
  channel: "fleet" | "cases" | "dm";
  channelName: string; // raw wire channel, e.g. "fleet-r7k2"
  from: string;
  to?: string;
  text: string;
  meta: { runId: string; slot: number | null; gen: number | null; caseId?: string; threadId?: string };
  blocked?: { reason: string; check: JevResult };
  kind?: "status" | "case" | "case_reply" | "note" | "dm" | "revocation";
}

/** Human-readable category ("false success claim"); wire uses snake_case. */
export type FailureCategory =
  | "false success claim"
  | "invented API"
  | "spec misread"
  | "conflicting instruction"
  | "other";

export interface CaseSummary {
  id: string;
  createdAt: number;
  agentName: string;
  slot: number;
  gen: number;
  category: FailureCategory;
  lesson: string | null; // null = the lesson writer said NO_LESSON
  revoked: boolean;
  synthetic: boolean;
  /** Bumped when a reply for this case arrives (case.reply event), so cached case views refresh. */
  updatedAt: number;
}

export interface CaseRecipient {
  agentName: string;
  similarity: number | null; // no source
  reply?: string; // this recipient's reply (CaseFile.replies, or its case_reply relay message on older payloads)
  avoidedTrap?: boolean; // no source
}

export interface CaseFile extends CaseSummary {
  runId: string;
  libraryId: string;
  task: string;
  subtask: string;
  claim: string;
  evidence: {
    testOutput?: string;
    jev?: JevResult;
    fallbackReason?: string;
    escalation?: string; // wire: escalationReason
  };
  driftTrace?: { step: number; score: number }[];
  recipients: CaseRecipient[];
  /** Replies in the case thread, oldest first. null = the payload has none (older / restarted live); [] = none yet. */
  replies: CaseReply[] | null;
  replacement: string | null;
}

export interface CaseReply {
  from: string;
  slot: number;
  gen: number;
  text: string;
  ts: number;
  seq: number; // RelayFeedItem.seq of the same message
}

export interface LedgerCategoryTotals {
  calls: number;
  usd: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export interface LedgerTotals {
  workerUsd: number;
  overheadUsd: number;
  byCategory: Record<LedgerCategory, LedgerCategoryTotals>;
  tokens: Omit<TokenTotals, "usd">;
  reuseTokensEst: number; // label "est."
  reuseUsdEst: number | null; // no source (no price in the contract)
  jevCalls: number;
  fallbackCalls: number;
  baselineUsd: number | null; // no source (only baselineRunId)
  baselineRunId: string | null;
  netSavingsUsd: number | null; // null until a baseline run exists: show "appears after a baseline run"
}

/**
 * One per retire, keyed by the contract's case id (<runId>.<slot>.g<gen>), so the row exists
 * from the first failure, before case.created arrives.
 * Stage times: the `recovery` event's `stages` win when present (authoritative). Otherwise a
 * stage is what the event stream showed: detectedAt = first under_investigation, retireBeganAt =
 * first retiring, caseFiledAt = case.created, respawnedAt = gen + 1 first seen. faultAt comes only
 * from the server (null for organic failures or when unknown). Anything not observed stays null;
 * after a gap or a live restart some stages may be missing.
 */
export interface Recovery {
  caseId: string;
  slot: number;
  gen: number; // the failing generation
  /** Timer start: faultAt ?? detectedAt. */
  startAt: number | null;
  faultAt: number | null;
  detectedAt: number | null;
  retireBeganAt: number | null;
  retiredAt: number | null; // status "retired"/"failed" seen (event stream only)
  caseFiledAt: number | null;
  respawnedAt: number | null;
  trustedAt: number | null; // gen + 1 reached trusted (event stream only)
  testsPassAt: number | null; // stages.testsPassingAt, else when the recovery event arrived
  ms: number | null; // server: testsPassingAt − detectedAt
  /** true once a recovery event with stages arrived. */
  stagesFromServer: boolean;
  caseFiled: boolean;
  replacement: string | null;
}

export interface Metrics {
  repeatFailures: number | null; // RunSummary.repeatFailures ?? immunity.repeatTrapHits; null = unknown
  trapHits: number | null; // RunSummary.immunity.trapHits
  casesBroadcast: number | null; // RunSummary.immunity.casesBroadcast
  lessonsAdopted: number | null; // RunSummary.immunity.lessonsAdopted
  chunksShared: number | null; // no source
  chunksReused: number | null; // no source
  retires: number | null; // RunSummary.retires
  cases: number | null; // RunSummary.cases
}

export interface JevView {
  online: boolean;
  mode: "jev" | "fallback";
  consecutiveFailures: number;
  fallbackUntil: number | null;
  lastLatencyMs: number | null;
  model: string;
}

export interface Health {
  jevOffline: boolean; // jev.mode === "fallback": show "Jev offline, using fallback"
  jev: JevView | null;
  actorsConnected: boolean | null; // no source
  relayConnected: boolean | null; // no source
}

export interface SwarmState {
  running: boolean | null; // no source
  agents: number;
  shards: number;
  stateChanges: number; // wire: handled
  lost: number;
  ratePerSec: number;
  measured: boolean;
  origin: DataOrigin; // "mock" when measured === false (authoritative "sim" signal)
  startedAt: number | null; // no source
  updatedAt: number;
}

export interface Snapshot {
  run: RunInfo | null; // the current run (latest started)
  runs: RunInfo[];
  roster: AgentSlot[];
  ledger: LedgerTotals | null;
  cases: CaseSummary[];
  relay: RelayMessage[]; // last 200
  recoveries: Recovery[];
  metrics: Metrics;
  health: Health;
  swarm: SwarmState | null;
  /** Fleet-scale mode (fleet.grid, ~1/s). null until the first grid of the current run. */
  fleetGrid: FleetGridView | null;
  /** Fleet-scale mode (fleet.stats, ~1/s): current counters plus a short history for sparklines. */
  fleetStats: FleetStatsState;
  /** Shared verified reasoning (chunk.created / chunk.reused / chunk.revoked). */
  chunks: ChunksState;
  /** Vector cleansing (context.cleansed). */
  cleansing: CleansingState;
  /** MOCK badge: the service is mock or anything arrived flagged mock. */
  origin: DataOrigin;
}

// ---------------------------------------------------------------- fleet-scale mode

/**
 * One char per agent in FleetGridView.cells (wire FLEET_GRID_CODES): "." queued, T trusted,
 * P probation, I under investigation, R retired, F failed, D done, X possessed.
 */
export type FleetCellCode = FleetGridCode;

/**
 * Latest fleet.grid. Cheap by design: `cells` is the raw string (one char per agent, no
 * per-agent objects); `counts` is computed once per tick. Agent i is team
 * floor(i / agentsPerTeam), member i % agentsPerTeam. A new object only when a grid arrives.
 */
export interface FleetGridView {
  runId: string;
  seq: number;
  ts: number;
  agents: number;
  teams: number;
  agentsPerTeam: number;
  cells: string;
  /** The previous tick's cells (same run), for diffing / animating changed dots. null on the first tick. */
  prevCells: string | null;
  /** How many cells differ from prevCells (length changes count as changed). */
  changed: number;
  /** Agents per code in `cells`; every code present, 0 when absent. */
  counts: Record<FleetCellCode, number>;
}

/** fleet.stats as the UI reads it. Same numbers as the wire; tokens renamed like everywhere else. */
export interface FleetStatsView {
  runId: string;
  seq: number;
  ts: number;
  agents: number;
  teams: number;
  elapsedMs: number;
  byStatus: Partial<Record<"queued" | "trusted" | "probation" | "under_investigation" | "retired" | "failed" | "done" | "possessed", number>>;
  steps: number;
  subtasksPassing: number;
  teamsPassing: number;
  poison: { injected: number; caught: number; spread: number };
  falseClaimsCaught: number;
  messagesBlocked: number;
  poisonedFactsRejected: number;
  trapHits: number;
  repeatTrapHits: number;
  trapHitRateRecent: { window: number; rate: number | null };
  cases: number;
  lessons: number;
  lessonsDelivered: number;
  retired: number;
  respawned: number;
  tokens: { input: number; cachedInput: number; output: number; reasoning: number }; // cachedInput ⊂ input, reasoning ⊂ output
  usd: number;
  reuseEstTokens: number; // label "est."
  chunks: { created: number; reused: number; revoked: number };
  poisonedContextTokensDropped: number;
  caucus: { threads: number; replies: number };
  overheadShare: number | null; // 0..1; null = unknown
  llmInFlight: number;
  testsInFlight: number;
  measured: true;
  /** Which numbers are estimates: label them "est.". */
  est: { reuseEstTokens: true };
}

/** One sparkline sample per fleet.stats tick. */
export interface FleetStatPoint {
  ts: number;
  elapsedMs: number;
  trapHitRate: number | null; // trapHitRateRecent.rate
  trapHits: number;
  poisonCaught: number;
  poisonSpread: number;
  falseClaimsCaught: number;
  messagesBlocked: number;
  cases: number;
  lessonsDelivered: number;
  chunksReused: number;
  poisonedContextTokensDropped: number;
  reuseEstTokens: number; // est.
  usd: number;
}

export interface FleetStatsState {
  current: FleetStatsView | null;
  /** Oldest first, at most FLEET_HISTORY_CAP (120) points; replaced (not mutated) on every tick. */
  history: FleetStatPoint[];
}

export interface ChunkView {
  id: string;
  runId: string;
  sourceAgent: string;
  slot: number;
  gen: number;
  step: number;
  fn: string;
  note: string;
  sourceOutputTokens: number;
  createdAt: number;
  /** Agents whose prompt received this chunk, in arrival order. */
  reusedBy: string[];
  /** Sum of chunk.reused reuseEstTokens for this chunk (est.). */
  reuseEstTokens: number;
  revoked: { reason: string; notified: string[]; ts: number } | null;
}

export interface ChunksState {
  /** Newest last, at most CHUNKS_CAP (200). */
  recent: ChunkView[];
  /**
   * Counted from chunk.* events seen by this client (since connect / run start). After a
   * reconnect gap they can undercount: for headline numbers prefer fleetStats.current.chunks.
   */
  totals: { created: number; reused: number; revoked: number; reuseEstTokens: number };
}

export interface CleansingEvent {
  id: string; // `${runId}:${seq}`
  seq: number;
  ts: number;
  runId: string;
  slot: number;
  fromGen: number;
  toGen: number;
  droppedPromptTokens: number;
  handoffPromptTokens: number;
}

export interface CleansingState {
  /** Newest last, at most CLEANSING_CAP (100). */
  recent: CleansingEvent[];
  count: number; // events seen (same caveat as ChunksState.totals)
  totalDroppedTokens: number; // Σ droppedPromptTokens seen
  totalHandoffTokens: number; // Σ handoffPromptTokens seen. Headline "poisoned context dropped" = fleetStats.current.poisonedContextTokensDropped (Σ dropped − handoff)
}

export interface BenchRow {
  mode: BenchMode;
  model: string;
  task: string;
  trial: number;
  success: boolean;
  tokensTotal: number; // input + output (cached ⊂ input, reasoning ⊂ output)
  tokens: { input: number; cachedInput: number; output: number; reasoning: number };
  tokensPerPassingTask: number | null;
  usd: number;
  trapHits: number;
  repeatTrapHits: number;
  recoverySec: number | null;
  finishMin: number; // wire finish_ms / 60000
  falseRetires: number | null;
  subagentsSpawned: number | null;
  killed: boolean;
  notes: string | null;
  sourceId: string;
  mock: boolean;
}

export interface BenchResults {
  generatedAt: number | null; // no source
  origin: DataOrigin; // "mock" when any row has mock: true
  rows: BenchRow[]; // adapted, old-compatible field names
  raw: BenchmarkResultRow[]; // GET /api/bench as served
}

/**
 * Headline comparison on ONE task suite (GET /api/bench/summary): ours_cold vs codex_baseline with the
 * same task_version. Suites are never pooled and poisoning trials are not in the summary. The suite
 * shown is the one with the most trials on both sides (ties: the newer suite).
 */
export interface BenchHeadline {
  taskVersion: number;
  suite: string; // "tasks v2"
  ratio: number; // baseline tokens per passing task / ours (> 1 = we use fewer)
  oursTokensPerPass: number;
  baseTokensPerPass: number;
  oursTrials: number;
  oursPasses: number;
  baseTrials: number;
  basePasses: number;
  oursSuccess: number | null; // 0..1
  baseSuccess: number | null;
  tasks: string[];
  origin: DataOrigin;
}
