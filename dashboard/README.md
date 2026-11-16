# dashboard

The web front end for Kept (React 19, Vite, Tailwind v4). One app, two routes:

- `/`: the landing page (`src/landing/`): what Kept is, how it works, and the measured benchmark proof.
- `/live`: the live dashboard (`src/components/`): agent team and fleet views, Relay feed, case files, token ledger and benchmark chart, streamed from the orchestrator over REST + SSE.

```bash
bun install && bun run dev        # http://localhost:5173 (npm install && npm run dev also works)
bun run build                     # tsc -b && vite build -> dist/
```

The orchestrator URL comes from `VITE_API_URL` (default `http://127.0.0.1:3000`). With no real backend running, start the
mock: `cd orchestrator && PORT=3000 bun run src/http/dev-mock.ts`. Everything it shows carries a MOCK badge.
`VITE_API_URL=recorded` (the Vercel build) replays a recorded real run from `public/api/*.json`, written by
`scripts/record-snapshot.ts`; controls that would change the run are disabled.

Wire types come from `../contract` (the `@contract` alias in `vite.config.ts`). See `src/data/README.md` for the data layer,
`DESIGN.md` for the design system, and `docs/DATA_CONTRACT.md` for the API.
