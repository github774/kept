import { cn } from "./cn";

export interface LiveDotProps {
  /** CSS color; defaults to the trusted green ("running", "live"). */
  color?: string;
  /** Blink (default true). Off for a steady indicator. Reduced motion stops it either way. */
  pulse?: boolean;
  className?: string;
}

/** A steady status dot. Pair it with a text label. */
export function LiveDot({ color = "var(--pass)", pulse: _pulse = false, className }: LiveDotProps) {
  // Steady by design: no looping ambient motion on this screen. `pulse` is accepted and ignored.
  void _pulse;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: color }}
    />
  );
}
