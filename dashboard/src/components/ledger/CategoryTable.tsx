import type { LedgerCategory, LedgerTotals } from "../../data/model";
import { cn } from "../ui";
import { formatInt, formatPct, formatTokens, formatUsd } from "../../lib/format";

// Fixed order so rows never jump while totals stream in. Worker first, then overhead.
const CATEGORY_ORDER: { key: LedgerCategory; label: string }[] = [
  { key: "worker", label: "Workers" },
  { key: "jev", label: "Jev checks" },
  { key: "fallback_judge", label: "Fallback judge" },
  { key: "embedding", label: "Embeddings" },
  { key: "lesson_writer", label: "Lesson writer" },
  { key: "case_discussion", label: "Case discussion" },
];

/**
 * Compact per-category spend. Tokens: input (cached input is part of it) and
 * output (reasoning bills as output and is part of it), straight from usage fields.
 */
export function CategoryTable({ byCategory, totalUsd }: { byCategory: LedgerTotals["byCategory"]; totalUsd: number }) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Spend by ledger category</caption>
      <thead>
        <tr className="border-b border-line text-left text-ink-3">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Category
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Calls
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Tokens in
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Tokens out
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Cost
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {CATEGORY_ORDER.map(({ key, label }) => {
          const row = byCategory?.[key];
          const usd = row?.usd ?? 0;
          const share = totalUsd > 0 ? usd / totalUsd : null;
          const idle = !row || row.calls === 0;
          return (
            <tr key={key} className={cn("border-b border-line/60 last:border-b-0", idle && "text-ink-3")}>
              <th
                scope="row"
                className={cn("py-1.5 pr-3 text-left font-medium", key === "worker" ? "text-ink" : "text-ink-2")}
              >
                {label}
              </th>
              <td className="py-1.5 pr-3 text-right">{formatInt(row?.calls ?? 0)}</td>
              <td className="py-1.5 pr-3 text-right">{formatTokens(row?.input ?? 0)}</td>
              <td className="py-1.5 pr-3 text-right">{formatTokens(row?.output ?? 0)}</td>
              <td className="py-1.5 pr-3 text-right font-semibold">{formatUsd(usd)}</td>
              <td className="py-1.5 text-right">{share === null ? "–" : formatPct(share, 1)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
