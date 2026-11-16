import { lazy, Suspense, useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { FLEET_CELL_STATUS, useFleetGrid, useFleetStats, type FleetCellCode, type FleetStatPoint } from "../data";
import { formatInt, formatPct, formatTokens, formatUsd } from "../lib/format";
import { useSpentUsd } from "./facts";
import { Roll } from "./Roll";
import { EmptyState, STATUS_META } from "./ui";

/*
  Fleet view (05): a thousand agents at once. The hero is the fleet grid on a sheet of paper (one
  dot per agent, teams of four, built in components/topology and loaded lazily; a plain canvas
  stands in until it exists). Beside it, three stat cards: poison caught, trap hits falling, cost.
  How vector cleansing works lives in Details (Cleansing.tsx).
*/
type GridModule = { FleetGrid: ComponentType };
const gridLoader = import.meta.glob<GridModule>("./topology/FleetGrid.tsx")["./topology/FleetGrid.tsx"];
const FleetGrid = gridLoader ? lazy(() => gridLoader().then((m) => ({ default: m.FleetGrid }))) : null;

export function FleetView() {
  const { current: stats, history } = useFleetStats();
  const spent = useSpentUsd();
  const grid = useFleetGrid();

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-[1.6rem] px-[2rem] pt-[1.6rem] pb-[1.7rem] min-[1100px]:grid-cols-[minmax(0,2.15fr)_minmax(0,1fr)]">
      <section aria-label={grid ? `The fleet: ${formatInt(grid.agents)} agents in ${formatInt(grid.teams)} teams` : "The fleet"} className="sheet flex min-h-[24rem] min-w-0 flex-col overflow-hidden min-[1100px]:min-h-0">
        {FleetGrid ? (
          <Suspense fallback={<DotGrid />}>
            <FleetGrid />
          </Suspense>
        ) : (
          <>
            <div className="min-h-0 flex-1 p-4">
              <DotGrid />
            </div>
            {grid && <Legend counts={grid.counts} />}
          </>
        )}
      </section>

      <div aria-label="At this scale" role="group" className="grid min-h-0 min-w-0 gap-[1.6rem] min-[1100px]:grid-rows-3">
        <StatCard
          label="Poison caught"
          rollKey={stats ? `${stats.poison.caught}/${stats.poison.injected}` : "-"}
          value={
            stats ? (
              <>
                {formatInt(stats.poison.caught)}
                <Small>of</Small>
                {formatInt(stats.poison.injected)}
              </>
            ) : (
              "–"
            )
          }
          note={
            stats ? (
              <>
                {stats.poison.spread === 0 ? "None spread to a teammate." : `${formatInt(stats.poison.spread)} spread before they were caught.`}{" "}
                {formatTokens(stats.poisonedContextTokensDropped)} poisoned tokens dropped by vector cleansing.
              </>
            ) : (
              "Start a run with 1,000 agents: this fills with how much poison was caught."
            )
          }
          title={stats ? `${formatInt(stats.falseClaimsCaught)} false claims caught, ${formatInt(stats.messagesBlocked)} messages blocked` : undefined}
        />
        <TrapRate history={history} current={stats?.trapHitRateRecent.rate ?? null} />
        <StatCard
          label="Cost"
          rollKey={formatUsd(spent)}
          value={formatUsd(spent)}
          note={stats ? (stats.overheadShare != null ? `Spent so far; ${formatPct(stats.overheadShare, 1)} of it is checking and sharing overhead.` : "Spent so far. Overhead share not reported.") : "Spent so far."}
        />
      </div>
    </div>
  );
}

/** "of" and "to" between the big numbers: the same serif, half the size. */
function Small({ children }: { children: ReactNode }) {
  return <span className="mx-[0.4em] align-[0.5em] text-[0.36em] font-semibold">{children}</span>;
}

/** 05's stat card: a serif label, a very large serif figure, and one quiet line under it. */
function StatCard({ label, value, rollKey, note, title, children }: { label: string; value: ReactNode; rollKey?: string; note?: ReactNode; title?: string; children?: ReactNode }) {
  return (
    <section aria-label={label} title={title} className="sheet flex min-h-0 min-w-0 flex-col overflow-hidden px-[1.5rem] pt-[1.2rem] pb-[1rem]">
      <h2 className="font-display m-0 text-[2.75rem] leading-[0.95] font-semibold tracking-[-0.012em] text-ink">{label}</h2>
      <p className="font-display m-0 mt-[0.35rem] text-[6.3rem] leading-[0.95] font-bold tracking-[-0.02em] whitespace-nowrap text-ink tabular-nums">
        <Roll k={rollKey ?? label}>{value}</Roll>
      </p>
      {children}
      {note != null && <p className="m-0 mt-auto line-clamp-2 shrink-0 pt-1 text-sm text-ink-3">{note}</p>}
    </section>
  );
}

/** "100% to 22%" with the recent-window rate drawn over time in print blue: immunity at work. */
function TrapRate({ history, current }: { history: FleetStatPoint[]; current: number | null }) {
  const rates = history.map((p) => p.trapHitRate).filter((r): r is number => r != null);
  const first = rates[0] ?? null;
  const value =
    first == null || current == null ? (
      current == null ? (
        "–"
      ) : (
        formatPct(current, 0)
      )
    ) : (
      <>
        {formatPct(first, 0)}
        <Small>to</Small>
        {formatPct(current, 0)}
      </>
    );
  return (
    <StatCard label="Trap hits" value={value} rollKey={`${first}/${current}`} note="Recent window. Falls as lessons reach the fleet.">
      {rates.length > 1 && <Spark values={rates} />}
    </StatCard>
  );
}

function Spark({ values }: { values: number[] }) {
  const w = 300;
  const h = 44;
  const max = Math.max(...values, 0.0001);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className="mt-1.5 block h-[1.8rem] w-full shrink overflow-visible">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const LEGEND: FleetCellCode[] = ["T", "P", "I", "X", "R", "F", "D", "."];

function codeColor(code: FleetCellCode): string {
  const status = FLEET_CELL_STATUS[code];
  if (status === "possessed") return "var(--pathogen)";
  if (status === "queued") return "var(--line-strong)";
  if (status === "done") return "var(--ink-3)";
  return STATUS_META[status].color;
}

function codeLabel(code: FleetCellCode): string {
  const status = FLEET_CELL_STATUS[code];
  if (status === "possessed") return "Bad note";
  if (status === "queued") return "Queued";
  if (status === "done") return "Done";
  return STATUS_META[status].label;
}

function Legend({ counts }: { counts: Record<FleetCellCode, number> }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 px-5 pb-3 text-sm text-ink-2">
      {LEGEND.filter((c) => counts[c] > 0).map((c) => (
        <li key={c} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: codeColor(c) }} />
          {codeLabel(c)} <span className="tabular-nums text-ink-3">{formatInt(counts[c])}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stand-in for the topology FleetGrid: one dot per agent on a canvas, coloured by status. */
function DotGrid() {
  const grid = useFleetGrid();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !grid) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const n = grid.cells.length;
    const cols = Math.ceil(Math.sqrt((n * rect.width) / Math.max(rect.height, 1)));
    const rows = Math.ceil(n / cols);
    const pitch = Math.min(rect.width / cols, rect.height / rows);
    const r = Math.max(1.5, pitch * 0.32);
    const css = getComputedStyle(canvas);
    const resolve = (v: string) => (v.startsWith("var(") ? css.getPropertyValue(v.slice(4, -1)).trim() : v);
    for (let i = 0; i < n; i++) {
      const code = grid.cells[i] as FleetCellCode;
      ctx.fillStyle = resolve(codeColor(code));
      ctx.beginPath();
      ctx.arc((i % cols) * pitch + pitch / 2, Math.floor(i / cols) * pitch + pitch / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [grid]);
  if (!grid) return <EmptyState title="Waiting for the fleet">The grid fills when a fleet-scale run starts.</EmptyState>;
  return <canvas ref={ref} className="block size-full" role="img" aria-label={`${grid.agents} agents, coloured by status`} />;
}

