# Kept: write-up

Haunted Hacks, Oct 31, 2026. Tracks: **Stateful Apps: Build with Durable Actors from Terse** and **Agent to agent communication built with Agent Relay**. Team: Avneh Bhatia (backend), Amar (frontend).

Every number below comes from a file in this repo, which is linked next to it. Anything not yet measured is marked **TBD**, along with the script that will measure it.

## Problem

Standard subagent setups, like the ones in Codex and Claude Code, waste tokens and reliability in four ways:

1. **Duplicated work.** Each subagent re-reads and re-derives what its siblings already worked out. In our 9 Codex baseline runs, the subagents used 55% of all tokens: about 124,000 tokens on average to write one function of a 19–30-test, 4-function Python module. 93.6% of all input tokens were cached re-reads of the same context. Source: [bench/results.json](../bench/results.json), rows started at 18:30 or later, `tokens_parent_events` vs `subagents[].tokens`.
2. **Context poisoning.** A wrong agent is corrected inside its own context, so the bad reasoning is re-sent on every later turn.
3. **No memory of failure.** One agent's mistake protects no one else, in this run or the next.
4. **Expensive oversight.** Putting an LLM judge on every step roughly doubles the bill, so most teams skip checking.

## What we built

A runtime for agent fleets with an immune system:

- **Retire and respawn.** An agent caught lying (it claims tests pass and they fail), sending a spec-breaking instruction, accepting a poisoned fact or stuck is retired. A fresh generation gets a clean handoff: verified checkpoints only, plus the lesson.
- **Case files and herd immunity.** Each failure becomes a case file with evidence and a one-line lesson. The case goes over Agent Relay only to the agents it is relevant to, and the lesson joins every later prompt.
- **Shared verified reasoning.** Notes behind code that passed tests are checked by Jev and shared with teammates working on related functions.
- **Cheap, typed oversight.** Jev answers yes/no questions for about $0.000018 per call. Only uncertain answers escalate to an LLM judge.
- **Durable state.** Every piece of state lives in Durable Actors, so `kill -9` of the whole stack loses nothing, and a 10,000-agent swarm simulation lost no state changes.
- **A token ledger.** One row per API call, copied from the usage fields, so our own overhead is counted.

## How it works

An orchestrator holds no state of its own and drives 4 worker agents, one per function of a Python task. One step is one LLM call (strict JSON schema), one action (`write_code`, `run_tests`, `message` or `claim_done`) and its checks. Ground truth comes first: a `tests_pass` claim is settled by running pytest, never by an LLM. Text claims (instructions to teammates and stated facts) go to Jev. Each step, checkpoint and ledger row is written to an actor, tagged with the agent's generation.

When a retire trigger fires, the retire protocol runs:

1. `Fleet.beginRetire`
2. Abort the in-flight call and close the Agent actor.
3. Release the Relay identity.
4. Build the case file.
5. `CaseLibrary.add`
6. Build the handoff from verified checkpoints.
7. Create the new generation's actor and Relay identity.
8. `Fleet.completeRetire`, which puts the new agent on probation.
9. Broadcast the case.

The lesson writer sees only the spec and the evidence, never the failed agent's reasoning, so the bad reasoning does not carry over.

Faults are injected by the orchestrator, not by asking a model to misbehave, so they fire every time:

- **F1:** false success claim
- **F2:** invented API
- **F3:** conflicting instruction over Relay
- **F4:** poisoned fact

"Possess" applies F1, then F3.

## How we used Durable Actors

Code: [actors/src/actors.ts](../actors/src/actors.ts) (`durable-actors` 0.14.6).

- **Eight actor classes, with SQLite in each actor.** The classes are `Fleet`, `Agent`, `CaseLibrary`, `ReasoningStore`, `Ledger`, `SwarmShard`, `RunIndex` and `Counter`. Anything that grows lives in the actor's own SQLite tables: `Fleet` has `slots` and `slot_history`, `Agent` has `steps` and `checkpoints`, `CaseLibrary` has `cases` and `case_receivers`, `ReasoningStore` has `chunks` and `reuse`, `Ledger` has `entries`, and `SwarmShard` has `agents` and `applied`. Persisted fields stay small.
- **Persist by reassignment.** Persisted fields are never mutated in place, because in-place edits are silently lost. Every update builds a new value: `this.roster = rosterOf(...)`, `this.info = {...this.info, relayName, relayToken}`, `this.counts = {...}`.
- **Generation guards.** Every Agent write (`appendStep`, `checkpoint`, `setRelay`) carries its generation. A stale generation gets `stale_generation`, and a closed one gets `closed`. `Fleet.setStatus`, `setStep`, `beginRetire` and `completeRetire` check the generation too. A late reply from a retired agent can never land.
- **Fleet is the single source of truth.** All status changes go through `Fleet`. Its roster is `@Emittable`, so the dashboard reads it live over an actor socket; the orchestrator issues the socket grants. On restart the orchestrator rebuilds itself from `Fleet` and `RunIndex`, because it holds no state of its own.
- **The retire protocol is idempotent.** It is safe to repeat at every step:
  - `beginRetire` succeeds only for an active slot at that generation, and a second caller gets `already_retiring`.
  - A repeated `completeRetire` reports the new generation and changes nothing.
  - `Agent.close` is idempotent.
  - `CaseLibrary.add` is idempotent on the case ID `<runId>.<slot>.g<gen>`.
  - `Ledger.record` is idempotent on the entry ID `<runId>.<slot>.g<gen>.s<step>.<n>`.

  A crash halfway through a retire resumes from `Fleet`'s `retiring` row.
- **Crash test, `kill -9`.** [actors/scripts/crash-test.ts](../actors/scripts/crash-test.ts) writes the following state, then `kill -9`s the actor runtime's whole process tree and restarts it:
  - a Counter at 5
  - a Fleet roster with `w1` retiring and `w2` under investigation
  - a Ledger row

  It then checks that the counter, the roster and the ledger totals are identical after the restart, and that `beginRetire("w1", 1)` still returns `already_retiring`. [scripts/crash-test.sh](../scripts/crash-test.sh) is the on-stage version: it kills the actor runtime and the orchestrator trees, never the Relay engine, and checks that the ports are free and no processes are left. Statuses, case files, the ledger and the Relay tokens all survive, because they are all in actors.
- **The ~30 s lease window.** After `kill -9`, the dead host still holds the lease on every actor that was awake. Those actors answer `unavailable` until the lease expires; we measured 14 s and 29 s ([scripts/README.md](../scripts/README.md)). `withRetry` in [orchestrator/src/actors.ts](../orchestrator/src/actors.ts) retries `unavailable` every 2 s for up to 90 s. This is safe only because every write is idempotent. On stage the dashboard shows "reconnecting" and recovers by itself.
- **Swarm: 10,000 agents across 20 actors.** Each of the 20 `SwarmShard` actors holds 500 simulated agents as SQLite rows. Over 10 ticks, every agent sends one change per tick (a step, a status change or a retire) through `applyBatch`. Change IDs are deterministic, so a retry after `outcome_unknown` resends the same IDs and the `applied` table dedupes them. Stale generations are rejected. "Lost" is measured by reading the shard stats after the run, not assumed. **Measured: 0 lost, 100,000 changes, 2,963 changes/s, peak 42 processes and 2.18 GB** ([DECISIONS #13](DECISIONS.md)). We used 20 shards rather than 100 because each awake actor is about 2 OS processes, so 100 shards would be about 200 processes ([DECISIONS #6](DECISIONS.md)). Code: [orchestrator/src/swarm/](../orchestrator/src/swarm/).

## Immune memory on Supabase

Code: [orchestrator/src/memory/immune.ts](../orchestrator/src/memory/immune.ts), schema [supabase/migrations](../supabase/migrations).

- **Two tiers.** Durable Actors hold the live fleet: roster, generations, the per-library `CaseLibrary`. Supabase holds the long-term memory: one `cases` row per retired agent (`id`, `lesson`, `category`, `task`, `function`, `run_id`, `library_id`, `created_at`, `embedding vector(256)`, `revoked`).
- **Written at retire.** Right after `CaseLibrary.add`, the same case and its existing 256-d embedding are upserted on the case id, so a retire that resumes after a crash writes the same row again, not a second one.
- **Recalled at run start.** Each function's subtask is embedded and `match_cases(query_embedding, task, k=3)` returns the nearest non-revoked lessons of that task (HNSW cosine index). They go ahead of the library's own lessons in the Fleet lessons block, deduplicated and capped at `max_lessons`, so a fresh run starts already immune to traps an earlier run hit.
- **Opt-in and fail-open.** Off without `SUPABASE_URL` and a secret key; a Supabase error is logged and the run continues on actor state only. MOCK lessons and hashed embeddings are never written. `IMMUNE_MEMORY=write` keeps cold benchmarks cold. RLS is on with no policies, so the publishable key reads nothing. Not yet wired: revoking a case in `CaseLibrary` does not set `revoked` in Supabase.
- **Verified live (2026-10-31).** Migration applied twice through `SUPABASE_DB_URL` (idempotent). `bun run src/memory/cli.ts check` took 3 real retire cases from the poisoning head-to-head (`r6fej.1.g1` invoice_parser/parse_line, `rzvxq.2.g1` shipping_rates/delivery_date, `r25fn.2.g1` discount_engine/code_is_active, all `conflicting_instruction`), re-ran the real lesson writer and embedder on their recorded evidence (the original lessons were in those runs' actors, not on disk), upserted them twice (3 rows, not 6), and `match_cases` returned each one first for its own task and function (cosine 0.41, 0.40, 0.35). The publishable key reads `[]` (RLS).

## How we used Agent Relay

Code: [orchestrator/src/relay/](../orchestrator/src/relay/README.md): `bus.ts`, `observer.ts` and `reactions.ts` (`@agent-relay/sdk` 15.0.1). It runs directly under Bun; only the local engine needs Node 22 ([DECISIONS #10](DECISIONS.md)).

- **Per-run channels.** `fleet-<runId>` carries status and teammate messages, and `cases-<runId>` carries case files. Trials never mix.
- **Warden identity.** A system identity, `warden-<runId>`, posts every case file. Its post is the root of the case thread.
- **Case files go only to relevant agents.** Recipients are active agents whose subtask embedding has cosine similarity of 0.6 or more with the case, filtered by Jev `lesson_relevant` of 0.5 or more, with at most 3 recipients ([config/thresholds.json](../config/thresholds.json)). Receipt is recorded durably with `CaseLibrary.markReceived`.
- **Capped threads.** Each recipient may reply once with how the lesson applies to its own function. A thread closes after 3 replies, and agents never reply to a reply. The bus enforces the cap from its own count and the server's reply count (`RelayCapError`). Each agent may send 1 message per step.
- **Jev-checked delivery.** Before a teammate message reaches an inbox, it is checked with `fact_contradicts_spec` and `instruction_conflicts_spec`. A blocked message never reaches the agent; the feed shows it struck through, with the reason, probability and source (Jev or fallback). Delivered messages are wrapped as quoted data with the sender's name. A possessed agent therefore cannot talk its teammates out of the spec.
- **Create-only registration, stored tokens, reconnect.** Each agent generation registers a new name, `w<slot>-g<gen>-<runId>`, and reusing a name returns 409 `name_conflict` (`RelayNameConflictError`). The token is stored in that generation's Agent actor (`Agent.setRelay`), so a restarted orchestrator reconnects with `workspace.reconnect({apiToken})` instead of re-registering. The workspace key and admin token are created once by [scripts/relay-bootstrap.sh](../scripts/relay-bootstrap.sh).
- **Idempotency keys.** Every send carries `<runId>.<slot>.g<gen>.s<step>`, and a resend returns the same message ID; this was verified in the 11:20 smoke test ([DECISIONS #10](DECISIONS.md)). The metadata `{runId, slot, gen, caseId, kind}` links feed items to cases.
- **Retired identities are released,** and the bus also rejects their sends locally, because the server keeps accepting sends after `workspace.release`.
- **The dashboard feed comes from Relay's observer plane** ([observer.ts](../orchestrator/src/relay/observer.ts)). On start, the orchestrator uses the workspace key to mint a read-only observer token (`POST /v1/observer-tokens`; scopes `stream:read`, `messages:read`, `threads:read`, `dms:read`, `reactions:read`; `include_dms`). It then runs `new AgentRelay({observerToken, sinceSeq, onCursor})`. The SDK backfills Relay's durable per-workspace event log and follows the live `/v1/ws` stream. Every message, thread reply, DM and reaction becomes a `relay.message` feed item. The cursor is saved in `.relay/`, so after a restart the feed resumes from the last event Relay delivered, and messages sent while the orchestrator was down still appear. Observer frames carry the message metadata that agent listener events lack. `GET /api/relay/observer` reports `{connected, cursor, latestSeq, lag, events, confirmed, reactions}`.
- **Herd immunity is visible as Relay reactions** ([reactions.ts](../orchestrator/src/relay/reactions.ts)). The warden reacts ✅ on a case's root post when a recipient adopts the lesson (its case reply is recorded). It reacts 🚫 on a teammate message that Jev blocked before delivery. The reactions are stored in Relay itself, so any Relay client sees them, and the observer streams them back onto the dashboard feed.
- **Verified live** against `@relaycast/engine@12.3.0`. A case post, a reply, a teammate note, ✅ and 🚫 all streamed through the observer token with lag 0. After the observer was stopped, a message was sent, and the restarted observer resumed from its saved cursor and published that message.

## Jev

Jev (`typesafe/jev-1.14`, through OpenRouter `POST /api/alpha/decisions`) answers six questions: `instruction_conflicts_spec`, `fact_contradicts_spec`, `note_consistent_with_spec`, `failure_category` (choice), `lesson_relevant` and `subtask_difficulty`. The adapter has a 2 s timeout. If the probability of a problem is 0.62 or more, it acts; below 0.45 it passes; anything in between goes to the fallback judge. After 3 failures in a row, it uses only the fallback for 60 s.

Calibration used real calls, no mocks: [bench/jev-calibration/report.md](../bench/jev-calibration/report.md).

| Metric | Value |
| --- | --- |
| Labelled examples × repeats | 74 × 3 = 222 calls, 0 failed, 0 retried |
| Latency | p50 178 ms, p90 205 ms, max 334 ms |
| Cost | $0.004065 total, $0.0000183 per call |
| Spec checks at act 0.62 / pass 0.45 | 72 acted correctly and 0 wrongly; 75 passed correctly and 0 wrongly; 3 escalated (2.0%); 100% accuracy on decided calls |
| Same at the spec's original 0.85 / 0.15 | 11 escalated (7.3%) |
| Separation | Highest p on a clean example 0.56; lowest p on a problem 0.95 |
| `failure_category` | 30/30 correct |
| `lesson_relevant` | 42/42 correct at 0.5 |

The one near-miss was `ic-16`, an instruction to "hold amounts as integer cents internally, return Decimal dollars". It scored p = 0.55–0.56 and was escalated, not acted on. We reworded `instruction_conflicts_spec` to judge observable behaviour ([DECISIONS #10](DECISIONS.md)). With the reworded questions the pooled clean maximum is 0.25 and the problem minimum is 0.94 ([config/thresholds.json](../config/thresholds.json) comment, [report-proposed.md](../bench/jev-calibration/report-proposed.md)).

## Results

### Codex baseline (v1 tasks, real runs)

The baseline is `codex exec` 0.157.1 with GPT-6 Luna via OpenRouter, told to use one subagent per function. 9 trials: 3 tasks × 3. Source: [bench/results.json](../bench/results.json). The file has 10 rows, because `invoice_parser` trial 1 was also recorded in an earlier trial run at 18:24; the figures below use the 9 rows of the full sweep.

| Metric | Mean | Min–max |
| --- | --- | --- |
| Success (all tests pass) | 9/9 | — |
| Tokens per passing task (input + output) | 901,529 | 706,452 – 1,339,368 |
| USD per task (config/prices.json) | $0.0188 | $0.0153 – $0.0271 |
| Time to finish | 84.9 s | 51.3 – 157.6 s |
| Subagents spawned | 4 per run | — |
| Trap hits | 0 | — |
| Share of input tokens that were cached | 93.6% | — |

### Ours vs Codex on the v2 tasks (real runs)

Same model (GPT-6 Luna), same 3 v2 tasks (`bench/tasks-v2`: each trap planted in several places), same tests, 3 trials per task per mode. Source: [bench/results.summary.json](../bench/results.summary.json) (groups `codex_baseline@v2`, `ours_cold@v2`, `ablation@v2`, `ours_warm@v2`), built by `bun bench/aggregate/aggregate.ts` from [bench/results.json](../bench/results.json). Our tokens and USD are Ledger totals for the whole run, oversight included (worker, Jev, fallback judge, embeddings, lesson writer). Codex USD is priced from config/prices.json.

| Metric | Codex subagents | Ours, cold | Difference (ours vs Codex) |
| --- | --- | --- | --- |
| Completion (all tests pass) | 9/9 | 9/9 | 0 |
| Tokens per passing task, mean (min–max) | 852,191 (573,232 – 1,351,083) | 53,093 (28,489 – 77,466) | 93.77% fewer (Codex/ours = 16.05×) |
| USD per passing task, mean (min–max) | $0.017219 ($0.0133 – $0.0243) | $0.005905 ($0.0022 – $0.0098) | 65.71% lower (2.92×) |
| Uncached input tokens per passing task | 57,723 | 14,460 | 74.9% fewer |
| Cached input tokens per passing task | 787,321 (92.39% of all tokens) | 29,149 (54.9%) | — |
| Output tokens per passing task (reasoning included) | 7,146 | 9,484 | ours 32.71% more |
| Time to finish, mean (min–max) | 56.7 s (33.2 – 98.9) | 61.7 s (19.1 – 90.0) | ours 5.0 s (8.80%) slower |
| Trap hits during the run (final) | 5 in 4 of 9 runs, 1 of them a repeat (0 in final code) | 0 in 9 runs (0) | — |
| False completion claims | 0 of 45 claims | 0 | — |
| Retires / false retires | — | 0 / 0 | — |

The token gap is mostly cached re-reads on the Codex side, so the USD row is the fairer comparison. **Where the savings come from:** the architecture, not reasoning reuse. Each agent owns one function and keeps a small, clean context (14,460 uncached input tokens per task vs Codex's 57,723), and oversight is cheap Jev checks rather than an LLM judge (7.09% of our spend). The ablation shows no reuse benefit on v2 (below; v3 pending), and warm showed no gain over cold. We produce more output tokens than Codex and finish about 5 s later. Trap hits are measured differently on each side: Codex from the agents' own pytest output, ours from ground-truth snapshots every ~3 s, which can miss a hit that is fixed within one interval.

| Mode | Completion | Tokens per passing task | USD per passing task | Time to finish |
| --- | --- | --- | --- | --- |
| Cold (fresh case library) | 9/9 | 53,093 | $0.005905 | 61.7 s |
| Warm (case library of cold trial 3 of the same task) | 9/9 | 56,136 | $0.006333 | 64.8 s |
| Ablation (shared notes off) | 9/9 | 44,056 | $0.005167 | 66.2 s |

Warm vs cold is not a learning measurement yet: the cold runs had 0 retires and 0 trap hits, so their libraries held no failures to learn from, and warm cost 7.3% more per passing task than cold.

| Metric | Value | Source |
| --- | --- | --- |
| Reasoning tokens skipped by shared notes | **None measured.** The ablation with shared notes off used 9,037 *fewer* tokens per passing task than cold (17.0% fewer). With 4 agents and no faults, sharing did not pay for itself in our runs. The live counter in the 20-agent fleet run showed 1,433 tokens, labelled "est." | `ablation@v2` vs `ours_cold@v2` |
| Oversight cost as a share of total spend | 7.09% for cold ($0.003770 of $0.053142 over 9 runs; per run 1.8–18.2%), 3.17% for ablation, 5.1% in the 20-agent fleet run | `tokens_by_category` in bench/results.json (non-worker USD / total); docs/FLEET.md |
| Time to recovery (fault → tests passing) | Benchmark: not measured (no faults injected, no trap hits). Poisoning run: 14.4 s, one sample (commit poison, ours trial 2) | docs/BENCHMARK.md "Poisoning head-to-head" |
| False retires | 0. The 18 cold and ablation runs had 0 retires at all; the 5 retires in the 3 poisoning runs and the 2 in the 20-agent fleet run were all of agents carrying an injected fault | `false_retires` in bench/results.json; bench/poison/results.json; docs/FLEET.md |
| v3 tasks (long specs, 6–8 functions) | **TBD** for ours. Codex: 6 of 6 passing so far, 2,280,515 tokens and $0.0464 per passing task | `codex_baseline@v3` in bench/results.summary.json; ours: `bench/ours/run.ts` on tasks-v3 |

### Poisoning head-to-head (invoice_parser, 3 trials per side)

The same poison text and file, injected into both systems at the same moment by the same rule. Full method and per-trial table: [docs/BENCHMARK.md "Poisoning head-to-head"](BENCHMARK.md#poisoning-head-to-head); rows: [bench/poison/results.json](../bench/poison/results.json), [summary.json](../bench/poison/summary.json).

| | Codex subagents | Ours |
| --- | --- | --- |
| Completion | 3/3 | 3/3 |
| Poison in final code | 0 of 9 poison × run | 0 of 9 |
| False fact (F4) and spec-breaking instruction (F3) | Read by 5 threads per run (via `TEAM_CHAT.md`); agents recognised the conflict with SPEC.md and ignored them; never followed in code | Never delivered: Jev blocked both before delivery in all 3 runs (p 0.90–0.92 for the fact, 0.95–0.96 for the instruction); the F3 sender was retired |
| False "tests pass" commit (F1) | The poisoned file stayed until its owner's next test run in 3/3 runs (repaired in 13.2–21.5 s, mean 17.5 s); the repair was silent in 2 of 3 | Fired in 2 of 3 runs (in trial 1 the slot had already been retired for F3); caught by a real test run and retired in 2/2; the poisoned file was seen in 1 snapshot, recovered in 14.4 s |
| USD per run (mean) | $0.021080 | $0.009658 (54.1% lower) |
| Tokens per run (mean) | 1,048,144 | 85,167 |

Three trials per side on one task: "in our runs", not significant.

### Fleet mode: 20 agents, real models

`startRun({agents: 20, poisonRate: 0.15})` on GPT-6 Luna: 5 teams of 4, 3 agents poisoned (F1, F3, F4). Source: [docs/FLEET.md "Smoke"](FLEET.md).

| Metric | Value |
| --- | --- |
| Poisoned / caught / spread | 3 / 3 / 0 (F1 retired for a false claim; F3 and F4 blocked by Jev before delivery) |
| Teams passing final pytest | 5 / 5 |
| Cost, wall time | $0.032, 65 s |
| Trap hits / repeat trap hits | 1 / 0 |
| Cases filed / lessons delivered | 2 / 8 |
| Context dropped on respawn (`poisonedContextTokensDropped`) | −304 tokens: the replacements' first prompts were longer than the retired agents' last ones |
| Overhead share of USD | 5.1% |

This run kept fleet state in in-memory shards and used the in-process fleet bus, not the Agent Relay server (docs/FLEET.md, H2 and H6). The 1,000-agent run is **TBD**.

### Emergent learning (1,000 subagents)

[bench/emergence/run.ts](../bench/emergence/run.ts) runs N runs of 4 subagents each on the v2 tasks, in two interleaved arms:

- **shared:** every run uses one case library, so lessons from early agents can reach later ones.
- **control:** each run gets a fresh library.

One row per subagent goes to `results.jsonl`. [summarize.ts](../bench/emergence/summarize.ts) computes, per window of 50 agents and per arm:

- trap-hit rate
- lesson-in-prompt rate
- library growth
- chunk reuse
- tokens per passing subtask
- cost
- process and memory peaks

`--shared-runs 125 --control-runs 125` is 1,000 subagents. A budget guard stops the run on whichever comes first: the rise in OpenRouter key usage or the ledger total.

Partial snapshot of the run in progress (experiment `emg-202610311936`, `--shared-runs 25 --control-runs 25`, i.e. 200 subagents; [bench/emergence/summary.json](../bench/emergence/summary.json) generated 19:47:41 UTC): 64 subagents, 8 runs per arm, one (partial) window. The 1,000-subagent run is TBD.

| Metric | Value |
| --- | --- |
| Trap-hit rate, shared vs control, first vs last window | 0 of 24 exposed agents in each arm (any time and final). With no trap hits there is no case file and no curve yet, so first vs last window is **TBD** |
| Repeat failures after the first case file | **TBD** (0 case files so far; the shared library still has 0 cases and 0 lessons after 4 waves) |
| Passing subtasks, shared vs control | 32/32 vs 31/32 |
| Tokens per passing subtask, shared vs control | 15,994 vs 13,900 (shared 15.1% higher) |
| Cost, wall time, peak processes and memory | Ledger $0.138 so far (OpenRouter key usage rose $0.802 over the same period, but the key is shared with other runs); 642 s wall; peak 379 stack processes, 11,851 MB stack RSS |

Rehearsal (`emg-202610311932`, [bench/emergence/rehearsal/](../bench/emergence/rehearsal/summary.json)): 20 subagents (12 shared, 8 control), 0 trap hits of 15 exposed, 20/20 subtasks passing, ledger $0.051, 248 s.

### Durable Actors and Relay

| Metric | Value | Source |
| --- | --- | --- |
| Swarm: agents / actors / changes / lost | 10,000 / 20 / 100,000 / 0 | DECISIONS #13 |
| Swarm throughput, peak processes, peak memory | 2,963 changes/s, 42, 2.18 GB | DECISIONS #13 |
| Actor unavailability after `kill -9` | 14 s and 29 s (two runs) | scripts/README.md |
| Prompt-cache hit on GPT-6 Luna, calls 2–3 | 2,222 of 2,256 and 2,222 of 2,248 prompt tokens cached | docs/SMOKE.md |

## Honest limits

- **The drift monitor was cut from the claims.** On real embeddings with synthetic runs, raw scoring caught 0 of 4 planted traps and contrast scoring caught 1 of 4, with no false flags ([DECISIONS #12](DECISIONS.md), [bench/tasks-synthetic-cases/calibration-result.json](../bench/tasks-synthetic-cases/calibration-result.json)). The code stays in, but we do not claim drift detection.
- **Codex hit 0 traps on the v1 tasks.** On v1 there is nothing for herd immunity to prevent in the head-to-head, so v1 can only compare tokens, cost and time. The v2 tasks plant each trap in several places (a shared-module docstring and doctest, a function docstring example, `TEAM_NOTES.md` and a fixture). On v2, Codex hit traps 5 times in 4 of 9 runs and fixed every one before the end; ours hit 0 in 27 runs (cold, warm, ablation). So the traps did not give herd immunity anything to prevent on our side either: the learning claims (warm vs cold, emergence curve) are still unmeasured.
- **The head-to-head covers one suite.** Ours ran on v2 only (27 runs); v3 has Codex runs only. Ours had no faults injected in the benchmark, so it measures cost and completion, not recovery; recovery comes only from the poisoning runs (one sample on our side).
- **Our cost and Codex's cost come from different sources.** Ours is OpenRouter `usage.cost` per call (else config/prices.json); Codex's is token counts × config/prices.json. Both use the same price table where they fall back.
- **Codex dollar figures come from config/prices.json.** The OpenRouter key delta recorded per row is higher (for example $0.0215 vs $0.0175 on the solo 18:24 trial), and it cannot be attributed to individual trials while trials overlap.
- **The sample is small.** 3 trials per task: we say "in our runs", not "significant".
- **The swarm simulates agents, not LLM agents.** It measures the actor layer only: state changes handled, rejected and lost.
- **Some dashboard fields have no durable source yet.** Case replies, most recovery stages and the immunity counters are not yet stored in actors, so they may be empty after a restart ([DATA_CONTRACT.md](DATA_CONTRACT.md)).
- **Jev returns a number, not a reason.** The reason in a case file comes from the evidence or from the fallback judge. Code claims are checked by tests, never by Jev.

## Feedback for the sponsors

**Agent Relay**

- Registration is create-only: a name that already exists returns 409 `name_conflict`, and there is no "get or create". After a restart you must have stored the token, so we put names with run and generation in them and stored tokens in actors.
- The SDK did not read its configuration from environment variables; we had to pass `baseUrl` explicitly.
- The default `baseUrl` points at the hosted service, so a local key silently goes to the wrong server unless `baseUrl` is set.
- `docs.agent-relay.com` returned 404.
- The server keeps accepting sends from an identity after `workspace.release`, so we reject them locally.
- Listener events carried empty metadata and no DM recipient, so the bus records its own sends and dedupes listener events by message ID.

**Durable Actors (Terse)**

- Each awake actor costs about 2 OS processes and about 100 MB. That is why we put the swarm in 20 SQLite-backed shards instead of one actor per agent, and why the emergence runner gates launches on stack memory.
- `push()` on a persisted array is not persisted. Only reassignment is, and the failure is silent.
- After `kill -9`, actors that were awake answer `unavailable` for up to about 30 s until the old host's lease expires. A faster lease handoff, or an error that says when the actor will be available, would help.
- `outcome_unknown` is never replayed by the runtime, so the caller must make every method idempotent and decide when to retry. We did, but the docs should say so prominently.

**Codex CLI (baseline harness)**

- `--ephemeral` breaks subagents, so we used a fresh `CODEX_HOME` per run instead.
- Subagent tokens are missing from `turn.completed`, so the runner sums every thread's rollout log.
- A custom `worker.toml` agent type is ignored by `spawn_agent` ([DECISIONS #14](DECISIONS.md)).

**Jev (TypeSafe, via OpenRouter)**

- For choice questions, the options go in `criteria`; this is not obvious from the question shape.
- `noul` answers have no `confidence` field, so we use max(p, 1−p).
- The response model ID is dated (`typesafe/jev-1.14-20261014`) and differs from the requested ID ([docs/SMOKE.md](SMOKE.md)).
