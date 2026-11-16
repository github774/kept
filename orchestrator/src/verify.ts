// Verification (BUILD_SPEC "Verification"): ground truth (real test runs) first, Jev for text judgments,
// fallback judge inside the Jev adapter. Every API call made here lands in the Ledger.
import type { JevQuestionId } from "./config.ts";
import type { CaseEvidence, DecisionSource, JevEvidence } from "./contract.ts";
import type { CheckResult, NoulCheck } from "./jev.ts";
import type { LedgerScope } from "./ledger.ts";
import { runTests, type RunTestsResult } from "./testrunner.ts";
import type { RunContext as RunCtx, TaskFn } from "./runtime/types.ts";

export async function runFnTests(ctx: RunCtx, fn: TaskFn, agentName: string): Promise<RunTestsResult> {
  return runTests({ workDir: ctx.workDir, testFile: fn.test, timeoutMs: ctx.caps.test_timeout_ms, agentId: agentName });
}

/** Full suite over the shared work dir (run end). */
export async function runAllTests(ctx: RunCtx): Promise<RunTestsResult> {
  return runTests({ workDir: ctx.workDir, timeoutMs: ctx.caps.test_timeout_ms * 3, agentId: `final-${ctx.runId}` });
}

/** Jev check with ledger rows recorded and a [MOCK] label when the judge is mocked. */
export async function jevCheck(
  ctx: RunCtx,
  scope: LedgerScope,
  questionId: JevQuestionId,
  state: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const meta = { category: "jev" as const, slot: String(scope.slot), gen: scope.gen, step: typeof scope.step === "number" ? scope.step : 0 };
  const r = await ctx.deps.jev.check(questionId, state, meta, signal);
  await ctx.ledger.record(scope, r.ledger);
  if (ctx.deps.mock.jev) ctx.deps.log(`[MOCK jev] ${questionId} -> ${r.kind === "noul" ? `p=${r.probability.toFixed(2)} value=${r.value}` : r.choice}`);
  return r;
}

export function noul(r: CheckResult): NoulCheck {
  if (r.kind !== "noul") throw new Error("expected a noul check");
  return r;
}

const sourceOf = (r: CheckResult): DecisionSource => (r.source === "fallback" ? "fallback" : "jev");

export function jevEvidence(questionId: JevQuestionId, r: NoulCheck): Pick<CaseEvidence, "jev" | "fallbackReason" | "escalationReason"> & { mock?: true } {
  const jev: JevEvidence = { questionId, probability: r.probability, source: sourceOf(r) };
  return {
    jev,
    ...(r.decision === "escalate" ? { escalationReason: r.jevProbability !== undefined ? `jev p=${r.jevProbability.toFixed(2)} in grey zone` : "jev offline" } : {}),
    ...(r.source === "fallback" && r.reason ? { fallbackReason: r.reason } : {}),
    ...(r.source === "mock" || r.reason?.includes("MOCK") ? { mock: true as const } : {}),
  };
}
