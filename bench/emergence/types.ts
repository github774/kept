// Row and state shapes for the emergence experiment (bench/emergence). See README.md for definitions.
// Every measured field is nullable: null means "not measured", never 0 and never an estimate.
import type { TokenCounts } from "../../orchestrator/src/contract.ts";

export type Arm = "shared" | "control";

export const ROW_SCHEMA = "emergence.agent.v1" as const;

/** One row per subagent (one slot of one run). Written to results.jsonl, 4 rows per run, appended together. */
export interface AgentRow {
  schema: typeof ROW_SCHEMA;
  experiment: string;
  arm: Arm;
  /** "<arm>:<armRunIndex 4 digits>"; resume skips run keys already present. */
  run_key: string;
  arm_run_index: number;
  /** Launch order of this agent within its arm: arm_run_index * agents_per_run + slot. Windows use this. */
  arm_agent_index: number;
  /** Order in which the run was launched across both arms (1-based, across sessions). */
  launch_seq: number;
  wave: number;
  run_id: string;
  library_id: string | null;
  task: string;
  model: string;
  slot: number;
  /** Function (subtask) the slot owns, from the service roster. null if the roster did not say. */
  function: string | null;
  launched_at: number;
  ended_at: number;
  run_status: string;
  run_wall_ms: number;
  killed: boolean;
  capped_usd: boolean;
  stopped_by_budget: boolean;
  crash: string | null;

  generations: number | null;
  retired: boolean | null;
  retire_cases: number | null;

  /** Trap ids whose trap test lives in this agent's function test file. */
  trap_ids: string[];
  exposed: boolean;
  /** Trap followed in the final ground-truth snapshot (trap test fails on an assertion, a sibling test passes). */
  trap_hit_final: boolean | null;
  /** Trap followed in any snapshot during the run (a trap-following step). */
  trap_hit_any: boolean | null;
  traps_followed: string[];
  /** Every test of this agent's function file passes in the final snapshot. */
  function_pass_final: boolean | null;

  /** Sum of Ledger rows attributed to this slot (all generations, all categories except reuse_est). */
  tokens: TokenCounts | null;
  usd: number | null;
  tokens_source: string | null;

  /** The agent's prompt carried a lesson from a case about one of its traps. null = service does not expose prompt context. */
  lesson_in_prompt: boolean | null;
  lesson_in_prompt_source: string | null;
  /** A non-revoked case with a lesson about this agent's trap was in the library before the run launched (measured from listCases). */
  trap_lesson_in_library_at_launch: boolean | null;
  library_cases_at_launch: number | null;
  library_lessons_at_launch: number | null;
  library_synthetic_at_launch: number | null;

  /** A verified chunk was reused by this slot (ReasoningStore reusers or Ledger reuse_est rows). */
  chunk_reused: boolean | null;
  chunk_reuse_source: string | null;

  run_tokens: TokenCounts | null;
  run_usd: number | null;
  /** Ledger tokens in this run not attributable to any slot. */
  run_unattributed_tokens: number | null;
  snapshots: number;
  notes: string[];
  mock?: true;
}

export interface ResourcePeaks {
  /** All processes on the machine. */
  processes: number;
  /** Processes whose command matches the stack pattern (durable-actors, bun, node, python). */
  stack_processes: number;
  stack_rss_mb: number;
  bench_rss_mb: number;
  samples: number;
}

export interface WaveRecord {
  wave: number;
  at: number;
  run_keys: string[];
  /** Shared library after the wave (listCases), null if unreadable. */
  library: { cases: number; lessons: number; synthetic: number; revoked: number } | null;
}

export interface Session {
  started_at: number;
  ended_at: number | null;
  runs_completed: number;
  stop_reason: string | null;
  peaks: ResourcePeaks;
}

/** bench/emergence/state.json: survives resume. */
export interface ExperimentState {
  experiment: string;
  library_id: string;
  created_at: number;
  /** OpenRouter key usage (USD) when the experiment first started; the budget guard measures the rise from here. */
  key_usage_baseline: number | null;
  key_usage_last: number | null;
  key_usage_last_at: number | null;
  budget_usd: number;
  next_launch_seq: number;
  sessions: Session[];
  waves: WaveRecord[];
}
