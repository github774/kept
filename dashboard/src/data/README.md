# Dashboard data layer

Import from `"../data"`. View-model types come from `./model` and are also re-exported from `"../data"`.

Wire types are `@contract/types`, which re-exports `orchestrator/src/contract.ts`. Panels never use them directly. `adapt.ts` turns them into the view model.

API base URL: `import.meta.env.VITE_API_URL`, default `http://127.0.0.1:3000`. Dev server: `cd orchestrator && PORT=3000 bun run src/http/dev-mock.ts`.

## Files

| File | Role |
| --- | --- |
| `model.ts` | View model: `Snapshot`, `RunInfo`, `AgentSlot`, `RelayMessage`, `CaseSummary`/`CaseFile`, `LedgerTotals`, `Recovery` (with stages), `Metrics`, `Health`, `SwarmState`, `BenchResults`. A field with no source in the contract is `null`, never invented. |
| `adapt.ts` | Wire to view converters (pure). |
| `state.ts` | Reducer: `applyEvent(state, SequencedEvent)` and `mergeRest(state, restSnapshot)` (pure). |
| `store.ts` | Module store, one EventSource, reconnect and rebuild logic. |
| `client.ts` | `api` (REST routes from docs/DATA_CONTRACT.md). |
| `http.ts` | `API_URL`, `request`, `ApiError`. |
| `cache.ts` | Fetch-on-demand case files and bench results. |
| `fleet.ts` | Fleet-scale reducers (grid, stats, chunks, cleansing) and constants. |
| `fleet.test.ts` | Reducer tests with synthetic events: `cd dashboard && bun test src/data`. |

## Core API

```ts
useDashboard(): { snapshot: Snapshot | null; connection: "connecting" | "open" | "reconnecting";
                  selectedCaseId: string | null; selectCase(id: string | null): void }
api.startRun(mode, taskId, { libraryId?, stepDelayMs?, agents?, poisonRate? })  // POST /api/runs
    // libraryId omitted = cold; stepDelayMs = demo pacing; agents > 4 = fleet-scale mode (e.g. 1000); poisonRate 0..1 (e.g. 0.05)
                                        // Tasks: invoice_parser, shipping_rates, discount_engine
api.stopRun()                           // POST /api/runs/:current/stop
api.possess(slot)                       // POST /api/runs/:current/possess -> { ok, slot, gen } (any active slot, mock too)
api.injectFault(slot, "F1".."F4")       // POST /api/runs/:current/fault
api.crash()                             // POST /api/demo/crash (MOCK only)
api.startSwarm(agents)                  // POST /api/swarm; stats arrive as swarm.stats (measured=false => "sim")
api.getCase(id)                         // GET /api/cases/:id -> view CaseFile
api.getBench()                          // GET /api/bench -> { origin, rows (view), raw: BenchmarkResultRow[] }
api.getBenchHeadline()                  // GET /api/bench/summary -> BenchHeadline | null: ours_cold vs codex_baseline on ONE task suite (never pooled); hook useBenchHeadline()
api.listRuns(), api.getJev(), api.grant(kind)
```

Failed calls reject with `ApiError`. It has `.status` (404 no_such_run/slot, 409 slot_not_active/already_possessed/run_finished, 501 unsupported), `.code` (the ActionResult error) and `.message`.

## How it works

1. The store opens `GET /api/events?since=<lastSeq>&boot=<bootId>`.
2. The server sends `hello` (with `gap`), then the replayed events, then `live`, then the live events. On the wire, `id:` is the seq.
3. On a fresh connect or a gap (buffer overflow, or a server restart, which shows up as a new bootId), the store rebuilds into a staging state:
   1. It folds in the replayed events.
   2. It fetches `GET /api/runs`, plus roster, ledger, relay, cases (for the latest run) and `/api/jev`.
   3. It merges those results.
   4. It applies any events that arrived meanwhile, then swaps the staging state in.

   Until the swap, the screen keeps the old state.
4. Reconnect: on error the EventSource is closed and `connection` becomes `"reconnecting"`. Retries come at 1 s, 2 s and 4 s, then every 5 s.
5. The current run is the most recently started one. Events for other runs are ignored. A `run.status` with `starting` resets that run's slices (the mock restarts this way).
6. Slices keep their references unless they change. Bursts of events render once (about 16 ms).
7. `selectedCaseId`: when nothing is selected and a new case arrives, it is selected automatically.

## Mapping from the contract

Token rule: `cachedInput ⊂ input` and `reasoning ⊂ output`. Total tokens = input + output; the subsets are never added on top.

- **`Metrics`**:
  - `repeatFailures` = `run.repeatFailures` ?? `immunity.repeatTrapHits`.
  - `trapHits`, `casesBroadcast` and `lessonsAdopted` come from `run.immunity`.
  - `retires` and `cases` come from the run. Anything absent is null (show nothing, never 0).
- **`Recovery`**: the row key is the contract's case id `<runId>.<slot>.g<gen>`.
  - The `recovery` event's `stages` win: `faultAt`, `detectedAt`, `retireBeganAt`, `caseFiledAt`, `respawnedAt`, and `testsPassAt` (from `testsPassingAt`).
  - Before that event (or when a server stage is null), each stage is what the event stream showed. `detectedAt` is the first `under_investigation`. `retireBeganAt` is the first `retiring`. `caseFiledAt` comes from `case.created`. `respawnedAt` is when gen + 1 is first seen.
  - `retiredAt` and `trustedAt` come only from status transitions.
  - `faultAt` comes only from the server.
  - `startAt` = `faultAt ?? detectedAt`, for the timer.
  - `ms` = server `testsPassingAt − detectedAt`.
  - `stagesFromServer` says which source you are looking at.
- **Case replies**: `CaseFile.replies` comes from the payload and from `case.reply` events (deduped by seq). It is `null` when the payload has none, for example after a live restart.
  - `recipients[].reply` is that recipient's reply.
  - Older payloads fall back to the recipient's `case_reply` relay message.
  - `case.reply` bumps `updatedAt`, so `useCase` re-renders and a fetched case file is refetched.
- **`health.jevOffline`**: `jev.mode === "fallback"`. `run.banner` comes from `run.status.banner`.
- **`origin` = "mock"**: when the server says `mock` in `hello`, or any event, run or row has `mock: true`. `SwarmState.origin` is "mock" when `measured === false`.
- **`ledger.netSavingsUsd`**: only when `net_savings_usd` is present.

## No source in the contract (null)

- `AgentSlot.persona`, `AgentSlot.maxSteps`
- `Metrics.chunksShared`, `Metrics.chunksReused`
- `Health.actorsConnected`, `Health.relayConnected` (null means unknown, not "down")
- `LedgerTotals.reuseUsdEst`, `LedgerTotals.baselineUsd`
- `CaseRecipient.similarity`, `CaseRecipient.avoidedTrap`
- `JevResult.latencyMs`
- `SwarmState.running`, `SwarmState.startedAt`
- `BenchResults.generatedAt`
- `RunInfo.origin` is never "replay", because there is no replay flag yet.

## Fleet-scale mode (1,000 agents)

### Starting it

- **On dev-mock** (`cd orchestrator && PORT=3000 bun run src/http/dev-mock.ts`), use either of:
  - `api.startRun("ours", "invoice_parser", { agents: 1000, poisonRate: 0.05 })`
  - `curl -XPOST localhost:3000/api/runs -H 'content-type: application/json' -d '{"taskId":"invoice_parser","mode":"ours","agents":1000,"poisonRate":0.05}'`

  Any `agents > 4` runs the MOCK fleet script (`orchestrator/mock/fleet.ts`). The run is `mockfleet01`, about 150 ticks of 1 s, with every event flagged `mock`. The 4-agent recording plays when `agents` is omitted.
- **Slot numbers:** in fleet mode, `slot` in agent-level events is the global agent index (0..agents−1). Team = `floor(slot / agentsPerTeam)`. Names look like `t<team>w<slot%4>-g<gen>-<runId>`.
- **What is complete and what is sampled:**
  - `fleet.grid` and `fleet.stats` are complete on every tick.
  - Agent-level events are complete for caught agents only: `roster` and `useAgent` hold just the agents that had events (about 50 of 1,000).
  - `chunk.reused` and routine relay messages are sampled.
  - So the headline numbers come from `useFleetStats()`. The `useChunks()` and `useCleansing()` lists are for drill-down.
- **History after a reload or gap:** these four slices are rebuilt from the SSE replay buffer (the last 2,000 events), so a reload restores the recent history. The fleet slices reset when a newer run starts.

### `useFleetGrid(): FleetGridView | null`

null until the first `fleet.grid` of the current run. The object is new on each grid tick (about 1/s) and stable otherwise.

```ts
interface FleetGridView {
  runId: string; seq: number; ts: number;
  agents: number; teams: number; agentsPerTeam: number;   // 1000 / 250 / 4
  cells: string;            // one char per agent; agent i = team floor(i/agentsPerTeam), member i%agentsPerTeam
  prevCells: string | null; // previous tick of the same run (diff / animate); null on the first tick
  changed: number;          // cells that differ from prevCells
  counts: Record<FleetCellCode, number>; // every code present, 0 when absent
}
type FleetCellCode = "." | "T" | "P" | "I" | "R" | "F" | "D" | "X";
// "." queued, T trusted, P probation, I under_investigation, R retired, F failed, D done, X possessed
```

There are no per-agent objects: iterate `cells` with `charCodeAt` / `cells[i]`. `FLEET_CELL_STATUS` maps each code to its status name, and `FLEET_CELL_CODES` lists the codes in order. Both are exported.

### `useFleetStats(): FleetStatsState`

The `FleetStatsState` object is new on each `fleet.stats` tick.

```ts
interface FleetStatsState {
  current: FleetStatsView | null; // null until the first tick
  history: FleetStatPoint[];      // oldest first, ≤ 120 points (FLEET_HISTORY_CAP); a new array each tick
}
```

- **`FleetStatsView`** is the wire `FleetStats` plus `runId`, `seq` and `ts`, with tokens renamed and an `est` flag. Fields:
  - Size and progress: `agents`, `teams`, `elapsedMs`, `byStatus` (status name to count), `steps`, `subtasksPassing`, `teamsPassing`.
  - Poison: `poison {injected, caught, spread}`, `falseClaimsCaught`, `messagesBlocked`, `poisonedFactsRejected`.
  - Traps: `trapHits`, `repeatTrapHits`, `trapHitRateRecent {window, rate: number|null}`.
  - Cases and lessons: `cases`, `lessons`, `lessonsDelivered`, `retired`, `respawned`.
  - Spend: `tokens {input, cachedInput, output, reasoning}` (cachedInput ⊂ input, reasoning ⊂ output), `usd`.
  - Reuse and cleansing: `reuseEstTokens` (label it "est."), `chunks {created, reused, revoked}`, `poisonedContextTokensDropped`.
  - Caucus and overhead: `caucus {threads, replies}`, `overheadShare` (0..1, or null).
  - Live load: `llmInFlight`, `testsInFlight`.
  - Flags: `measured: true` and `est: { reuseEstTokens: true }`.
- **`FleetStatPoint`** (one per tick, for sparklines): `ts`, `elapsedMs`, `trapHitRate` (number|null), `trapHits`, `poisonCaught`, `poisonSpread`, `falseClaimsCaught`, `messagesBlocked`, `cases`, `lessonsDelivered`, `chunksReused`, `poisonedContextTokensDropped`, `reuseEstTokens` (est.), `usd`.
- **MOCK badge:** take it from `snapshot.origin` or `run.origin`, never from `measured`. The mock also sends `measured: true` to satisfy the type.

### `useChunks(): ChunksState`

```ts
interface ChunksState {
  recent: ChunkView[]; // newest last, ≤ 200 (CHUNKS_CAP)
  totals: { created: number; reused: number; revoked: number; reuseEstTokens: number }; // counted from events seen
}
interface ChunkView {
  id: string; runId: string; sourceAgent: string; slot: number; gen: number; step: number;
  fn: string; note: string; sourceOutputTokens: number; createdAt: number;
  reusedBy: string[];          // agent names, arrival order (chunk.reused is sampled in fleet mode)
  reuseEstTokens: number;      // Σ chunk.reused reuseEstTokens (est.)
  revoked: { reason: string; notified: string[]; ts: number } | null;
}
```

`totals` only counts what this client saw, and `chunk.reused` is sampled. For headline numbers use `useFleetStats().current.chunks` and `reuseEstTokens`.

### `useCleansing(): CleansingState`

```ts
interface CleansingState {
  recent: CleansingEvent[];  // newest last, ≤ 100 (CLEANSING_CAP)
  count: number;
  totalDroppedTokens: number; // Σ droppedPromptTokens seen
  totalHandoffTokens: number; // Σ handoffPromptTokens seen
}
interface CleansingEvent {
  id: string; seq: number; ts: number; runId: string;
  slot: number; fromGen: number; toGen: number;
  droppedPromptTokens: number;  // retired agent's last prompt
  handoffPromptTokens: number;  // replacement's first prompt (verified handoff only)
}
```

The headline "poisoned context dropped" is `useFleetStats().current.poisonedContextTokensDropped`, which is Σ (dropped − handoff) over all retirements.

### Recovery timer and faults

- `agent.status.faultAt` (sent when an injected fault fires) sets the Recovery row's `faultAt` and `startAt` right away, so the timer starts at the fault and never jumps.
- The 4-agent recording sends it. The MOCK fleet script does not yet: there, `faultAt` arrives with the `recovery` event.

## Optional hooks

| Hook | Returns |
| --- | --- |
| `useSnapshot()`, `useConnection()`, `useSelectedCaseId()` | Single fields |
| `useRun()`, `useRoster()`, `useLedger()`, `useCases()`, `useRelay()`, `useRecoveries()`, `useMetrics()`, `useHealth()`, `useSwarm()` | That slice, or null before the first snapshot |
| `useAgent(slot)` | One `AgentSlot`; re-renders only when that card changes |
| `useFleetGrid()`, `useFleetStats()`, `useChunks()`, `useCleansing()` | Fleet-scale slices; see "Fleet-scale mode" above |
| `selectCase(id)` | Module-level setter |
| `useCase(id)` | `{ data, error, loading, reload }`. Served from the store (updated as replies arrive), else fetched from `/api/cases/:id`. |
| `useBenchResults()` | `{ data: BenchResults, error, loading, reload }`. Fetched once. |
