// Config-wired entry point for the Relay layer. Import bus.ts directly for config-free use (tests).
import { join } from "node:path";
import { REPO_ROOT, config } from "../config.ts";
import { createRelayBus, relayStateFileFor, type RelayBus } from "./bus.ts";

export * from "./bus.ts";
export * from "./reactions.ts";

const RELAY_DIR = join(REPO_ROOT, ".relay");
/** Pre-per-port shared state file. Read once for migration into the keyed file; never written. */
export const LEGACY_RELAY_STATE_FILE = join(RELAY_DIR, "workspace.json");
/** One workspace file per engine (`.relay/workspace-<port>.json`), so stacks on other ports never clobber
 * each other's key. RELAY_STATE_FILE env overrides. */
export const RELAY_STATE_FILE = process.env.RELAY_STATE_FILE || relayStateFileFor(RELAY_DIR, config.env.relayBaseUrl);

/** RELAY_MOCK=1 permits a labeled in-memory MOCK when the engine is down; otherwise it throws. */
export function relayBusFromConfig(): Promise<RelayBus> {
  return createRelayBus({
    baseUrl: config.env.relayBaseUrl,
    stateFile: RELAY_STATE_FILE,
    legacyStateFile: LEGACY_RELAY_STATE_FILE,
    workspaceName: "smarter-subagents",
    repliesPerThread: config.caps.replies_per_case_thread,
    allowMock: process.env.RELAY_MOCK === "1",
  });
}
