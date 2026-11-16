import { describe, expect, test } from "bun:test";
import { fromChatUsage, ledgerId, type CallMeta } from "../src/ledger-entry.ts";
import {
  createLlm,
  mockFromSchema,
  Semaphore,
  StepFailed,
  stripForeignActionFields,
  WORKER_STEP_ACTION_FIELDS,
  WORKER_STEP_SCHEMA,
  type FetchFn,
  type RequestOptionsConfig,
} from "../src/llm.ts";
import { cosine, createEmbedder, mockVector } from "../src/embeddings.ts";

const prices = {
  checked: "test",
  models: {
    "openai/gpt-6-luna": { input: 0.1, cached_input: 0.01, output: 0.5 },
    "openai/text-embedding-3-small": { input: 0.02, output: 0 },
  },
};
const meta: CallMeta = { category: "worker", slot: "s1", gen: 1, step: 3 };
const quiet = () => {};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chat = (
  content: string | null,
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5 },
  extra: { finish_reason?: string | null; provider?: string } = {},
) =>
  json({
    model: "openai/gpt-6-luna",
    ...(extra.provider ? { provider: extra.provider } : {}),
    choices: [{ finish_reason: extra.finish_reason === undefined ? "stop" : extra.finish_reason, message: { content } }],
    usage,
  });

function seq(...responses: Array<() => Response>) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return r();
  };
  return { fetch, calls };
}
const llmWith = (fetch: FetchFn, apiKey: string | undefined = "k", requestOptions?: RequestOptionsConfig, log: (l: string) => void = quiet) =>
  createLlm({ baseUrl: "https://x/api/v1", apiKey, prices, concurrency: 2, fetch, log, baseDelayMs: 1, requestOptions });
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

describe("ledger math", () => {
  test("cached and reasoning are subsets; prices.json when no cost", () => {
    const u = fromChatUsage(
      { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 400_000 }, completion_tokens: 200_000, completion_tokens_details: { reasoning_tokens: 150_000 } },
      "openai/gpt-6-luna",
      prices,
    );
    expect(u.input_tokens).toBe(1_000_000);
    expect(u.cached_input_tokens).toBe(400_000);
    expect(u.output_tokens).toBe(200_000);
    expect(u.reasoning_tokens).toBe(150_000);
    // 600k*0.10 + 400k*0.01 + 200k*0.50 (reasoning not double-billed) per 1M
    expect(u.usd).toBeCloseTo(0.06 + 0.004 + 0.1, 10);
  });
  test("OpenRouter usage.cost preferred over prices", () => {
    expect(fromChatUsage({ prompt_tokens: 100, completion_tokens: 10, cost: 0.0123 }, "openai/gpt-6-luna", prices).usd).toBe(0.0123);
  });
  test("Jev usage shape; missing fields are 0; unknown price throws", () => {
    const u = fromChatUsage({ input_tokens: 50, output_tokens: 1, cost: 0.000002 }, "typesafe/jev-1.14", prices);
    expect([u.input_tokens, u.output_tokens, u.cached_input_tokens, u.reasoning_tokens, u.usd]).toEqual([50, 1, 0, 0, 0.000002]);
    expect(() => fromChatUsage({ prompt_tokens: 1 }, "nope/model", prices)).toThrow(/No usage.cost/);
    expect(fromChatUsage({ prompt_tokens: 1 }, "openai/gpt-6-luna-2026", prices, "openai/gpt-6-luna").usd).toBeCloseTo(1e-7);
  });
  test("ledgerId format", () => expect(ledgerId("r1", meta, 2)).toBe("r1.s1.g1.s3.2"));
});

describe("chatStructured", () => {
  test("parses and returns usage draft with meta", async () => {
    const { fetch, calls } = seq(() => chat('{"ok":true}', { prompt_tokens: 10, completion_tokens: 5, cost: 0.5 }));
    const r = await llmWith(fetch).chatStructured<{ ok: boolean }>({ model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta });
    expect(r.data.ok).toBe(true);
    expect(r.usage).toMatchObject({ category: "worker", model: "openai/gpt-6-luna", input_tokens: 10, output_tokens: 5, usd: 0.5, slot: "s1", gen: 1, step: 3 });
    expect(calls[0]!.body.response_format.json_schema).toMatchObject({ name: "t", strict: true });
  });
  test("one retry on bad JSON then success; failed attempt billed in extraUsages", async () => {
    const { fetch, calls } = seq(() => chat("not json"), () => chat('{"ok":false}'));
    const r = await llmWith(fetch).chatStructured<{ ok: boolean }>({ model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta });
    expect(calls.length).toBe(2);
    expect(r.data.ok).toBe(false);
    expect(r.extraUsages.length).toBe(1);
  });
  test("schema failure twice -> StepFailed('schema') with both usages", async () => {
    const { fetch, calls } = seq(() => chat('{"ok":"yes"}'));
    const parse = (v: unknown) => {
      if (typeof (v as { ok?: unknown }).ok !== "boolean") throw new Error("ok not boolean");
      return v as { ok: boolean };
    };
    const err = await llmWith(fetch)
      .chatStructured({ model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta, parse })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StepFailed);
    expect(err.kind).toBe("schema");
    expect(err.usages.length).toBe(2);
    expect(calls.length).toBe(2);
  });
  test("backoff on 429/5xx then success; 400 not retried", async () => {
    const a = seq(() => json({}, 429), () => json({}, 503), () => chat('{"ok":true}'));
    const ok = await llmWith(a.fetch).chatStructured<{ ok: boolean }>({ model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta });
    expect(ok.data.ok).toBe(true);
    expect(a.calls.length).toBe(3);
    const b = seq(() => json({ error: "bad" }, 400));
    const err = await llmWith(b.fetch).chatStructured({ model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta }).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailed);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(400);
    expect(b.calls.length).toBe(1);
  });
  test("AbortSignal -> StepFailed('aborted')", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const err = await llmWith(seq(() => chat("{}")).fetch)
      .chatStructured({ model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta, signal: ctl.signal })
      .catch((e) => e);
    expect(err.kind).toBe("aborted");
  });
  test("MOCK mode: no fetch, model MOCK, logs [MOCK], deterministic", async () => {
    const lines: string[] = [];
    const llm = createLlm({ baseUrl: "x", apiKey: undefined, prices, concurrency: 1, log: (l) => lines.push(l), fetch: () => { throw new Error("no"); } });
    const r = await llm.chatStructured({ model: "m", messages: [], schema: { type: "object", properties: { s: { type: "string" }, n: { type: "integer" }, e: { enum: ["a", "b"] } } }, schemaName: "x", meta });
    expect(r.model).toBe("MOCK");
    expect(r.usage.model).toBe("MOCK");
    expect(r.data).toEqual({ s: "MOCK", n: 0, e: "a" });
    const fb = await llm.chatStructured<{ problem: boolean }>({ model: "m", messages: [], schema, schemaName: "fallback_judge", meta });
    expect(fb.data.problem).toBe(false);
    const t = await llm.chatText({ model: "m", messages: [], meta });
    expect(t.text).toContain("[MOCK]");
    expect(lines.every((l) => l.includes("[MOCK]"))).toBe(true);
    expect(mockFromSchema({ type: "array" })).toEqual([]);
  });
});

describe("request options (DECISIONS #11)", () => {
  const M = "deepseek/deepseek-v4.1-flash-1017";
  const S = { model: M, messages: [], schema, schemaName: "t", meta };
  test("defaults: max_tokens 4000, reasoning low, require_parameters, usage include; chatText too", async () => {
    const { fetch, calls } = seq(() => chat('{"ok":true}'));
    const llm = llmWith(fetch);
    await llm.chatStructured(S);
    await llm.chatText({ model: M, messages: [], meta });
    for (const c of calls) {
      expect(c.body.max_tokens).toBe(4000);
      expect(c.body.reasoning).toEqual({ effort: "low" });
      expect(c.body.provider).toEqual({ require_parameters: true });
      expect(c.body.usage).toEqual({ include: true });
    }
  });
  test("config default + per-model override + per-call override; null effort omits reasoning", async () => {
    const { fetch, calls } = seq(() => chat('{"ok":true}'));
    const llm = llmWith(fetch, "k", {
      default: { max_tokens: 3000, reasoning_effort: "medium" },
      models: { "openai/gpt-6-luna": { reasoning_effort: null } },
    });
    await llm.chatStructured(S);
    await llm.chatStructured({ ...S, model: "openai/gpt-6-luna" });
    await llm.chatText({ model: M, messages: [], meta, maxTokens: 500, reasoningEffort: "high" });
    expect([calls[0]!.body.max_tokens, calls[0]!.body.reasoning]).toEqual([3000, { effort: "medium" }]);
    expect(calls[1]!.body.max_tokens).toBe(3000);
    expect("reasoning" in calls[1]!.body).toBe(false);
    expect([calls[2]!.body.max_tokens, calls[2]!.body.reasoning]).toEqual([500, { effort: "high" }]);
  });
  test("configured provider_order pins with allow_fallbacks false and never auto-pins", async () => {
    const { fetch, calls } = seq(() => chat('{"ok":true}', undefined, { provider: "Cohere" }));
    const llm = llmWith(fetch, "k", { models: { [M]: { provider_order: ["Ionstream"] } } });
    await llm.chatStructured(S);
    await llm.chatStructured(S);
    for (const c of calls) expect(c.body.provider).toEqual({ require_parameters: true, order: ["Ionstream"], allow_fallbacks: false });
    expect(llm.pinnedProviders()).toEqual({});
  });
  test("auto pin: first response's provider is pinned (per model) and logged", async () => {
    const lines: string[] = [];
    const { fetch, calls } = seq(
      () => chat('{"ok":true}', undefined, { provider: "Ionstream" }),
      () => chat('{"ok":true}', undefined, { provider: "Ionstream" }),
      () => chat('{"ok":true}', undefined, { provider: "OpenAI" }),
    );
    const llm = llmWith(fetch, "k", undefined, (l) => lines.push(l));
    await llm.chatStructured(S);
    await llm.chatStructured(S);
    await llm.chatStructured({ ...S, model: "openai/gpt-6-luna" });
    expect(calls[0]!.body.provider).toEqual({ require_parameters: true });
    expect(calls[1]!.body.provider).toEqual({ require_parameters: true, order: ["Ionstream"], allow_fallbacks: false });
    expect(calls[2]!.body.provider).toEqual({ require_parameters: true }); // other model not pinned yet
    expect(llm.pinnedProviders()).toEqual({ [M]: "Ionstream", "openai/gpt-6-luna": "OpenAI" });
    expect(lines.some((l) => l.includes("pinned provider Ionstream"))).toBe(true);
  });
  test("auto_pin_provider false: never pins", async () => {
    const { fetch, calls } = seq(() => chat('{"ok":true}', undefined, { provider: "Ionstream" }));
    const llm = llmWith(fetch, "k", { default: { auto_pin_provider: false } });
    await llm.chatStructured(S);
    await llm.chatStructured(S);
    expect(calls[1]!.body.provider).toEqual({ require_parameters: true });
  });
  test("auto-pinned provider failing -> unpin and retry once unpinned", async () => {
    const { fetch, calls } = seq(
      () => chat('{"ok":true}', undefined, { provider: "Ionstream" }),
      () => json({ error: "no endpoints" }, 404),
      () => chat('{"ok":true}', undefined, { provider: "Cohere" }),
    );
    const llm = llmWith(fetch);
    await llm.chatStructured(S);
    const r = await llm.chatStructured<{ ok: boolean }>(S);
    expect(r.data.ok).toBe(true);
    expect(calls[1]!.body.provider.order).toEqual(["Ionstream"]);
    expect(calls[2]!.body.provider).toEqual({ require_parameters: true });
    expect(llm.pinnedProviders()).toEqual({ [M]: "Cohere" });
  });
});

describe("finish_reason", () => {
  const S = { model: "openai/gpt-6-luna", messages: [], schema, schemaName: "t", meta };
  test("length then stop: retried, truncated attempt billed in extraUsages", async () => {
    const { fetch, calls } = seq(
      () => chat('{"ok":tr', { prompt_tokens: 10, completion_tokens: 4000, cost: 0.01 }, { finish_reason: "length" }),
      () => chat('{"ok":true}', { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }),
    );
    const r = await llmWith(fetch).chatStructured<{ ok: boolean }>(S);
    expect(calls.length).toBe(2);
    expect(r.data.ok).toBe(true);
    expect(r.extraUsages.map((u) => u.usd)).toEqual([0.01]);
  });
  test("valid JSON but finish_reason length twice -> StepFailed schema with both usages", async () => {
    const { fetch } = seq(() => chat('{"ok":true}', undefined, { finish_reason: "length" }));
    const err = await llmWith(fetch).chatStructured(S).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailed);
    expect(err.kind).toBe("schema");
    expect(err.message).toContain("finish_reason length");
    expect(err.usages.length).toBe(2);
  });
  test("chatText: length retried once, then StepFailed schema with usages", async () => {
    const a = seq(() => chat("partial", undefined, { finish_reason: "length" }), () => chat(" full text "));
    const ok = await llmWith(a.fetch).chatText({ model: "openai/gpt-6-luna", messages: [], meta });
    expect(ok.text).toBe("full text");
    expect(ok.extraUsages.length).toBe(1);
    const b = seq(() => chat("partial", undefined, { finish_reason: "length" }));
    const err = await llmWith(b.fetch).chatText({ model: "openai/gpt-6-luna", messages: [], meta }).catch((e) => e);
    expect(err.kind).toBe("schema");
    expect(err.usages.length).toBe(2);
  });
  test("missing finish_reason is accepted (mock providers / older shapes)", async () => {
    const { fetch } = seq(() => chat('{"ok":true}', undefined, { finish_reason: null }));
    expect((await llmWith(fetch).chatStructured<{ ok: boolean }>(S)).data.ok).toBe(true);
  });
});

describe("foreign action fields", () => {
  const step = (o: Record<string, unknown>) => ({
    action: "message",
    file: null,
    code: null,
    message: null,
    claims: [],
    approach_note: "n",
    summary: "s",
    ...o,
  });
  test("message step with code/file: cleared to null before parse, not a failure", async () => {
    const { fetch, calls } = seq(() =>
      chat(JSON.stringify(step({ file: "a.py", code: "x=1", message: { to: "a2", text: "dollars" } }))),
    );
    const parse = (v: any) => {
      if (v.action === "message" && (v.code !== null || v.file !== null)) throw new Error("foreign field");
      return v;
    };
    const r = await llmWith(fetch).chatStructured<any>({
      model: "openai/gpt-6-luna",
      messages: [],
      schema: WORKER_STEP_SCHEMA,
      schemaName: "worker_step",
      meta,
      parse,
      actionFields: WORKER_STEP_ACTION_FIELDS,
    });
    expect(calls.length).toBe(1);
    expect(r.data).toMatchObject({ action: "message", file: null, code: null, message: { to: "a2", text: "dollars" } });
  });
  test("write_code keeps file/code, clears message; run_tests clears all", () => {
    const w = step({ action: "write_code", file: "a.py", code: "x", message: { to: "a", text: "t" } });
    expect(stripForeignActionFields(w, WORKER_STEP_SCHEMA, WORKER_STEP_ACTION_FIELDS)).toEqual({ stripped: ["message"], kept: [] });
    expect(w).toMatchObject({ file: "a.py", code: "x", message: null });
    const t = step({ action: "run_tests", file: "a.py", code: "x" });
    stripForeignActionFields(t, WORKER_STEP_SCHEMA, WORKER_STEP_ACTION_FIELDS);
    expect([t.file, t.code, t.message]).toEqual([null, null, null]);
  });
  test("non-nullable required foreign field is left alone; optional one is deleted", () => {
    const sch = {
      type: "object",
      required: ["action", "code"],
      properties: { action: { type: "string" }, code: { type: "string" }, file: { type: "string" } },
    };
    const af = { key: "action", byAction: { write_code: ["code", "file"], message: [] } };
    const o: Record<string, unknown> = { action: "message", code: "x", file: "f" };
    expect(stripForeignActionFields(o, sch, af)).toEqual({ stripped: ["file"], kept: ["code"] });
    expect(o).toEqual({ action: "message", code: "x" });
    expect(stripForeignActionFields({ action: "unknown", code: "x" }, sch, af)).toEqual({ stripped: [], kept: [] });
  });
});

describe("concurrency limiter", () => {
  test("never exceeds cap", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        s.run(async () => {
          peak = Math.max(peak, ++active);
          await Bun.sleep(5);
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("embeddings", () => {
  test("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
  test("MOCK vectors deterministic, normalized, similar texts closer", async () => {
    const e = createEmbedder({ baseUrl: "x", apiKey: undefined, model: "m", dimensions: 256, prices, log: quiet });
    const r = await e.embed(["fix invoice total rounding", "invoice total rounding bug", "ship parcel abroad"], meta);
    expect(r.model).toBe("MOCK");
    expect(r.usage.category).toBe("embedding");
    expect(r.vectors[0]!.length).toBe(256);
    expect(mockVector("a b c", 256)).toEqual(mockVector("a b c", 256));
    expect(cosine(r.vectors[0]!, r.vectors[1]!)).toBeGreaterThan(cosine(r.vectors[0]!, r.vectors[2]!));
  });
  test("real path: sorts by index, ledger from usage", async () => {
    const { fetch, calls } = seq(() =>
      json({ model: "openai/text-embedding-3-small", data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1_000_000 } }),
    );
    const e = createEmbedder({ baseUrl: "https://x/v1", apiKey: "k", model: "openai/text-embedding-3-small", dimensions: 2, prices, fetch, log: quiet });
    const r = await e.embed(["a", "b"], meta);
    expect(r.vectors).toEqual([[1, 0], [0, 1]]);
    expect(r.usage.usd).toBeCloseTo(0.02);
    expect(calls[0]!.body.dimensions).toBe(2);
  });
});
