# scripts/demo

The on-stage driver for the 3-minute demo (`docs/BUILD_SPEC.md` "Demo runbook", `docs/SPEC.md` "Demo script";
the rehearsed script is `docs/demo-runbook.md`).
It prints a one-line **SAY:** cue per beat, then the live evidence for it. Every number comes from the orchestrator
API (REST + SSE `/api/events`); the only exception is the swarm fallback below, which prints the swarm engine's own
output. When the service is the mock, every line is prefixed `[MOCK]` and each beat header says "recorded, not measured".

| File | What it does |
| --- | --- |
| `preflight.sh [--offline]` | One GO / NO-GO line per check, then `PREFLIGHT: GO` or `NO-GO` (exit 1). Checks: `.env` present and every key from `.env.example` set (values never printed; `MODEL_PROFILE` and `WORKER_MODEL` are optional overrides), bun >= 1.4.2, `$NODE22` is Node v22, python3 >= 3.11 + pytest, ports `ACTORS_PORT` / `RELAY_PORT` / `ORCHESTRATOR_PORT` free or held by our own `.run/*.pid` tree, OpenRouter `GET /api/v1/key` (usage / limit / remaining, numbers only; NO-GO under `MIN_OPENROUTER_USD`, default 0.50), disk (`MIN_DISK_GB`, 5) and reclaimable RAM (`MIN_RAM_GB`, 2). |
| `demo.ts <beat\|all>` | The beats. `all` runs them in order and waits for Enter between beats; `--auto` advances by itself after `--pause-s` (default 3). Run `bun scripts/demo/demo.ts --help` for every option. |

## Beats

| # | name | does | evidence printed |
| --- | --- | --- | --- |
| 1 | `start` | `POST /api/runs {taskId: invoice_parser, mode: ours, stepDelayMs: 8000}` with a fresh library | run id, model, library; each agent's slot / subtask / status once all four finished step 1 |
| 2 | `reuse` | waits for a verified-note reuse | the Relay line and the ledger's `reuse_est_tokens` (est.), worker / overhead USD, Jev vs fallback calls |
| 3 | `possess` | `POST /api/runs/:id/possess` on `--slot`, default the slot owning the function the task's trap targets (`bench/tasks/<task>/task.json` `traps[0].trap_test`; `parse_line` = slot 1 for invoice_parser) | the HTTP result and the "Possess armed" status. If the service possessed a different slot, it says so and follows that slot |
| 4 | `recover` | waits for retire + case + replacement + `recovery` event for that slot | status changes, blocked message, case id / category / claim, test tail, Jev check, lesson, recipients, recovery ms and each stage (fault, detected, retire, case, respawn, tests passing) as + seconds |
| 5 | `herd` | waits for a `case.reply` from a recipient | the reply text and sender, recipients / replies count, run immunity counters (trap hits, repeats, broadcast, lessons adopted) |
| 6 | `crash` | live: `scripts/crash-test.sh --restart` (with `ORCHESTRATOR_PORT` taken from `--api`). MOCK: `POST /api/demo/crash` | before / after table (run, statuses, cases, ledger, feed), time until the API answers with a new boot id, SSE reconnect time, what survived. Live mode keeps polling up to 60 s for the actor leases to expire |
| 7 | `swarm` | 100 -> 1,000 -> 10,000 agents (`--swarm`) | per size: shards, handled, **lost**, rate, measured vs SIM. Tries `POST /api/swarm {agents}` (`--swarm-route`); on 404 it runs `orchestrator/src/swarm/run.ts --steps N` (with `--mock` when the service is MOCK) and says so |
| 8 | `bench` | reads `bench/results.summary.json` (`--summary`), else `GET /api/bench` | per mode: trials, passes, success, recovery s, repeat traps, USD per pass, and the claim sentence (or why there is none) |

Beats can run alone or in a list, by name or number: `demo.ts possess`, `demo.ts 4,5`. A standalone beat uses
`--run`, else the newest run, and reads the run's history from the SSE replay buffer, so `recover` still works if the
retire already happened.

## Stage sequence

Terminal 1 (before going on stage, about 2 minutes ahead):

```bash
scripts/demo/preflight.sh                  # every line GO
scripts/start-all.sh                       # actors, relay, orchestrator
# dashboard full screen, no MOCK badge; backup video open in another window
```

Terminal 2 (on stage), one command for the whole demo:

```bash
bun scripts/demo/demo.ts all               # Enter advances to the next beat
```

| time | beat | you |
| --- | --- | --- |
| 0:00 | 1 start | read the SAY line; point at the four Trusted cards |
| 0:20 | 2 reuse | point at the verified note in the feed and the reuse counter |
| 0:40 | 3 possess | say what is about to happen before pressing Enter on the next beat |
| 0:50 | 4 recover | narrate as lines arrive: false claim, test fails, message blocked, retire, case, replacement, timer |
| 1:30 | 5 herd | read the reply out; point at the immunity counters |
| 1:50 | 6 crash | dashboard shows "reconnecting"; keep talking ~30 s while actor leases expire |
| 2:30 | 7 swarm | read the lost column |
| 2:45 | 8 bench | read the claim line; close |

To rehearse without the real stack, against the mock on a spare port:

```bash
(cd orchestrator && ORCHESTRATOR_PORT=3303 bun run src/http/serve-live.ts --mock) &
bun scripts/demo/demo.ts all --auto --api http://127.0.0.1:3303
```

## If a beat fails

Each beat has a timeout (`--timeout-s`, default 240). On failure the driver prints `BEAT <name> FAILED: <why>` and a
`FALLBACK:` line, then goes on to the next beat; the summary at the end lists what passed. On stage: **say what happened
in one sentence, skip, keep going.** Never read out a number the screen did not show.

| beat | likely cause | what to do / say |
| --- | --- | --- |
| 1 start | orchestrator down, model or key error | `scripts/start-all.sh orchestrator`; or use the run started before going on stage: `demo.ts 2,3,4,5,6,7,8 --run <id>` |
| 2 reuse | no reuse yet in this run | "No note has been reused yet in this run"; point at the verified notes in the feed and go to Possess |
| 3 possess | `slot_not_active` / `run_finished` | `demo.ts 3,4,5 --slot <other trusted slot>`; if the run finished, skip to the crash test and say the fault drill is in the benchmark |
| 4 recover | timed out partway | read the last stage it printed ("it was retired, the case is still being written"); the case viewer shows what was filed |
| 5 herd | no reply in time | show the case's recipients in the case viewer; "the lesson was delivered; nobody has replied yet" |
| 6 crash | restart failed | `scripts/start-all.sh actors orchestrator` by hand; if not back in 30 s, switch to the backup video |
| 7 swarm | no route and no actor runtime for the CLI | skip; "the swarm numbers are in the README from the earlier run" only if you have that measured run |
| 8 bench | no summary and no rows | `bun bench/aggregate/aggregate.ts` before going on stage; otherwise the backup video's chart |

If more than one beat fails, switch to the backup video and talk over it.

## Known gaps (live mode)

- `POST /api/runs` in `orchestrator/src/http/api.ts` forwards only `taskId`, `mode` and `libraryId`, so the
  `stepDelayMs` the driver sends is dropped and the live run is not paced. Until the route forwards it, start the
  demo run with a pace that leaves time for Possess, or press Possess early.
- There is no HTTP route for `RuntimeService.startSwarm` yet. Beat 7 falls back to the swarm CLI, which in live mode
  needs the actor runtime and the generated client (real `SwarmShard`s, `measured: true`). Pass `--swarm-route` when
  the route lands.
- After a mock crash the mock replays its recording from the start, so beat 6 in MOCK shows reconnection, not
  persistence; the driver prints this.
