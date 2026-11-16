// Embeddings adapter (rule 10). OpenRouter /embeddings by default; EMBED_BASE_URL/EMBED_API_KEY override.
// No key => deterministic hashed bag-of-words vectors, labeled MOCK (rule 6).
import type { Prices } from "./config.ts";
import { fromChatUsage, mockDraft, toDraft, type CallMeta, type LedgerDraft, type RawUsage } from "./ledger-entry.ts";
import { postJson, Semaphore, type FetchFn } from "./llm.ts";

export interface EmbedDeps {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  dimensions: number;
  prices: Prices;
  fetch?: FetchFn;
  log?: (line: string) => void;
  limiter?: Semaphore;
  maxRetries?: number;
  baseDelayMs?: number;
}
export interface EmbedResult {
  vectors: number[][];
  usage: LedgerDraft;
  model: string;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** FNV-1a 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** MOCK vector: signed hashed bag of words, L2-normalized. Deterministic. */
export function mockVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    const h = hash(w);
    v[h % dims]! += h & 0x80000000 ? -1 : 1;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

interface EmbeddingsResponse {
  model?: string;
  data?: Array<{ index: number; embedding: number[] }>;
  usage?: RawUsage;
}

export function createEmbedder(deps: EmbedDeps) {
  const log = deps.log ?? ((l: string) => console.log(l));
  const limiter = deps.limiter ?? new Semaphore(4);
  const url = `${deps.baseUrl.replace(/\/$/, "")}/embeddings`;
  const mock = !deps.apiKey;

  async function embed(texts: string[], meta: CallMeta, signal?: AbortSignal): Promise<EmbedResult> {
    const m: CallMeta = { ...meta, category: "embedding" };
    if (mock) {
      log(`[MOCK] embed n=${texts.length} (no embedding key; hashed bag-of-words)`);
      return { vectors: texts.map((t) => mockVector(t, deps.dimensions)), usage: mockDraft(m), model: "MOCK" };
    }
    const res = (await limiter.run(() =>
      postJson(url, { model: deps.model, input: texts, dimensions: deps.dimensions, encoding_format: "float" }, {
        fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
        apiKey: deps.apiKey!,
        maxRetries: deps.maxRetries ?? 4,
        baseDelayMs: deps.baseDelayMs ?? 500,
        signal,
      }),
    )) as EmbeddingsResponse;
    const data = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) throw new Error(`embed: expected ${texts.length} vectors, got ${data.length}`);
    const model = res.model ?? deps.model;
    return {
      vectors: data.map((d) => d.embedding),
      usage: toDraft(fromChatUsage(res.usage, model, deps.prices, deps.model), m),
      model,
    };
  }
  return { mock, embed };
}
export type Embedder = ReturnType<typeof createEmbedder>;

let defaultEmbedder: Promise<Embedder> | undefined;
export function getEmbedder(): Promise<Embedder> {
  defaultEmbedder ??= Promise.all([import("./config.ts"), import("./llm.ts")]).then(async ([{ config }, { getLlm }]) =>
    createEmbedder({
      baseUrl: config.env.embedBaseUrl ?? config.env.llmBaseUrl,
      apiKey: config.env.embedBaseUrl ? config.env.embedApiKey : (config.env.embedApiKey ?? config.env.llmApiKey),
      model: config.models.embedding.model,
      dimensions: config.models.embedding.dimensions,
      prices: config.prices,
      limiter: (await getLlm()).limiter,
    }),
  );
  return defaultEmbedder;
}

export async function embed(texts: string[], meta: CallMeta, signal?: AbortSignal): Promise<EmbedResult> {
  return (await getEmbedder()).embed(texts, meta, signal);
}
