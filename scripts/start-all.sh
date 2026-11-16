#!/usr/bin/env bash
# Start the actor runtime, the Relay engine and the orchestrator in the background.
# Pids and logs go to .run/ (override with RUN_DIR). Waits until each port is listening.
#
# Usage: scripts/start-all.sh [actors] [relay] [orchestrator]   (no args = all three, in that order)
#
# Ports come from .env (ACTORS_PORT, RELAY_PORT, ORCHESTRATOR_PORT). Variables already exported in
# the calling shell win over .env, so a second stack can run on other ports, e.g.
#   ACTORS_PORT=7192 RELAY_PORT=8792 ORCHESTRATOR_PORT=3092 DURABLE_ACTORS_DATA_DIR=/tmp/da scripts/start-all.sh
# Other overrides: STARTUP_TIMEOUT (seconds, default 120), ORCHESTRATOR_CMD (default "bun run dev").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env without overriding anything already exported. Values are never printed.
load_env() {
    local line key
    [[ -f "$ROOT/.env" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
        key="${BASH_REMATCH[2]}"
        [[ -n "${!key+x}" ]] && continue
        eval "export ${line#export }"
    done < "$ROOT/.env"
}
# Derived URLs must follow the ports even if .env hard-codes the default port in them.
url_overrides_before_env() {
    URL_SET_CP="${DURABLE_ACTORS_CONTROL_PLANE_URL+x}"
    URL_SET_RELAY="${RELAY_BASE_URL+x}"
}
url_overrides_before_env
load_env
: "${ACTORS_PORT:?ACTORS_PORT is not set (put it in .env)}"
: "${RELAY_PORT:?RELAY_PORT is not set (put it in .env)}"
: "${ORCHESTRATOR_PORT:?ORCHESTRATOR_PORT is not set (put it in .env)}"
[[ -z "$URL_SET_CP" ]] && export DURABLE_ACTORS_CONTROL_PLANE_URL="http://127.0.0.1:$ACTORS_PORT"
[[ -z "$URL_SET_RELAY" ]] && export RELAY_BASE_URL="http://127.0.0.1:$RELAY_PORT"
export DURABLE_ACTORS_PORT="$ACTORS_PORT"

RUN_DIR="${RUN_DIR:-$ROOT/.run}"
TIMEOUT="${STARTUP_TIMEOUT:-120}"
mkdir -p "$RUN_DIR"

listen_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
alive() { kill -0 "$1" 2>/dev/null; }
die() { echo "start-all: FAIL: $*" >&2; exit 1; }

# start <name> <port> <dir> <command...>
start() {
    local name="$1" port="$2" dir="$3"; shift 3
    local pidf="$RUN_DIR/$name.pid" log="$RUN_DIR/$name.log" holder pid
    holder="$(listen_pid "$port")"
    if [[ -n "$holder" ]]; then
        if [[ -f "$pidf" ]] && alive "$(cat "$pidf")"; then
            echo "start-all: $name already running (pid $(cat "$pidf")), :$port listening"
            return 0
        fi
        die "$name: port $port is already held by pid $holder ($(ps -o comm= -p "$holder" 2>/dev/null)), not started by this script; stop it or use another port"
    fi
    echo "=== $(date '+%F %T') start-all: $name on :$port: $*" >> "$log"
    # set -m gives the job its own process group, so stop-all can signal the whole group.
    set -m
    (cd "$dir" && exec nohup "$@" < /dev/null >> "$log" 2>&1) &
    pid=$!
    set +m
    echo "$pid" > "$pidf"
    echo -n "start-all: $name (pid $pid) waiting for :$port "
    local deadline=$((SECONDS + TIMEOUT))
    while [[ -z "$(listen_pid "$port")" ]]; do
        if ! alive "$pid"; then
            echo; echo "---- last lines of $log ----" >&2; tail -n 30 "$log" >&2
            die "$name exited before listening on :$port (log: $log)"
        fi
        if (( SECONDS >= deadline )); then
            echo; echo "---- last lines of $log ----" >&2; tail -n 30 "$log" >&2
            die "$name not listening on :$port after ${TIMEOUT}s (pid $pid still running; log: $log)"
        fi
        echo -n "."; sleep 0.5
    done
    echo " up (listener pid $(listen_pid "$port"))"
}

components=("$@")
[[ ${#components[@]} -eq 0 ]] && components=(actors relay orchestrator)
for c in "${components[@]}"; do
    case "$c" in
        actors)       start actors "$ACTORS_PORT" "$ROOT/actors" bunx durable-actors dev --no-watch --port "$ACTORS_PORT" ;;
        relay)        start relay "$RELAY_PORT" "$ROOT" bash "$ROOT/scripts/relay-server.sh" ;;
        orchestrator)
            if [[ -n "${ORCHESTRATOR_CMD:-}" ]]; then
                start orchestrator "$ORCHESTRATOR_PORT" "$ROOT/orchestrator" bash -c "exec $ORCHESTRATOR_CMD"
            else
                start orchestrator "$ORCHESTRATOR_PORT" "$ROOT/orchestrator" bun run dev
            fi ;;
        *) die "unknown component '$c' (expected actors, relay, orchestrator)" ;;
    esac
done
echo "start-all: OK (${components[*]}); pids and logs in $RUN_DIR"
