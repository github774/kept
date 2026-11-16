// Control and detail calls (docs/DATA_CONTRACT.md routes), returning view-model shapes.
import type * as W from "@contract/types";
import { toBench, toBenchHeadline, toCaseFile, toJev, toRun } from "./adapt";
import { ApiError, DEMO_REPLAY, request } from "./http";
import type { BenchHeadline, BenchResults, CaseFile, JevView, Mode, RunInfo } from "./model";
import { currentRunId, getCaseFile, getState, replayPossess, replayStart, replayStop } from "./store";

export { API_URL, ApiError, DEMO_REPLAY, RECORDED, RECORDED_NOTE } from "./http";

function runPath(suffix: string): string {
  const id = currentRunId();
  if (!id) throw new ApiError(409, "no_such_run: no run yet", "no_such_run");
  return `/api/runs/${encodeURIComponent(id)}${suffix}`;
}
const origin = () => getState().snapshot?.origin ?? "live";

export interface StartRunOptions {
  libraryId?: string;
  stepDelayMs?: number;
  agents?: number;
  poisonRate?: number;
}

export const api = {
  /**
   * POST /api/runs. Tasks: "invoice_parser" (demo), "shipping_rates", "discount_engine".
   * opts.libraryId: omit for a fresh (cold) library. opts.stepDelayMs: demo pacing (ignored by the mock).
   * opts.agents (> 4 = fleet-scale mode, e.g. 1000) and opts.poisonRate (0..1, e.g. 0.05).
   */
  async startRun(mode: Mode, task: string, opts: StartRunOptions = {}): Promise<RunInfo> {
    if (DEMO_REPLAY) {
      const rec = await replayStart(task);
      if (!rec) throw new ApiError(404, `No recorded run for ${task} in this demo.`, "no_recording");
      return toRun(rec, origin());
    }
    const body: W.StartRunOpts = { taskId: task, mode };
    if (opts.libraryId) body.libraryId = opts.libraryId;
    if (opts.stepDelayMs !== undefined) body.stepDelayMs = opts.stepDelayMs;
    if (opts.agents !== undefined) body.agents = opts.agents;
    if (opts.poisonRate !== undefined) body.poisonRate = opts.poisonRate;
    return toRun(await request<W.RunSummary>("POST", "/api/runs", body), origin());
  },
  /** Kill switch for the current run. */
  async stopRun(): Promise<void> {
    if (DEMO_REPLAY) return replayStop();
    await request<W.ActionResult>("POST", runPath("/stop"), {});
  },
  /** Possess a slot of the current run (F1 then F3). Rejects with ApiError (404 / 409) when the slot can't be possessed. */
  async possess(slot: number): Promise<{ ok: true; slot: number; gen: number }> {
    if (DEMO_REPLAY) {
      if (!(await replayPossess(slot))) throw new ApiError(409, "No recording of that agent being possessed in this demo.", "no_recording");
      return { ok: true, slot, gen: 1 };
    }
    await request<W.ActionResult>("POST", runPath("/possess"), { slot });
    const gen = getState().snapshot?.roster.find((a) => a.slot === slot)?.gen ?? 1;
    return { ok: true, slot, gen };
  },
  async injectFault(slot: number, fault: W.FaultId): Promise<void> {
    await request<W.ActionResult>("POST", runPath("/fault"), { slot, fault });
  },
  /** MOCK only: the server exits so the supervisor restarts it. A dropped connection here is success. */
  async crash(): Promise<void> {
    try {
      await request("POST", "/api/demo/crash", {});
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
  },
  /** POST /api/swarm {agents}. Rejects with ApiError 501 "unsupported" when the service has no swarm. Stats arrive as swarm.stats. */
  async startSwarm(agents: number): Promise<void> {
    await request<W.ActionResult>("POST", "/api/swarm", { agents });
  },
  /** Full case file (with recipient replies taken from the relay when the store has them). */
  async getCase(id: string): Promise<CaseFile> {
    const c = await request<W.CaseFile>("GET", `/api/cases/${encodeURIComponent(id)}`);
    const relayReplies = new Map<string, string>();
    for (const m of getState().snapshot?.relay ?? []) if (m.kind === "case_reply" && m.meta.caseId === id && !relayReplies.has(m.from)) relayReplies.set(m.from, m.text);
    const cf = toCaseFile(c, relayReplies);
    const fromStore = getCaseFile(id);
    return fromStore ? { ...cf, updatedAt: Math.max(cf.updatedAt, fromStore.updatedAt) } : cf;
  },
  /** GET /api/bench: adapted rows plus the raw BenchmarkResultRow[]; origin "mock" if any row is mock. */
  async getBench(): Promise<BenchResults> {
    return toBench(await request<W.BenchmarkResultRow[]>("GET", "/api/bench"));
  },
  /** GET /api/bench/summary: the headline suite (one task_version, never pooled); null when there is no summary. */
  async getBenchHeadline(): Promise<BenchHeadline | null> {
    try {
      return toBenchHeadline(await request<W.BenchmarkSummary>("GET", "/api/bench/summary"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  async listRuns(): Promise<RunInfo[]> {
    return (await request<W.RunSummary[]>("GET", "/api/runs")).map((r) => toRun(r, origin()));
  },
  async getJev(): Promise<JevView> {
    return toJev(await request<W.JevStatus>("GET", "/api/jev"));
  },
  /** Fresh actor socket grant for the current run. Empty websocketUrl (mock) = use SSE. */
  async grant(kind: "fleet" | "ledger"): Promise<W.ActorSocketGrant> {
    return request<W.ActorSocketGrant>("GET", runPath(`/grant/${kind}`));
  },
};
