#!/usr/bin/env bash
# Starts a throwaway durable-actors runtime from a temp copy of actors/ (HEAD actors.ts) on PORT,
# runs actors-probe.ts with the given args while sampling process count + RSS, then stops it.
# Usage: PORT=7194 scripts/scale-probe/actors-run.sh <shards> <agents> <steps> <tick|single>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-7194}"
TMP="$(mktemp -d)"
mkdir -p "$TMP/src"
git -C "$ROOT" show HEAD:actors/src/actors.ts > "$TMP/src/actors.ts"
cp "$ROOT/actors/package.json" "$ROOT/actors/tsconfig.json" "$ROOT/actors/bunfig.toml" "$TMP/"
ln -s "$ROOT/actors/node_modules" "$TMP/node_modules"
( cd "$TMP" && DURABLE_ACTORS_PORT="$PORT" exec bunx durable-actors dev --no-watch --port "$PORT" > "$TMP/dev.log" 2>&1 ) &
PID=$!
cleanup() { pkill -9 -P "$PID" 2>/dev/null || true; for p in $(ps -A -o pid=,ppid= | awk -v r="$PID" '$2==r{print $1}'); do pkill -9 -P "$p" 2>/dev/null || true; done; kill -9 "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
for _ in $(seq 90); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 1; done
( while true; do "$ROOT/scripts/scale-probe/tree-rss.sh" "$PID" >> "$TMP/rss.txt"; sleep 0.5; done ) &
MON=$!
DURABLE_ACTORS_CONTROL_PLANE_URL="http://127.0.0.1:$PORT" bun "$ROOT/scripts/scale-probe/actors-probe.ts" "$@"
kill "$MON"
echo "peak_processes $(sort -k1 -n "$TMP/rss.txt" | tail -1 | cut -d' ' -f1) peak_rss_mb $(sort -k2 -n "$TMP/rss.txt" | tail -1 | cut -d' ' -f2)"
