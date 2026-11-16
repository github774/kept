// Ledger writes (BUILD_SPEC "Token ledger"). Every API call -> one Ledger.record row, id
// `<runId>.<slot>.g<gen>.s<step>.<n>` (n counts calls within the step).
// Calls outside a worker step (retire, herd) use `<runId>.<slot>.g<gen>.<label>.<n>`.
// n is NOT restarted at 1 by a new process: on first use of a prefix the writer reads the highest n already
// in the Ledger actor (Ledger.maxIndex) and continues after it. A step re-executed after a crash makes new
// paid calls, so those get new ids and are counted; a retried write of the same row keeps its id (no-op).
import type { LedgerTotals as ContractTotals, LedgerCategory as ContractCategory, TokenSpend } from "./contract.ts";
import type { LedgerDraft } from "./ledger-entry.ts";
import type { LedgerEntry, LedgerTotals } from "./actors.ts";

type LedgerStub = {
  record(e: LedgerEntry): Promise<unknown>;
  totals(): Promise<LedgerTotals>;
  /** Highest n among ids `<prefix>.<n>`; optional so simple test stubs still work (treated as 0). */
  maxIndex?(prefix: string): Promise<number>;
};

export interface LedgerScope {
  slot: number | string;
  gen: number;
  /** Worker step number, or a label such as "retire" / "herd.<caseId>". */
  step: number | string;
}

export const isMockModel = (model: string) => model.startsWith("MOCK");

export class LedgerWriter {
  private readonly counters = new Map<string, number>();
  /** prefix -> one seeding read of Ledger.maxIndex (shared by concurrent first callers). */
  private readonly seeded = new Map<string, Promise<void>>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly runId: string,
    private readonly actor: LedgerStub,
    private readonly onTotals: (t: ContractTotals) => void,
  ) {}

  private prefix(s: LedgerScope): string {
    return typeof s.step === "number"
      ? `${this.runId}.${s.slot}.g${s.gen}.s${s.step}`
      : `${this.runId}.${s.slot}.g${s.gen}.${s.step}`;
  }

  /** Records drafts in call order. Idempotent per id (Ledger.record ignores repeats). */
  async record(scope: LedgerScope, drafts: LedgerDraft[]): Promise<void> {
    if (!drafts.length) return;
    const p = this.prefix(scope);
    await this.seed(p);
    for (const d of drafts) {
      const n = (this.counters.get(p) ?? 0) + 1;
      this.counters.set(p, n);
      await this.actor.record({
        id: `${p}.${n}`,
        category: d.category,
        model: d.model,
        input_tokens: d.input_tokens,
        cached_input_tokens: d.cached_input_tokens,
        output_tokens: d.output_tokens,
        reasoning_tokens: d.reasoning_tokens,
        usd: d.usd,
        slot: String(d.slot),
        gen: d.gen,
        step: typeof scope.step === "number" ? scope.step : undefined,
        ts: d.ts,
        mock: isMockModel(d.model),
      });
    }
    this.scheduleEmit();
  }

  private seed(p: string): Promise<void> {
    let s = this.seeded.get(p);
    if (!s) {
      const stub = this.actor;
      s = (typeof stub.maxIndex === "function" ? stub.maxIndex(p) : Promise.resolve(0)).then(
        (max) => {
          if (max > (this.counters.get(p) ?? 0)) this.counters.set(p, max);
        },
        (e: unknown) => {
          this.seeded.delete(p); // retry the read next time; never guess
          throw e;
        },
      );
      this.seeded.set(p, s);
    }
    return s;
  }

  /** Estimate row (never spend): output tokens of the step whose chunk was reused. Labeled est. */
  async recordReuseEstimate(scope: LedgerScope, chunkId: string, estTokens: number): Promise<void> {
    await this.actor.record({
      id: `${this.prefix(scope)}.reuse.${chunkId}`,
      category: "reuse_est",
      model: "est",
      input_tokens: estTokens,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      usd: 0,
      slot: String(scope.slot),
      gen: scope.gen,
      ts: Date.now(),
    });
    this.scheduleEmit();
  }

  async totals(): Promise<ContractTotals> {
    return toContractTotals(this.runId, await this.actor.totals());
  }

  /** USD cap (caps.usd_per_run) against the Ledger's own totals. */
  async overBudget(capUsd: number): Promise<{ over: boolean; usd: number }> {
    const t = await this.actor.totals();
    const usd = t.worker_usd + t.overhead_usd;
    return { over: usd >= capUsd, usd };
  }

  private scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.totals().then(this.onTotals, () => {});
    }, 300);
  }
}

const CATS: ContractCategory[] = ["worker", "jev", "fallback_judge", "embedding", "lesson_writer", "case_discussion"];

export function toContractTotals(runId: string, t: LedgerTotals): ContractTotals {
  const by = {} as Record<ContractCategory, TokenSpend & { calls: number }>;
  for (const c of CATS) {
    const x = t.by_category[c];
    by[c] = { calls: x?.calls ?? 0, usd: x?.usd ?? 0, input: x?.input ?? 0, cached: x?.cached ?? 0, output: x?.output ?? 0, reasoning: x?.reasoning ?? 0 };
  }
  return {
    runId,
    worker_usd: t.worker_usd,
    overhead_usd: t.overhead_usd,
    by_category: by,
    calls: t.calls,
    tokens: t.tokens,
    reuse_est_tokens: t.reuse_est_tokens,
    est: { reuse_est_tokens: true },
  };
}
