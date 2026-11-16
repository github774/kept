import type {
  BenchMode,
  BenchmarkResultRow as ContractRow,
  TokenCounts,
} from "../../orchestrator/src/contract.ts";

export type { BenchMode, TokenCounts };

/** CLI mode -> contract BenchMode. */
export const CLI_MODES = {
  codex: "codex_baseline",
  ours: "ours_cold",
  warm: "ours_warm",
  ablation: "ablation",
} as const satisfies Record<string, BenchMode>;
export type CliMode = keyof typeof CLI_MODES;

export interface TestSummary {
  passed: number;
  failed: number;
  errors: number;
  total: number;
  failing: string[];
}

export interface SubagentInfo {
  thread_id: string;
  nickname: string | null;
  role: string | null;
  agent_path: string | null;
  model: string | null;
  tokens: TokenCounts;
}

/**
 * One row per trial in bench/results.json: the contract row (orchestrator/src/contract.ts) plus
 * traceability extras. Tokens come from API usage fields only (rule 7); reasoning ⊂ output.
 */
export interface BenchmarkResultRow extends ContractRow {
  /** task.json "version": 1 = bench/tasks, 2 = bench/tasks-v2 (harder traps). */
  task_version?: number;
  /** Set on rows that must not be aggregated (kept for traceability), e.g. "duplicate_trial". */
  excluded?: string;
  tests: TestSummary;
  traps_hit: string[];
  /** Trap hits in the final workspace only (end-of-run pytest). trap_hits = in-run ∪ final. */
  trap_hits_final?: number;
  traps_hit_final?: string[];
  /** Traps whose test failed with a real assertion in an agent's own pytest run during the run. */
  traps_hit_in_run?: string[];
  /** Seconds from codex spawn to the last pytest run (any thread) that exited 0, else to process exit. */
  time_to_finish_s?: number | null;
  time_to_finish_basis?: string | null;
  time_to_recovery_s?: number | null;
  /** Factuality (bench/codex/trace.ts). */
  false_completion_claims?: number | null;
  completion_claims?: number | null;
  unverified_pass_claims?: number | null;
  trap_following_edits?: number | null;
  repeat_trap_edits?: number | null;
  traps_followed_in_edits?: string[];
  poisoned_facts_accepted?: number | null;
  jev_blocked_messages?: number | null;
  /** Subagent efficiency. */
  subagent_tokens_mean?: number | null;
  subagent_model_calls_mean?: number | null;
  subagent_turns_mean?: number | null;
  wasted_tokens?: number | null;
  wasted_tokens_basis?: string;
  subagent_efficiency?: unknown[];
  claims?: unknown[];
  trap_edits?: unknown[];
  pytest_runs_total?: number;
  pytest_runs_unavailable?: number;
  env_note?: string;
  /** What `tokens` covers. Codex: summed from every thread's rollout (parent + subagents). */
  tokens_scope: string;
  /** Codex only: sum of turn.completed usage in the exec JSON stream (parent thread only). */
  tokens_parent_events?: TokenCounts;
  usd_source: string;
  /** Cross-check: change in the OpenRouter key's reported usage across the run (other traffic on the key inflates it). */
  usd_openrouter_key_delta?: number | null;
  subagents?: SubagentInfo[];
  models_seen: string[];
  exit_code: number | null;
  run_dir: string;
  started_at: string;
}

export const zeroTokens = (): TokenCounts => ({ input: 0, cached: 0, output: 0, reasoning: 0 });

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  cached: a.cached + b.cached,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
});

/** Total billed tokens (input incl. cached + output incl. reasoning). */
export const totalTokens = (t: TokenCounts): number => t.input + t.output;
