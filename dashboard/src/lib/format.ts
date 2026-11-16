// The dashboard's one set of number formatters (components/ui re-exports them).
// Pure functions, no React.
// Missing values (null, undefined, NaN, Infinity) render as an en dash so a
// gap never reads as a zero.

export const MISSING = "–";

const MINUS = "−"; // typographic minus, same width as a figure

function isNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usdWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 1234 -> "1,234". */
export function formatInt(n: number | null | undefined): string {
  if (!isNum(n)) return MISSING;
  return intFmt.format(Math.round(n));
}

/**
 * USD with sensible precision for very cheap runs (Luna totals can be $0.003).
 *  >= $1,000 -> "$1,234"        >= $1 -> "$12.34"
 *  >= $0.01  -> "$0.423"        <  $0.01 -> two significant figures, "$0.0031"
 *  0 -> "$0.00". Negative values get a real minus sign: "−$0.004".
 */
export function formatUsd(n: number | null | undefined): string {
  if (!isNum(n)) return MISSING;
  const sign = n < 0 ? MINUS : "";
  return sign + "$" + usdMagnitude(Math.abs(n));
}

/** Same as formatUsd but always carries a sign: "+$0.12", "−$0.004", "$0.00". */
export function formatUsdSigned(n: number | null | undefined): string {
  if (!isNum(n)) return MISSING;
  if (n === 0) return "$0.00";
  return (n > 0 ? "+" : MINUS) + "$" + usdMagnitude(Math.abs(n));
}

function usdMagnitude(a: number): string {
  if (a === 0) return "0.00";
  if (a >= 1000) return usdWhole.format(a);
  if (a >= 1) return a.toFixed(2);
  if (a >= 0.01) return a.toFixed(3);
  // Two significant figures, never scientific notation.
  const digits = Math.min(10, Math.max(3, 1 - Math.floor(Math.log10(a))));
  return trimZeros(a.toFixed(digits));
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  const t = s.replace(/0+$/, "");
  return t.endsWith(".") ? t + "00" : t;
}

/** Compact token counts: 950 -> "950", 12,345 -> "12.3K", 4,200,000 -> "4.2M". */
export function formatTokens(n: number | null | undefined): string {
  if (!isNum(n)) return MISSING;
  const a = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  if (a < 10_000) return sign + intFmt.format(Math.round(a));
  if (a < 1_000_000) return sign + oneDecimal(a / 1_000) + "K";
  if (a < 1_000_000_000) return sign + oneDecimal(a / 1_000_000) + "M";
  return sign + oneDecimal(a / 1_000_000_000) + "B";
}

function oneDecimal(x: number): string {
  return x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, "");
}

/** Fraction 0..1 -> "42%". `digits` decimals; tiny non-zero values never round to "0%". */
export function formatPct(fraction: number | null | undefined, digits = 0): string {
  if (!isNum(fraction)) return MISSING;
  const pct = fraction * 100;
  const floor = 1 / 10 ** digits;
  if (pct > 0 && pct < floor) return "<" + floor.toFixed(digits) + "%";
  return pct.toFixed(digits) + "%";
}

/**
 * Milliseconds -> "840 ms", "4.2 s", "42 s", "3 m 05 s", "2 h 05 m".
 * Takes ms like every timestamp in the contract; pass seconds * 1000.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (!isNum(ms)) return MISSING;
  const sign = ms < 0 ? MINUS : "";
  const a = Math.abs(ms);
  if (a < 1000) return sign + Math.round(a) + " ms";
  const s = a / 1000;
  if (s < 10) return sign + s.toFixed(1) + " s";
  if (s < 60) return sign + Math.round(s) + " s";
  const total = Math.round(s);
  if (total < 3600) {
    const m = Math.floor(total / 60);
    return sign + `${m} m ${String(total % 60).padStart(2, "0")} s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return sign + `${h} h ${String(m).padStart(2, "0")} m`;
}

/** Epoch ms -> "14:03:22" local clock time for event rows. */
export function formatClock(ts: number | null | undefined): string {
  if (!isNum(ts)) return MISSING;
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Events per second: 12.34 -> "12.3/s", 1530 -> "1,530/s". */
export function formatRate(perSec: number | null | undefined): string {
  if (!isNum(perSec)) return MISSING;
  if (perSec < 100) return perSec.toFixed(1).replace(/\.0$/, "") + "/s";
  return intFmt.format(Math.round(perSec)) + "/s";
}

/** "1 trial" / "3 trials". */
export function plural(n: number, one: string, many = one + "s"): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}
