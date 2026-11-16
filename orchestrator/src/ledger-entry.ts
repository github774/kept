// One ledger row per API call (BUILD_SPEC "Token ledger"). Tokens come from API usage fields only (rule 7).
import type { Prices } from "./config.ts";

export type LedgerCategory =
  | "worker"
  | "jev"
  | "fallback_judge"
  | "embedding"
  | "lesson_writer"
  | "case_discussion";

export interface LedgerEntry {
  /** `<runId>.<slot>.g<gen>.s<step>.<n>`; makes Ledger.record idempotent. */
  id: string;
  category: LedgerCategory;
  /** Provider + exact model id from the response ("MOCK" for labeled mocks). */
  model: string;
  input_tokens: number;
  /** Subset of input_tokens. */
  cached_input_tokens: number;
  output_tokens: number;
  /** Subset of output_tokens (bills as output). */
  reasoning_tokens: number;
  usd: number;
  slot: string;
  gen: number;
  step: number;
  ts: number;
}

/** A ledger row before the caller assigns its id. */
export type LedgerDraft = Omit<LedgerEntry, "id">;

/** Where/why a call happened; passed into every adapter call. */
export interface CallMeta {
  category: LedgerCategory;
  slot: string;
  gen: number;
  step: number;
}

/** Union of the usage shapes we receive: OpenAI/OpenRouter chat + embeddings, and Jev. */
export interface RawUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost?: number | null;
}

export type UsageFields = Pick<
  LedgerEntry,
  "model" | "input_tokens" | "cached_input_tokens" | "output_tokens" | "reasoning_tokens" | "usd"
>;

const n = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Normalizes a usage object. usd = OpenRouter's usage.cost when present, else config/prices.json
 * (per 1M tokens; cached input at cached_input price; reasoning is already inside output).
 * `requestedModel` is a price-lookup fallback when the response's model id carries a suffix.
 */
export function fromChatUsage(
  usage: RawUsage | null | undefined,
  model: string,
  prices: Prices,
  requestedModel?: string,
): UsageFields {
  const u = usage ?? {};
  const input = n(u.prompt_tokens ?? u.input_tokens);
  const output = n(u.completion_tokens ?? u.output_tokens);
  const cached = Math.min(n(u.prompt_tokens_details?.cached_tokens), input);
  const reasoning = Math.min(n(u.completion_tokens_details?.reasoning_tokens), output);
  let usd: number;
  if (typeof u.cost === "number" && Number.isFinite(u.cost)) {
    usd = u.cost;
  } else {
    const p = prices.models[model] ?? (requestedModel ? prices.models[requestedModel] : undefined);
    if (!p) throw new Error(`No usage.cost and no price for model ${model} in config/prices.json`);
    usd = ((input - cached) * p.input + cached * (p.cached_input ?? p.input) + output * p.output) / 1e6;
  }
  return { model, input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_tokens: reasoning, usd };
}

export function toDraft(fields: UsageFields, meta: CallMeta, ts = Date.now()): LedgerDraft {
  return { ...fields, category: meta.category, slot: meta.slot, gen: meta.gen, step: meta.step, ts };
}

export function mockDraft(meta: CallMeta, ts = Date.now()): LedgerDraft {
  return toDraft(
    { model: "MOCK", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 0 },
    meta,
    ts,
  );
}

export function ledgerId(runId: string, meta: Pick<CallMeta, "slot" | "gen" | "step">, n: number): string {
  return `${runId}.${meta.slot}.g${meta.gen}.s${meta.step}.${n}`;
}

export function withId(draft: LedgerDraft, id: string): LedgerEntry {
  return { id, ...draft };
}
