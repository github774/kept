# bench/ours — benchmark runner for our system

Runs our system in modes **cold** (`ours_cold`), **warm** (`ours_warm`) and **ablation** for each task × trial and
appends one row per trial to `bench/results.json` (rows flagged `mock` go to `bench/results.mock.json`).

```
bun --env-file=/Users/avneh/Code/SmarterSubagents/.env bench/ours/run.ts \
  [--modes cold,warm,ablation] [--tasks invoice_parser,shipping_rates,discount_engine] \
  [--trials 3] [--trial-start 1] [--parallel 3] [--warm-library <libraryId>] [--poll-ms 3000] [--check]
```

- Sets `MODEL_PROFILE=bench` before importing the service; aborts a trial whose run reports a model other than
  `config/models.json profiles.bench.worker` (override: `--allow-dev-model`).
- Fresh run per trial (service assigns the runId). Cold and ablation omit `libraryId` (fresh library); warm uses
  `--warm-library`, else the library of the first cold trial of the same task in this invocation, else the latest
  real `ours_cold` row for that task in results.json. No library → the warm trial is skipped loudly.
- Limits: 10-min wall clock (`caps.codex_wall_clock_ms`, same as Codex) → `stopRun`, `killed: true`, failed;
  $1 per run (`caps.usd_per_run`) checked against Ledger totals each poll → `stopRun`, failed; at most 3 trials in parallel (`BENCH_PARALLEL_MAX=<n>` raises the cap for this process and scales
  `caps.concurrent_llm_calls_benchmark` by n/3 so each trial keeps the same LLM concurrency share).
- Modes run in order cold → warm → ablation.
- `--check` loads the service and the tasks, then exits without starting a run.

## Service requirements (orchestrator/src/service.ts)

The real service is `createRuntimeService()` (orchestrator/src/runtime/service.ts, re-exported by orchestrator/src/service.ts). It provides `getRunWorkDir(runId)` (the run's work dir under `bench/runs/<runId>`), reconciles unfinished runs from actors in the background (`svc.ready`, awaited before the first trial), and uses `caps.concurrent_llm_calls_benchmark` because the runner sets `LLM_CONCURRENCY=benchmark`. Task ids are the folder ids (`invoice_parser`, ...); the old `--short-task-ids` flag is gone.

Loaded via one of the exports `createRuntimeService()`, `createService()`, `getRuntimeService()`, `getService()`,
`service`, `runtimeService` or `default`, typed as `RuntimeService` (orchestrator/src/contract.ts). Missing module/export →
`orchestrator service not available: …`, exit 2, nothing written. A service with `mock === true` is refused.

**Extension needed:** the run's work dir (the folder whose `*.py` files are the agents' code, next to `tests/`) via
`RunSummary.workDir` or `getRunWorkDir(runId)`. Without it the runner refuses (it cannot run pytest on the final code).
If `.py` files are not in the root, `starter/` or `src/` are tried.

## Metrics (all from ground truth or the Ledger)

Every `--poll-ms` the runner copies the work dir's `.py` files next to the **canonical** `bench/tasks/<id>/tests` in a
temp dir and runs pytest (JUnit XML). One more snapshot after the run ends.

| Field | Definition |
| --- | --- |
| `success` | Final snapshot: every canonical test passes (count ≥ collected count), and the run was not killed, capped or crashed |
| `tokens` | `getLedger(runId).tokens` (API usage fields, all categories) |
| `tokens_per_passing_task` | `input + output` when `success`, else null |
| `usd` | Ledger `worker_usd + overhead_usd`; null if the ledger is unavailable |
| trap followed (one snapshot) | the trap's `trap_test` fails with a real assertion (not NotImplementedError/import errors) while another test in the same file passes — same rule as the Codex runner |
| `trap_hits` / `traps_hit` | distinct traps followed in any snapshot |
| `repeat_trap_hits` | re-hits (followed → fixed → followed again) + hits beyond the first per trap family (`stale_rate_table_quote` is in family `stale_rate_table`) |
| `trap_hits_final`, `repeat_trap_hits_final` | the same rule on the final snapshot only (what the Codex runner measures) |
| `recovery_ms` | first snapshot with a trap followed → first later snapshot where all tests pass; null if no trap hit or never recovered |
| `finish_ms` | trial start → `RunSummary.endedAt` (or when the bench stopped it) |
| `false_retires` | non-synthetic cases that were revoked, or whose agent's function tests all passed in the latest snapshot before the retire; null if no snapshot precedes any retire |

Crashes after `startRun` are recorded as failed rows (with the error in `notes`). A failure in `startRun` itself has
no runId to trace and is logged, not recorded.

Tests: `bun test bench/ours` (uses the task's own `_solution`/`_trap_variant` as code under test, and a MOCK in-process service).
