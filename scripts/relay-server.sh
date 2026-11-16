#!/usr/bin/env bash
# Runs the Agent Relay local engine on Node 22 (DECISIONS #5). Port from RELAY_PORT (no default).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Load .env without overriding variables already exported (so start-all.sh can pick ports).
_pre_port="${RELAY_PORT-}"; _pre_node="${NODE22-}"
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi
[[ -n "$_pre_port" ]] && RELAY_PORT="$_pre_port"
[[ -n "$_pre_node" ]] && NODE22="$_pre_node"
: "${RELAY_PORT:?RELAY_PORT is not set (put it in .env)}"
NODE22="${NODE22:-/opt/homebrew/opt/node@22/bin/node}"
[[ -x "$NODE22" ]] || { echo "Node 22 not found at $NODE22" >&2; exit 1; }
mkdir -p "$ROOT/.relay"
cd "$ROOT"
export PATH="$(dirname "$NODE22"):$PATH"
exec npx --yes @relaycast/engine@12.3.0 --db ./.relay/relaycast.db --port "$RELAY_PORT"
