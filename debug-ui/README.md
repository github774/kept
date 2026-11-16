# Debug UI

A barebones page for testing the orchestrator API by hand: start/stop runs, possess or inject F1–F4 on any slot, and watch the roster, Relay feed, cases, ledger, Jev, swarm, recovery and the raw SSE event log. It is not the demo dashboard (that is `dashboard/`).

It serves one HTML file and proxies `/api/*` (SSE included) to the orchestrator, so no CORS setup is needed.

```bash
# terminal 1: the API (mock service; swap in the real service the same way)
cd orchestrator && bun run src/http/dev-mock.ts          # :3000, MOCK_SPEED=4 to speed up
# terminal 2: the page
bun run debug-ui/serve.ts                                # http://127.0.0.1:5174
API_URL=http://127.0.0.1:3000 PORT=5174 bun run debug-ui/serve.ts
```

To test the real `RuntimeService`, serve it with `createApi(svc)` from `orchestrator/src/http/api.ts`, exactly as `dev-mock.ts` does with `MockRuntimeService`.
