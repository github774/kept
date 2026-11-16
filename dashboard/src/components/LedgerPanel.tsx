import type { DataOrigin, LedgerTotals } from "../data/model";
import { CircleCheck, Coins, TrendingDown, TrendingUp, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useHealth, useLedger, useRun } from "../data";
import { formatInt, formatPct, formatTokens, formatUsd } from "../lib/format";
import { CategoryTable } from "./ledger/CategoryTable";
import { Roll } from "./Roll";
import { useCountUp } from "./ledger/useCountUp";
import { Badge, EmptyState, Panel, Stat, cn } from "./ui";

/** Spec target: overhead (every category except worker) stays under 5% of total spend. */
const OVERHEAD_TARGET = 0.05;

/** Token ledger: net savings is the hero; spend, overhead, reuse (est.) and Jev usage support it. */
export function LedgerPanel() {
  const ledger = useLedger();
  const origin = useRun()?.origin ?? null;

  return (
    <Panel
      title={
        <>
          Token usage <span className="font-medium">(this run)</span>
        </>
      }
      scroll={false}
      actions={
        <span className="flex items-center gap-3">
          {ledger && ledger.reuseTokensEst > 0 && <span className="text-base text-ink-2">est. reused {formatTokens(ledger.reuseTokensEst)} tokens</span>}
          {origin && origin !== "live" ? <OriginBadge origin={origin} /> : null}
        </span>
      }
    >
      {ledger ? (
        <LedgerBody ledger={ledger} />
      ) : (
        <EmptyState compact icon={Coins} title="No ledger yet">
          Spend appears once the orchestrator sends its first snapshot.
        </EmptyState>
      )}
    </Panel>
  );
}

function OriginBadge({ origin }: { origin: DataOrigin }) {
  return (
    <Badge
      tone="neutral"
      variant="outline"
      size="sm"
      title="These totals come from a mock or replayed run, not live API usage"
    >
      {origin === "mock" ? "Mock data" : "Replayed data"}
    </Badge>
  );
}

function LedgerBody({ ledger }: { ledger: LedgerTotals }) {
  // Same source as the header's "Jev offline, using fallback": the live health of Jev.
  const jevOffline = useHealth()?.jevOffline ?? false;
  const ours = ledger.workerUsd + ledger.overheadUsd;
  const overheadShare = ours > 0 ? ledger.overheadUsd / ours : null;
  const overheadOk = overheadShare !== null && overheadShare < OVERHEAD_TARGET;
  const judged = ledger.jevCalls + ledger.fallbackCalls;

  return (
    <div className="flex flex-col gap-5">
      <dl className="m-0 grid grid-cols-3">
        <Big label="Worker" value={formatUsd(ledger.workerUsd)} first />
        <Big
          label="Overhead"
          value={formatUsd(ledger.overheadUsd)}
          note={
            overheadShare === null ? null : (
              <span className={cn("inline-flex items-center gap-1", overheadOk ? "text-ink-3" : "text-ink-2")}>
                {overheadOk ? (
                  <CircleCheck aria-hidden className="size-[1.05em] shrink-0" strokeWidth={2.25} />
                ) : (
                  <TriangleAlert aria-hidden className="size-[1.05em] shrink-0" strokeWidth={2.25} />
                )}
                {formatPct(overheadShare, 1)} of total, target under 5%
              </span>
            )
          }
        />
        <Big label="Total" value={formatUsd(ours)} />
      </dl>

      <NetSavings net={ledger.netSavingsUsd} baseline={ledger.baselineUsd} ours={ours} />

      <dl className="m-0 flex flex-col">
        <Row
          label={
            <>
              Reasoning reused
              <span title="Estimated, not measured" className="ml-1.5 rounded-sm px-1.5 py-px text-xs font-semibold text-ink-3 shadow-[inset_0_0_0_1px_var(--line-strong)]">
                est.
              </span>
            </>
          }
          value={`${formatTokens(ledger.reuseTokensEst)} tokens`}
          note={ledger.reuseUsdEst != null && Number.isFinite(ledger.reuseUsdEst) && ledger.reuseUsdEst > 0 ? `about ${formatUsd(ledger.reuseUsdEst)}, est.` : null}
        />
        <Row
          label="Jev vs fallback calls"
          value={`${formatInt(ledger.jevCalls)} vs ${formatInt(ledger.fallbackCalls)}`}
          note={
            jevOffline
              ? `Jev is offline now, so new checks go to the fallback judge${judged > 0 ? ` (${formatPct(ledger.fallbackCalls / judged, 0)} so far)` : ""}.`
              : judged > 0
                ? `${formatPct(ledger.fallbackCalls / judged, 0)} went to the fallback judge`
                : null
          }
        />
      </dl>

      <CategoryTable byCategory={ledger.byCategory} totalUsd={ours} />
    </div>
  );
}

/** 06's token usage: a grotesk label over a serif dollar figure, columns split by hairlines. */
function Big({ label, value, note, first }: { label: string; value: ReactNode; note?: ReactNode; first?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", !first && "border-l border-line-strong/70 pl-6")}>
      <dt className="text-base font-medium text-ink">{label}</dt>
      <dd className="font-display m-0 text-[2.9rem] leading-[0.9] font-semibold tabular-nums text-ink">
        <Roll k={typeof value === "string" ? value : label}>{value}</Roll>
      </dd>
      {note != null && <dd className="m-0 text-sm">{note}</dd>}
    </div>
  );
}

/** One compact label / value line; the note sits under the value. */
function Row({ label, value, note }: { label: ReactNode; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-line/60 py-1.5 last:border-b-0">
      <dt className="flex items-center text-sm font-medium text-ink-2">{label}</dt>
      <dd className="m-0 ml-auto text-right text-lg font-semibold text-ink">{value}</dd>
      {note != null && <dd className="m-0 w-full text-right text-xs text-ink-3">{note}</dd>}
    </div>
  );
}

function NetSavings({ net, baseline, ours }: { net: number | null; baseline: number | null; ours: number }) {
  const shown = useCountUp(net);

  if (net === null || shown === null) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-ink-2">Net savings vs baseline</div>
        <p className="m-0 text-lg font-semibold leading-snug text-balance text-ink-2">
          Net savings appear after a baseline run
        </p>
        <p className="m-0 text-sm text-ink-3">Our spend so far: {formatUsd(ours)}, overhead included.</p>
      </div>
    );
  }

  const saved = net > 0;
  const lost = net < 0;
  const Trend = lost ? TrendingDown : TrendingUp;
  return (
    <div>
      {/* Screen readers get the settled value, not every animation frame. */}
      <span className="sr-only">Net savings vs baseline: {formatUsd(net)}</span>
      <div aria-hidden className="flex flex-col gap-1.5">
        <Stat
          size="xl"
          label="Net savings vs baseline"
          value={formatUsd(shown)}
          tone={lost ? "failed" : "default"}
        />
        <div className="flex flex-col gap-0.5 text-sm">
          {(saved || lost) && (
            <span
              className={cn("inline-flex items-center gap-1 font-semibold", saved ? "text-ink" : "text-pathogen-ink")}
            >
              <Trend aria-hidden className="size-[1.1em] shrink-0" strokeWidth={2.5} />
              {saved ? "Cheaper than baseline" : "Costlier than baseline"}
            </span>
          )}
          <span className="text-ink-3">
            Baseline {formatUsd(baseline)} minus ours {formatUsd(ours)}, overhead included
          </span>
        </div>
      </div>
    </div>
  );
}
