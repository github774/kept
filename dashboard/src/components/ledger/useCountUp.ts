import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(QUERY).matches;
}

/** Live prefers-reduced-motion flag. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// Exponential ease-out: fast start, settles gently on the real value.
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

/**
 * Animates from the currently displayed value to `target` whenever target
 * changes. Returns the value to render. With reduced motion, or when target is
 * null, it returns target directly. The final frame is always exactly target.
 */
export function useCountUp(target: number | null, durationMs = 240): number | null {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState<number | null>(target);
  const shownRef = useRef<number | null>(target);

  useEffect(() => {
    if (target === null || reduced) {
      // Rendered straight from target below; just remember where we are.
      shownRef.current = target;
      return;
    }
    const from = shownRef.current ?? 0;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const v = t >= 1 ? target : from + (target - from) * easeOutExpo(t);
      shownRef.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced, durationMs]);

  return target === null || reduced ? target : shown;
}
