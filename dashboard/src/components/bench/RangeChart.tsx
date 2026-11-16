import type { BenchMode } from "../../data/model";
import type { ReactNode } from "react";
import { cn } from "../ui";
import { HEADLINE_MODES, MODE_LABEL, type Spread } from "./stats";

// Series colors from DESIGN.md: accent for ours, ink-3 for Codex, line-strong for ablation.
export const MODE_COLOR: Record<BenchMode, string> = {
  codex_baseline: "var(--ink-3)",
  ours_cold: "var(--accent)",
  ours_warm: "color-mix(in oklch, var(--accent) 55%, var(--surface))",
  ablation: "var(--line-strong)",
};

export interface RangeRow {
  mode: BenchMode;
  spread: Spread | null;
  /** Shown instead of a bar when spread is null: "no runs", "no passing run". */
  emptyText?: string;
  /** Small extra note under the value, e.g. "2 of 9 runs". */
  note?: string;
}

interface RangeChartProps {
  title: string;
  /** "Lower is better" / "Higher is better": said in words, never left to color. */
  direction: string;
  rows: RangeRow[];
  format: (n: number) => string;
  /** Fixed axis max (1 for rates). Defaults to the largest max across rows. */
  domainMax?: number;
  size?: "md" | "lg";
  footnote?: ReactNode;
}

/**
 * One small multiple: a horizontal bar per mode at the mean, a whisker from
 * min to max, and the numbers written out beside it. The bars are decoration
 * for the eye; the text is the data (screen readers read the text only).
 */
export function RangeChart({ title, direction, rows, format, domainMax, size = "md", footnote }: RangeChartProps) {
  const max = domainMax ?? Math.max(0, ...rows.flatMap((r) => (r.spread ? [r.spread.max, r.spread.mean] : [])));
  const scale = (v: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
  const lg = size === "lg";

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3">
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={cn("font-semibold text-ink", lg ? "text-xl" : "text-lg")}>{title}</span>
        <span className="text-sm text-ink-3">{direction}</span>
      </figcaption>
      <ul className={cn("m-0 flex list-none flex-col p-0", lg ? "gap-3.5" : "gap-2.5")}>
        {rows.map((r) => {
          const headline = HEADLINE_MODES.has(r.mode);
          const s = r.spread;
          const showRange = s !== null && s.n > 1 && s.min !== s.max;
          return (
            <li key={r.mode} className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_auto] items-center gap-x-3">
              <span
                className={cn(
                  "truncate",
                  lg ? "text-base" : "text-sm",
                  headline ? "font-semibold text-ink" : "font-medium text-ink-2",
                )}
                title={MODE_LABEL[r.mode]}
              >
                {MODE_LABEL[r.mode]}
              </span>

              <div aria-hidden className={cn("relative rounded-sm bg-sunken", lg ? "h-7" : "h-5")}>
                {s && (
                  <>
                    <div
                      className="absolute inset-0 origin-left rounded-sm transition-transform duration-[240ms] ease-[var(--ease-out)] motion-reduce:transition-none"
                      style={{ transform: `scaleX(${scale(s.mean) / 100})`, background: MODE_COLOR[r.mode] }}
                    />
                    {showRange && (
                      // min-max whisker: ink line and caps with a surface halo, readable over any bar in either theme
                      <div
                        className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-ink shadow-[0_0_0_1.5px_var(--surface)]"
                        style={{ left: `${scale(s.min)}%`, width: `${scale(s.max) - scale(s.min)}%` }}
                      >
                        <span className="absolute -top-1.5 left-0 h-3.5 w-0.5 -translate-x-1/2 bg-ink shadow-[0_0_0_1.5px_var(--surface)]" />
                        <span className="absolute -top-1.5 right-0 h-3.5 w-0.5 translate-x-1/2 bg-ink shadow-[0_0_0_1.5px_var(--surface)]" />
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className={cn("min-w-[7.5rem] text-right leading-tight", lg ? "text-lg" : "text-base")}>
                {s ? (
                  <>
                    <span className={cn("font-semibold", headline ? "text-ink" : "text-ink-2")}>{format(s.mean)}</span>
                    {showRange && (
                      <span className="block text-xs text-ink-3">
                        <span className="sr-only">range </span>
                        {format(s.min)} to {format(s.max)}
                      </span>
                    )}
                    {r.note && <span className="block text-xs text-ink-3">{r.note}</span>}
                  </>
                ) : (
                  <span className="text-sm text-ink-3">{r.emptyText ?? "no runs"}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {footnote != null && <p className="text-xs text-ink-3">{footnote}</p>}
    </figure>
  );
}
