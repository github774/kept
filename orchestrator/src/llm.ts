// The single LLM adapter (rule 10): OpenRouter chat completions, OpenAI-compatible.
// Returns result + usage-derived ledger draft. No key => deterministic, labeled MOCK (rule 6).
import type { Prices } from "./config.ts";
import { fromChatUsage, mockDraft, toDraft, type CallMeta, type LedgerDraft, type RawUsage } from "./ledger-entry.ts";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
export type JsonSchema = Record<string, unknown>;
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type StepFailedKind = "schema" | "http" | "aborted";
export class StepFailed extends Error {
  override readonly name = "StepFailed";
  constructor(
    readonly kind: StepFailedKind,
    message: string,
    /** Ledger drafts for calls that were billed before the failure. */
    readonly usages: LedgerDraft[] = [],
    readonly status?: number,
  ) {
    super(message);
  }
}

/** FIFO counting semaphore; cap can change at runtime (demo vs benchmark). */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private cap: number) {}
  setCap(cap: number): void {
    this.cap = cap;
    this.drain();
  }
  get inFlight(): number {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.cap) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.drain();
    }
  }
  private drain(): void {
    while (this.active < this.cap && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
}

export interface HttpOpts {
  fetch: FetchFn;
  apiKey: string;
  maxRetries: number;
  baseDelayMs: number;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const retryable = (status: number) => status === 429 || status >= 500;

/** POST JSON with exponential backoff on 429/5xx/network errors. Throws StepFailed('http'|'aborted'). */
export async function postJson(url: string, body: unknown, o: HttpOpts): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw new StepFailed("aborted", `aborted before POST ${url}`);
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await o.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify(body),
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw new StepFailed("aborted", `aborted during POST ${url}`);
      err = e;
    }
    if (res?.ok) return res.json();
    const status = res?.status;
    const detail = res ? (await res.text().catch(() => "")).slice(0, 300) : String(err);
    if ((res && !retryable(res.status)) || attempt >= o.maxRetries) {
      throw new StepFailed("http", `POST ${url} failed (${status ?? "network"}): ${detail}`, [], status);
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(o.baseDelayMs * 2 ** attempt, 15_000) * (0.75 + Math.random() * 0.5);
    try {
      await sleep(delay, o.signal);
    } catch {
      throw new StepFailed("aborted", `aborted while backing off ${url}`);
    }
  }
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
/** Per-model request options (config/models.json `request_options`). */
export interface ModelRequestOptions {
  /** Reasoning tokens count against this, so keep it large (800 truncated DeepSeek JSON; docs/SMOKE.md). */
  max_tokens?: number;
  /** Sent as reasoning.effort; null => omit the reasoning field (provider default). */
  reasoning_effort?: ReasoningEffort | null;
  /** Fixed provider pin: provider.order = this, allow_fallbacks false. Disables auto pinning. */
  provider_order?: string[];
  /** Pin to the provider of the first successful response for the rest of the process (prompt cache). */
  auto_pin_provider?: boolean;
}
export interface RequestOptionsConfig {
  default?: ModelRequestOptions;
  models?: Record<string, ModelRequestOptions>;
}
/** Built-in defaults used when config has no request_options (DECISIONS #11). */
export const DEFAULT_REQUEST_OPTIONS: Required<Omit<ModelRequestOptions, "provider_order">> = {
  max_tokens: 4000,
  reasoning_effort: "low",
  auto_pin_provider: true,
};

export function resolveRequestOptions(cfg: RequestOptionsConfig | undefined, model: string): ModelRequestOptions {
  return { ...DEFAULT_REQUEST_OPTIONS, ...cfg?.default, ...cfg?.models?.[model] };
}

/**
 * Which fields belong to which action in a discriminated strict schema (e.g. the worker step).
 * Fields owned by some action but not the chosen one are nulled (or deleted when optional)
 * before validation, when the schema allows it; otherwise they are left alone.
 */
export interface ActionFields {
  key: string;
  byAction: Record<string, string[]>;
}

function allowsNull(s: JsonSchema | undefined): boolean {
  if (!s) return false;
  const t = (s as { type?: unknown }).type;
  if (t === "null" || (Array.isArray(t) && t.includes("null"))) return true;
  const any = (s as { anyOf?: JsonSchema[]; oneOf?: JsonSchema[] }).anyOf ?? (s as { oneOf?: JsonSchema[] }).oneOf;
  return Array.isArray(any) && any.some(allowsNull);
}

/** Returns the fields it cleared and the foreign fields it could not clear (schema not nullable/optional). */
export function stripForeignActionFields(
  data: unknown,
  schema: JsonSchema,
  af: ActionFields,
): { stripped: string[]; kept: string[] } {
  const out = { stripped: [] as string[], kept: [] as string[] };
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  const obj = data as Record<string, unknown>;
  const action = obj[af.key];
  if (typeof action !== "string" || !(action in af.byAction)) return out;
  const allowed = new Set(af.byAction[action]);
  const owned = new Set(Object.values(af.byAction).flat());
  const props = ((schema as { properties?: Record<string, JsonSchema> }).properties ?? {});
  const required = new Set(((schema as { required?: string[] }).required ?? []));
  for (const f of owned) {
    if (allowed.has(f) || f === af.key || obj[f] == null) continue;
    if (allowsNull(props[f])) {
      obj[f] = null;
      out.stripped.push(f);
    } else if (!required.has(f)) {
      delete obj[f];
      out.stripped.push(f);
    } else out.kept.push(f);
  }
  return out;
}

/** BUILD_SPEC "Step output schema" in OpenAI strict form (all keys required; optional ones nullable). */
export const WORKER_STEP_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "file", "code", "message", "claims", "approach_note", "summary"],
  properties: {
    action: { type: "string", enum: ["write_code", "run_tests", "message", "claim_done"] },
    file: { type: ["string", "null"] },
    code: { type: ["string", "null"] },
    message: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["to", "text"],
          properties: { to: { type: "string" }, text: { type: "string" } },
        },
      ],
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: ["tests_pass", "spec_fact", "instruction"] },
          text: { type: "string" },
        },
      },
    },
    approach_note: { type: "string" },
    summary: { type: "string" },
  },
};
export const WORKER_STEP_ACTION_FIELDS: ActionFields = {
  key: "action",
  byAction: { write_code: ["file", "code"], message: ["message"], run_tests: [], claim_done: [] },
};

export interface LlmDeps {
  baseUrl: string;
  /** undefined => MOCK mode. Never logged. */
  apiKey: string | undefined;
  prices: Prices;
  concurrency: number;
  fetch?: FetchFn;
  log?: (line: string) => void;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Per-model request options; built-in defaults apply when absent. */
  requestOptions?: RequestOptionsConfig;
}

/** Per-call overrides of the model's request options. */
export interface CallOverrides {
  maxTokens?: number;
  /** null => omit reasoning for this call. */
  reasoningEffort?: ReasoningEffort | null;
}

export interface StructuredOpts<T> extends CallOverrides {
  model: string;
  messages: ChatMessage[];
  /** JSON schema for response_format (strict). */
  schema: JsonSchema;
  schemaName: string;
  meta: CallMeta;
  signal?: AbortSignal;
  /** Optional runtime validator (e.g. zod's .parse); a throw counts as a schema failure. */
  parse?: (v: unknown) => T;
  /** Null out fields that belong to a different action than the chosen one (see ActionFields). */
  actionFields?: ActionFields;
}
export interface StructuredResult<T> {
  data: T;
  usage: LedgerDraft;
  /** Drafts for earlier billed attempts that failed schema validation (also belong in the ledger). */
  extraUsages: LedgerDraft[];
  model: string;
}
export interface TextOpts extends CallOverrides {
  model: string;
  messages: ChatMessage[];
  meta: CallMeta;
  signal?: AbortSignal;
}
export interface TextResult {
  text: string;
  usage: LedgerDraft;
  /** Drafts for an earlier billed attempt that was truncated/empty (also belong in the ledger). */
  extraUsages: LedgerDraft[];
  model: string;
}

interface ChatResponse {
  model?: string;
  provider?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: RawUsage;
}

/** Canned MOCK responses by schemaName; anything unregistered is derived from the schema. */
const mockResponses = new Map<string, (messages: ChatMessage[]) => unknown>([
  ["fallback_judge", () => ({ problem: false, probability: 0.5, reason: "[MOCK] no LLM key; fallback judge not consulted" })],
  ["fallback_judge_choice", () => ({ choice: "other", probability: 0.5, reason: "[MOCK] no LLM key" })],
]);
export function registerMock(schemaName: string, fn: (messages: ChatMessage[]) => unknown): void {
  mockResponses.set(schemaName, fn);
}

/** Deterministic minimal value satisfying a JSON schema (strings are labeled MOCK). */
export function mockFromSchema(schema: JsonSchema): unknown {
  const s = schema as {
    type?: string | string[];
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    anyOf?: JsonSchema[];
  };
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf?.[0]) return mockFromSchema(s.anyOf[0]);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") ?? "null" : s.type;
  switch (type) {
    case "object":
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, mockFromSchema(v)]));
    case "array":
      return [];
    case "string":
      return "MOCK";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

export function createLlm(deps: LlmDeps) {
  const fetchFn = deps.fetch ?? ((u, i) => fetch(u, i));
  const log = deps.log ?? ((l: string) => console.log(l));
  const limiter = new Semaphore(deps.concurrency);
  const url = `${deps.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const mock = !deps.apiKey;
  const http = (signal?: AbortSignal): HttpOpts => ({
    fetch: fetchFn,
    apiKey: deps.apiKey ?? "",
    maxRetries: deps.maxRetries ?? 4,
    baseDelayMs: deps.baseDelayMs ?? 500,
    signal,
  });

  /** Auto-captured provider pin per model (first successful response wins). */
  const pins = new Map<string, string>();

  function buildBody(model: string, base: Record<string, unknown>, ov: CallOverrides): Record<string, unknown> {
    const ro = resolveRequestOptions(deps.requestOptions, model);
    const maxTokens = ov.maxTokens ?? ro.max_tokens;
    const effort = ov.reasoningEffort !== undefined ? ov.reasoningEffort : ro.reasoning_effort;
    const order = ro.provider_order?.length ? ro.provider_order : ro.auto_pin_provider ? pins.get(model) && [pins.get(model)!] : undefined;
    return {
      model,
      ...base,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      provider: { require_parameters: true, ...(order ? { order, allow_fallbacks: false } : {}) },
      usage: { include: true },
    };
  }

  async function call(model: string, base: Record<string, unknown>, ov: CallOverrides, meta: CallMeta, signal?: AbortSignal) {
    const ro = resolveRequestOptions(deps.requestOptions, model);
    const autoPinned = !ro.provider_order?.length && ro.auto_pin_provider && pins.has(model);
    let res: ChatResponse;
    try {
      res = (await limiter.run(() => postJson(url, buildBody(model, base, ov), http(signal)))) as ChatResponse;
    } catch (e) {
      // An auto pin must never wedge the run: if the pinned provider fails, drop the pin and retry once unpinned.
      if (!(autoPinned && e instanceof StepFailed && e.kind === "http")) throw e;
      log(`[llm] ${model}: pinned provider ${pins.get(model)} failed (${e.status ?? "network"}); unpinning and retrying`);
      pins.delete(model);
      res = (await limiter.run(() => postJson(url, buildBody(model, base, ov), http(signal)))) as ChatResponse;
    }
    if (ro.auto_pin_provider && !ro.provider_order?.length && res.provider && !pins.has(model)) {
      pins.set(model, res.provider);
      log(`[llm] ${model}: pinned provider ${res.provider} for this process (prompt cache)`);
    }
    const returned = res.model ?? model;
    const usage = toDraft(fromChatUsage(res.usage, returned, deps.prices, model), meta);
    const choice = res.choices?.[0];
    const msg = choice?.message;
    return {
      model: returned,
      usage,
      content: msg?.content ?? null,
      refusal: msg?.refusal ?? null,
      finishReason: choice?.finish_reason ?? undefined,
      provider: res.provider,
    };
  }

  /** A present finish_reason other than "stop" (e.g. "length") means truncated output. */
  function checkFinish(finishReason: string | undefined): void {
    if (finishReason !== undefined && finishReason !== "stop") throw new Error(`finish_reason ${finishReason} (not stop)`);
  }

  async function chatStructured<T>(o: StructuredOpts<T>): Promise<StructuredResult<T>> {
    if (mock) {
      log(`[MOCK] chatStructured schema=${o.schemaName} category=${o.meta.category} (no LLM key)`);
      const raw = (mockResponses.get(o.schemaName) ?? (() => mockFromSchema(o.schema)))(o.messages);
      return { data: o.parse ? o.parse(raw) : (raw as T), usage: mockDraft(o.meta), extraUsages: [], model: "MOCK" };
    }
    const base = {
      messages: o.messages,
      response_format: { type: "json_schema", json_schema: { name: o.schemaName, strict: true, schema: o.schema } },
    };
    const billed: LedgerDraft[] = [];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await call(o.model, base, o, o.meta, o.signal).catch((e: unknown) => {
        if (e instanceof StepFailed) throw new StepFailed(e.kind, e.message, billed, e.status);
        throw e;
      });
      billed.push(r.usage);
      try {
        checkFinish(r.finishReason);
        if (r.content == null) throw new Error(r.refusal ? `refusal: ${r.refusal}` : "empty content");
        const parsed: unknown = JSON.parse(r.content);
        if (o.actionFields) {
          const { stripped, kept } = stripForeignActionFields(parsed, o.schema, o.actionFields);
          if (stripped.length) log(`[llm] ${o.schemaName}: cleared fields not used by the chosen action: ${stripped.join(",")}`);
          if (kept.length) log(`[llm] ${o.schemaName}: foreign fields left as-is (schema not nullable): ${kept.join(",")}`);
        }
        const data = o.parse ? o.parse(parsed) : (parsed as T);
        return { data, usage: r.usage, extraUsages: billed.slice(0, -1), model: r.model };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        log(`[llm] ${o.schemaName}: schema/JSON failure on attempt ${attempt + 1}: ${lastErr.slice(0, 200)}`);
      }
    }
    throw new StepFailed("schema", `${o.schemaName}: invalid structured output after retry: ${lastErr}`, billed);
  }

  async function chatText(o: TextOpts): Promise<TextResult> {
    if (mock) {
      log(`[MOCK] chatText category=${o.meta.category} (no LLM key)`);
      return { text: "[MOCK] Follow the spec excerpt exactly and verify claims by running the tests.", usage: mockDraft(o.meta), extraUsages: [], model: "MOCK" };
    }
    const billed: LedgerDraft[] = [];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await call(o.model, { messages: o.messages }, o, o.meta, o.signal).catch((e: unknown) => {
        if (e instanceof StepFailed) throw new StepFailed(e.kind, e.message, billed, e.status);
        throw e;
      });
      billed.push(r.usage);
      try {
        checkFinish(r.finishReason);
        if (r.content == null || !r.content.trim()) throw new Error("empty content");
        return { text: r.content.trim(), usage: r.usage, extraUsages: billed.slice(0, -1), model: r.model };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        log(`[llm] chatText: failure on attempt ${attempt + 1}: ${lastErr}`);
      }
    }
    throw new StepFailed("schema", `chatText: ${lastErr} after retry`, billed);
  }

  return {
    mock,
    chatStructured,
    chatText,
    limiter,
    setConcurrency: (cap: number) => limiter.setCap(cap),
    /** Current provider pins (configured pins are not listed). */
    pinnedProviders: (): Record<string, string> => Object.fromEntries(pins),
  };
}
export type Llm = ReturnType<typeof createLlm>;

export type ConcurrencyMode = "demo" | "benchmark";
let defaultLlm: Promise<Llm> | undefined;

/** Process-wide adapter built from config/ and env (config is imported lazily so tests need no env). */
export function getLlm(mode?: ConcurrencyMode): Promise<Llm> {
  defaultLlm ??= import("./config.ts").then(({ config }) =>
    createLlm({
      baseUrl: config.env.llmBaseUrl,
      apiKey: config.env.llmApiKey,
      prices: config.prices,
      concurrency: config.caps.concurrent_llm_calls_demo,
      requestOptions: config.models.request_options,
    }),
  );
  if (!mode) return defaultLlm;
  return Promise.all([defaultLlm, import("./config.ts")]).then(([llm, { config }]) => {
    llm.setConcurrency(mode === "demo" ? config.caps.concurrent_llm_calls_demo : config.caps.concurrent_llm_calls_benchmark);
    return llm;
  });
}

export async function chatStructured<T>(o: StructuredOpts<T>): Promise<StructuredResult<T>> {
  return (await getLlm()).chatStructured(o);
}
export async function chatText(o: TextOpts): Promise<TextResult> {
  return (await getLlm()).chatText(o);
}
