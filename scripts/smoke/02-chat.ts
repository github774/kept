// Smoke 2/3: chat completions with strict json_schema (BUILD_SPEC Step output schema),
// usage shape, and prompt-cache check (two calls sharing an identical ~1500-token prefix).
// Usage: bun --env-file=.env scripts/smoke/02-chat.ts <model-id>
// Env: MAX_TOKENS (default 4000), EFFORT (low|medium|high -> reasoning.effort), PIN=0 (no provider pin)
import { post, show, STEP_SCHEMA, validateStep } from "./_lib.ts";

const model = process.argv[2] ?? "deepseek/deepseek-v4.1-flash-1017";

// ~1500+ token stable prefix (system prompt). Deterministic text, no randomness.
const rules = Array.from({ length: 60 }, (_, i) =>
  `Rule ${i + 1}: When handling invoice line ${i + 1}, parse the amount as dollars with two decimals, keep the currency code unchanged, and never mutate shared state in place.`,
).join("\n");
const system = `You are a worker agent on a 4-agent team building an invoice CSV parser in Python.
You output exactly one step as JSON matching the schema. Spec rules follow.
${rules}
End of spec rules.`;

// Prompt caching needs the same upstream provider; after call 1 we pin it (PIN=0 disables).
let pinned: string | undefined;
const PIN = process.env.PIN !== "0";
function body(user: string) {
  return {
    ...(pinned ? { provider: { order: [pinned], allow_fallbacks: false } } : {}),
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: STEP_SCHEMA },
    // Reasoning tokens count against max_tokens: 800 truncated JSON (finish_reason "length") in testing.
    max_tokens: Number(process.env.MAX_TOKENS ?? 4000),
    ...(process.env.EFFORT ? { reasoning: { effort: process.env.EFFORT } } : {}),
    usage: { include: true },
  };
}

let ok = true;
const users = [
  "Step 1. Your file is agents/a1/parse_amount.py. Write a function parse_amount(s: str) -> float. Choose write_code.",
  "Step 2. Your file is agents/a1/parse_amount.py. Tell teammate a2 that amounts are dollars. Choose message.",
  "Step 3. Your file is agents/a1/parse_amount.py. Choose run_tests.",
];
for (const [i, u] of users.entries()) {
  const r = await post("/v1/chat/completions", body(u));
  const content = r.json?.choices?.[0]?.message?.content;
  let parsed: any = null, parseErr = "";
  try { parsed = JSON.parse(content); } catch (e) { parseErr = String(e); }
  const errs = parsed ? validateStep(parsed) : [`JSON.parse failed: ${parseErr}`];
  show(`call ${i + 1} | ${model}${pinned && i > 0 ? ` | pinned=${pinned}` : ""} | HTTP ${r.status} | ${r.ms} ms`, {
    returned_model: r.json?.model,
    provider: r.json?.provider,
    finish_reason: r.json?.choices?.[0]?.finish_reason,
    valid_json: !!parsed,
    schema_errors: errs,
    action: parsed?.action,
    content_preview: typeof content === "string" ? content.slice(0, 300) : content,
    usage: r.json?.usage,
    error: r.json?.error ?? r.text,
  });
  if (r.status !== 200 || errs.length) ok = false;
  if (PIN && i === 0 && r.json?.provider) pinned = r.json.provider;
}
process.exit(ok ? 0 : 1);
