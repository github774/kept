// Scale probe 1: OpenRouter concurrency. Fires N concurrent small structured-output calls
// (WORKER_STEP_SCHEMA, short prompt) and reports success rate, errors, latency, throughput and cost.
// Usage: bun scripts/scale-probe/llm-burst.ts <model> <level>[,<level>...] [--max-cost USD] [--prompt big]
// Stops escalating at the first level with >5% errors or once --max-cost is spent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_STEP_SCHEMA } from "../../orchestrator/src/llm.ts";

const ROOT = join(import.meta.dir, "..", "..");
for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}
const KEY = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
if (!KEY) throw new Error("no OPENROUTER_API_KEY");
const BASE = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";

const [model, levelsArg] = process.argv.slice(2);
if (!model || !levelsArg) throw new Error("usage: llm-burst.ts <model> <levels>");
const levels = levelsArg.split(",").map(Number);
const maxCostIdx = process.argv.indexOf("--max-cost");
const maxCost = maxCostIdx > 0 ? Number(process.argv[maxCostIdx + 1]) : 0.4;
const big = process.argv.includes("--prompt") && process.argv[process.argv.indexOf("--prompt") + 1] === "big";
const TIMEOUT_MS = 120_000;

const shortPrompt = (i: number) =>
  `You are worker w${i} on a team fixing a small Python module. Subtask: implement format_invoice_id(n) returning "INV-" plus n zero-padded to 6 digits. ` +
  `Reply with exactly one step: action "write_code", file "format_invoice_id.py", a 3-line implementation in code, message null, claims [], a one-sentence approach_note and summary.`;

function bigPrompt(i: number): string {
  // Roughly a real worker step: spec + notes + starter + test file (~3-4k tokens).
  const t = join(ROOT, "bench/tasks-v2/invoice_parser");
  const parts = ["SPEC.md", "AGENTS.md", "TEAM_NOTES.md", "starter/parse_line.py", "starter/invoice_common.py", "tests/test_parse_line.py"].map(
    (f) => `--- ${f} ---\n${readFileSync(join(t, f), "utf8")}`,
  );
  return `${parts.join("\n\n")}\n\n${shortPrompt(i).replace("format_invoice_id(n)", "parse_line(line) per the spec").replace("format_invoice_id.py", "parse_line.py")}`;
}

interface Result { ok: boolean; status: number | string; ms: number; cost: number; inTok: number; outTok: number; provider?: string }

const firstErr = new Set<number>();
async function one(i: number): Promise<Result> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a careful software engineer. Respond only with the requested JSON." },
          { role: "user", content: big ? bigPrompt(i) : shortPrompt(i) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "worker_step", strict: true, schema: WORKER_STEP_SCHEMA } },
        max_tokens: 4000,
        reasoning: { effort: "low" },
        provider: { require_parameters: true },
        usage: { include: true },
      }),
    });
    const ms = performance.now() - t0;
    const text = await res.text();
    if (!res.ok) {
      if (!firstErr.has(res.status)) {
        firstErr.add(res.status);
        const hdr = [...res.headers].filter(([k]) => /rate|retry/i.test(k)).map(([k, v]) => `${k}=${v}`).join(" ");
        console.error(`first ${res.status}: ${text.slice(0, 400)} ${hdr}`);
      }
      return { ok: false, status: res.status, ms, cost: 0, inTok: 0, outTok: 0 };
    }
    const j = JSON.parse(text);
    if (j.error) return { ok: false, status: `body:${j.error.code ?? "err"}`, ms, cost: 0, inTok: 0, outTok: 0 };
    const content = j.choices?.[0]?.message?.content;
    let parsed = false;
    try {
      const o = JSON.parse(content);
      parsed = typeof o.action === "string";
    } catch {}
    return {
      ok: parsed,
      status: parsed ? 200 : "bad_json",
      ms: performance.now() - t0,
      cost: Number(j.usage?.cost ?? 0),
      inTok: Number(j.usage?.prompt_tokens ?? 0),
      outTok: Number(j.usage?.completion_tokens ?? 0),
      provider: j.provider,
    };
  } catch (e) {
    return { ok: false, status: (e as Error).name === "AbortError" ? "timeout" : "network", ms: performance.now() - t0, cost: 0, inTok: 0, outTok: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};

let spent = 0;
const rows: unknown[] = [];
for (const n of process.argv.includes("--sustain") || process.argv.includes("--rate") ? [] : levels) {
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
  const wall = (performance.now() - t0) / 1000;
  const ok = rs.filter((r) => r.ok);
  const errs: Record<string, number> = {};
  for (const r of rs) if (!r.ok) errs[String(r.status)] = (errs[String(r.status)] ?? 0) + 1;
  const cost = rs.reduce((a, r) => a + r.cost, 0);
  spent += cost;
  const providers: Record<string, number> = {};
  for (const r of ok) providers[r.provider ?? "?"] = (providers[r.provider ?? "?"] ?? 0) + 1;
  const row = {
    model,
    prompt: big ? "big" : "short",
    concurrency: n,
    ok: ok.length,
    errorRate: +((n - ok.length) / n).toFixed(3),
    errors: errs,
    p50_s: +(pct(ok.map((r) => r.ms), 50) / 1000).toFixed(2),
    p95_s: +(pct(ok.map((r) => r.ms), 95) / 1000).toFixed(2),
    max_s: +(pct(ok.map((r) => r.ms), 100) / 1000).toFixed(2),
    wall_s: +wall.toFixed(2),
    calls_per_s: +(ok.length / wall).toFixed(1),
    cost_usd: +cost.toFixed(4),
    usd_per_call: +(cost / Math.max(1, ok.length)).toFixed(6),
    avg_in_tok: Math.round(ok.reduce((a, r) => a + r.inTok, 0) / Math.max(1, ok.length)),
    avg_out_tok: Math.round(ok.reduce((a, r) => a + r.outTok, 0) / Math.max(1, ok.length)),
    providers,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (row.errorRate > 0.05) {
    console.log(`stop: >5% errors at ${n}`);
    break;
  }
  if (spent >= maxCost) {
    console.log(`stop: spent ${spent.toFixed(4)} >= max-cost ${maxCost}`);
    break;
  }
}
console.log(`TOTAL_SPENT ${spent.toFixed(4)}`);

// Sustained mode: --sustain <seconds> keeps <level> calls in flight (closed loop) for that long.
const sIdx = process.argv.indexOf("--sustain");
if (sIdx > 0) {
  const secs = Number(process.argv[sIdx + 1]);
  const c = levels[levels.length - 1]!;
  const t0 = performance.now();
  const end = t0 + secs * 1000;
  const rs: Result[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (performance.now() < end) rs.push(await one(i++));
    }),
  );
  const wall = (performance.now() - t0) / 1000;
  const ok = rs.filter((r) => r.ok);
  const errs: Record<string, number> = {};
  for (const r of rs) if (!r.ok) errs[String(r.status)] = (errs[String(r.status)] ?? 0) + 1;
  const cost = rs.reduce((a, r) => a + r.cost, 0);
  console.log(
    JSON.stringify({
      model, mode: "sustained", inFlight: c, seconds: secs, wall_s: +wall.toFixed(1), calls: rs.length, ok: ok.length,
      errorRate: +((rs.length - ok.length) / Math.max(1, rs.length)).toFixed(3), errors: errs,
      p50_s: +(pct(ok.map((r) => r.ms), 50) / 1000).toFixed(2), p95_s: +(pct(ok.map((r) => r.ms), 95) / 1000).toFixed(2),
      calls_per_s: +(ok.length / wall).toFixed(1), cost_usd: +cost.toFixed(4),
    }),
  );
}

// Open-loop mode: --rate <calls/s> --secs <n> launches calls at a fixed rate (no retries), so 429s
// show the account admission ceiling rather than a retry storm.
const rIdx = process.argv.indexOf("--rate");
if (rIdx > 0) {
  const rate = Number(process.argv[rIdx + 1]);
  const secs = Number(process.argv[process.argv.indexOf("--secs") + 1] ?? 15);
  const t0 = performance.now();
  const pending: Promise<Result & { at: number }>[] = [];
  for (let k = 0; k < rate * secs; k++) {
    const due = t0 + (k * 1000) / rate;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const at = (performance.now() - t0) / 1000;
    pending.push(one(k).then((r) => ({ ...r, at })));
  }
  const rs = await Promise.all(pending);
  const wall = (performance.now() - t0) / 1000;
  const ok = rs.filter((r) => r.ok);
  const errs: Record<string, number> = {};
  for (const r of rs) if (!r.ok) errs[String(r.status)] = (errs[String(r.status)] ?? 0) + 1;
  const first429 = rs.filter((r) => r.status === 429).map((r) => r.at).sort((a, b) => a - b)[0];
  const maxInFlight = (() => {
    const ev = rs.flatMap((r) => [[r.at, 1], [r.at + r.ms / 1000, -1]] as [number, number][]).sort((a, b) => a[0] - b[0]);
    let cur = 0, m = 0;
    for (const [, d] of ev) m = Math.max(m, (cur += d));
    return m;
  })();
  console.log(JSON.stringify({
    model, mode: "open-loop", rate, seconds: secs, calls: rs.length, ok: ok.length,
    errorRate: +((rs.length - ok.length) / rs.length).toFixed(3), errors: errs, first429_at_s: first429 ?? null, maxInFlight,
    p50_s: +(pct(ok.map((r) => r.ms), 50) / 1000).toFixed(2), p95_s: +(pct(ok.map((r) => r.ms), 95) / 1000).toFixed(2),
    wall_s: +wall.toFixed(1), cost_usd: +rs.reduce((a, r) => a + r.cost, 0).toFixed(4),
  }));
}
