import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useDashboard, useFleetStats, type BenchRow, type Recovery } from "../data";
import { formatInt, formatTokens, formatUsd } from "../lib/format";
import { headlineRatio, summarize, type ModeSummary } from "./bench/stats";
import { useBench } from "./bench/useBench";
import { TEAM_MAX, useCurrentRecovery, useImmunity, useSpentUsd, useStageRoster } from "./facts";
import { agentTitle, catchMs, faultTrusted, recoveryMs, recoveryStart, secs } from "./names";
import { Roll } from "./Roll";
import { cn } from "./ui";

/** Spec target for the note to tests passing. Shown as a target, never as a result. */
const TARGET_MS = 60_000;

/** Wall clock that ticks every `ms`, only while `active`. */
export function useNow(active: boolean, ms = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Measured rows only: anything flagged mock never feeds a claim on screen. */
export function useMeasuredBench(): { rows: BenchRow[]; summaries: ModeSummary[] } {
  const { data } = useBench();
  return useMemo(() => {
    // One suite only, same tasks both sides: the reasoning-heavy v3 suite, Kept's default config
    // (note sharing off, the measured winner) vs Codex subagents. Never pools versions/variants.
    const rows = (data?.rows ?? [])
      .filter((r) => {
        const x = r as typeof r & { task_version?: number; excluded?: unknown; variant?: unknown; sharing_fix?: unknown };
        return !r.mock && !x.excluded && !x.variant && !x.sharing_fix && x.task_version === 3 && (r.mode === "codex_baseline" || r.mode === "ablation");
      })
      .map((r) => (r.mode === "ablation" ? { ...r, mode: "ours_cold" as typeof r.mode } : r));
    return { rows, summaries: summarize(rows) };
  }, [data]);
}

/**
 * The header's proof slot. When measured runs of ours and of Codex subagents both exist, the
 * benchmark headline; until then, this run's own proof in one line.
 */
export function HeaderProof() {
  const { summaries } = useMeasuredBench();
  const ratio = headlineRatio(summaries);
  const base = summaries.find((s) => s.mode === "codex_baseline");
  const ours = summaries.find((s) => s.mode === "ours_cold");
  if (ratio != null && base?.tokensPerPass && ours?.tokensPerPass) return <BenchHeadline ratio={ratio} base={base} ours={ours} />;
  return <RunProof />;
}

function BenchHeadline({ ratio, base, ours }: { ratio: number; base: ModeSummary; ours: ModeSummary }) {
  const fewer = ratio >= 1;
  const factor = fewer ? ratio : 1 / ratio;
  const model = base.models.length === 1 && ours.models.length === 1 && base.models[0] === ours.models[0] ? base.models[0] : null;
  const runs = base.runs === ours.runs ? `${base.runs} runs each` : `${ours.runs} and ${base.runs} runs`;
  return (
    <p
      className="m-0 flex h-[1.9rem] items-baseline justify-center gap-x-3 overflow-hidden text-center whitespace-nowrap"
      title={`${model ? `Same model (${model})` : "Same tasks"}, reasoning-heavy suite, ${runs}, overhead included. In our runs, not a significance claim.`}
    >
      <span className="font-display text-[1.9rem] leading-none font-semibold tabular-nums">{factor.toFixed(1)}&times;</span>
      <span className="text-[1.2rem] font-semibold text-ink">{fewer ? "fewer" : "more"} tokens per passing task than Codex subagents</span>
      <span className="text-base text-ink-3">{runs}, same {model ? "model" : "tasks"}, reasoning-heavy suite</span>
    </p>
  );
}

/** "Caught in 3.0 s · recovered in 18.4 s · 2 teammates kept the lesson · $0.0082", from the live run. */
function RunProof() {
  const { snapshot } = useDashboard();
  const run = snapshot?.run ?? null;
  const now = useNow(run?.status === "running", 500);
  const r = useCurrentRecovery(now);
  const { targets } = useImmunity();
  const spent = useSpentUsd();
  const { current: fleet } = useFleetStats();
  const possessed = snapshot?.roster.find((a) => a.possessed && !(r && r.slot === a.slot && r.gen === a.gen && r.detectedAt != null));

  if (!run) return null;
  if (run.agents > TEAM_MAX && fleet) {
    // Counted from the same snapshot that turns a card Caught, so the header moves in the same tick as
    // the card (the fleet stats arrive every couple of seconds; "of 50 poisoned" lives on the Fleet view).
    const detected = snapshot?.recoveries.filter((x) => x.detectedAt != null).length ?? 0;
    const fleetParts = [
      `Caught ${formatInt(detected)} lying ${detected === 1 ? "agent" : "agents"}`,
      `${formatInt(fleet.lessonsDelivered)} lessons delivered`,
      ...(spent != null ? [formatUsd(spent)] : []),
    ];
    return <ProofLine>{fleetParts.join(" · ")}</ProofLine>;
  }
  const parts: string[] = [];
  const caught = r ? catchMs(r, run.startedAt) : null;
  const recovered = r ? recoveryMs(r, run.startedAt) : null;
  if (caught != null) parts.push(`Caught in ${secs(caught)}`);
  else if (r?.detectedAt != null) parts.push("Caught");
  if (recovered != null) parts.push(`recovered in ${secs(recovered)}`);
  else if (r && r.testsPassAt == null && recoveryStart(r, run.startedAt) != null) parts.push("recovering");
  if (targets.length > 0) parts.push(`${targets.length} ${targets.length === 1 ? "teammate" : "teammates"} kept the lesson`);
  if (spent != null) parts.push(formatUsd(spent));

  return (
    <ProofLine>
      {r ? parts.join(" · ") : possessed ? <>Waiting for {agentTitle(possessed.slot)}&rsquo;s next step&hellip;</> : <>No bad note yet. Leave one and watch the next run start higher.</>}
    </ProofLine>
  );
}

/** "THIS RUN  Caught in 3.0 s · recovered in 18.4 s · ...", centred under the headline. */
function ProofLine({ children }: { children: ReactNode }) {
  return (
    // Two fixed columns meeting near the centre: the label never moves when the sentence changes length.
    <p className="m-0 grid h-[1.9rem] w-full grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)] items-baseline gap-3 overflow-hidden text-[1.2rem] font-medium whitespace-nowrap text-ink-2">
      <span className="text-right text-base text-ink-3">This run</span>
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

/**
 * Side column: how fast it healed (with the steps), how many functions are done, what it cost.
 * Before a catch it waits in neutral words; a stale clock from an earlier replay is never shown.
 */
export function RunNumbers() {
  const { snapshot } = useDashboard();
  const run = snapshot?.run ?? null;
  const live = run?.status === "running";
  const now = useNow(live);
  // On a fleet run the recovery clock is the team on stage's; functions and spend are fleet-wide and say so.
  const stage = useStageRoster();
  const current = useCurrentRecovery(now, stage.fleet ? stage.agents.map((a) => a.slot) : null);
  const spent = useSpentUsd();
  const startedAt = run?.startedAt ?? null;
  const start = current ? recoveryStart(current, startedAt) : null;
  const recovering = current != null && current.testsPassAt == null && live && start != null;
  const possessed = stage.agents.find((a) => a.possessed && !(current && current.slot === a.slot && current.gen === a.gen && current.detectedAt != null));

  let value: string | null = null;
  let note = "Press Bad note. The clock runs from the note to passing tests; target under 1 minute.";
  let over = false;
  if (current && start != null && current.testsPassAt != null) {
    const ms = recoveryMs(current, startedAt) ?? 0;
    value = secs(ms);
    over = ms > TARGET_MS;
    note = `${agentTitle(current.slot)}, from the ${faultTrusted(current, startedAt) ? "note" : "catch"} to passing tests.`;
  } else if (recovering && start != null) {
    const ms = now - start;
    value = secs(ms);
    over = ms > TARGET_MS;
    note = `${agentTitle(current.slot)} is recovering.`;
  } else if (possessed) {
    note = `Waiting for ${agentTitle(possessed.slot)}'s next step…`;
  }

  return (
    <section aria-label="This run" className="flex flex-col gap-2 border-t border-line-strong pt-3">
      <div className="grid grid-cols-3 gap-x-6">
        <Num
          label={stage.fleet && stage.team != null ? `Team ${stage.team + 1} recovery` : "Recovery time"}
          tone={over ? "text-pathogen-ink" : "text-ink"}
          // A live clock ticks; it only rolls when it lands on a new final value.
          value={recovering ? value : <Roll k={value ?? "none"}>{value ?? (possessed ? "Waiting" : "Not yet")}</Roll>}
          muted={!value}
        />
        <Num
          label={stage.fleet ? "Fleet functions" : "Functions done"}
          value={
            run ? (
              <>
                <Roll k={String(run.testsPassing)}>{formatInt(run.testsPassing)}</Roll>
                <span className="text-[0.45em] text-ink-3"> of {formatInt(run.testsTotal)}</span>
              </>
            ) : (
              "–"
            )
          }
        />
        <Num label={stage.fleet ? "Fleet spend" : "Spent so far"} value={<Roll k={formatUsd(spent)}>{formatUsd(spent)}</Roll>} />
      </div>
      {/* Fixed-height lines: the note and the steps change text, never the height of this block. */}
      <p className="m-0 line-clamp-2 h-[2.84em] text-sm text-ink-3">
        {over ? "Over the 1 minute target." : note}
        {snapshot?.ledger && snapshot.ledger.reuseTokensEst > 0 && <> {formatTokens(snapshot.ledger.reuseTokensEst)} tokens reused, est.</>}
      </p>
      <div className="h-[1.42em] text-sm">{current && start != null && <Steps r={current} start={start} live={recovering} />}</div>
    </section>
  );
}

/** A label in grotesk over a number in the display serif (05's stat cards, small). */
function Num({ label, value, tone = "text-ink", muted }: { label: string; value: ReactNode; tone?: string; muted?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm whitespace-nowrap text-ink-2">{label}</span>
      <span className={cn("font-display leading-[0.9] font-semibold whitespace-nowrap tabular-nums", muted ? "text-[2rem] text-ink-3" : cn("text-[2.7rem]", tone))}>{value}</span>
    </div>
  );
}

/** The recovery steps as words with their offsets from the clock start; a step not reached yet stays grey. */
function Steps({ r, start, live }: { r: Recovery; start: number; live: boolean }) {
  const steps = [
    { label: "caught", at: r.detectedAt },
    { label: "retired", at: r.retireBeganAt ?? r.retiredAt },
    { label: "replaced", at: r.respawnedAt },
    { label: "tests pass", at: r.testsPassAt },
  ];
  const nextIdx = live ? steps.findIndex((s) => s.at == null) : -1;
  return (
    <ol aria-label="Recovery steps" className="m-0 flex list-none flex-nowrap gap-x-4 overflow-hidden p-0 text-sm whitespace-nowrap">
      {steps.map((s, i) => (
        <li
          key={s.label}
          aria-label={s.at != null ? `${s.label}, ${secs(s.at - start)} after the start` : i === nextIdx ? `${s.label}, in progress` : `${s.label}, not yet`}
          className={cn(s.at != null ? "text-ink-2" : i === nextIdx ? "font-medium text-ink" : "text-ink-3")}
        >
          {s.label}
          {s.at != null && <span className="text-ink-3 tabular-nums"> +{secs(s.at - start)}</span>}
        </li>
      ))}
    </ol>
  );
}
