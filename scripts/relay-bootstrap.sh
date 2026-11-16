#!/usr/bin/env bash
# Bootstraps the Relay workspace once (key + admin token -> .relay/workspace-<port>.json, gitignored;
# one file per engine port, so a stack on another port never overwrites the default 8787 key).
# Requires the engine (scripts/relay-server.sh) to be running. Idempotent: reuses the stored key, and
# migrates a legacy .relay/workspace.json for the same engine if its key still works.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/orchestrator"
exec bun --env-file=../.env -e '
import { createRelayBus, relayStateFileFor } from "./src/relay/bus.ts";
const baseUrl = process.env.RELAY_BASE_URL!;
const stateFile = process.env.RELAY_STATE_FILE || relayStateFileFor("../.relay", baseUrl);
const bus = await createRelayBus({ baseUrl, stateFile, legacyStateFile: "../.relay/workspace.json", workspaceName: "smarter-subagents", repliesPerThread: 3, allowMock: false });
console.log(`[relay] workspace ready; state in ${stateFile}`); await bus.close(); process.exit(0);'
