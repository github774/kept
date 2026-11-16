import { mkdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { BENCH_DIR } from "./config.ts";
import type { BenchmarkResultRow } from "./types.ts";

export const RESULTS_PATH = join(BENCH_DIR, "results.json");
/** Rows from runs without a real key go here, never into results.json (rule 6). */
export const MOCK_RESULTS_PATH = join(BENCH_DIR, "results.mock.json");

export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (i > 200) throw new Error(`could not lock ${path}`);
      await Bun.sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

/** Appends one row; safe for 3 parallel trials (mkdir lock + atomic rename). */
export async function appendResult(row: BenchmarkResultRow): Promise<string> {
  const path = row.mock ? MOCK_RESULTS_PATH : RESULTS_PATH;
  await withLock(path, async () => {
    const f = Bun.file(path);
    const rows: unknown[] = (await f.exists()) ? ((await f.json()) as unknown[]) : [];
    const tmp = join(BENCH_DIR, `.results.${process.pid}.tmp`);
    await Bun.write(tmp, JSON.stringify([...rows, row], null, 2) + "\n");
    await rename(tmp, path);
  });
  return path;
}

/** Rewrites results.json under the same lock as appendResult (used by backfills). */
export async function updateResults(fn: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<void> {
  await withLock(RESULTS_PATH, async () => {
    const f = Bun.file(RESULTS_PATH);
    const rows = (await f.exists()) ? ((await f.json()) as Record<string, unknown>[]) : [];
    const tmp = join(BENCH_DIR, `.results.${process.pid}.tmp`);
    await Bun.write(tmp, JSON.stringify(fn(rows), null, 2) + "\n");
    await rename(tmp, RESULTS_PATH);
  });
}
