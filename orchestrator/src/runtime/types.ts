// Internal module interfaces for the real runtime (orchestrator/src/runtime/**).
// Types only. Every runtime module receives a RunContext and NEVER imports ../config.ts as a value
// (config.ts reads env at import time); take config from ctx.cfg so unit tests can build a ctx.
//
// Ownership (one implementer per file, call only the functions listed in each JSDoc):
//   worker.ts + prompt.ts + faults.ts  | retire.ts | herd.ts + reasoning.ts | service.ts + runs.ts + main.ts
import type { Caps, Config, JevQuestionId } from "../config.ts";
import type { CaseId, DriftPoint, FailureCategory, FaultId, LibraryId, Mode, RecoveryStages, RunId, TaskId } from "../contract.ts";
import type { runActors } from "../actors.ts";
import type { Embedder } from "../embeddings.ts";
import type { EventBus } from "../events.ts";
import type { Jev, NoulCheck } from "../jev.ts";
import type { LedgerWriter } from "../ledger.ts";
import type { Llm } from "../llm.ts";
import type { LedgerDraft } from "../ledger-entry.ts";
import type { RelayBus } from "../relay/bus.ts";
import type { RunTestsResult } from "../testrunner.ts";

// ---------- Task (bench/tasks/<id>/) ----------

/** One function of a task (task.json "functions"). */
export interface TaskFn {
  name: string;
  /** Relative to the work dir, e.g. "parse_line.py". */
  file: string;
  /** Relative to the work dir, e.g. "tests/test_parse_line.py". */
  test: string;
  /** Short description; embedded for chunk retrieval and case relevance. */
  subgoal: string;
}

export interface TaskTrap {
  id: string;
  description: string;
  /** pytest node id of the test that fails only when the trap is followed. */
  trap_test: string;
}

/** One row of faults.json "schedule" (fault drill only; the demo uses Possess). */
export interface FaultScheduleEntry {
  slot: number;
  fault: FaultId;
  step: number;
  /** Generation the entry fires on (default 1): a respawned generation restarts its step count, so without
   * this the replacement would hit the same scheduled fault again. */
  gen?: number;
  payload?: string;
}

/** Parsed task.json plus the spec text, loaded once per run by RunManager. */
export interface TaskDef {
  id: TaskId;
  /** Absolute path of bench/tasks/<id>. */
  dir: string;
  /** Spec file name from task.json ("SPEC.md"). */
  spec: string;
  /** Full spec text: prompt part 2 and the Jev spec_excerpt source. */
  specText: string;
  functions: TaskFn[];
  traps: TaskTrap[];
  /** faults.json schedule; empty unless the run is a fault drill. */
  faults: FaultScheduleEntry[];
}

// ---------- Dependencies and context ----------

/** Adapters, created once per process (llm.ts getLlm, jev.ts getJev, embeddings.ts getEmbedder). */
export interface RuntimeDeps {
  llm: Llm;
  jev: Jev;
  embedder: Embedder;
  /** Log sink; mocks must prefix lines with [MOCK] (rule 6). */
  log: (line: string) => void;
  /** Which adapters are labeled mocks (no key / engine down). */
  mock: { llm: boolean; jev: boolean; embed: boolean; relay: boolean };
}

/** Typed actor handles for one run (actors.ts runActors). Wrap calls in withRetry. */
export type RunActors = ReturnType<typeof runActors>;

/**
 * Everything a runtime module needs for one run. Built by RunManager.startRun / reconcile.
 * The orchestrator is stateless (rule 3): the Maps below are caches/in-flight handles only and
 * must be rebuildable from actors after a restart (RunManager.reconcile).
 */
export interface RunContext {
  runId: RunId;
  libraryId: LibraryId;
  taskId: TaskId;
  mode: Mode;
  task: TaskDef;
  cfg: Config;
  /** Same object as cfg.caps (verify.ts reads ctx.caps). */
  caps: Caps;
  /** Shared work folder of the run: a copy of starter/ + tests/ (testrunner copies it per test run). */
  workDir: string;
  /** Model the workers use (cfg.models.worker after MODEL_PROFILE). */
  model: string;
  bus: EventBus;
  relay: RelayBus;
  actors: RunActors;
  ledger: LedgerWriter;
  deps: RuntimeDeps;
  /** Extra wait before every worker step (StartRunOpts.stepDelayMs; 0 for benchmarks). */
  stepDelayMs: number;
  /** Shared reasoning on (false in mode "ablation" and "baseline"). */
  sharedReasoning: boolean;
  /** Herd immunity / lessons on (false in mode "baseline"). */
  herd: boolean;
  /**
   * Opt-in A/B baseline (bench/ab), default off: "dirty" respawn. The replacement inherits the retired
   * generation's full step log, its failing test output and its unverified code (the file is not restored),
   * like an orchestrator that corrects an agent in the same context. Off = the normal clean handoff.
   */
  dirtyRespawn?: boolean;
  /** In-flight LLM call per slot; retire step 2 aborts it. */
  abort: Map<number, AbortController>;
  /** Faults armed per slot, fired in order on that slot's next step(s) (faults.ts). */
  pendingFaults: Map<number, FaultId[]>;
  /** Recovery stage times per slot for the current retire (published on the "recovery" event). */
  recovery: Map<number, RecoveryStages>;
  /** Facts rejected by fact_contradicts_spec (lower-cased); "accepted_poison" trigger. */
  rejectedFacts: Set<string>;
  /** Relay inbox cursor (BusMessage.seq) per agent name. */
  inboxCursor: Map<string, number>;
  /** Run is stopping (stopRun / USD cap): loops exit with 'aborted' at the next check. */
  stopping: boolean;
  /** Fleet lessons block (prompt part 3), oldest first, at most caps.max_lessons. Rebuilt from CaseLibrary on reconcile. */
  lessons(): string[];
  /** Replace the lessons block by reassignment (herd.ts broadcastCase appends; oldest dropped first). */
  setLessons(next: string[]): void;
  /**
   * Starts a new worker loop for a slot whose loop already ended "done" (set by RunManager; retire.ts calls
   * it after reassigning a failed slot's function to that slot). Absent in unit tests.
   */
  restartSlot?: (slot: number, gen: number) => void;
}

// ---------- Agents and steps ----------

/** One generation of one slot. name = relayNames.agent(runId, slot, gen) = "w<slot>-g<gen>-<runId>". */
export interface AgentRef {
  slot: number;
  gen: number;
  name: string;
}

export type ClaimKind = "tests_pass" | "spec_fact" | "instruction";
export interface Claim {
  kind: ClaimKind;
  text: string;
}

/** Parsed worker step output (llm.ts WORKER_STEP_SCHEMA; foreign action fields already nulled). */
export interface WorkerStep {
  action: "write_code" | "run_tests" | "message" | "claim_done";
  file: string | null;
  code: string | null;
  message: { to: string; text: string } | null;
  claims: Claim[];
  approach_note: string;
  summary: string;
}

/** What happened in one step, in memory (the Agent actor stores only summary + claims). */
export interface StepRecord {
  ref: AgentRef;
  step: number;
  /** The fn this step worked on (the slot's subtask). */
  fn: TaskFn;
  output: WorkerStep;
  /** Faults that fired on this step (faults.ts). */
  injected: FaultId[];
  /** Present when the step ran tests (run_tests, or a tests_pass claim checked by verify.runFnTests). */
  test?: RunTestsResult;
  /** Code passed its tests on this step. */
  verified: boolean;
  /** Chunk ids that were in this step's prompt (reasoning.retrieveChunks). */
  reusedChunkIds: string[];
  /** Every ledger draft of this step (worker call + checks), already recorded. */
  usage: LedgerDraft[];
  startedAt: number;
  endedAt: number;
}

export type RetireReason = "false_claim" | "conflicting_instruction" | "accepted_poison" | "stuck" | "drift";

/** Why an agent is being retired; retire.ts turns it into contract CaseEvidence. */
export interface Evidence {
  /** What the agent claimed or said (CaseFile.claim). */
  claim: string;
  /** pytest -q tail (false_claim, stuck, accepted_poison). */
  testOutput?: string;
  failedTests?: string[];
  /** The decided Jev/fallback check (conflicting_instruction, accepted_poison, drift). */
  jev?: { questionId: JevQuestionId; result: NoulCheck };
  /** Hint when the category is obvious (F1 => false_success_claim); else failure_category decides. */
  category?: FailureCategory;
  driftTrace?: DriftPoint[];
  /** Injected fault that caused it, if any. */
  fault?: FaultId;
  /** Epoch ms of the check that caught it (RecoveryStages.detectedAt). */
  detectedAt: number;
}

export type LoopOutcome = "done" | "retired" | "failed" | "capped" | "aborted";

/** Handoff to generation + 1 (retire protocol step 6). Nothing unverified carries over. */
export interface Handoff {
  fromGen: number;
  /** `stale` set when the checkpoint's tests fail against the shared folder at handoff time (retire.buildHandoff). */
  checkpoints: { fn: string; code: string; stale?: string }[];
  /** Remaining subtask, e.g. "make tests/test_parse_line.py pass". */
  remaining: string;
  lesson: string | null;
  caseId: CaseId;
}

/** Agent state the prompt needs, read from the Agent actor (Agent.state / handoff). */
export interface PromptAgentState {
  ref: AgentRef;
  subtask: TaskFn;
  persona: string;
  /** Respawned agents only. */
  handoff: Handoff | null;
  /** Last 4 steps, oldest first (prompt part 7). */
  recentSteps: { step: number; summary: string }[];
  /** Agent is on probation (notes are not shared; messages still Jev-checked). */
  probation: boolean;
}

/** A verified teammate chunk retrieved for the prompt (prompt part 5). */
export interface RetrievedChunk {
  chunkId: string;
  sourceAgent: string;
  fn: string | null;
  text: string;
  similarity: number;
  /** Output tokens of the producing step (ledger reuse estimate; labeled est.). */
  estTokens: number;
}

/** One inbox message after Jev checks, ready for prompt part 8. */
export interface InboxItem {
  seq: number;
  from: string;
  channel: string;
  kind: "case" | "case_reply" | "note" | "dm" | "status" | "fact";
  caseId?: CaseId;
  /** Raw text (never placed in instructions). */
  text: string;
  /** Quoted-data wrapping that goes in the prompt, e.g. `<message from="w1-g1-r7k2">"..."</message>`. */
  wrapped: string;
  /** Injected by faults.ts (F4); still Jev-checked like any other fact. */
  injected?: FaultId;
}

/** Extra prompt inputs gathered in step 1 of the loop. */
export interface PromptExtras {
  notes: RetrievedChunk[];
  inbox: InboxItem[];
  /** Tail of the last test run, if the previous step ran tests. */
  lastTestOutput?: string;
}
