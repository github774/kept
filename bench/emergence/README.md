# bench/emergence: emergent learning across 1,000 LLM subagents

Runs of 4 real subagents each (`MODEL_PROFILE=bench`, GPT-6 Luna) in two interleaved arms:

| Arm | Library | What it measures |
| --- | --- | --- |
| **shared** | every run passes the same `libraryId`, so cases and lessons from earlier agents reach later ones | learning |
| **control** | `libraryId` omitted, so each run gets a fresh, empty library | no learning (same tasks, model, caps, time of day) |

Tasks rotate per arm by run index over `bench/tasks-v2` (or `bench/tasks` if v2 is missing; `--tasks-dir` overrides).
The arms are interleaved in proportion (1:1 gives S,C,S,C…), so provider load and time of day hit both equally.
Runs launch in **waves** of `--concurrency` runs (default 8 = 32 agents at once). Each wave waits for all of its runs.
Every run keeps the normal caps: `caps.usd_per_run` ($1) and the 10-minute wall clock (`caps.codex_wall_clock_ms`).

## Commands

All commands run from the repo root. The actor runtime and Relay must already be up (`scripts/start-all.sh actors relay`).
The orchestrator service runs inside this process, so the orchestrator HTTP server is not needed. Don't run two experiments
against the same `--out-dir`.

```bash
# 0. Validate config, tasks (collects the canonical tests), key, env and service; print the plan and an est. cost. Starts nothing.
bun bench/emergence/run.ts --dry-run --check-service --shared-runs 25 --control-runs 25

# 1. 20-agent rehearsal: 3 shared + 2 control runs, one wave, $1 budget, its own out dir.
bun bench/emergence/run.ts --shared-runs 3 --control-runs 2 --concurrency 5 --budget-usd 1 \
  --out-dir bench/emergence/rehearsal

# 2. 100 + 100 agents (25 shared runs + 25 control runs), $12 budget.
bun bench/emergence/run.ts --shared-runs 25 --control-runs 25 --concurrency 8 --budget-usd 12
#    (if you meant 100 + 100 *runs* = 400 + 400 agents: --shared-runs 100 --control-runs 100)

# 3. Full run: 1,000 shared-library agents (250 runs) + 1,000 control agents (250 runs).
#    Same out dir as step 2, so the 25+25 runs already done are kept and the shared library carries on.
#    The budget counts from the experiment's first start, so raise it to cover everything so far.
bun bench/emergence/run.ts --shared-runs 250 --control-runs 250 --concurrency 8 --budget-usd 25
#    To keep cost down with a smaller control arm: --shared-runs 250 --control-runs 50

# Rebuild summary.json from results.jsonl + state.json at any time (run.ts also does this after each wave):
bun bench/emergence/summarize.ts

# Tests (summarizer, schedule, budget guard, row builder; data is a hand-written FIXTURE, not measured):
bun test bench/emergence
```

Run the dry run before steps 2 and 3. It prints the **est.** cost (measured mean USD per run once
`results.jsonl` has runs, otherwise a token model from `config/prices.json` with its assumptions written out), the hard-cap
bound (runs × $1), how many runs fit in the remaining budget, est. processes/memory and est. wall time.
It exits 1 and prints `NOT READY: …` if the service, key or key usage is missing.

Options: `--tasks a,b,c`, `--library-id <id>` (default `emg-<stamp>-shared`), `--max-runs N` (cap this session),
`--poll-ms 5000`, `--snapshot-ms 15000` (ground-truth pytest during the run), `--key-check-ms 30000`,
`--max-stack-rss-mb 16000` (no new wave launches while the stack's RSS is above this; aborts after 5 min),
`--allow-dev-model`, `--allow-no-key-usage`.

## Resume

Run the same command again. Run keys (`shared:0007`, `control:0012`) depend only on arm and index, so finished runs
already in `results.jsonl` are skipped, and growing the arm sizes adds runs without changing the earlier ones. `state.json`
keeps the experiment id, the shared `libraryId`, the OpenRouter usage baseline, waves and sessions. Runs stopped by the
budget, Ctrl-C or a fatal error are recorded (with `stopped_by_budget` / `run_status` / notes) and are not rerun.
A `startRun` that throws has no run id and is not recorded. 3 in a row abort the experiment.

## Budget guard (default $12, `--budget-usd`)

Hard stop when **either** measure goes over the limit:
1. OpenRouter key usage (`GET https://openrouter.ai/api/v1/key`, numeric fields only) has risen by more than the limit
   since the experiment's first start. This is checked before each wave and every `--key-check-ms` during it.
2. The Ledger totals (sum of every run's Ledger USD, finished plus live) are over the limit.

On a stop, active runs get `stopRun`, are recorded, and the summary is written. Exit code 3. Before each wave, once 3 runs are
measured, the wave is trimmed to the number of runs the measured mean cost says still fit. If the key usage can't be read at
start, the run refuses unless `--allow-no-key-usage` is passed (Ledger only).

Exit codes: 0 done · 1 dry run not ready · 2 config/service unavailable (nothing started) · 3 budget stop · 4 other fatal · 130 Ctrl-C.

## Service requirements (`orchestrator/src/service.ts`)

Loaded through `bench/ours/service.ts` (same exports as the benchmark). If the file or a `RuntimeService` export is missing,
the run exits 2 with `orchestrator service not available: …` and writes nothing. A service with `mock: true` is refused. The
experiment aborts (exit 4) when:
- a run reports a model other than `config/models.json profiles.bench.worker` (unless `--allow-dev-model`),
- a shared run's `RunSummary.libraryId` is not the requested shared library (the service would be ignoring `libraryId`),
  or a control run is given the shared one,
- the run's work dir holds a `SPEC.md` different from `--tasks-dir`'s (the service would be running another task version).

Needed: the run's work dir via `RunSummary.workDir` or `getRunWorkDir(runId)` (as for `bench/ours`).
Optional, read when present:
- **Durable Actors reads** (`orchestrator/src/actors.ts`, read only): `Ledger.list` for per-agent tokens and `ReasoningStore.list`
  for chunk reuse. If they can't be read, those fields are null.
- **`getAgentTelemetry(runId)`** → `{ slot, gen, lessonCaseIds: string[], reusedChunkIds?: string[] }[]`: the case ids
  whose lessons were in each agent's prompts. Without it, `lesson_in_prompt` is **null** and is never guessed. The measured
  stand-in `trap_lesson_in_library_at_launch` is reported separately.

## Outputs

`bench/emergence/results.jsonl` has one row per agent (`AgentRow` in `types.ts`). Each run's rows are appended together.
`null` means not measured.

| Field | Definition |
| --- | --- |
| `arm_agent_index` | launch order within the arm: `arm_run_index × 4 + slot`; windows use this |
| `launch_seq` | order the run was launched across both arms and sessions |
| `function` | the slot's subtask from `getRoster` |
| `exposed`, `trap_ids` | the function owns ≥ 1 trap (`task.json` trap `function`, else the trap test's file) |
| `trap_hit_final` | in the final ground-truth snapshot (agent code + canonical tests, pytest) the trap test fails with a real assertion while a sibling test in the same file passes (same rule as `bench/ours`) |
| `trap_hit_any` | the same rule in any snapshot during the run (`--snapshot-ms`), i.e. a trap-following step that may have been fixed later |
| `function_pass_final` | every test of the function's file passes in the final snapshot |
| `retired`, `generations`, `retire_cases` | roster generation > 1, status retired/failed, or a non-synthetic case for the slot in `listCases({runId})` |
| `tokens`, `usd` | sum of Ledger rows with this slot (all categories and generations, `reuse_est` excluded). Usage fields only |
| `run_tokens`, `run_usd`, `run_unattributed_tokens` | `getLedger(runId)` totals, and Ledger tokens with no slot |
| `lesson_in_prompt` | `getAgentTelemetry` lists a case with a lesson about a trap in the same family as this agent's trap |
| `trap_lesson_in_library_at_launch` | such a case (non-revoked, lesson not `NO_LESSON`) was in the run's library before it launched |
| `library_cases_at_launch`, `library_lessons_at_launch` | non-synthetic cases / lessons in the library created before launch |
| `chunk_reused` | a `ReasoningStore` reuser id for this slot, or a Ledger `reuse_est` row for it (or `getAgentTelemetry.reusedChunkIds`) |

A case is "about" a trap when its `evidence.testOutput` names the trap test, or it comes from the same task and function.
A trap's family is the `family` field in v2, otherwise the shortest trap id that prefixes it.

`bench/emergence/summary.json` is built by `summarize.ts`:
- `curve.windows[]`: the **emergence chart**. Per window of 50 agents (by `arm_agent_index`), the `trap_hit_final` rate over
  exposed agents for `shared` and `control` (`*_n` = agents measured; `shared_any`/`control_any` = trap-following-step rate).
  A window with no measured agent is `null`, never interpolated.
- `arms.<arm>.windows[]`: per window: trap hits (final/any), retired, lesson_in_prompt, lesson in library at launch, chunk reuse,
  passing subtasks, tokens, `tokens_per_passing_subtask` (null unless every agent in the window has Ledger tokens), USD,
  and library cases/lessons at launch. `partial: true` marks windows with fewer than 50 agents recorded.
- `arms.<arm>`: totals, including `run_tokens_per_passing_subtask` (run Ledger totals including unattributed overhead).
- `library_growth[]`: shared library cases/lessons/synthetic/revoked after each wave (from `state.json`).
- `cost`: Ledger USD (sum of runs) and the OpenRouter key usage delta since the baseline, plus the budget.
- `wall`: first launch → last end, summed session time, mean run time.
- `resources`: peaks from `ps` sampled every 5 s: all processes, "stack" processes (command matches durable/actors/bun/node/python,
  machine-wide), their summed RSS, and this process's RSS.

Rows marked `mock` are excluded unless `summarize.ts --include-mock` is passed. The test fixture `fixtures/rows.FIXTURE.ts`
is hand-written and is not measured data.
