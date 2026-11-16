#!/usr/bin/env bash
# Graceful stop: SIGTERM the orchestrator, Relay engine and actor runtime (whole process trees),
# wait up to STOP_TIMEOUT seconds (default 15) for their ports to close, then SIGKILL leftovers.
#
# Usage: scripts/stop-all.sh [orchestrator] [relay] [actors]   (no args = all three)
# Targets are the pids in .run/ (RUN_DIR) and their descendants, plus whatever listens on the
# component's port. Same env rules as start-all.sh (exported vars win over .env).
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
RUN_DIR="${RUN_DIR:-$ROOT/.run}"
TIMEOUT="${STOP_TIMEOUT:-15}"

listen_pids() { [[ -n "$1" ]] && lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u; }
alive() { kill -0 "$1" 2>/dev/null; }
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

# stop <name> <port>
stop() {
    local name="$1" port="$2" pidf="$RUN_DIR/$1.pid" root="" tree
    [[ -f "$pidf" ]] && root="$(cat "$pidf")"
    tree="$(descendants $root $(listen_pids "$port"))"
    if [[ -z "$tree" ]]; then
        echo "stop-all: $name not running"; rm -f "$pidf"; return 0
    fi
    echo "stop-all: $name SIGTERM $(echo $tree | wc -w | tr -d ' ') processes (root ${root:-none}, :$port)"
    kill -TERM $tree 2>/dev/null
    local deadline=$((SECONDS + TIMEOUT)) left
    while :; do
        left=""; for p in $tree; do alive "$p" && left="$left $p"; done
        [[ -z "$left" && -z "$(listen_pids "$port")" ]] && break
        if (( SECONDS >= deadline )); then
            # Re-scan: children may have been spawned during shutdown.
            left="$(descendants $left $(listen_pids "$port"))"
            echo "stop-all: $name still alive after ${TIMEOUT}s, SIGKILL:" $left
            kill -9 $left 2>/dev/null; sleep 0.5; break
        fi
        sleep 0.25
    done
    rm -f "$pidf"
    if [[ -n "$(listen_pids "$port")" ]]; then echo "stop-all: FAIL: :$port still listening" >&2; return 1; fi
    echo "stop-all: $name stopped"
}

components=("$@")
[[ ${#components[@]} -eq 0 ]] && components=(orchestrator relay actors)
rc=0
for c in "${components[@]}"; do
    case "$c" in
        orchestrator) stop orchestrator "${ORCHESTRATOR_PORT:-}" || rc=1 ;;
        relay)        stop relay "${RELAY_PORT:-}" || rc=1 ;;
        actors)       stop actors "${ACTORS_PORT:-}" || rc=1 ;;
        *) echo "stop-all: unknown component '$c'" >&2; rc=1 ;;
    esac
done
exit $rc
