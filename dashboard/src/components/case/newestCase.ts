import type { CaseSummary } from "../../data/model";

/** The most recently created case, or null. Order of the input is not assumed. */
export function newestCase(cases: CaseSummary[] | undefined): CaseSummary | null {
  if (!cases || cases.length === 0) return null;
  let best = cases[0];
  for (const c of cases) if (c.createdAt > best.createdAt) best = c;
  return best;
}

export function newestCaseId(cases: CaseSummary[] | undefined): string | null {
  return newestCase(cases)?.id ?? null;
}
