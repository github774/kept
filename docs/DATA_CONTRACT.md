# Data contract: orchestrator to dashboard

For Amar. The source of truth is `orchestrator/src/contract.ts`. It holds only types, so the dashboard can `import type` it. This page explains how to use it.

## What you wrap

`RuntimeService` (in contract.ts). The real one will be `orchestrator/src/service.ts`. Until it lands, use the mock:

```ts
import { MockRuntimeService } from "../orchestrator/mock/service.ts";
const svc = new MockRuntimeService({ speed: 4, loop: true, autoStart: true }); // logs "[MOCK] ..."
```

| Method | Returns | Notes |
| --- | --- | --- |
| `startRun({taskId, mode, libraryId?, stepDelayMs?})` | `RunSummary` | `taskId` is the task folder id: `invoice_parser`, `shipping_rates` or `discount_engine`. Leave out `libraryId` to start with a fresh (cold) library. `stepDelayMs` slows every worker step for the demo, so the run can't finish before Possess. In mock mode this restarts playback (`stepDelayMs` is ignored). |
| `listRuns()` | `RunSummary[]` | |
| `getRoster(runId)` | `AgentCard[]` | One card per slot, current generation |
| `listCases({runId} \| {libraryId})` | `CaseFile[]` | |
| `getCase(id)` | `CaseFile \| null` | Case id format: `<runId>.<slot>.g<gen>` |
| `getLedger(runId)` | `LedgerTotals \| null` | |
| `getRelayFeed(runId, sinceSeq?)` | `RelayFeedItem[]` | Backfill for the feed panel |
| `possess(runId, slot)` | `ActionResult` | Applies F1, then F3 on that slot's next step. Works on any active slot. Mock mode replays the recorded possession on the chosen slot, still flagged `mock: true` (see below). |
| `injectFault(runId, slot, 'F1'..'F4')` | `ActionResult` | |
| `stopRun(runId)` | `ActionResult` | Kill switch |
| `getJevStatus()` | `JevStatus` | |
| `getBenchmarkResults()` | `BenchmarkResultRow[]` | Rows from bench/results.json (mock: `orchestrator/mock/bench-results.json`) |
| `actorSocketGrant('fleet'\|'ledger', runId)` | `ActorSocketGrant` | A fresh grant for the actor websocket. Ask for a new one on every socket close. In mock mode `websocketUrl` is `""`, so use the SSE `roster` and `ledger.totals` events instead. |
| `subscribe(cb)` | unsubscribe fn | Live `SequencedEvent`s |
| `replay(afterSeq)` | `SequencedEvent[]` | Replay buffer (last 2000 events) |
| `mock` | boolean | `true` means show the MOCK badge |

## Suggested routes

| Route | Calls |
| --- | --- |
| `GET /api/runs` | `listRuns` |
| `POST /api/runs` `{taskId, mode, libraryId?}` | `startRun` |
| `POST /api/runs/:id/stop` | `stopRun` |
| `GET /api/runs/:id/roster` | `getRoster` |
| `GET /api/runs/:id/ledger` | `getLedger` |
| `GET /api/runs/:id/relay?since=` | `getRelayFeed` |
| `GET /api/runs/:id/cases` / `GET /api/libraries/:id/cases` | `listCases` |
| `GET /api/cases/:id` | `getCase` (id contains dots, so URL-encode it or match it as a raw segment) |
| `POST /api/runs/:id/possess` `{slot}` | `possess` |
| `POST /api/runs/:id/fault` `{slot, fault}` | `injectFault` |
| `GET /api/jev` | `getJevStatus` |
| `GET /api/bench` | `getBenchmarkResults` |
| `GET /api/runs/:id/grant/:kind` | `actorSocketGrant` |
| `GET /api/events` (SSE) | `replay(Last-Event-ID)`, then `subscribe` |

SSE frame: `id: <seq>\nevent: <type>\ndata: <JSON SequencedEvent>\n\n`. When a client reconnects, read the `Last-Event-ID` header (or `?since=`) and send `replay(n)` before switching to live events. If the client's seq is older than the buffer, `EventBus.hasGap(n)` is true. The client should then refetch the snapshots (roster, ledger, relay, cases).

## Events (`DashboardEvent`, each has `runId`, `ts`, `mock?`; on the wire it also has `seq`)

| type | Payload | Panel |
| --- | --- | --- |
| `roster` | `agents: AgentCard[]` (full replace) | Agent grid |
| `agent.status` | `slot, gen, status, step, reason?, agent?` (patch the card; use `agent` whole when present) | Agent grid |
| `relay.message` | `item: RelayFeedItem` | Relay feed. When `blocked` is set, show the message struck through with `blocked.reason`. |
| `case.created` | `case: CaseFile` | Case viewer and toast |
| `ledger.totals` | `totals: LedgerTotals` (full replace) | Ledger |
| `jev.status` | `status: JevStatus` | Ledger and header. When `mode === 'fallback'`, show "Jev offline, using fallback". |
| `case.reply` | `caseId, reply: CaseReply` | Case viewer: append to the case's replies (dedupe on `reply.seq`) |
| `recovery` | `caseId, ms, slot?, stages?` | Case viewer ("recovered in N s") and the recovery timeline. `ms = stages.testsPassingAt − stages.detectedAt`, which is the same definition as the benchmark's `recovery_ms`. |
| `run.status` | `run: RunSummary, banner?` | Header. Show `banner` (for example "reconnecting") while it is set. |
| `swarm.stats` | `stats: SwarmStats` | Swarm (stretch). If `measured: false`, label the numbers "sim". |

## Which panel uses what

- **Agent grid:** `AgentCard`. Each status needs its own color and its own icon: trusted, probation, under_investigation, retiring, retired, failed. `possessed` gets a marker.
- **Relay feed:** `RelayFeedItem`. Link it to a case through `metadata.caseId`.
- **Case viewer:** `CaseFile`. Show the claim, then `evidence.testOutput`, `evidence.jev` (questionId, P, source), `fallbackReason` and `escalationReason`, followed by the category, lesson, recipients, `replies` and replacement. Show `synthetic` cases with a "synthetic" tag and `revoked` cases struck through. When `lesson === null` the writer said NO_LESSON.
- **Recovery timeline:** `recovery.stages` gives `faultAt → detectedAt → retireBeganAt → caseFiledAt → respawnedAt → testsPassingAt` (epoch ms). A `null` stage did not happen or isn't known; leave it empty rather than filling it in. `faultAt` is `null` for failures that weren't injected.
- **Immunity counters:** `RunSummary.repeatFailures` and `RunSummary.immunity` `{trapHits, repeatTrapHits, casesBroadcast, lessonsAdopted}`, carried on every `run.status`. If they're absent, show nothing, not 0.
- **Tokens (everywhere):** `cached` is part of `input`, and `reasoning` is part of `output`. This is how OpenAI and OpenRouter report them; docs/SMOKE.md confirms it, e.g. 2222 cached of 2256 prompt tokens and 107 reasoning of 299 completion tokens. Total = `input + output`. Show cached and reasoning as "of which" and never add them on top.
- **Ledger:** `worker_usd`, `overhead_usd`, `calls.jev` vs `calls.fallback`, and `reuse_est_tokens`. The reuse value **must be labelled "est."** (`est.reuse_est_tokens` is always `true`). Show `net_savings_usd` only when it is present, which means a baseline run exists.
- **Controls:** `startRun`, `possess`, the mode switch (`ours` / `baseline` / `ablation`), and `stopRun`.
- **Results:** `BenchmarkResultRow[]` grouped by `mode`. Show the mean and the min–max of `tokens_per_passing_task`, the success rate, `recovery_ms` and `usd`.

## MOCK badge rule

Show a visible **MOCK** badge whenever any of these is true: `svc.mock`, any event or row received with `mock: true`, or an empty grant `websocketUrl`. Never drop the flag. A replayed real run gets **REPLAY** instead. The mock data is hand-scripted, not measured: `orchestrator/mock/events.jsonl` (70 events covering fleet at work, shared reasoning, possess on slot 3, catch + retire + case, herd immunity with 2 case replies, crash/reconnect and swarm) and `bench-results.json` (36 rows). The recording is built by `mock/script.ts`.

**Mock Possess.** By default the recording possesses slot 3 on its own, as before. `possess(runId, slot)` before that beat switches the rest of the recording to the chosen slot and fires it right away; everything already shown stays valid, because the events before the beat are the same for every slot. Pass `new MockRuntimeService({ autoPossess: false })` and playback pauses at the beat until Possess is pressed. That matches the live service, where nothing is possessed until someone presses the button. If Possess is pressed after the beat has played, it returns ok and queues that slot for the next replay (`startRun` or loop). Regenerate them with `bun run mock/generate.ts` and check them with `bun run mock/check.ts` (from `orchestrator/`).

## Changelog for Amar (contract update, Oct 31)

Every change is additive except the `TaskId` rename. New fields are optional, so older payloads still type-check.

| Change | Where | Notes |
| --- | --- | --- |
| **Renamed** `TaskId` values: `invoice` / `shipping` / `discount` → `invoice_parser` / `shipping_rates` / `discount_engine` | `TaskId`, `RunSummary.taskId`, `CaseFile.task`, `BenchmarkResultRow.task`, `StartRunOpts.taskId` | These now match the task folders under `bench/tasks/`. The mock events and mock bench rows were regenerated with them. `TaskId` still accepts any string. |
| Documented token semantics | `TokenCounts`, `TokenSpend` | `cached` ⊂ `input`, `reasoning` ⊂ `output`. Nothing about the shape changed. |
| Added `RunSummary.repeatFailures?: number` | `RunSummary` | Same value as `immunity.repeatTrapHits`, for the header counter |
| Added `RunSummary.immunity?: ImmunitySummary` | new `ImmunitySummary {trapHits, repeatTrapHits, casesBroadcast, lessonsAdopted}` | Uses the same definitions as the benchmark's trap metrics |
| Added `stages?: RecoveryStages` and `slot?: number` to the `recovery` event | new `RecoveryStages {faultAt, detectedAt, retireBeganAt, caseFiledAt, respawnedAt, testsPassingAt}` (each `number \| null`) | `ms` is kept, and now means `testsPassingAt − detectedAt`. The old mock measured it from case creation. |
| Added `CaseFile.replies?: CaseReply[]` | new `CaseReply {from, slot, gen, text, ts, seq}` | `seq` is the matching `RelayFeedItem.seq` |
| Added event `case.reply` `{caseId, reply}` | `DashboardEvent` | Sent once for each reply in a case thread (at most 3 per thread) |
| Added `StartRunOpts.stepDelayMs?: number` | `StartRunOpts` | Demo pacing. Ignored in mock. |
| Mock: `possess` works on any slot; new `autoPossess` option | `MockRuntimeService` | See "Mock Possess" above |

**Still without a durable source in the live service.** The live service can fill these while it runs, but nothing in the actors holds them yet. After an orchestrator restart they may be missing or `null`, and the panels should show nothing for them:

- `CaseFile.replies`: CaseLibrary has no replies column yet, so this needs an actor method (`CaseLibrary.addReply`).
- `recovery.stages`, all except `retireBeganAt`: only the Fleet's `retire_started_at` is persisted today.
- `RunSummary.immunity` and `repeatFailures`: there is no persisted counter yet. After a restart, `casesBroadcast` can be rebuilt from CaseLibrary receivers, but trap hits cannot.

## Changelog 2: fleet-scale mode (1,000-agent demo, DECISIONS #16)

| Change | Notes |
| --- | --- |
| New event `fleet.stats` `{stats: FleetStats}` ~1/s | Aggregates for the headline counters: by status, poison injected/caught/spread, false claims caught, messages blocked, poisoned facts rejected, trap hits + repeat, recent trap-hit rate, cases, lessons delivered, tokens, USD, reuse est. |
| New event `fleet.grid` `{grid: FleetGrid}` ~1/s | `cells` is one char per agent (`FLEET_GRID_CODES`: `.` queued, `T` trusted, `P` probation, `I` under investigation, `R` retired, `F` failed, `D` done, `X` possessed). Render as a 1,000-dot grid; team = i / agentsPerTeam. |
| `StartRunOpts.agents?`, `StartRunOpts.poisonRate?` | `agents: 1000, poisonRate: 0.05` starts the fleet demo. Per-agent `agent.status` / `relay.message` events are sampled in fleet mode; use the grid + stats for the overview and `GET` endpoints for drill-down. |
| New events `chunk.created` `{chunk: ChunkInfo}`, `chunk.reused` `{chunkId, byAgent, reuseEstTokens}`, `chunk.revoked` `{chunkId, reason, notified[]}`, `context.cleansed` `{slot, fromGen, toGen, droppedPromptTokens, handoffPromptTokens}` | Shared reasoning + **vector cleansing** panels. |
| `FleetStats.chunks {created, reused, revoked}`, `poisonedContextTokensDropped`, `caucus {threads, replies}`, `overheadShare` | Headline counters for vector cleansing, the caucus and token savings. |
