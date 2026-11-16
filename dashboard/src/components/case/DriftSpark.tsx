import { memo } from "react";

interface Point {
  step: number;
  score: number;
}

const W = 160;
const H = 40;
const PAD = 3;

/**
 * Tiny line of drift score per step. Inherits its stroke from `currentColor`
 * so the caller decides the hue from the design tokens. The last point is
 * marked and labelled in text next to it by the caller, so the chart is never
 * the only carrier of the number.
 */
export const DriftSpark = memo(function DriftSpark({
  trace,
  className,
}: {
  trace: Point[];
  className?: string;
}) {
  if (trace.length === 0) return null;
  const pts = trace.toSorted((a, b) => a.step - b.step);
  const minX = pts[0].step;
  const maxX = pts[pts.length - 1].step;
  let maxY = 1;
  for (const p of pts) if (p.score > maxY) maxY = p.score;
  const x = (s: number) =>
    maxX === minX ? W / 2 : PAD + ((s - minX) / (maxX - minX)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (Math.max(0, v) / maxY) * (H - 2 * PAD);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.step).toFixed(1)} ${y(p.score).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className={className}
      role="img"
      aria-label={`Drift score over ${pts.length} steps, last ${last.score.toFixed(2)} at step ${last.step}`}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.step)} cy={y(last.score)} r={3.5} fill="currentColor" />
    </svg>
  );
});
