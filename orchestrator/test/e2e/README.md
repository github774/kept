# End-to-end suite (`run-e2e.ts`)

Runs against a **running** orchestrator over REST + SSE (`/api/*`, `/api/events`). It encodes the
BUILD_SPEC Scope "Done when" rows and the Demo runbook beats. It is not part of `bun test`: the file is
not named `*.test.ts`, and it needs a live stack.

```sh
cd orchestrator
bun test/e2e/run-e2e.ts                         # every scenario except runbook, against http://127.0.0.1:3000
bun test/e2e/run-e2e.ts runbook                 # definition of done: every demo beat, twice in a row
bun test/e2e/run-e2e.ts possess herd --api http://127.0.0.1:3092
E2E_API=http://127.0.0.1:3092 bun test/e2e/run-e2e.ts all --json /tmp/e2e.json
```

Options: `--api URL` (or env `E2E_API`), `--task ID` (default `invoice_parser`), `--slot N` (Possess
target, default 3), `--agents N` (default 4), `--step-delay MS` (`stepDelayMs` sent with POST /api/runs,
env `E2E_STEP_DELAY_MS`, default 1500), `--timeout-scale X`, `--direct-swarm[=mock]`, `--swarm-agents N`
(default 1000), `--crash-cmd CMD`, `--json FILE`, `--strict`.

Exit code: 1 if any scenario FAILs; 3 with `--strict` if the only problems are GAPs; otherwise 0.

## Output

Every check prints one line, and each scenario ends with one line:
`PASS|FAIL|GAP|SKIP <scenario> (secs) [counts] runId=... caseId=... recovery_ms=...`.

| Status | Meaning |
| --- | --- |
| PASS | Assertion held. |
| FAIL | Assertion did not hold, or a wait hit its timeout. Every scenario also has a hard timeout. |
| GAP | An optional contract field or route was absent (for example `RunSummary.immunity`, `CaseFile.replies`, `recovery.stages`, or `POST /api/swarm/start`). The suite never fills these in. |
| SKIP | The API does not expose this by design: prompt contents, ledger rows, net savings before a baseline run exists. |
| LIVE-ONLY | Only meaningful against the real stack, and the mock did not meet it. On a live server (`/api/meta` mock=false) these checks are FAILs. |

## Scenarios

The standalone scenarios share **one** demo run, started lazily, so a live suite pays for one run and
one possession. They run in this order no matter how you list them: possess, jev-block, herd, reuse,
ledger, crash, fleet, swarm, runbook. Possess has to land before the run finishes, and `fleet` waits
for the finish.

| Scenario | BUILD_SPEC source | Asserts |
| --- | --- | --- |
| fleet | Worker loop; runbook beat 1 | The run starts on a fresh (empty) case library. 4 agents are trusted at the same moment, named `w<slot>-g<gen>-<runId>`. GET roster returns the agents. The Relay feed has messages on `fleet-<runId>`. The run reaches `finished` with `testsPassing == testsTotal`, and `endedAt` is set. If the run had a case, `immunity.repeatTrapHits == 0`. |
| possess | Fault injection + Retire and respawn; beats 3-4 | The slot is mid-run (step >= 1) when Possess is pressed, and POST possess returns ok. The agent goes under_investigation, then is retired. `case.created` arrives with id `<runId>.<slot>.g<gen>`, a claim, `testOutput` showing the failure, a category and a lesson. The replacement at gen+1 is on probation, `case.replacement` matches it, and its name follows the scheme. A `recovery` event follows the retire; all 6 stages are non-null and in order, and `ms == testsPassingAt - detectedAt`. Tests then pass again, and the run shows retires >= 1 and cases >= 1. |
| jev-block | Jev checks; beat 4 | After Possess, a `relay.message` from the possessed agent carries `blocked` with a non-empty reason. It comes from `instruction_conflicts_spec` with source jev or fallback, and with Jev p >= 0.62 (DECISIONS #10). GET /relay still holds it as blocked. |
| herd | Herd immunity; beat 5 | The case is posted to `cases-<runId>` by `warden-<runId>`, and at least one `case.reply` arrives. GET /api/cases/:id shows 1-3 recipients that exclude the author, a lesson, and evidence. Replies number 1-3 and come only from recipients. The case is listed by run and by library. The immunity counters show casesBroadcast >= 1 and lessonsAdopted >= 1 (the wait lasts until the run ends), with repeatTrapHits == 0. "Lesson in later prompts" is SKIP because prompts are not exposed. |
| reuse | Shared verified reasoning; beat 2 | `ledger.totals.reuse_est_tokens > 0`, with `est.reuse_est_tokens === true`. If a feed message mentions reuse it is shown; otherwise SKIP, since the contract has no chunk-reused event. |
| ledger | Token ledger | For the latest totals streamed for this run: tokens.{input,cached,output,reasoning} equal the sum over by_category; cached <= input and reasoning <= output; worker_usd equals worker.usd; overhead_usd equals the sum of the non-worker categories; calls.jev and calls.fallback equal their categories; and run.usd ≈ worker_usd + overhead_usd. "Totals == sum of rows" is tried against `/api/runs/:id/ledger/rows`, `/api/ledger/:id/rows` and `?rows=1`, and is SKIP if none of them exists. |
| crash | Durable Actors state; beat 6 | Takes a snapshot (roster, cases, ledger, run), then crashes the stack. Live, it runs `scripts/crash-test.sh --restart` with ORCHESTRATOR_PORT taken from `--api` (or `--crash-cmd`) and requires `CRASH TEST: PASS` and `RESTART: OK`. On the mock it calls `POST /api/demo/crash` and never the script. It then waits for a new bootId and for SSE to reconnect with `restarted/gap`. It polls up to 120 s, because actors answer "unavailable" for about 30 s, then compares. Roster: same slots, gen never lower, status never regressed at the same gen, step >= pre-1. Cases: same ids, lessons, categories, recipients and replies. Ledger: no total lower than before. Run counters: not lost. Finally, this run's events flow again and some agent's step advances (or the run finishes). |
| swarm | Swarm (stretch), DECISIONS #13 | Sends `POST /api/swarm/start {agents:1000, ticks:10}`. If the route returns 404, the result is SKIP, or with `--direct-swarm` it is GAP and the suite calls `src/swarm/launch.ts` `startSwarm` in-process instead (the function both RuntimeService implementations delegate to); `=mock` forces MOCK shards. The final `swarm.stats` is the last one after 5 s of quiet. It asserts agents == 1000, lost == 0, handled <= agents×ticks, and measured == true (LIVE-ONLY). |
| runbook | Definition of done | Runs two rounds, each on a new run with a fresh library. Pre: meta.mock false, Jev online and not mock, a new runId in round 2. Beat 1: grid and feed (fleet start). Beat 2: reuse. Beat 3: Possess. Beat 4: the possess chain and jev-block, concurrently. Beat 5: herd. Beat 6: crash. Beat 7: finish, ledger, and GET /api/bench (rows present, none mock, ours plus codex_baseline). |

## Live-only vs mock

`serve-live.ts --mock` replays `mock/events.jsonl` (runId `mock01`, about 61 s, then it loops). The suite
detects the replay restarting inside one process (a second `run.status starting` in the same boot) and
ignores the later pass. Results on the mock:

- Everything in possess, jev-block, herd, reuse, ledger and fleet passes on the mock with `--slot 3`
  (the recorded slot). `--slot 1` also passes possess and jev-block through the mock's remapping. On
  the mock, slot 1 owns the trap function `parse_line`, so after possessing it nobody else meets the
  trap and `lessonsAdopted` correctly stays 0. Live, possess a slot that does not own the trap.
- These are LIVE-ONLY: "not mock" flags (meta, run, Jev, bench rows); everything restored after the crash
  (the mock replays from scratch after `/api/demo/crash`); a new runId per round; swarm `measured`.
- The mock ignores `stepDelayMs`.

Last validation (2026-10-31, mock on :3342): the default set passed every scenario except swarm, which
is GAP because the route is missing; `runbook` PASSED both rounds (156 PASS, 8 SKIP, 19 LIVE-ONLY, about 190 s).

## Known gaps for the integrator

- `POST /api/runs` in `src/http/api.ts` does not forward `stepDelayMs` to `StartRunOpts`. Live demo
  pacing depends on it: without it, Possess can fail with `run_finished`, and the check says so.
- There is no `POST /api/swarm/start` route (`RuntimeService.startSwarm` exists). The swarm scenario
  reports GAP or SKIP until it is added.
- There is no ledger rows endpoint, so "totals == sum of API usage fields" can only be checked
  internally (by_category vs totals). Exposing rows would turn the SKIP into a real check.
- Prompt contents (verified notes and the lessons block in later prompts) are not observable over the
  API. Those beats are SKIP and have to be checked in the orchestrator logs.

## Safety

- `crash` on a live server kills whatever listens on ACTORS_PORT (from `.env`) and on the `--api` port,
  then restarts both with `scripts/start-all.sh`. Run it only against the stack you mean to crash.
- Against a mock (`/api/meta` mock=true) the suite never runs `crash-test.sh`.
