import { useState, type ReactNode } from "react";
import { cn } from "./ui";

/**
 * A number that rolls instead of snapping when its value (`k`) changes: the old figure slides up and
 * fades out while the new one rises into place, 200 ms, transform and opacity only, both stacked in one
 * grid cell so nothing around it moves. Reduced motion: an instant swap.
 */
export function Roll({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  const [state, setState] = useState<{ k: string; shown: ReactNode; prev: ReactNode; n: number }>({ k, shown: children, prev: null, n: 0 });
  if (state.k !== k) setState({ k, shown: children, prev: state.shown, n: state.n + 1 });
  return (
    <span className={cn("roll", className)}>
      {state.prev != null && (
        <span key={`out${state.n}`} aria-hidden className="roll-out" onAnimationEnd={() => setState((s) => (s.n === state.n ? { ...s, prev: null } : s))}>
          {state.prev}
        </span>
      )}
      <span key={`in${state.n}`} className={state.n > 0 ? "roll-in" : undefined}>
        {children}
      </span>
    </span>
  );
}
