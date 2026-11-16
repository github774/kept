// Thin typed wrapper over the generated Durable Actors client (actors/generated, built by actors/scripts/gen.sh).
// The orchestrator is the only caller of actors; actors never call each other or the network.
// Client config comes from env: DURABLE_ACTORS_CONTROL_PLANE_URL (default http://127.0.0.1:7100), DURABLE_ACTORS_PROJECT_ID.
import { fileURLToPath } from "node:url"
import { actors, ActorInvocationError } from "../../actors/generated/index.js"

export { actors, ActorInvocationError }
export type {
    ActorRpcTransport,
    SocketGrant,
} from "../../actors/generated/index.js"
export type {
    AgentInfo,
    CaseFile,
    CaseInput,
    Checkpoint,
    Chunk,
    ChunkInput,
    LedgerCategory,
    LedgerEntry,
    LedgerTotals,
    RosterSummary,
    RunInfo,
    RunMode,
    RunStatus,
    SlotHistory,
    Reassignment,
    SlotStatus,
    SlotSummary,
    StepInput,
    StepRecord,
    SwarmChange,
    SwarmStats,
    TokenTotals,
} from "../../actors/src/actors.ts"

/** Absolute path of the generated client directory (regenerate with actors/scripts/gen.sh after any actor change). */
export const GENERATED_DIR = fileURLToPath(new URL("../../actors/generated/", import.meta.url))

/** Actor ID builders (BUILD_SPEC "Actors"): letters, digits, dots, underscores, hyphens; max 128 chars. */
export const ids = {
    fleet: (runId: string) => `run.${runId}`,
    agent: (runId: string, slot: string, gen: number) => `agent.${runId}.${slot}.g${gen}`,
    cases: (libraryId: string) => `cases.${libraryId}`,
    chunks: (runId: string) => `chunks.${runId}`,
    ledger: (runId: string) => `ledger.${runId}`,
    swarm: (runId: string, shard: number) => `swarm.${runId}.${shard}`,
    caseId: (runId: string, slot: string, gen: number) => `${runId}.${slot}.g${gen}`,
    ledgerEntry: (runId: string, slot: string, gen: number, step: number, n: number) => `${runId}.${slot}.g${gen}.s${step}.${n}`,
} as const

/** Typed handles for one run. */
export function runActors(runId: string, libraryId: string = runId) {
    return {
        fleet: actors.Fleet.get(ids.fleet(runId)),
        agent: (slot: string, gen: number) => actors.Agent.get(ids.agent(runId, slot, gen)),
        cases: actors.CaseLibrary.get(ids.cases(libraryId)),
        chunks: actors.ReasoningStore.get(ids.chunks(runId)),
        ledger: actors.Ledger.get(ids.ledger(runId)),
        swarm: (shard: number) => actors.SwarmShard.get(ids.swarm(runId, shard)),
    }
}

/**
 * Retries a call while the runtime answers "unavailable". After a kill -9 the dead host's owner lease
 * must expire (measured ~30 s locally) before those actors reactivate. All actor writes are idempotent
 * (ids / generations), so retrying is safe. "outcome_unknown" is NOT retried here: callers decide.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; onWait?: (err: unknown) => void } = {}): Promise<T> {
    const end = Date.now() + (opts.timeoutMs ?? 90_000)
    for (;;) {
        try {
            return await fn()
        } catch (err) {
            if ((err as { code?: unknown }).code !== "unavailable" || Date.now() > end) throw err
            opts.onWait?.(err)
            await Bun.sleep(opts.intervalMs ?? 2_000)
        }
    }
}
