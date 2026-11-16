import { useEffect } from "react";
import { useBenchResults } from "../../data";

const POLL_MS = 60_000;

/**
 * BenchResults from the shared data cache (GET /api/bench/results), re-read
 * every minute so a dashboard opened before the last trials finished still ends
 * on real numbers. The cache keeps the last good result when a reload fails.
 */
export function useBench() {
  const res = useBenchResults();
  const { reload } = res;
  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return res;
}
