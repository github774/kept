#!/usr/bin/env bash
# Demo crash test (BUILD_SPEC demo runbook step 6): kill -9 the actor runtime and the orchestrator,
# whole process trees, then verify both are really gone. The Relay engine is never touched.
#
# Usage: scripts/crash-test.sh [--restart]
#   --restart   after a PASS, start the actor runtime and orchestrator again (scripts/start-all.sh)
#
# Targets: the pid listening on ACTORS_PORT / ORCHESTRATOR_PORT, its durable-actors / orchestrator
# ancestors, the pids in .run/actors.pid and .run/orchestrator.pid, and every descendant of those
# (pgrep -P, recursively: the runtime spawns a native host + bun executor per awake actor).
# Same env rules as start-all.sh (exported vars win over .env; RUN_DIR overrides .run/).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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
load_env
: "${ACTORS_PORT:?ACTORS_PORT is not set (put it in .env)}"
: "${ORCHESTRATOR_PORT:?ORCHESTRATOR_PORT is not set (put it in .env)}"
RELAY_PORT="${RELAY_PORT:-}"
RUN_DIR="${RUN_DIR:-$ROOT/.run}"

RESTART=0
for a in "$@"; do
    case "$a" in
        --restart) RESTART=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "crash-test: unknown option $a" >&2; exit 2 ;;
    esac
done

log() { echo "[crash-test] $*"; }
listen_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u; }
alive() { kill -0 "$1" 2>/dev/null; }
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
cmd_of() { ps -o command= -p "$1" 2>/dev/null; }
pidfile() { [[ -f "$RUN_DIR/$1.pid" ]] && cat "$RUN_DIR/$1.pid" 2>/dev/null; }

# descendants <pid...>: the pids given plus all descendants (pgrep -P, recursive), one per line.
descendants() {
    local queue=("$@") out=() p kids
    while [[ ${#queue[@]} -gt 0 ]]; do
        p="${queue[0]}"; queue=("${queue[@]:1}")
        [[ -z "$p" ]] && continue
        alive "$p" || continue
        out+=("$p")
        kids="$(pgrep -P "$p" 2>/dev/null || true)"
        [[ -n "$kids" ]] && queue+=($kids)
    done
    [[ ${#out[@]} -gt 0 ]] && printf '%s\n' "${out[@]}" | sort -un
}

# roots <name> <port> <ancestor-regex>: listener pids, matching ancestors, and the .run pid.
roots() {
    local name="$1" port="$2" re="$3" p a
    for p in $(listen_pids "$port"); do
        echo "$p"
        a="$(ppid_of "$p")"
        while [[ -n "$a" && "$a" -gt 1 && "$a" != "$$" ]] && [[ "$(cmd_of "$a")" =~ $re ]]; do
            echo "$a"; a="$(ppid_of "$a")"
        done
    done
    p="$(pidfile "$name")"
    [[ -n "$p" ]] && alive "$p" && echo "$p"
    return 0
}

ACT_RE='durable-actors'
ORC_RE='src/main\.ts|bun run dev|orchestrator'

# Never touch the Relay engine (or ourselves).
protected="$( { [[ -n "$RELAY_PORT" ]] && listen_pids "$RELAY_PORT"; pidfile relay; } | xargs -n1 2>/dev/null | sort -u)"
protected="$(descendants $protected; echo $$; echo $PPID)"

collect() {
    local all p
    all="$( { roots actors "$ACTORS_PORT" "$ACT_RE"; roots orchestrator "$ORCHESTRATOR_PORT" "$ORC_RE"; } | sort -un)"
    [[ -z "$all" ]] && return 0
    for p in $(descendants $all); do
        grep -qx "$p" <<< "$protected" && { echo "[crash-test] skipping protected pid $p (relay or self)" >&2; continue; }
        echo "$p"
    done
}

# Collect until the set is stable, so a child spawned mid-scan is not missed.
targets="$(collect)"
for _ in 1 2 3; do
    again="$(collect)"; [[ "$again" == "$targets" ]] && break; targets="$again"
done
# Process groups led by a target (start-all.sh gives each service its own group). Groups led by
# something else (a terminal, another tool's shell) are ignored so nothing unrelated is reported.
pgids="$(for p in $targets; do g="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"; grep -qx "$g" <<< "$targets" && echo "$g"; done | sort -un)"

if [[ -z "$targets" ]]; then
    log "nothing to kill: no listener on :$ACTORS_PORT or :$ORCHESTRATOR_PORT and no live pids in $RUN_DIR"
else
    log "kill -9 $(echo $targets | wc -w | tr -d ' ') processes (actor runtime + orchestrator trees):"
    ps -o pid=,ppid=,command= -p "$(echo $targets | tr ' ' ',')" 2>/dev/null | cut -c1-140 | sed 's/^/    /'
    kill -9 $targets 2>/dev/null
fi

# Wait up to 10 s for the kernel to release the ports.
for _ in $(seq 1 40); do
    [[ -z "$(listen_pids "$ACTORS_PORT")$(listen_pids "$ORCHESTRATOR_PORT")" ]] && break
    sleep 0.25
done

fail=0
for port in "$ACTORS_PORT" "$ORCHESTRATOR_PORT"; do
    l="$(listen_pids "$port" | tr '\n' ' ')"
    if [[ -n "$l" ]]; then log "FAIL: :$port still listening (pid $l)"; fail=1; else log "ok: nothing listening on :$port"; fi
done
left=""
for p in $targets; do alive "$p" && left="$left $p"; done
# Anything still in the killed process groups (children forked after the scan) also counts.
for g in $pgids; do
    for p in $(pgrep -g "$g" 2>/dev/null); do grep -qx "$p" <<< "$protected" || left="$left $p"; done
done
left="$(echo $left | xargs -n1 2>/dev/null | sort -un | tr '\n' ' ')"
if [[ -n "$left" ]]; then log "FAIL: processes still alive: $left"; fail=1; else log "ok: no process from the killed trees remains"; fi
if [[ -n "$RELAY_PORT" ]]; then
    r="$(listen_pids "$RELAY_PORT" | xargs)"
    if [[ -n "$r" ]]; then log "relay :$RELAY_PORT still listening (pid $r), untouched"; else log "relay :$RELAY_PORT not running (was not touched)"; fi
fi
rm -f "$RUN_DIR/actors.pid" "$RUN_DIR/orchestrator.pid"

if [[ $fail -ne 0 ]]; then echo "CRASH TEST: FAIL"; exit 1; fi
echo "CRASH TEST: PASS (actor runtime and orchestrator are dead)"

if [[ $RESTART -eq 1 ]]; then
    log "restarting actor runtime and orchestrator"
    t0=$SECONDS
    "$ROOT/scripts/start-all.sh" actors orchestrator || { echo "RESTART: FAIL"; exit 1; }
    log "both ports listening after $((SECONDS - t0)) s. Actors that were awake at the kill answer"
    log "\"unavailable\" for ~30 s until their old lease expires; the orchestrator's reconcile retries."
    echo "RESTART: OK"
fi
