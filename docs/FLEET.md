# Fleet-scale mode (DECISIONS #16)

`startRun({ taskId, mode: "ours", agents: 1000, poisonRate: 0.05 })` with `agents > 4` starts a fleet:
`agents / 4` teams of 4 on the v2 trap tasks (`bench/tasks-v2`, rotated by team). Every team runs the **unchanged**
runtime worker loop (`runtime/worker.ts` → retire / herd / reasoning / faults). Only what each team's
`RunContext` points at is different. Code: `orchestrator/src/fleet/`. Tests: `orchestrator/test/fleet/`.

| Piece | File | What it does |
| --- | --- | --- |
| FleetRunner | `runner.ts` | Builds the teams, starts them evenly over `rampMs` (60 s), arms the poisoned slice at `poisonAtMs` (5 s), handles Possess on any global agent index, emits `fleet.grid` + `fleet.stats` each tick |
| Shard state | `shard-core.ts`, `team.ts` | Fleet + Agent actor semantics (generation guards, idempotency, `markDone` / `reassign`) for many teams in one shard. One shard per ~50 agents. `teamActors()` gives the runtime a `ctx.actors` that talks to the shard |
| Shared stores | `stores.ts` | One CaseLibrary for every team; verified-chunk store per task (shared across teams); FleetLedger. Per-team views store the global agent index and return slots relative to the reader |
| Transport | `bus.ts` | FleetBus implements `RelayBus`: per-recipient mailboxes, `cc` for cross-team case threads, 3-reply thread cap, no reply to a reply, released identities rejected, generation guard. **In-process, not the Agent Relay server** (`transport: "in-process"`) |
| Fleet herd | `herd.ts` | Recipients picked across all teams: cosine similarity of each distinct subgoal ≥ `case_similarity`, then Jev `lesson_relevant` (one check per distinct function). Other teams and unfinished agents rank first, `caseRecipients` (6) per case. There is one thread root, cc'd to every recipient. The lesson goes into the lessons block of the case's task family |
| Limits | `limits.ts`, `seams.ts` | Global gates: LLM 64, pytest 16, Jev 32, Relay 24 (the local Relay engine crashed at 32–64 concurrent requests; fleet agents make no Relay calls). Each gate records its peak |
| Stats | `stats.ts` | Grid and stats computed from live state. Tokens and USD come from ledger rows only. Measurement rules are listed below |
| LLM pools | `pools.ts`, `config/fleet.json` | Opt-in: worker and lesson calls are split between OpenRouter and direct OpenAI (same `gpt-6-luna`, weighted round-robin, overflow on 429/5xx). Direct calls are priced from `prices.json` as `openai/gpt-6-luna` and recorded as `openai-direct/gpt-6-luna`. Benchmarks never load this file |

## How the numbers are measured

- **poison**: `round(poisonRate × agents)` agents, chosen deterministically by seed, with faults F1/F3/F4 cycled.
  - An agent counts as **caught** when its generation is retired, or when its poisoned message or fact is blocked before delivery.
  - It counts as **spread** when it starts another step after the fault without being caught.
  - At the end of the run, anything not caught counts as spread.
  - Every `agent.status` of a possessed generation after the fault fires carries `faultAt` and `fault`.
- **context.cleansed**: the retired generation's last worker `prompt_tokens` against the replacement's first, both from ledger rows. `poisonedContextTokensDropped` is the raw sum of the differences and can be negative.
- **trapHitRateRecent**: one entry per agent generation at its first real test run of a trap function. The entry is true if a `trap_test` failed. `repeatTrapHits` counts hits on a trap that already has a case filed in the fleet.
- **lessonsDelivered**: distinct (agent generation, lesson) pairs found in the lessons block of worker prompts as they were sent.
- **`D` cell**: the loop returned done, or it hit the step cap while that function's tests pass (latest run, or the final pytest at team end).
- **Sampling**: these events are always emitted: `case.*`, `chunk.created`, `chunk.revoked`, `context.cleansed`, `recovery`, blocked `relay.message`, retire and respawn status, and every status of a possessed agent. Routine status, notes and `chunk.reused` are sampled at `sampleRate` (2%). The stats always hold the full counts.

## Durability, Relay, caucus (Oct 31, second pass)

- **State**: FleetShard actor (`actors/src/actors.ts`, logic in `actors/src/fleet-shard-core.ts`, shared with the in-memory shard). One shard per 50 agents; `fleetshard.index` holds the fleet list, config, stats snapshot, runner state and Relay tokens. Cases go to the CaseLibrary actor `cases.<libraryId>`. Chunks go to ReasoningStore `chunks.<fleet>.<task>`. Ledger rows go to Ledger actors `ledger.<fleet>.<n>` (one per 250 agents), written through a background queue: the Ledger actor recomputes totals on every insert, which took 3.4 s at 1,000 agents. `FLEET_STATE=memory` turns all of this off.
- **Restart recovery**: `RealRuntimeService.resumeFleets()` runs after `RunManager.reconcile()`.
  - It rebuilds every running fleet from the actors.
  - Retiring slots finish their retire, active loops resume after their last logged step, and done or failed slots stay as they are.
  - The ledger is seeded from the Ledger actors; case counters come from the CaseLibrary; other stats come from the last snapshot (saved every 5 s).
  - `listCases` and `getRoster` for a fleet read the actors.
- **Relay**: these go to the real Agent Relay server first, through `gates.relay` (≤ 24 requests in flight):
  - case posts, on the fleet channel `cases-<fleet>` as `warden-<fleet>`;
  - case-thread replies, as the replying agent (registered lazily, token kept in the index);
  - chunk-revoke DMs to every reuser;
  - ✅/🚫 reactions.

  Routine chatter stays on the in-process FleetBus, and every feed item says which: `RelayMetadata.transport = "relay" | "in-process"`.
- **Caucus**:
  - Same-function agents in other teams come first, with no Jev gate, top-N by embedding similarity, running agents before finished ones. Other functions are filtered by Jev `lesson_relevant`.
  - Finished recipients are woken for one more step so they can reply.
  - The lesson reaches the case's team and every team with a recipient.
- **Vector cleansing**: when a function's code now fails its tests, the chunks its author made from that function are revoked, and every reuser gets a Relay DM.
- **Poisoning**:
  - Faults are armed only on agents whose chunks were reused at least once, and finished agents are woken so the fault fires.
  - Wave 2: once an F3 case has been broadcast, the same F3 instruction and the task's F4 fact are re-injected without the inbound Jev check. They go to agents in other teams whose team has the lesson, and to agents whose team does not. The result is in `FleetStats.poisonWaves`.

## Open

- **Throughput at 1,000 agents** (main gap): about 1 step/s overall. The 15-minute wall clock stopped the run with 68 agents done. The ledger write fix and the resume fix landed mid-run.
- **Thread cap race**: one thread got 4 replies, because concurrent replies at the cap both pass the check.
- **`RunManager.applyConcurrency`** resets the shared LLM cap whenever a normal run starts.
- **`herd.recordReply`** "own case" check uses slot numbers. The fleet views work around it with negative slots for other teams.

## Measured runs (real, gpt-6-luna, OpenRouter + direct OpenAI)

**100 agents** (`frwdx`): 25 teams, poisonRate 0.05, kill -9 crash test at 129 s. Wall time 258 s; cost $0.232.

| Feature | Measured |
| --- | --- |
| Agent kill | 10 injected (5 armed twice by a restart bug, since fixed), 10 caught, 0 spread. 8 retired, 8 respawned |
| Jev before delivery | 7 messages blocked, 2 of them poisoned facts |
| Vector kill | 12 chunks revoked; reuser DMs went over Relay. `context.cleansed` on respawns; poisonedContextTokensDropped −4,475 (replacement prompts are larger) |
| Caucus over Relay | 8 threads, 18 replies |
| Reuse | 554 chunk reuses, reuse_est 182,827 tokens |
| Wave 2 | with the lesson 6/6 rejected; without it 9/9 rejected. No measurable difference |
| Crash test | Cases 4 before the crash, 8 at the end. Ledger $0.095 before, continued to $0.232. Roster of 100 came back from the FleetShards |

**1,000 agents** (`f56bh`): 250 teams, 20 FleetShards + index, 4 Ledgers, 1 CaseLibrary, 3 ReasoningStores. Actor runtime peaked at 75 processes / 3.0 GB. Stopped by the 15-minute wall clock; cost $0.76; 6,410 durable ledger rows.

| Measured | Value |
| --- | --- |
| Agent records in FleetShards | 1,000 |
| Current-generation step rows | 2,926 |
| Durable cases (CaseLibrary) | 11 |
| Threads with recipients | 4 |
| Replies over Relay | 11 |
| Chunks created / reused / revoked | 716 / 4,322 / 7 |
| reuse_est (est.) | 1.73M tokens |
| Poison | 40 armed, 16 caught, 2 spread, 22 still pending at the stop |
| Wave 2 | 96 injected; with the lesson 13/13 decided rejected, without it 52/52 decided rejected; 0 accepted |
| Crash test at 318 s | Cases 1 → 6 after resume. Ledger $0.163 / 1,876 rows before, $0.269 / 2,682 rows after. Roster of 1,000 came back |
