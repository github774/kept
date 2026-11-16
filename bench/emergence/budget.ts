// Budget guard. Two independent measures, either one stops the experiment:
//   1. OpenRouter key usage (GET /api/v1/key): rise since the experiment's baseline > budget.
//   2. Ledger totals (sum of every run's Ledger USD) > budget.
// Only numeric fields of the key response are read; the key and its label are never printed.

export interface KeyUsage {
  usage: number;
  limit: number | null;
  limit_remaining: number | null;
}

export async function fetchKeyUsage(apiKey: string | undefined, baseUrl = "https://openrouter.ai/api/v1"): Promise<KeyUsage | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${baseUrl}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const usage = num(d.usage);
    if (usage === null) return null;
    return { usage, limit: num(d.limit), limit_remaining: num(d.limit_remaining) };
  } catch {
    return null;
  }
}

export interface BudgetStatus {
  over: boolean;
  reason: string | null;
  key_delta_usd: number | null;
  ledger_usd: number;
}

/** Pure: decides whether the budget is exceeded. */
export function checkBudget(budgetUsd: number, keyBaseline: number | null, keyNow: number | null, ledgerUsd: number): BudgetStatus {
  const delta = keyBaseline !== null && keyNow !== null ? keyNow - keyBaseline : null;
  if (delta !== null && delta > budgetUsd)
    return { over: true, reason: `OpenRouter key usage rose $${delta.toFixed(4)} > budget $${budgetUsd}`, key_delta_usd: delta, ledger_usd: ledgerUsd };
  if (ledgerUsd > budgetUsd)
    return { over: true, reason: `Ledger totals $${ledgerUsd.toFixed(4)} > budget $${budgetUsd}`, key_delta_usd: delta, ledger_usd: ledgerUsd };
  return { over: false, reason: null, key_delta_usd: delta, ledger_usd: ledgerUsd };
}

/** The larger of the two measures of spend so far (for pre-wave headroom checks). */
export const spentUsd = (s: BudgetStatus) => Math.max(s.key_delta_usd ?? 0, s.ledger_usd);
