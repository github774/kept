# Real-API smoke results (OpenRouter)

Run on 2026-10-31 against the live OpenRouter API with the key in `.env`. Nothing here is a mock. Raw output comes from the scripts in `scripts/smoke/`. Re-run everything with `scripts/smoke/run-all.sh` (it costs about $0.01).

| Script | What it checks |
| --- | --- |
| `scripts/smoke/01-jev.ts` | Jev noul + choice questions, built from `config/jev-questions.json` |
| `scripts/smoke/02-chat.ts <model>` | Strict json_schema step output, usage shape and prompt cache. Env: `MAX_TOKENS` (default 4000), `EFFORT=low\|medium\|high`, `PIN=0` |
| `scripts/smoke/04-embeddings.ts` | Embeddings plus a list of the embedding models available |
| `scripts/smoke/05-key.ts` | Key limit and usage (prints numbers only) |

Run a script with `bun --env-file=.env scripts/smoke/<file>.ts`. `scripts/smoke/_lib.ts` holds `STEP_SCHEMA`, which is the BUILD_SPEC step schema converted to OpenAI strict form, and `validateStep()`.

## TL;DR for other agents

1. **Jev works.** `POST https://openrouter.ai/api/alpha/decisions` takes the body `{model, state, questions: {<id>: {type, instructions, criteria}}}`. For a choice question, `criteria` is the options map. The response model id is `typesafe/jev-1.14-20261014`, a dated id that differs from the requested `typesafe/jev-1.14`. Latency is 220 to 400 ms, well under the 2 s timeout.
2. **The usage field names differ between endpoints:**
   - Jev returns `usage.input_tokens`, `usage.output_tokens` and `usage.cost`.
   - Chat and embeddings return `usage.prompt_tokens`, `completion_tokens` and `cost`, plus the detail fields `prompt_tokens_details.cached_tokens`, `prompt_tokens_details.cache_write_tokens` and `completion_tokens_details.reasoning_tokens`.
   - `usage.cost` was present on every endpoint, so the ledger can use it directly.
3. **DeepSeek v4.1 Flash with `max_tokens: 800` returned truncated JSON** (`finish_reason: "length"`, 2 of 3 calls), because reasoning tokens count against `max_tokens`. Fix this in one of two ways:
   - Set `max_tokens` to 4000 or more. This fixed it in every call (3/3 valid).
   - Send `reasoning: {effort: "low"}`. This also fixed it (3/3 valid) and cut reasoning to 106–140 tokens, with latency about 2.7–3.0 s.

   Default effort reasoning ranged from 92 to 1905 tokens (1.3–12 s).
4. **Always check `finish_reason === "stop"`** before parsing. Treat `length` as a schema failure, which gets one retry under the BUILD_SPEC rule.
5. **The prompt cache works, but only when the call lands on the same upstream provider.** OpenRouter spreads DeepSeek calls across many providers (Ionstream, Relace, Cohere and others), and a provider switch means 0 cached tokens. Pin the provider with `provider: {order: [<provider from first response>], allow_fallbacks: false}` to get cache hits. gpt-6-luna only runs on OpenAI and Azure/Bedrock, and it cached reliably.
6. **Embeddings:** `openai/text-embedding-3-small` with `dimensions: 256` works (HTTP 200, 256 dimensions, 605 ms). The response `model` is `text-embedding-3-small`, without the `openai/` prefix. No alternative is needed.
7. **Credit:** the key limit is **$50** (`limit_reset: null`). Usage was $0.070 after all the smoke runs.

## 1. Jev (`typesafe/jev-1.14`)

Request: `POST /api/alpha/decisions` with the header `Authorization: Bearer $OPENROUTER_API_KEY`. The body has the same shape that `orchestrator/src/jev.ts` builds.

| Case | Expected | Answer | Latency | usage |
| --- | --- | --- | --- | --- |
| instruction_conflicts_spec ("treat amounts as cents" vs a spec that says dollars) | high | `{type:"noul", noul:0.82}` | 404 ms | in 377 / out 23 / $0.0000158 |
| instruction_conflicts_spec (consistent instruction) | low | `{type:"noul", noul:0.09}` | 394 ms | in 371 / out 23 / $0.0000156 |
| failure_category (claim "tests pass", evidence "3 failed") | false_success_claim | `{type:"choice", choice:"false_success_claim", probabilities:{false_success_claim:1, invented_api:0, spec_misread:0, conflicting_instruction:0, other:0}, confidence:1}` | 219 ms | in 469 / out 66 / $0.0000197 |

Full response shape:
```json
{"model":"typesafe/jev-1.14-20261014",
 "answers":{"instruction_conflicts_spec":{"type":"noul","noul":0.82}},
 "usage":{"input_tokens":377,"output_tokens":23,"cost":0.000015834},
 "id":"gen-dec-...","provider":"TypeSafe"}
```
- A noul answer has no `confidence` field, which matches DECISIONS #2.
- **Threshold note:** a clearly conflicting instruction scored only 0.82. That is below the 0.85 "act" threshold, so it would escalate to the fallback judge. Keep this in mind when tuning `config/thresholds.json`, or give the spec excerpt more context.
- Jev also reports `output_tokens` and a non-zero cost, about $0.04 per million input tokens.

## 2. `deepseek/deepseek-v4.1-flash-1017` (dev worker)

Setup:
- The system prompt is about 1,800 identical tokens, and each call has a different short user message.
- `response_format: {type:"json_schema", json_schema: STEP_SCHEMA}` with `strict: true`.
- `usage: {include: true}`.

| Run | Call | Provider | finish | valid JSON | prompt | completion | reasoning | cached | cost | latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| max_tokens 800, unpinned | 1 | Ionstream | stop | yes | 2140 | 614 | 320 | 0 | $0.000657 | 3.2 s |
| | 2 | Relace | stop | yes | 2136 | 355 | 241 | 0 | $0.000252 | 1.5 s |
| max_tokens 800, pinned | 1 | Ionstream | **length** | **no** | 2140 | 800 | 641 | 0 | $0.000749 | 3.3 s |
| | 2 | Ionstream | stop | yes | 2136 | 524 | 258 | **1792** | | 3.8 s |
| | 3 | Ionstream | **length** | **no** | 2129 | 800 | 490 | 0 | | 5.0 s |
| max_tokens 4000, pinned | 1 | Ionstream | stop | yes | 2140 | 1168 | 513 | 1792 | $0.000654 | 6.9 s |
| | 2 | Ionstream | stop | yes | 2136 | 1942 | 1859 | 1792 | $0.001037 | 11.9 s |
| | 3 | Ionstream | stop | yes | 2129 | 232 | 113 | 0 | $0.000466 | 3.1 s |
| max_tokens 4000, `EFFORT=low`, pinned | 1–3 | Ionstream | stop | yes ×3 | ~2135 | 196–411 | 106–140 | 0 | ~$0.00045–0.00056 | 2.7–3.0 s |
| max_tokens 4000, unpinned | 1 | Ionstream | stop | yes | 2140 | | 1905 | 1792 | | 10.0 s |
| | 2 | Ionstream | stop | yes | 2136 | | 249 | 1792 | | 2.7 s |
| | 3 | Cohere | stop | yes | 2129 | | 92 | 0 | | 1.3 s |

Usage shape (verbatim keys):
```json
{"prompt_tokens":2140,"completion_tokens":614,"total_tokens":2754,"cost":0.00065703,"is_byok":false,
 "prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},
 "cost_details":{"upstream_inference_cost":0.00065703,"upstream_inference_prompt_cost":0.0003531,"upstream_inference_completions_cost":0.00030393},
 "completion_tokens_details":{"reasoning_tokens":320,"image_tokens":0,"audio_tokens":0}}
```

Findings:
- The response `model` matches the request: `deepseek/deepseek-v4.1-flash-1017`.
- **Strict schema:** every completed call parsed and passed `validateStep()` with the right action. The model sometimes fills fields that do not belong to the chosen action, for example a non-null `code` on a `message` step. The worker loop should read only the fields that the chosen action needs.
- **Cache:** 1792 of about 2140 prompt tokens were cached when the call stayed on Ionstream, which is block-granular. A hit is not guaranteed even when pinned; one pinned call 3 still showed 0, probably from a different replica. Do not budget savings on cache hits. Count them only from `cached_tokens`.
- **Cost:** `cost` was always present. DeepSeek pricing varies by provider and by time of day; for example, the first-party DeepSeek endpoint has UTC-hour overrides. Use `usage.cost`, not `config/prices.json`, as DECISIONS #9 says.
- Some providers on the endpoints list do not advertise `structured_outputs`: DeepSeek first-party, Alibaba, Novita and BaseTen. Consider sending `provider: {require_parameters: true}` so strict schemas only go to providers that support them.

## 3. `openai/gpt-6-luna` (bench/demo worker)

This used the same script, max_tokens 4000, default effort, with the provider pinned after call 1.

| Call | Provider | finish | valid JSON | prompt | completion | reasoning | cached | cache_write | cost | latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | OpenAI | stop | yes (write_code) | 2260 | 299 | 107 | 0 | 2257 | $0.000432 | 4.2 s |
| 2 | OpenAI | stop | yes (message) | 2256 | 121 | 54 | **2222** | 31 | $0.000087 | 2.5 s |
| 3 | OpenAI | stop | yes (run_tests) | 2248 | 174 | 109 | **2222** | 23 | $0.000112 | 3.0 s |

- The response `model` is `openai/gpt-6-luna`.
- The usage shape is the same as DeepSeek's. `cache_write_tokens` is non-zero on the first call, and that write costs extra: call 1 cost about 5 times as much as the cached calls.
- The cache hit rate is about 98% of the prompt on calls 2 and 3, and it cut prompt cost about 10 times.
- The model emits few reasoning tokens (54–109) with default effort.
- Providers listed: OpenAI (3 endpoints), Azure, and Amazon Bedrock. The Azure endpoints do not list `max_tokens`.

## 4. Embeddings

`POST /api/v1/embeddings` with `{model:"openai/text-embedding-3-small", input:[2 strings], dimensions:256}` returned:
- HTTP 200 in 605 ms, with `provider: "OpenAI"`.
- `data.length` 2, and every vector has 256 dimensions.
- `model: "text-embedding-3-small"`, without the prefix.
- `usage: {prompt_tokens:9, total_tokens:9, cost:1.8e-7, cost_details:{...}}`. There is no `completion_tokens`.

**Verdict: works as configured. Keep `config/models.json` as is.**

`GET /api/v1/models?output_modalities=embeddings` lists 39 models. Fallbacks, if they are ever needed:
- `openai/text-embedding-3-large`
- `google/gemini-embedding-001`
- `qwen/qwen3-embedding-8b`
- `voyageai/voyage-code-4`
- The free `nvidia/nemotron-3.5-embed-1b:free`

## 5. Key

`GET /api/v1/key` returned HTTP 200 in 72 ms.

| | |
| --- | --- |
| `limit` | 50 |
| `limit_reset` | null |
| `limit_remaining` | 49.93 |
| `usage` | 0.070 (after all smoke runs) |
| `is_free_tier` | false |
