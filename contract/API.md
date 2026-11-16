# Dashboard API contract

The contract is [`docs/DATA_CONTRACT.md`](../docs/DATA_CONTRACT.md). Its types are
[`orchestrator/src/contract.ts`](../orchestrator/src/contract.ts), which `contract/types.ts` re-exports.

- **REST and SSE layer:** `orchestrator/src/http/api.ts`, built with `createApi(svc: RuntimeService)`. It implements the suggested routes in DATA_CONTRACT.md.
- **Mock server:** `cd orchestrator && PORT=3000 bun run src/http/dev-mock.ts` serves `MockRuntimeService`.
- **Dashboard:** reads through `dashboard/src/data/` (view model: `dashboard/src/data/model.ts`). Switching from mock to live only means pointing `VITE_API_URL` at a different server.

## Additions in the http layer (beyond DATA_CONTRACT.md)

- **`GET /api/meta`** returns `{ mock, bootId, lastSeq }`.
- **SSE control frames** carry no `id:`. They do not move `Last-Event-ID`.
  - Before the replay: `event: hello` with `{ bootId, mock, since, gap, restarted, firstSeq, lastSeq, replay }`.
  - After the replay: `event: live` with `{ lastSeq }`.
  - `gap: true` means one of these happened:
    - the client's seq is older than the buffer;
    - the client is ahead of the server;
    - the client sent `?boot=` with a different bootId, which means the server restarted and its seq numbers reset.
  - On a gap, the server replays its whole buffer, and the client must rebuild its state from REST snapshots.
- **SSE resume** accepts the `Last-Event-ID` header or `?since=<seq>` (plus an optional `&boot=<bootId>`).
- **`GET /api/runs/:id/ledger`** returns `null` (200) before the first totals.
- **Errors** are sent as `{ error, detail? }`. ActionResult errors are mapped to HTTP status codes:
  - `no_such_run`, `no_such_slot`: 404
  - `slot_not_active`, `already_possessed`, `run_finished`: 409
  - `unsupported`: 501
  - bad body: 400
- **`POST /api/demo/crash`** is mock only (routed only when `svc.mock`). The process exits, and `dev-mock.ts` restarts it.
