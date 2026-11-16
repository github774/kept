#!/usr/bin/env bash
# Regenerate the typed actor client into actors/generated/ (run after every method change).
# Needs the runtime up (bunx durable-actors dev); falls back to compiling src/actors.ts directly.
set -euo pipefail
cd "$(dirname "$0")/.."
export DURABLE_ACTORS_CONTROL_PLANE_URL="${DURABLE_ACTORS_CONTROL_PLANE_URL:-http://127.0.0.1:${ACTORS_PORT:-7100}}"
export DURABLE_ACTORS_PROJECT_ID="${DURABLE_ACTORS_PROJECT_ID:-local}"
if curl -fsS -o /dev/null "$DURABLE_ACTORS_CONTROL_PLANE_URL" 2>/dev/null || lsof -nP -iTCP:"${DURABLE_ACTORS_CONTROL_PLANE_URL##*:}" -sTCP:LISTEN >/dev/null 2>&1; then
  bunx durable-actors generate --out-dir generated
else
  echo "[gen] runtime not reachable at $DURABLE_ACTORS_CONTROL_PLANE_URL; compiling src/actors.ts locally" >&2
  bunx durable-actors generate --out-dir generated src/actors.ts
fi
echo "[gen] client written to $(pwd)/generated"
