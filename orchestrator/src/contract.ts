// Data contract between the orchestrator (Avneh) and the dashboard + its REST/SSE layer (Amar).
// Types only, no runtime imports, so the dashboard can `import type` this file directly.
// See docs/DATA_CONTRACT.md. Token counts come from API usage fields only (rule 7);
// anything estimated carries an explicit `est: true`.

export type RunId = string; // e.g. "r7k2"
export type LibraryId = string;
export type CaseId = string; // "<runId>.<slot>.g<gen>"
export type Mode = "ours" | "baseline" | "ablation";
export type FaultId = "F1" | "F2" | "F3" | "F4";
/** The task folder id under bench/tasks/ (also task.json "id"). Renamed from "invoice" | "shipping" | "discount". */
export type TaskId = "invoice_parser" | "shipping_rates" | "discount_engine" | (string & {});

export type AgentStatus =
  | "trusted"
  | "probation"
  | "under_investigation"
  | "retiring"
  | "retired"
  | "failed";

export type RunStatus = "starting" | "running" | "recovering" | "finished" | "failed" | "stopped";

export type JevQuestionId =
  | "instruction_conflicts_spec"
  | "fact_contradicts_spec"
  | "note_consistent_with_spec"
  | "failure_category"
  | "lesson_relevant"
  | "subtask_difficulty";

export type FailureCategory =
  | "false_success_claim"
  | "invented_api"
  | "spec_misread"
  | "conflicting_instruction"
  | "other";

/** Who decided a check: Jev, the fallback LLM judge, or ground truth (a real test run). */
export type DecisionSource = "jev" | "fallback" | "tests";

export type LedgerCategory =
  | "worker"
  | "jev"
  | "fallback_judge"
  | "embedding"
  | "lesson_writer"
  | "case_discussion";

/**
 * Token counts copied from API usage fields (rule 7), with OpenAI/OpenRouter semantics
 * (confirmed in docs/SMOKE.md: e.g. 2222 cached of 2256 prompt; 107 reasoning of 299 completion):
 * - `cached` is a SUBSET of `input` (prompt_tokens_details.cached_tokens ⊂ prompt_tokens).
 * - `reasoning` is a SUBSET of `output` (completion_tokens_details.reasoning_tokens ⊂ completion_tokens).
 * Total tokens = input + output. Never add cached or reasoning on top; show them as "of which".
 */
export interface TokenCounts {
  /** prompt_tokens, cached included. */
  input: number;
  /** Part of `input` served from the prompt cache. */
  cached: number;
  /** completion_tokens, reasoning included. */
  output: number;
  /** Part of `output` spent on reasoning (bills as output). */
  reasoning: number;
}
/** TokenCounts plus USD (same subset rules: cached ⊂ input, reasoning ⊂ output). */
export interface TokenSpend extends TokenCounts {
  usd: number;
}

// ---------- Roster / agents ----------

export interface AgentCard {
  slot: number; // 0-based
  name: string; // Relay name, "w<slot>-g<gen>-<runId>"
  gen: number; // 1-based
  status: AgentStatus;
  step: number; // current step within this generation
  subtask: string; // function name the slot owns, e.g. "parse_amount"
  tokens: TokenSpend; // this generation's totals
  possessed: boolean; // a scripted fault is armed or firing on this slot
  verifiedSteps: number; // counts toward probation -> trusted
  lastSummary?: string; // last step summary (<= 40 words)
}

export interface RunSummary {
  runId: RunId;
  taskId: TaskId;
  mode: Mode;
  libraryId: LibraryId;
  status: RunStatus;
  model: string;
  startedAt: number; // epoch ms
  endedAt?: number;
  agents: number;
  retires: number;
  cases: number;
  testsPassing: number; // functions currently passing
  testsTotal: number;
  usd: number;
  /**
   * Failures of a kind that already has a case file in this run, i.e. the same trap failing again
   * in another function/agent after the first hit. Equals `immunity.repeatTrapHits`; kept top level
   * for the header counter. Absent => not known yet (show nothing, never 0).
   */
  repeatFailures?: number;
  /** Herd-immunity counters. Absent => not known yet (show nothing). */
  immunity?: ImmunitySummary;
  mock?: true;
}

/** Herd-immunity counters for one run (same definitions as the benchmark's trap metrics). */
export interface ImmunitySummary {
  /** Trap tests that failed (each trap has a test that fails only when the trap is followed). */
  trapHits: number;
  /** Trap hits on a trap that had already been hit by another function/agent in this run. */
  repeatTrapHits: number;
  /** Case files posted to cases-<runId> with at least one recipient. */
  casesBroadcast: number;
  /** Recipients whose next verified step followed the lesson (trap test passing after receipt). */
  lessonsAdopted: number;
}

// ---------- Case files ----------

export interface JevEvidence {
  questionId: JevQuestionId;
  probability: number; // P(problem), 0..1
  source: DecisionSource;
}

export interface CaseEvidence {
  testOutput?: string; // pytest -q tail
  jev?: JevEvidence;
  fallbackReason?: string; // fallback judge's one-sentence reason
  escalationReason?: string; // why it went to the fallback (e.g. "jev 0.62 in grey zone", "jev offline")
}

/** One reply in a case thread (BUILD_SPEC Herd immunity: max 3 per thread, one per recipient). */
export interface CaseReply {
  from: string; // agent name, e.g. "w0-g1-r7k2"
  slot: number;
  gen: number;
  text: string;
  ts: number;
  /** RelayFeedItem.seq of the same message, so the feed and the case viewer can cross-link. */
  seq: number;
}

export interface DriftPoint {
  step: number;
  score: number;
}

export interface CaseFile {
  id: CaseId;
  runId: RunId;
  libraryId: LibraryId;
  slot: number;
  gen: number;
  agentName: string;
  task: TaskId;
  subtask: string;
  claim: string; // what the agent claimed / said
  evidence: CaseEvidence;
  category: FailureCategory;
  driftTrace?: DriftPoint[];
  lesson: string | null; // null when the writer returned NO_LESSON
  recipients: string[]; // agent names the case was delivered to
  replacement?: string; // name of the gen+1 agent
  /** Replies in the case thread, oldest first. Absent on older payloads; [] = no replies yet. */
  replies?: CaseReply[];
  synthetic: boolean; // seeded cold-start case, shown as such
  revoked: boolean;
  createdAt: number;
}

// ---------- Relay feed ----------

export interface BlockedInfo {
  reason: string;
  questionId: JevQuestionId;
  probability: number;
  source: DecisionSource;
}

export interface RelayMetadata {
  runId: RunId;
  slot?: number;
  gen?: number;
  caseId?: CaseId;
  kind?: "status" | "case" | "case_reply" | "note" | "dm" | "revoke";
  threadId?: string;
  /** Fleet mode: "relay" = went over the Agent Relay server; "in-process" = fleet bus only (routine chatter). */
  transport?: "relay" | "in-process";
}

export interface RelayFeedItem {
  seq: number; // monotonically increasing per orchestrator process + run
  channel: string; // "fleet-<runId>" | "cases-<runId>" | "dm"
  from: string;
  to?: string; // "@handle" for DMs
  text: string;
  ts: number;
  blocked?: BlockedInfo; // present => never delivered; render struck through
  metadata: RelayMetadata;
}

// ---------- Ledger ----------

export interface LedgerTotals {
  runId: RunId;
  worker_usd: number;
  overhead_usd: number; // every category except worker
  by_category: Record<LedgerCategory, TokenSpend & { calls: number }>;
  calls: { jev: number; fallback: number };
  tokens: TokenCounts; // all categories
  /** Output tokens of steps whose verified notes were reused. Always an estimate. */
  reuse_est_tokens: number;
  est: { reuse_est_tokens: true };
  /** Present only when a baseline run exists for the same task. */
  net_savings_usd?: number;
  baselineRunId?: string;
}

// ---------- Jev ----------

export interface JevStatus {
  online: boolean;
  mode: "jev" | "fallback"; // "fallback" => show "Jev offline, using fallback"
  consecutiveFailures: number;
  fallbackUntil?: number; // epoch ms
  lastLatencyMs?: number;
  model: string;
  mock?: true;
}

// ---------- Benchmark (bench/results.json, one row per trial) ----------

export type BenchMode = "codex_baseline" | "ours_cold" | "ours_warm" | "ablation";

export interface BenchmarkResultRow {
  mode: BenchMode;
  model: string;
  task: TaskId;
  trial: number; // 1..3
  sourceId: string; // our runId or Codex session ID
  success: boolean;
  tokens: TokenCounts;
  tokens_per_passing_task: number | null; // null when failed
  usd: number;
  trap_hits: number;
  repeat_trap_hits: number;
  recovery_ms: number | null; // first trap failure -> tests passing again
  finish_ms: number;
  false_retires: number | null; // ours only
  subagents_spawned?: number; // codex only
  killed?: boolean; // hit the 10-min limit
  notes?: string;
  mock?: true;
}

/** Mean and min-max over trials (bench/aggregate). null when no trial had a value. */
export interface BenchSpread {
  mean: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

/** One mode on one task suite version. Only the fields the dashboard reads are typed. */
export interface BenchSummaryGroup {
  group: string; // "<mode>@v<task_version>"
  mode: BenchMode;
  task_version: number;
  label: string;
  trials: number;
  passes: number;
  tasks: string[];
  success_rate: BenchSpread;
  tokens_per_passing_task: BenchSpread;
  /** All tokens (failed trials included) / passing trials: the headline unit. */
  tokens_per_passing_task_pooled: number | null;
  usd_per_passing_task_pooled?: number | null;
}

/**
 * bench/results.summary.json, written by bench/aggregate from results.json. Groups are per
 * mode x task_version: suites are never pooled, and poisoning trials are not in results.json.
 */
export interface BenchmarkSummary {
  generated_at: string;
  mock: boolean;
  rows_used: number;
  note: string;
  groups: BenchSummaryGroup[];
}

// ---------- Swarm (stretch) ----------

export interface SwarmStats {
  agents: number;
  shards: number;
  handled: number;
  lost: number;
  ratePerSec: number;
  measured: boolean; // false => display must say "est."/"sim"
}

// ---------- Recovery ----------

/**
 * Wall-clock (epoch ms) of each recovery stage for one retire. null = that stage did not happen
 * or its time is not known (show nothing, never invent a value).
 */
export interface RecoveryStages {
  /** An injected fault fired (Possess / fault drill). null for organic failures. */
  faultAt: number | null;
  /** The check that caught it: failing test run or a decided Jev/fallback check. */
  detectedAt: number | null;
  /** Fleet.beginRetire succeeded. */
  retireBeganAt: number | null;
  /** CaseLibrary.add done. */
  caseFiledAt: number | null;
  /** gen+1 agent registered and Fleet.completeRetire done. */
  respawnedAt: number | null;
  /** The slot's tests pass again. */
  testsPassingAt: number | null;
}

// ---------- Events (SSE /api/events) ----------

interface EventBase {
  runId: RunId;
  ts: number;
  mock?: true;
}

export type DashboardEvent = EventBase &
  (
    | { type: "roster"; agents: AgentCard[] }
    | { type: "agent.status"; slot: number; gen: number; status: AgentStatus; step: number; reason?: string; agent?: AgentCard; /** Set when an injected fault fires: start the recovery timer here (same value as recovery.stages.faultAt). */ faultAt?: number; fault?: FaultId }
    | { type: "relay.message"; item: RelayFeedItem }
    | { type: "case.created"; case: CaseFile }
    | { type: "ledger.totals"; totals: LedgerTotals }
    | { type: "jev.status"; status: JevStatus }
    | { type: "case.reply"; caseId: CaseId; reply: CaseReply }
    | {
        type: "recovery";
        caseId: CaseId;
        /** testsPassingAt - detectedAt (same definition as BenchmarkResultRow.recovery_ms). */
        ms: number;
        slot?: number;
        stages?: RecoveryStages;
      }
    | { type: "run.status"; run: RunSummary; banner?: string }
    | { type: "swarm.stats"; stats: SwarmStats }
    /** Fleet-scale mode (DECISIONS #16): aggregate stats, ~1/s. Every number measured. */
    | { type: "fleet.stats"; stats: FleetStats }
    /** Fleet-scale mode: one status char per agent, ~1/s. See FleetGridCodeMap. */
    | { type: "fleet.grid"; grid: FleetGrid }
    /** Shared verified reasoning: a test-verified note entered the vector store. */
    | { type: "chunk.created"; chunk: ChunkInfo }
    /** A teammate's prompt received a stored chunk (token savings, est.). */
    | { type: "chunk.reused"; chunkId: string; byAgent: string; reuseEstTokens: number }
    /** Vector cleansing: a chunk proved wrong was revoked; its reusers were DM'd. */
    | { type: "chunk.revoked"; chunkId: string; reason: string; notified: string[] }
    /** Vector cleansing: retired agent's context dropped, replacement starts from verified handoff only. */
    | { type: "context.cleansed"; slot: number; fromGen: number; toGen: number; droppedPromptTokens: number; handoffPromptTokens: number }
  );

export type DashboardEventType = DashboardEvent["type"];

/** An event as stored in the replay buffer / sent over SSE (`id:` = seq). */
export type SequencedEvent = DashboardEvent & { seq: number };

// ---------- Service the REST/SSE layer wraps ----------

// ---------- Fleet-scale mode (1,000-agent demo, DECISIONS #16) ----------

/**
 * Status codes in FleetGrid.cells, one char per agent in slot order (types only; the runtime
 * lookup table is FLEET_GRID_CODES in src/fleet-codes.ts):
 * "." queued, T trusted, P probation, I under_investigation, R retired, F failed,
 * D done (subtask finished, tests passing), X possessed (fault injected, not yet caught).
 */
export interface FleetGridCodeMap {
  ".": "queued";
  T: "trusted";
  P: "probation";
  I: "under_investigation";
  R: "retired";
  F: "failed";
  D: "done";
  X: "possessed";
}
export type FleetGridCode = keyof FleetGridCodeMap;
export type FleetGridStatus = FleetGridCodeMap[FleetGridCode];

export interface FleetGrid {
  agents: number;
  teams: number;
  agentsPerTeam: number;
  /** length === agents; agent i is team floor(i / agentsPerTeam), slot i % agentsPerTeam. */
  cells: string;
}

export interface FleetStats {
  agents: number;
  teams: number;
  elapsedMs: number;
  byStatus: Partial<Record<FleetGridStatus, number>>;
  steps: number;
  subtasksPassing: number;
  teamsPassing: number;
  /** Faults injected by the orchestrator (F1–F4) and how many were caught before spreading. */
  poison: { injected: number; caught: number; spread: number };
  falseClaimsCaught: number;
  messagesBlocked: number;
  poisonedFactsRejected: number;
  trapHits: number;
  repeatTrapHits: number;
  /** Trap-hit rate among the most recent `window` agents to reach their trap function. */
  trapHitRateRecent: { window: number; rate: number | null };
  cases: number;
  lessons: number;
  lessonsDelivered: number;
  retired: number;
  respawned: number;
  tokens: TokenCounts;
  usd: number;
  reuseEstTokens: number; // labelled "est." in UI
  /** Vector cleansing + shared reasoning. */
  chunks: { created: number; reused: number; revoked: number };
  /** Sum over retirements of (retired agent's last prompt tokens − replacement's first prompt tokens), from usage fields. */
  poisonedContextTokensDropped: number;
  /** Caucus: case threads opened and replies posted (≤3 per thread). */
  caucus: { threads: number; replies: number };
  /** Our overhead (Jev, fallback judge, embeddings, lesson writer) as a share of total USD. */
  overheadShare: number | null;
  llmInFlight: number;
  testsInFlight: number;
  /**
   * Fleet poisoning waves. Wave 1 goes through the normal Jev filter (accepted = spread). Wave 2 re-injects
   * the same poison text, unfiltered, into agents of OTHER teams with vs without the caucus lesson in their
   * prompts; accepted = the agent acted on it (relayed it, wrote code that failed, or was retired for it),
   * rejected = it carried on without acting on it, before Jev had to block anything.
   */
  poisonWaves?: FleetPoisonWave[];
  measured: true;
}

export interface FleetPoisonWave {
  wave: number;
  injected: number;
  accepted: number;
  rejected: number;
  pending: number;
  withLesson?: { probed: number; accepted: number; rejected: number };
  withoutLesson?: { probed: number; accepted: number; rejected: number };
}

export interface StartRunOpts {
  taskId: TaskId;
  mode: Mode;
  libraryId?: LibraryId; // omit => fresh (cold) library
  /** Fleet-scale mode: total agents (default 4 = one team). >4 runs agents/4 teams on rotating tasks. */
  agents?: number;
  /** Fleet-scale mode: fraction of agents to poison at start (F1/F3/F4 mix), e.g. 0.05. */
  poisonRate?: number;
  /**
   * Demo pacing: extra wait before every worker step, so the run cannot finish before Possess is
   * pressed. Omit/0 for benchmarks. Mock: accepted and logged, playback speed is unchanged.
   */
  stepDelayMs?: number;
}

export interface ActorSocketGrant {
  kind: "fleet" | "ledger";
  actorId: string; // "run.<runId>" | "ledger.<runId>"
  websocketUrl: string;
  expiresAt?: number;
  mock?: true;
}

export type ActionResult =
  | { ok: true; detail?: string }
  | { ok: false; error: "no_such_run" | "no_such_slot" | "slot_not_active" | "already_possessed" | "run_finished" | "unsupported"; detail?: string };

export interface RuntimeService {
  readonly mock: boolean;
  startRun(opts: StartRunOpts): Promise<RunSummary>;
  listRuns(): Promise<RunSummary[]>;
  getRoster(runId: RunId): Promise<AgentCard[]>;
  /** Accepts a libraryId or a runId (cases created in that run). */
  listCases(scope: { libraryId: LibraryId } | { runId: RunId }): Promise<CaseFile[]>;
  getCase(id: CaseId): Promise<CaseFile | null>;
  getLedger(runId: RunId): Promise<LedgerTotals | null>;
  getRelayFeed(runId: RunId, sinceSeq?: number): Promise<RelayFeedItem[]>;
  /**
   * Demo Possess button: arms F1 then F3 for the slot's next step. Works on any active slot.
   * Mock: the recorded possession sequence is replayed on the chosen slot (still mock:true).
   */
  possess(runId: RunId, slot: number): Promise<ActionResult>;
  injectFault(runId: RunId, slot: number, fault: FaultId): Promise<ActionResult>;
  stopRun(runId: RunId): Promise<ActionResult>;
  getJevStatus(): Promise<JevStatus>;
  getBenchmarkResults(): Promise<BenchmarkResultRow[]>;
  /** bench/results.summary.json; null when it has not been generated. Optional: routes 404 if absent. */
  getBenchmarkSummary?(): Promise<BenchmarkSummary | null>;
  actorSocketGrant(kind: "fleet" | "ledger", runId: RunId): Promise<ActorSocketGrant>;
  /** Live events. Returns unsubscribe. */
  subscribe(cb: (ev: SequencedEvent) => void): () => void;
  /** Buffered events with seq > afterSeq (SSE Last-Event-ID resume). */
  replay(afterSeq: number): SequencedEvent[];
  /**
   * Swarm simulator: starts one run and streams `swarm.stats` events. One run at a time.
   * Real SwarmShard actors when the actor runtime is up, else MOCK shards (stats.measured=false).
   * Optional while the live service is being finished; routes should 501 if absent.
   */
  startSwarm?(opts: { agents: number; agentsPerShard?: number; ticks?: number }): Promise<ActionResult>;
}

/** A shared verified reasoning chunk (only notes behind code that passed tests). */
export interface ChunkInfo {
  id: string;
  runId: RunId;
  sourceAgent: string;
  slot: number;
  gen: number;
  step: number;
  fn: string;
  note: string;
  /** Output tokens of the step that produced it (basis for reuse est.). */
  sourceOutputTokens: number;
  createdAt: number;
}
