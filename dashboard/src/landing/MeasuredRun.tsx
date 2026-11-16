import data from "./measured.json";

/*
  The slot for one measured run of our fleet. Filled by hand from a real run on the live orchestrator, never from
  the mock server. Full instructions: dashboard/src/landing/README.md, "Filling the measured run".

  measured.json is either {} (the default: this renders nothing) or exactly this shape:

    {
      "runId": "r-2026-10-31-1842",        // RunSummary.id of the run
      "caughtSec": 3.0,                     // (stages.detectedAt - stages.faultAt) / 1000, from the "recovery" event
      "recoveredSec": 18.4,                 // (stages.testsPassingAt - stages.detectedAt) / 1000 (= recovery.ms / 1000)
      "teammatesImmune": 2,                 // CaseFile.recipients.length for that case (GET /api/cases/:id)
      "usd": 0.0412,                        // LedgerTotals.worker_usd + overhead_usd (GET /api/runs/:id/ledger)
      "measuredAt": "2026-10-31T18:42:00Z"  // when the run finished, ISO 8601
    }

  The type below is checked against the file at build time: a missing or misspelt field fails `tsc`.
  It renders at the same size as the Codex reference line, labelled "Measured run <id>, <date>".
*/

export interface MeasuredRunData {
  runId: string;
  caughtSec: number;
  recoveredSec: number;
  teammatesImmune: number;
  usd: number;
  measuredAt: string;
}

type Empty = Record<string, never>;

// The annotation is the build-time check: the JSON must be {} or a complete MeasuredRunData.
const MEASURED: MeasuredRunData | Empty = data;

const isMeasured = (m: MeasuredRunData | Empty): m is MeasuredRunData => typeof m.runId === "string";

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

export function MeasuredRun() {
  if (!isMeasured(MEASURED)) return null;
  const m = MEASURED;
  const usd = m.usd < 0.1 ? m.usd.toFixed(4) : m.usd.toFixed(2);
  return (
    <p className="lp-proof-ref lp-measured">
      <strong>
        Measured run {m.runId}, {fmtDate(m.measuredAt)}:
      </strong>{" "}
      caught in {m.caughtSec.toFixed(1)} s · recovered in {m.recoveredSec.toFixed(1)} s · {m.teammatesImmune}{" "}
      {m.teammatesImmune === 1 ? "teammate" : "teammates"} kept the lesson · ${usd}
    </p>
  );
}
