// Extra LLM capacity for fleet mode (opt-in via config/fleet.json "llm_pools"): worker / lesson calls are split
// between OpenRouter (the shared llm.ts adapter) and direct OpenAI (same model, gpt-6-luna). Benchmarks never
// load this file, so they stay OpenRouter-only.
//
// Routing: round-robin by weight while both pools are healthy; an OpenRouter http failure (429/5xx after the
// adapter's own retries) is retried once on OpenAI ("overflow"), and vice versa.
// USD: direct OpenAI returns no usage.cost, so fromChatUsage prices it from config/prices.json under the
// OpenRouter id ("openai/gpt-6-luna"). The ledger row's model is "openai-direct/<model>", so the provider
// stays visible in the ledger.
import { readFileSync, existsSync } from "node:fs";
import type { Prices } from "../config.ts";
import { fromChatUsage, toDraft, type LedgerDraft, type RawUsage } from "../ledger-entry.ts";
import { postJson, Semaphore, StepFailed, stripForeignActionFields, type Llm } from "../llm.ts";

export interface FleetLlmConfig {
  llm_pools: ("openrouter" | "openai")[];
  /** Share of calls sent to direct OpenAI while both pools are healthy (0..1). */
  openai_share?: number;
  openai_base_url?: string;
  /** Direct OpenAI model id; priced as `openai/<id>`. */
  openai_model?: string;
  openai_concurrency?: number;
}

export function loadFleetConfig(configDir: string): FleetLlmConfig {
  const p = `${configDir}/fleet.json`;
  if (!existsSync(p)) return { llm_pools: ["openrouter"] };
  return JSON.parse(readFileSync(p, "utf8")) as FleetLlmConfig;
}

/** Minimal OpenAI chat adapter (standard params only; OpenRouter's provider/usage/reasoning objects are not sent). */
export function directOpenAiLlm(o: { apiKey: string; baseUrl: string; model: string; prices: Prices; concurrency: number; log: (l: string) => void }): Llm {
  const limiter = new Semaphore(o.concurrency);
  const url = `${o.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const priced = `openai/${o.model}`;
  const ledgerModel = `openai-direct/${o.model}`;
  type Meta = { category: LedgerDraft["category"]; slot: string; gen: number; step: number };
  async function call(body: Record<string, unknown>, meta: Meta, signal?: AbortSignal, maxTokens?: number) {
    const res = (await limiter.run(() =>
      postJson(url, { model: o.model, ...body, max_completion_tokens: maxTokens ?? 4000, reasoning_effort: "low" }, { fetch: (u, i) => fetch(u, i), apiKey: o.apiKey, maxRetries: 3, baseDelayMs: 500, signal }),
    )) as { choices?: { finish_reason?: string; message?: { content?: string | null } }[]; usage?: RawUsage };
    const f = fromChatUsage(res.usage, priced, o.prices);
    const usage = toDraft({ ...f, model: ledgerModel }, meta);
    const ch = res.choices?.[0];
    return { usage, content: ch?.message?.content ?? null, finish: ch?.finish_reason };
  }
  const llm = {
    mock: false,
    limiter,
    setConcurrency: (n: number) => limiter.setCap(n),
    pinnedProviders: () => ({}),
    async chatStructured(s: { messages: unknown[]; schema: Record<string, unknown>; schemaName: string; meta: Meta; signal?: AbortSignal; maxTokens?: number; actionFields?: Parameters<typeof stripForeignActionFields>[2]; parse?: (v: unknown) => unknown }) {
      const billed: LedgerDraft[] = [];
      let last = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await call({ messages: s.messages, response_format: { type: "json_schema", json_schema: { name: s.schemaName, strict: true, schema: s.schema } } }, s.meta, s.signal, s.maxTokens).catch((e: unknown) => {
          if (e instanceof StepFailed) throw new StepFailed(e.kind, e.message, billed, e.status);
          throw e;
        });
        billed.push(r.usage);
        try {
          if (r.finish && r.finish !== "stop") throw new Error(`finish_reason ${r.finish}`);
          if (r.content == null) throw new Error("empty content");
          const parsed: unknown = JSON.parse(r.content);
          if (s.actionFields) stripForeignActionFields(parsed, s.schema, s.actionFields);
          return { data: s.parse ? s.parse(parsed) : parsed, usage: r.usage, extraUsages: billed.slice(0, -1), model: ledgerModel };
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
          o.log(`[llm openai-direct] ${s.schemaName}: attempt ${attempt + 1} failed: ${last.slice(0, 160)}`);
        }
      }
      throw new StepFailed("schema", `${s.schemaName}: invalid structured output after retry: ${last}`, billed);
    },
    async chatText(t: { messages: unknown[]; meta: Meta; signal?: AbortSignal; maxTokens?: number }) {
      const r = await call({ messages: t.messages }, t.meta, t.signal, t.maxTokens);
      if (!r.content?.trim()) throw new StepFailed("schema", "chatText: empty content", [r.usage]);
      return { text: r.content.trim(), usage: r.usage, extraUsages: [], model: ledgerModel };
    },
  };
  return llm as unknown as Llm;
}

/** Splits calls across pools (weighted round-robin) with overflow to the other pool on http failure. */
export function pooledLlm(primary: Llm, secondary: Llm, share: number, log: (l: string) => void): Llm & { counts: Record<string, number> } {
  let n = 0;
  const counts = { openrouter: 0, openai: 0, overflow: 0 };
  const pick = () => {
    n++;
    return Math.floor(n * share) !== Math.floor((n - 1) * share) ? "openai" : "openrouter";
  };
  const route = async <R>(f: (l: Llm) => Promise<R>): Promise<R> => {
    const first = pick();
    const [a, b] = first === "openai" ? [secondary, primary] : [primary, secondary];
    counts[first]++;
    try {
      return await f(a);
    } catch (e) {
      if (!(e instanceof StepFailed) || e.kind !== "http") throw e;
      counts.overflow++;
      log(`[fleet pools] ${first} failed (${e.status ?? "network"}); overflow to ${first === "openai" ? "openrouter" : "openai"}`);
      return f(b);
    }
  };
  return {
    ...primary,
    counts,
    chatStructured: (o: Parameters<Llm["chatStructured"]>[0]) => route((l) => l.chatStructured(o as never)),
    chatText: (o: Parameters<Llm["chatText"]>[0]) => route((l) => l.chatText(o)),
  } as unknown as Llm & { counts: Record<string, number> };
}

/**
 * The LLM fleet teams use: `base` alone, or base + direct OpenAI when config/fleet.json lists both pools and
 * OPENAI_API_KEY is set. Never logs the key.
 */
export function fleetLlm(base: Llm, cfg: FleetLlmConfig, prices: Prices, log: (l: string) => void, env: Record<string, string | undefined> = process.env): Llm {
  const key = env.OPENAI_API_KEY;
  if (!cfg.llm_pools.includes("openai") || base.mock) return base;
  if (!key) {
    log("[fleet pools] openai pool configured but OPENAI_API_KEY is not set; OpenRouter only");
    return base;
  }
  const openai = directOpenAiLlm({ apiKey: key, baseUrl: cfg.openai_base_url ?? "https://api.openai.com/v1", model: cfg.openai_model ?? "gpt-6-luna", prices, concurrency: cfg.openai_concurrency ?? 32, log });
  if (!cfg.llm_pools.includes("openrouter")) return openai;
  log(`[fleet pools] OpenRouter + direct OpenAI (${cfg.openai_model ?? "gpt-6-luna"}), openai share ${cfg.openai_share ?? 0.5}`);
  return pooledLlm(base, openai, cfg.openai_share ?? 0.5, log);
}
