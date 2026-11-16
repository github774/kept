import { ChartColumnBig, CircleAlert, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BenchResults } from "../data/model";
import { formatDuration, formatPct, formatTokens, formatUsd, plural } from "../lib/format";
import { RangeChart, type RangeRow } from "./bench/RangeChart";
import { headlineRatio, MODE_LABEL, summarize, type ModeSummary } from "./bench/stats";
import { useBench } from "./bench/useBench";
import { Banner, Button, EmptyState, Panel, cn } from "./ui";

/**
 * Benchmark results, the demo's closing slide. Headline: tokens per passing task,
 * ours (cold) vs Codex subagents on the same model. Small multiples for success
 * rate, time to recovery and cost per run, each with mean and min-max range.
 */
export function BenchmarkChart() {
  const { data, error, loading, reload } = useBench();
  // Presenting mode: the demo closes on this panel, so it can take the whole screen.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const refresh = (
    <Button
      variant="ghost"
      size="sm"
      icon={RefreshCw}
      loading={loading}
      onClick={reload}
      aria-label="Reload benchmark results"
      title="Reload benchmark results"
    />
  );

  // Measured rows only: a mock row never feeds a chart or a claim. (The data layer adapts GET /api/bench.)
  const bench = useMemo(() => (data ? { ...data, rows: data.rows.filter((r) => !r.mock) } : null), [data]);
  const hiddenMock = data && bench ? data.rows.length - bench.rows.length : 0;

  return (
    <div className={expanded ? "fixed inset-0 z-50 flex bg-canvas p-8" : "h-full"}>
      <Panel
        className="h-full w-full"
        bodyClassName="@container"
        title="Benchmark"
        actions={
          <>

            {refresh}
            <Button
              variant="ghost"
              size="sm"
              icon={expanded ? Minimize2 : Maximize2}
              onClick={() => setExpanded((v) => !v)}
              aria-pressed={expanded}
              aria-label={expanded ? "Exit full screen (Esc)" : "Show the benchmark full screen"}
              title={expanded ? "Exit full screen (Esc)" : "Full screen"}
            >
              {expanded ? "Exit full screen" : null}
            </Button>
          </>
        }
      >
        {error && data && (
          <Banner tone="neutral" icon={CircleAlert} title="Showing the last results loaded" className="mb-4">
            Reload failed: {error}
          </Banner>
        )}
        {bench && bench.rows.length > 0 ? (
          <BenchBody bench={bench} expanded={expanded} />
        ) : error ? (
          <EmptyState icon={CircleAlert} title="Could not load benchmark results" action={refresh}>
            {error}. The orchestrator serves bench/results.json at /api/bench/results; check it is running, then reload.
          </EmptyState>
        ) : !bench ? (
          <EmptyState icon={ChartColumnBig} title="Loading benchmark results" />
        ) : (
          <EmptyState icon={ChartColumnBig} title="No measured benchmark runs yet">
            Results appear here as bench/results.json fills with measured runs: Codex subagents, ours cold, ours warm and the ablation.
            {hiddenMock > 0 && ` ${hiddenMock} mock rows are not shown.`}
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}

function describeRun(bench: BenchResults): string {
  const models = [...new Set(bench.rows.map((r) => r.model))];
  const model = models.length === 1 ? models[0] : models.length > 1 ? `${models.length} models` : null;
  const at =
    bench.generatedAt === null
      ? null
      : new Date(bench.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return [model ? `Model ${model}` : null, at ? `results from ${at}` : null].filter(Boolean).join(", ");
}

function BenchBody({ bench, expanded }: { bench: BenchResults; expanded: boolean }) {
  const summaries = useMemo(() => summarize(bench.rows), [bench.rows]);
  const ratio = headlineRatio(summaries);
  const base = summaries.find((s) => s.mode === "codex_baseline");
  const ours = summaries.find((s) => s.mode === "ours_cold");

  const tokenRows: RangeRow[] = summaries.map((s) => ({
    mode: s.mode,
    spread: s.tokensPerPass,
    emptyText: s.runs === 0 ? "no runs" : "no passing run",
    note: s.runs > 0 ? `${s.passes} of ${plural(s.runs, "run")} passed` : undefined,
  }));

  const successRows: RangeRow[] = summaries.map((s) => ({ mode: s.mode, spread: s.success }));
  const recoveryRows: RangeRow[] = summaries.map((s) => ({
    mode: s.mode,
    spread: s.recovery,
    emptyText: s.runs === 0 ? "no runs" : "none recorded",
    note: s.recovery && s.recoveryMissing > 0 ? `${s.recovery.n} of ${plural(s.runs, "run")}` : undefined,
  }));
  const costRows: RangeRow[] = summaries.map((s) => ({ mode: s.mode, spread: s.cost }));

  return (
    <div className={cn("flex flex-col", expanded ? "gap-10 p-4" : "gap-6")}>
      <div className="grid grid-cols-1 items-center gap-x-10 gap-y-5 @4xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Headline ratio={ratio} base={base} ours={ours} large={expanded} />
        <RangeChart
          size={expanded ? "lg" : "md"}
          title="Tokens per passing task"
          direction="lower is better"
          rows={tokenRows}
          format={formatTokens}
        />
      </div>

      <div className="grid grid-cols-1 gap-x-10 gap-y-6 @2xl:grid-cols-2 @6xl:grid-cols-3">
        <RangeChart
          size={expanded ? "lg" : "md"}
          title="Success rate"
          direction="higher is better"
          rows={successRows}
          format={(n) => formatPct(n, 0)}
          domainMax={1}
        />
        <RangeChart
          size={expanded ? "lg" : "md"}
          title="Time to recovery"
          direction="lower is better"
          rows={recoveryRows}
          format={(sec) => formatDuration(sec * 1000)}
          footnote="First trap failure to tests passing again."
        />
        <RangeChart
          size={expanded ? "lg" : "md"}
          title="Cost per run"
          direction="lower is better"
          rows={costRows}
          format={formatUsd}
          footnote="One price table for both sides."
        />
      </div>

      <p className="text-sm text-ink-3">
        Bars show the mean; whiskers and small figures show min to max across tasks (success, tokens) or runs (time,
        cost). Tokens per passing task counts failed runs&apos; tokens too. {trialNote(summaries)} In our runs, not
        significant. {describeRun(bench)}.
      </p>
    </div>
  );
}

function trialNote(summaries: ModeSummary[]): string {
  const withRuns = summaries.filter((s) => s.runs > 0);
  if (withRuns.length === 0) return "";
  const counts = [...new Set(withRuns.map((s) => s.runs))];
  const tasks = Math.max(...withRuns.map((s) => s.tasks));
  return counts.length === 1
    ? `${plural(counts[0], "run")} per mode over ${plural(tasks, "task")}.`
    : `${withRuns.map((s) => `${MODE_LABEL[s.mode]} ${s.runs}`).join(", ")} runs.`;
}

function Headline({
  ratio,
  base,
  ours,
  large,
}: {
  ratio: number | null;
  base?: ModeSummary;
  ours?: ModeSummary;
  large: boolean;
}) {
  if (ratio === null || !base?.tokensPerPass || !ours?.tokensPerPass) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xl font-semibold leading-snug text-ink-2 text-balance">
          The comparison appears once Codex subagents and ours (cold) each have a passing run.
        </p>
        <p className="text-sm text-ink-3">
          Codex subagents: {base ? `${base.passes} of ${plural(base.runs, "run")} passed` : "no runs"}. Ours, cold:{" "}
          {ours ? `${ours.passes} of ${plural(ours.runs, "run")} passed` : "no runs"}.
        </p>
      </div>
    );
  }

  const fewer = ratio >= 1;
  const factor = fewer ? ratio : 1 / ratio;
  const sameModel =
    base.models.length === 1 && ours.models.length === 1 && base.models[0] === ours.models[0] ? base.models[0] : null;
  const factorText = factor >= 10 ? Math.round(factor).toString() : factor.toFixed(1);
  return (
    <div className="flex flex-col gap-3">
      <p
        className={cn(
          "font-semibold leading-[1.05] tracking-[-0.025em] text-ink text-balance",
          large ? "text-[3.75rem]" : "text-2xl",
        )}
      >
        {factorText}× {fewer ? "fewer" : "more"} tokens per passing task than Codex subagents
      </p>
      <p className={cn("text-ink-2", large ? "text-xl" : "text-base")}>
        Ours, cold: {formatTokens(ours.tokensPerPass.mean)} tokens per pass. Codex subagents:{" "}
        {formatTokens(base.tokensPerPass.mean)}.{sameModel ? ` Both on ${sameModel}, same tasks and traps.` : ""}
      </p>
    </div>
  );
}
