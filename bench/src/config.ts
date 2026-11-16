import { join, resolve } from "node:path";
import type { TokenCounts as Tokens } from "./types.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const BENCH_DIR = join(REPO_ROOT, "bench");
export const CONFIG_DIR = join(REPO_ROOT, "config");

interface Price {
  input: number;
  cached_input?: number;
  output: number;
}
interface PricesFile {
  checked: string;
  models: Record<string, Price>;
}
interface ModelsFile {
  worker: string;
  profiles?: { bench?: { worker?: string } };
}
interface CapsFile {
  codex_wall_clock_ms: number;
}

const readJson = async <T>(name: string): Promise<T> =>
  (await Bun.file(join(CONFIG_DIR, name)).json()) as T;

export const loadPrices = () => readJson<PricesFile>("prices.json");
export const loadModels = () => readJson<ModelsFile>("models.json");
/** Benchmark model: models.json profiles.bench.worker (GPT-6 Luna), else top-level worker. */
export const benchModel = (m: ModelsFile): string => m.profiles?.bench?.worker ?? m.worker;
export const loadCaps = () => readJson<CapsFile>("caps.json");

/** USD from config/prices.json (per 1M tokens). Reasoning bills as output and is already inside output. */
export function priceTokens(prices: PricesFile, model: string, t: Tokens): number {
  const p = prices.models[model];
  if (!p) throw new Error(`no price for model ${model} in config/prices.json`);
  const uncached = Math.max(0, t.input - t.cached);
  const usd =
    (uncached * p.input + t.cached * (p.cached_input ?? p.input) + t.output * p.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Loads keys from the repo .env into process.env when absent (Bun only auto-loads .env from cwd).
 * Never prints values.
 */
export async function loadRepoEnv(): Promise<void> {
  const f = Bun.file(join(REPO_ROOT, ".env"));
  if (!(await f.exists())) return;
  for (const line of (await f.text()).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || !m[1] || m[2] === undefined) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (val && !process.env[m[1]]) process.env[m[1]] = val;
  }
}
