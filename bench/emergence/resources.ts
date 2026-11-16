// Process / memory sampler (`ps`), so the 32-awake-actor load is measured, not assumed.
// "Stack" processes = command matches durable-actors, bun, node or python (actor hosts, executors,
// the Relay engine, pytest). It is a machine-wide count, so unrelated bun/node processes are included.
import { spawnSync } from "node:child_process";
import type { ResourcePeaks } from "./types.ts";

const STACK = /durable|actors|\bbun\b|\/bun |\bnode\b|python/i;

export interface Sample {
  processes: number;
  stack_processes: number;
  stack_rss_mb: number;
  bench_rss_mb: number;
}

export function sampleProcesses(): Sample | null {
  const r = spawnSync("ps", ["-axo", "rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  let processes = 0;
  let stack = 0;
  let rssKb = 0;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    processes++;
    if (STACK.test(m[2]!)) {
      stack++;
      rssKb += Number(m[1]);
    }
  }
  return {
    processes,
    stack_processes: stack,
    stack_rss_mb: Math.round(rssKb / 1024),
    bench_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

export const emptyPeaks = (): ResourcePeaks => ({ processes: 0, stack_processes: 0, stack_rss_mb: 0, bench_rss_mb: 0, samples: 0 });

export class ResourceMonitor {
  readonly peaks: ResourcePeaks = emptyPeaks();
  last: Sample | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(everyMs = 5000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  tick(): Sample | null {
    const s = sampleProcesses();
    if (!s) return null;
    this.last = s;
    const p = this.peaks;
    p.samples++;
    p.processes = Math.max(p.processes, s.processes);
    p.stack_processes = Math.max(p.stack_processes, s.stack_processes);
    p.stack_rss_mb = Math.max(p.stack_rss_mb, s.stack_rss_mb);
    p.bench_rss_mb = Math.max(p.bench_rss_mb, s.bench_rss_mb);
    return s;
  }
}
