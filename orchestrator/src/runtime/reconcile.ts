// Reconcile on startup (BUILD_SPEC "Retire and respawn" -> "Reconcile on startup"; rule 3).
// The orchestrator keeps nothing on disk: the run list comes from the RunIndex actor and each run's
// state from its Fleet actor. Actors answer "unavailable" for ~30 s after a kill -9; every read goes
// through withRetry (inside RunManager).
import type { RunManager } from "./runs.ts";

export interface ReconcileReport {
  resumed: string[];
  ended: string[];
  errors: { runId: string; error: string }[];
}

/**
 * For every run the index lists as not ended: rebuild its RunContext from Fleet, reconnect Relay
 * identities from tokens stored in actors, finish half-done retires (retire.resumeRetire) and restart
 * active slots' loops (worker.runAgentLoop resumes after the last logged step). Each run is handled on
 * its own, so one broken run never blocks the others.
 */
export async function reconcileRuns(runs: RunManager): Promise<ReconcileReport> {
  const log = (l: string) => runs.d.deps.log(`[reconcile] ${l}`);
  const report: ReconcileReport = { resumed: [], ended: [], errors: [] };
  const entries = await runs.listIndex();
  const open = entries.filter((e) => !["finished", "failed", "stopped"].includes(e.status));
  if (!open.length) {
    log(`nothing to resume (${entries.length} run(s) in the index, all ended)`);
    return report;
  }
  log(`resuming ${open.length} run(s): ${open.map((e) => e.runId).join(", ")}`);
  for (const e of open) {
    try {
      const r = await runs.resumeRun(e);
      if (r === "resumed") report.resumed.push(e.runId);
      else if (r === "ended") report.ended.push(e.runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push({ runId: e.runId, error: msg });
      log(`run ${e.runId}: ${msg}`);
    }
  }
  log(`done: resumed [${report.resumed.join(", ")}] ended [${report.ended.join(", ")}] errors ${report.errors.length}`);
  return report;
}
