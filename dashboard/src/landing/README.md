# Landing page (`/`)

## Filling the measured run

The Proof section has one slot for a measured run of our fleet. It reads `measured.json` in this folder.

- `{}` (the default) renders nothing.
- A complete object renders one line, at the same size as the Codex reference line:
  "Measured run <runId>, <date>: caught in X s · recovered in Y s · N teammates immune · $Z".
- The file is type-checked at build time against `MeasuredRunData` in `MeasuredRun.tsx`. A missing or misspelt
  field fails `npx tsc -b`.

Use a real run on the live orchestrator, never the mock server (`GET /api/meta` must say `mock: false`).

```json
{
  "runId": "r-2026-10-31-1842",
  "caughtSec": 3.0,
  "recoveredSec": 18.4,
  "teammatesImmune": 2,
  "usd": 0.0412,
  "measuredAt": "2026-10-31T18:42:00Z"
}
```

| Field | Meaning | Where it comes from |
| --- | --- | --- |
| `runId` | The run's id | `RunSummary.id` (`GET /api/runs`) |
| `caughtSec` | Seconds from the lie to the catch | The `recovery` SSE event (`GET /api/events`): `(stages.detectedAt - stages.faultAt) / 1000` |
| `recoveredSec` | Seconds from the catch to passing tests | The same event: `(stages.testsPassingAt - stages.detectedAt) / 1000`, which equals `ms / 1000` |
| `teammatesImmune` | Teammates the lesson reached | `CaseFile.recipients.length` for that event's `caseId` (`GET /api/cases/:id`) |
| `usd` | What the whole run cost, overhead included | `LedgerTotals.worker_usd + overhead_usd` (`GET /api/runs/:id/ledger`, or the last `ledger.totals` event) |
| `measuredAt` | When the run finished, ISO 8601 | `RunSummary` finish time, or the timestamp of the last event |

If any stage time is `null` in `recovery.stages`, that number is unknown: leave the file as `{}` rather than
estimating it.

## Where the numbers come from

Token ratios and trap counts: `bench/results.summary.json`, one suite per figure (`bench.ts`): light suite =
`codex_baseline@v2` vs `ours_cold@v2`, reasoning-heavy suite = `codex_baseline@v3` vs `ablation@v3` (Kept's default,
note sharing off). The poisoning and fleet figures in `Proof.tsx` name their source next to each one.
