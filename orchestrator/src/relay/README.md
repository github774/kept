# Relay layer

- `bus.ts`: `RelayBus` over `@agent-relay/sdk` (real engine) or a labeled MOCK. Registration, per-run channels, generation-guarded sends, capped case threads, idempotency keys, release, `react()`.
- `reactions.ts`: herd-immunity signals as native Relay reactions, posted by the run's warden.
- `observer.ts`: the dashboard feed from Relay's observer plane.
- `index.ts`: config-wired entry point (`relayBusFromConfig`).

## Observer plane (`observer.ts`)

1. `POST /v1/observer-tokens` with the workspace key mints a read-only `ot_live_…` token. Its scopes are `stream:read`, `messages:read`, `threads:read`, `dms:read` and `reactions:read`, with `filters.include_dms: true`. The previous process's token is revoked first.
2. `new AgentRelay({ observerToken, baseUrl, sinceSeq, onCursor })` with `addListener("*")`. The SDK backfills Relay's durable per-workspace event log (`GET /v1/workspace/events`), then follows the live `/v1/ws` stream, ordered and deduplicated by `seq`.
3. The cursor is saved to `.relay/observer-<port>.json`, so a restarted orchestrator resumes after its last seq. Messages sent while it was down still reach the feed. A first start begins at Relay's current `latest_seq` instead of replaying old runs.
4. Each `message.created`, `thread.reply`, `dm.received` and `message.reacted` becomes a `relay.message` on the process EventBus. Observer frames carry message metadata (runId, slot, gen, caseId, kind), which agent-client listener events do not. When metadata is missing, the runId comes from the channel or identity name. Feed seqs start at 1e9, so they never collide with bus seqs.
5. Mode: `RELAY_FEED_SOURCE=supplement` is the default. A message the herd already published (same sender and text, within the last 2 min) is counted as `confirmed` and not posted again. `RELAY_FEED_SOURCE=observer` publishes everything; use it together with herd's `publishFeed` turned off. `RELAY_OBSERVER=0` disables the observer.
6. It starts from `createApi()` when the service is live. `GET /api/relay/observer` returns `{started, connected, mode, cursor, latestSeq, lag, resumedFrom, events, published, confirmed, reactions, unattributed, byType, lastEventAt, tokenId, error}`.

## Reactions (`reactions.ts`)

- `reactLessonAdopted(relay, runId, caseRootMessageId)` reacts ✅ on the warden's case post once a recipient's reply is recorded.
- `reactBlocked(relay, runId, relayMessageId)` reacts 🚫 on a teammate message that Jev blocked before delivery.

Both are best effort: they return `{ok:false, reason}` and never throw. The observer sees the reactions come back as `message.reacted` and adds them to the feed.

Hook into `runtime/herd.ts`. These are two lines, not yet applied because another workstream is editing herd.ts:

```ts
// recordReply(), right after persistReply(ctx, caseId, reply):
void reactLessonAdopted(ctx.relay, ctx.runId, root.id);
// readInbox(), inside `if (!res.deliver) {` before publishBlocked(...):
void reactBlocked(ctx.relay, ctx.runId, m.id);
```

Import both from `../relay/index.ts`. Send-time blocks (`sendMessage`) never reach Relay, so they have nothing to react to.

Verified on 2026-10-31 against `@relaycast/engine@12.3.0` on :8799. A case post, a reply, a teammate note, ✅ and 🚫 all streamed through the observer token (lag 0, 1 item confirmed instead of duplicated). After the observer stopped, a message was sent and the observer restarted: it resumed after its saved cursor and published the missed message.
