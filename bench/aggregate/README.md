# bench/aggregate

```
bun bench/aggregate/aggregate.ts [--in bench/results.json] [--out bench/results.summary.json] \
  [--chart bench/aggregate/chart-data.json] [--include-mock]
```

Reads rows from both producers (Codex runner and `bench/ours/run.ts`; either the contract shape `recovery_ms`/`finish_ms`/
`cached` or the older `time_to_recovery_s`/`cached_input` shape). Mode aliases: `codex`→`codex_baseline`, `ours`→`ours_cold`,
`warm`→`ours_warm`. Task ids fold to the short id (`invoice_parser`→`invoice`). `task_version` defaults to 1.

- Rows with `excluded` set (e.g. `"duplicate_trial"`) are always skipped and listed in `rows_excluded`.
- Rows with `mock: true` are skipped unless `--include-mock`, in which case both outputs carry `mock: true`.
- Missing values stay `null`; a `Stat` with `n: 0` means "not measured", never zero.
- Definitions of every metric: docs/BENCHMARK.md.

## bench/results.summary.json

- `groups[]`: one summary per **mode × task version** (`group` = `"codex_baseline@v2"` etc.). Task versions are never pooled.
- `by_version.v<N>.<mode>`: the same summaries keyed for lookup.
- `modes.<mode>`: legacy per-mode summary across all versions (kept for older readers; do not use for v1-vs-v2 claims).

Each summary (`Stat` = `{mean, min, max, n}`):

| Field | Meaning |
| --- | --- |
| `trials`, `passes`, `tasks` | counts |
| `success_rate` | completion rate: mean = passes / trials; min/max = range of per-task pass rates |
| `tokens_per_passing_task` | Stat over passing trials of input + output |
| `tokens_per_passing_task_pooled` | all trials' tokens / passes (failed trials count against the mode) |
| `tokens_breakdown_per_passing_task.{total,input_uncached,cached,output,reasoning}` | Stat over passing trials (cached ⊂ input, reasoning ⊂ output) |
| `tokens_breakdown_per_passing_task_pooled.{...}` | pooled versions |
| `usd`, `usd_per_passing_task`, `usd_per_passing_task_pooled` | cost per trial; per passing trial; pooled |
| `subagents.spawned` | subagents per trial |
| `subagents.tokens_per_subagent`, `model_calls_per_subagent`, `turns_per_subagent` | Stat over every subagent of every trial (needs per-agent rows: Codex `subagent_efficiency`, ours `agents`) |
| `subagents.wasted_tokens` | per trial: tokens of retired (ours) or failed (Codex) agents |
| `subagents.retires` | ours only |
| `factuality.*` | `false_completion_claims`, `completion_claims`, `unverified_pass_claims`, `trap_hits` (any time), `trap_hits_final`, `repeat_trap_hits`, `trap_following_edits`, `repeat_trap_edits`, `poisoned_facts_accepted`, `jev_blocked_messages`, `false_retires` |
| `recovery_s`, `finish_s` | time to recovery, time to finish (`time_to_finish_s`, else `finish_ms`/1000) |

`claim`: "On our N-task benchmark against Codex subagents, X% higher success at Y% lower net cost, with Z% faster
recovery." Computed from the newest task version that has both `codex_baseline` and `ours_cold` rows (`claim.task_version`).
`null` (reasons in `claim.missing`) if any number is missing, the baseline is 0, or ours is not better.

`learning_curves[]`: `kind: "library"` = ours runs sharing a `library_id`, ordered by `started_at` (cold run first, then warm);
`kind: "control"` = Codex trials of one task × version ordered by trial (no memory between trials, the flat reference line).
Each run: `index`, `mode`, `trial`, `success`, `usd`, `tokens`, `trap_hits`, `repeat_trap_hits`, `trap_following_edits`.
`learning_by_index[]`: per `series` (`library@v2`, `control@v2`, ...) and run index, Stats over curves.

## chart-data.json (for the dashboard chart)

```ts
{
  generated_at: string;
  mock: boolean;                         // true => show MOCK badge
  groups: { id: string; mode: Mode; task_version: number; label: string }[]; // one bar per group, e.g. "codex_baseline@v2"
  modes: { id: Mode; label: string }[];  // modes with rows (legacy)
  metrics: {
    id: "success_rate" | "tokens_per_passing_task" | "tokens_input_uncached_per_passing_task" | "tokens_cached_per_passing_task"
      | "tokens_output_per_passing_task" | "tokens_reasoning_per_passing_task" | "usd_per_passing_task" | "usd"
      | "tokens_per_subagent" | "model_calls_per_subagent" | "wasted_tokens" | "false_completion_claims" | "trap_hits"
      | "trap_hits_final" | "repeat_trap_hits" | "trap_following_edits" | "poisoned_facts_accepted" | "jev_blocked_messages"
      | "recovery_s" | "finish_s";
    label: string;
    unit: "fraction" | "tokens" | "USD" | "s" | "count";
    higher_is_better: boolean;
    series: { group; mode; task_version; label; mean: number | null; min: number | null; max: number | null; n: number }[];
    points: { group; mode; task_version; task: string; trial: number; value: number | null }[]; // per-trial dots
  }[];
  learning_curves: LearningCurve[];      // same as the summary
  claim: string | null;
  claim_task_version: number | null;
}
```

Bar = `mean`, whisker = `min`–`max`, `n` = trials with a value (`n: 0` → draw "not measured", not 0). Success-rate
points are 0/1 per trial. Put v1 and v2 groups side by side or filter by `task_version`; never average across them.
Suggested headline panel: `tokens_per_passing_task` and `usd_per_passing_task` for `codex_baseline@v2` vs `ours_cold@v2`;
factuality panel: `trap_hits`, `repeat_trap_hits`, `false_completion_claims`; learning panel: `learning_curves`.

Tests: `bun test bench/aggregate` against `fixtures/results.MOCK.fixture.json` (hand-written MOCK fixture, not measured)
plus inline MOCK rows for versions, exclusion, breakdowns and curves.
