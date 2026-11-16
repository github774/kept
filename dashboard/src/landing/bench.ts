import raw from "../../../bench/results.summary.json?raw";

/*
  Every benchmark figure on the landing page, read at build time from bench/results.summary.json (the aggregator's
  output; methodology in docs/BENCHMARK.md). One suite per figure, same tasks and same model on both sides:
  task versions and config variants are never pooled. A group the file does not hold is null and the page says so.

  - Light suite (tasks v2): Codex subagents vs Kept (ours_cold), 9 runs each.
  - Heavy suite (tasks v3, reasoning-heavy): Codex subagents vs Kept's default config (note sharing off, the
    measured winner, recorded as the "ablation" group), 9 and 6 runs.
*/

interface Stat {
  mean: number | null;
}

interface Group {
  group: string;
  trials: number;
  passes: number;
  tokens_per_passing_task?: Stat;
  usd_per_passing_task?: Stat;
  trap_hits?: Stat;
}

export interface Side {
  trials: number;
  passes: number;
  tokensPerPass: number | null;
  usdPerPass: number | null;
  /** Distinct traps hit at any time, summed over the runs. */
  trapHits: number | null;
}

export interface Suite {
  name: string;
  codex: Side | null;
  neo: Side | null;
  /** Codex tokens per passing task over Kept's, when both exist. */
  ratio: number | null;
}

function load(): Map<string, Group> {
  try {
    const parsed = JSON.parse(raw) as { mock?: boolean; groups?: Group[] };
    if (parsed.mock) return new Map();
    return new Map((parsed.groups ?? []).map((g) => [g.group, g]));
  } catch {
    return new Map();
  }
}

const GROUPS = load();

function side(id: string): Side | null {
  const g = GROUPS.get(id);
  if (!g) return null;
  const traps = g.trap_hits?.mean;
  return {
    trials: g.trials,
    passes: g.passes,
    tokensPerPass: g.tokens_per_passing_task?.mean ?? null,
    usdPerPass: g.usd_per_passing_task?.mean ?? null,
    trapHits: traps != null ? Math.round(traps * g.trials) : null,
  };
}

function suite(name: string, codexId: string, neoId: string): Suite {
  const codex = side(codexId);
  const neo = side(neoId);
  const ratio = codex?.tokensPerPass && neo?.tokensPerPass ? codex.tokensPerPass / neo.tokensPerPass : null;
  return { name, codex, neo, ratio };
}

export const LIGHT = suite("light", "codex_baseline@v2", "ours_cold@v2");
export const HEAVY = suite("heavy", "codex_baseline@v3", "ablation@v3");

const sum = (xs: (number | null | undefined)[]) => (xs.every((x) => x != null) ? (xs as number[]).reduce((a, b) => a + b, 0) : null);

/** Traps hit across both suites: Codex vs Kept. */
export const TRAPS = {
  codex: sum([LIGHT.codex?.trapHits, HEAVY.codex?.trapHits]),
  neo: sum([LIGHT.neo?.trapHits, HEAVY.neo?.trapHits]),
};

export const fmtX = (r: number) => `${Math.round(r)}×`;
