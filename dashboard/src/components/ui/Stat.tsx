import type { ReactNode } from "react";
import { cn } from "./cn";
import { toneText, type Tone } from "./tone";

export interface StatProps {
  /** What the number is, in plain words: "Net savings vs baseline". */
  label: ReactNode;
  /** Pre-formatted value: use formatUsd / formatTokens / formatDuration. */
  value: ReactNode;
  /** Adds an "est." tag. Required for anything estimated (reuseTokensEst, reuseUsdEst). */
  est?: boolean;
  /** One short line under the value that names its baseline: "of $2.14 baseline". */
  hint?: ReactNode;
  /** Value colour. Keep "default" unless the number IS the verdict (net savings > 0 = trusted). */
  tone?: Tone | "default";
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const valueSizes = {
  sm: "text-xl",
  md: "text-2xl",
  lg: "text-3xl",
  xl: "text-4xl",
} as const;

/** A number with its label above it. The label is read first, then how much. */
export function Stat({ label, value, est, hint, tone = "default", size = "lg", className }: StatProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-baseline gap-2 text-sm text-ink-2">
        <span className="truncate">{label}</span>
        {est && (
          <span title="Estimated, not measured" className="text-xs text-ink-3 italic">
            est.
          </span>
        )}
      </div>
      <div className={cn("font-semibold tabular-nums", valueSizes[size], tone === "default" ? "text-ink" : toneText[tone])}>{value}</div>
      {hint != null && <div className="text-sm text-ink-3">{hint}</div>}
    </div>
  );
}
