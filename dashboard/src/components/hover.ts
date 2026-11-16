// One tiny shared value: the agent slot the pointer (or keyboard focus) is on in "What just happened",
// so its card on the stage can answer with an outline (cross-highlight). No React context needed.
import { useSyncExternalStore } from "react";

let slot: number | null = null;
const subs = new Set<() => void>();

export function setHoverSlot(next: number | null) {
  if (next === slot) return;
  slot = next;
  for (const fn of subs) fn();
}

export function useHoverSlot(): number | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => slot,
    () => null,
  );
}
