# scripts

Process control for the local stack. Ports come from `.env` (`ACTORS_PORT`, `RELAY_PORT`,
`ORCHESTRATOR_PORT`); variables already exported in your shell win over `.env`. Pids and logs go to
`.run/` (git-ignored; override with `RUN_DIR`).

| Script | What it does |
| --- | --- |
| `start-all.sh [actors] [relay] [orchestrator]` | Starts each in the background, each in its own process group, and waits until its port is listening. Fails loudly (with the log tail) if a process exits early or the port is not up within `STARTUP_TIMEOUT` seconds (default 120). Refuses to start if the port is held by something it did not start. |
| `crash-test.sh [--restart]` | Demo runbook step 6. `kill -9` on the whole process tree of the actor runtime and the orchestrator, then checks nothing listens on their ports and no process from those trees is left. Prints `CRASH TEST: PASS` or `FAIL` (exit 1). Never touches the Relay engine. `--restart` runs `start-all.sh actors orchestrator` afterwards. |
| `stop-all.sh [orchestrator] [relay] [actors]` | Graceful stop: SIGTERM to each tree, waits up to `STOP_TIMEOUT` (default 15 s), then SIGKILL for leftovers. |
| `relay-server.sh` | Relay engine on Node 22 (used by `start-all.sh`). |
| `relay-bootstrap.sh` | One-time Relay workspace setup. |

Logs: `.run/actors.log`, `.run/relay.log`, `.run/orchestrator.log`.

Subfolders: `demo/` is the on-stage demo driver (see `demo/README.md`), `smoke/` the real-API smoke checks
(results in `docs/SMOKE.md`), `scale-probe/` the one-off throughput probes for LLM calls, pytest, Relay and actors
(usage is in each file's header comment).

## Demo crash test

```bash
scripts/start-all.sh            # before going on stage
scripts/crash-test.sh           # on stage: kill -9; dashboard shows "reconnecting"
scripts/start-all.sh actors orchestrator   # or: scripts/crash-test.sh --restart
```

How the kill finds its targets: the pid listening on each port, its `durable-actors` (or
orchestrator) parent processes, the pids in `.run/actors.pid` and `.run/orchestrator.pid`, and all
descendants of those (`pgrep -P`, recursively). The actor runtime spawns a native host plus a bun
executor for each awake actor, so killing only the listener would leave them running. Pids that
belong to the Relay engine are skipped even if they turn up in the scan.

**The restart is not instant.** The ports come back within a couple of seconds, but after a `kill -9`
the dead host still holds the lease on every actor that was awake. Those actors answer
`unavailable` for about 30 s, until the lease expires (measured: 14 s and 29 s on two runs). The
orchestrator's reconcile retries `unavailable`, so statuses, cases and ledger rows come back by
themselves. Keep talking for half a minute.

## A second stack on other ports

To test without disturbing a running stack, export other ports, a separate data dir and run dir:

```bash
export ACTORS_PORT=7192 ORCHESTRATOR_PORT=3092 RELAY_PORT=8792
export DURABLE_ACTORS_DATA_DIR=/tmp/da-test RUN_DIR=/tmp/run-test
scripts/start-all.sh actors orchestrator && scripts/crash-test.sh --restart && scripts/stop-all.sh
```

`start-all.sh` also sets `DURABLE_ACTORS_PORT`, and derives `DURABLE_ACTORS_CONTROL_PLANE_URL` and
`RELAY_BASE_URL` from the ports unless you exported them yourself. `ORCHESTRATOR_CMD` replaces
`bun run dev` (for example a stand-in server while main.ts has no listener).

Caveat: `relay-server.sh` sources `.env` with `set -a`, so it always uses the `.env` `RELAY_PORT`, not
an exported one. Start the Relay on another port only after that script stops overriding it.
