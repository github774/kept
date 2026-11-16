// Jev threshold calibration (BUILD_SPEC 12:30 milestone: "label 10 examples and set thresholds").
//
// Calls REAL Jev (OpenRouter POST {JEV_BASE_URL}/alpha/decisions) once per labeled example in
// examples.json, records p(problem), sweeps act/pass thresholds and writes a markdown report.
// No mocks: if the key is missing or Jev is unreachable the run fails loudly.
//
// Run:  bun --env-file=/Users/avneh/Code/SmarterSubagents/.env bench/jev-calibration/calibrate.ts
// Flags: --questions <path>  question wording to test (default config/jev-questions.json)
//        --tag <name>        output suffix: results[-tag].json, report[-tag].md (default: none)
//        --repeat <n>        call each example n times (stability check; default 1)
//        --concurrency <n>   parallel Jev calls (default 4)
//
// Rules honoured: config read from config/ only (rule 10), tokens and USD from the API's usage
// field only (rule 7), key never printed (key goes only in the Authorization header).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const REPO = resolve(HERE, "..", "..");
const CONFIG = join(REPO, "config");

// ---------- args ----------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const questionsPath = resolve(arg("questions") ?? join(CONFIG, "jev-questions.json"));
const tag = arg("tag");
const repeat = Math.max(1, Number(arg("repeat") ?? 1));
const concurrency = Math.max(1, Number(arg("concurrency") ?? 4));
const suffix = tag ? `-${tag}` : "";

// ---------- config ----------
type Noul = { type: "noul"; state_keys: string[]; instructions: string; criteria: { true: string; false: string } };
type Choice = { type: "choice"; state_keys: string[]; instructions: string; options: Record<string, string> };
type Question = Noul | Choice;

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const questions = readJson<Record<string, Question | string>>(questionsPath);
const models = readJson<{ jev: { model: string } }>(join(CONFIG, "models.json"));
const thresholds = readJson<{ act: number; pass: number; jev_timeout_ms: number; lesson_relevant: number }>(
  join(CONFIG, "thresholds.json"),
);

const KEY = process.env.OPENROUTER_API_KEY?.trim();
const BASE = process.env.JEV_BASE_URL?.trim();
if (!KEY || KEY.startsWith("${")) throw new Error("OPENROUTER_API_KEY missing: calibration needs real Jev (no mock).");
if (!BASE || BASE.startsWith("${")) throw new Error("JEV_BASE_URL missing (expected https://openrouter.ai/api in .env).");
const ENDPOINT = `${BASE.replace(/\/$/, "")}/alpha/decisions`;
const TIMEOUT_MS = thresholds.jev_timeout_ms;

// ---------- examples ----------
type Example = {
  id: string;
  question: string;
  trap: string;
  spec?: string;
  state: Record<string, string>;
  label: boolean | string;
  hard?: boolean;
};
const exFile = readJson<{ spec_excerpts: Record<string, string>; examples: Example[] }>(join(HERE, "examples.json"));

function buildState(ex: Example, q: Question): Record<string, string> {
  const state: Record<string, string> = { ...ex.state };
  if (ex.spec) state.spec_excerpt = exFile.spec_excerpts[ex.spec] ?? "";
  for (const k of q.state_keys) if (!(k in state)) throw new Error(`${ex.id}: state missing key ${k}`);
  // Send only the keys the question declares (BUILD_SPEC: state holds only the needed excerpt).
  return Object.fromEntries(q.state_keys.map((k) => [k, state[k]!]));
}

function wireQuestion(q: Question) {
  // Verified wire shape: noul -> {type, instructions, criteria:{true,false}};
  // choice -> {type, instructions, criteria:{<option>: description}}.
  return q.type === "noul"
    ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
    : { type: "choice", instructions: q.instructions, criteria: q.options };
}

// ---------- Jev call ----------
type Call = {
  id: string;
  question: string;
  trap: string;
  label: boolean | string;
  rep: number;
  ok: boolean;
  error?: string;
  attempts: number;
  latencyMs: number;
  p?: number; // noul: p(true) = p(problem) / p(relevant)
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  model?: string;
};

async function jevOnce(qid: string, q: Question, state: Record<string, string>) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: models.jev.model, state, questions: { [qid]: wireQuestion(q) } }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false as const, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    const body = JSON.parse(text);
    return { ok: true as const, latencyMs, body };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - t0);
    const msg = ctrl.signal.aborted ? `timeout ${TIMEOUT_MS}ms` : String((e as Error).message ?? e);
    return { ok: false as const, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function runExample(ex: Example, rep: number): Promise<Call> {
  const q = questions[ex.question];
  if (!q || typeof q === "string") throw new Error(`unknown question ${ex.question}`);
  const state = buildState(ex, q);
  const base = { id: ex.id, question: ex.question, trap: ex.trap, label: ex.label, rep, inputTokens: 0, outputTokens: 0, usd: 0 };
  let last: Awaited<ReturnType<typeof jevOnce>> | undefined;
  let usage = { in: 0, out: 0, usd: 0 };
  // One retry, as the SDK would; each attempt is bounded by the 2 s adapter timeout.
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await jevOnce(ex.question, q, state);
    if (last.ok) {
      const b = last.body;
      const u = b.usage ?? {};
      usage = { in: usage.in + (u.input_tokens ?? 0), out: usage.out + (u.output_tokens ?? 0), usd: usage.usd + (u.cost ?? 0) };
      const a = b.answers?.[ex.question];
      const call: Call = { ...base, ok: true, attempts: attempt, latencyMs: last.latencyMs, inputTokens: usage.in, outputTokens: usage.out, usd: usage.usd, model: b.model };
      if (a?.type === "noul" && typeof a.noul === "number") call.p = a.noul;
      else if (a?.type === "choice") Object.assign(call, { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence });
      else return { ...call, ok: false, error: `unexpected answer shape: ${JSON.stringify(a).slice(0, 200)}` };
      return call;
    }
  }
  return { ...base, ok: false, attempts: 2, latencyMs: last!.latencyMs, error: last!.ok ? "?" : last!.error };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---------- run ----------
const jobs: Array<[Example, number]> = [];
for (let r = 0; r < repeat; r++) for (const ex of exFile.examples) jobs.push([ex, r]);
console.log(`[calibrate] REAL Jev ${models.jev.model} @ ${ENDPOINT} | ${exFile.examples.length} examples x ${repeat} | timeout ${TIMEOUT_MS}ms | questions ${questionsPath}`);
const t0 = Date.now();
const calls = await pool(jobs, concurrency, async ([ex, r]) => {
  const c = await runExample(ex, r);
  const shown = c.ok ? (c.p !== undefined ? `p=${c.p.toFixed(3)}` : `choice=${c.choice}`) : `ERR ${c.error}`;
  console.log(`  ${c.id.padEnd(7)} r${r} label=${String(c.label).padEnd(23)} ${shown} ${c.latencyMs}ms`);
  return c;
});
const wallMs = Date.now() - t0;

// ---------- analysis ----------
const SPEC_QS = ["instruction_conflicts_spec", "fact_contradicts_spec", "note_consistent_with_spec"];
const okNoul = (qs: string[]) => calls.filter((c) => c.ok && c.p !== undefined && qs.includes(c.question));
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number | undefined, d = 3) => (x === undefined ? "n/a" : x.toFixed(d));
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

type Eval = { total: number; actOk: number; actBad: number; passOk: number; passBad: number; esc: number };
function evaluate(cs: Call[], act: number, pass: number): Eval {
  const e: Eval = { total: cs.length, actOk: 0, actBad: 0, passOk: 0, passBad: 0, esc: 0 };
  for (const c of cs) {
    const p = c.p!;
    if (p >= act) c.label === true ? e.actOk++ : e.actBad++;
    else if (p < pass) c.label === false ? e.passOk++ : e.passBad++;
    else e.esc++;
  }
  return e;
}
const decidedAcc = (e: Eval) => pct(e.actOk + e.passOk, e.actOk + e.actBad + e.passOk + e.passBad);
const jevOnlyAcc = (e: Eval) => pct(e.actOk + e.passOk, e.total);

/** Most permissive (lowest) act with zero clean examples at or above it; highest pass with zero problems below it. */
function sweep(cs: Call[]) {
  const clean = cs.filter((c) => c.label === false).map((c) => c.p!);
  const prob = cs.filter((c) => c.label === true).map((c) => c.p!);
  const maxClean = clean.length ? Math.max(...clean) : 0;
  const minProb = prob.length ? Math.min(...prob) : 1;
  let act: number | undefined;
  for (let t = 50; t <= 99; t++) if (clean.every((p) => p < t / 100)) { act = t / 100; break; }
  let pass: number | undefined;
  for (let t = 50; t >= 1; t--) if (prob.every((p) => p >= t / 100)) { pass = t / 100; break; }
  return { maxClean, minProb, act, pass, separable: maxClean < minProb };
}

const spec = okNoul(SPEC_QS);
const pooled = sweep(spec);
const perQ = Object.fromEntries(SPEC_QS.map((q) => [q, sweep(okNoul([q]))]));
// Literal sweep result (most permissive zero-false-act / zero-false-pass), then a 0.05 safety margin
// on each side because 10-17 examples per question cannot show the tails of real agent text.
const MARGIN = 0.05;
const litAct = pooled.act ?? 0.99;
const litPass = pooled.pass ?? 0.01;
const recAct = r2(Math.min(0.99, litAct + MARGIN));
let recPass = r2(Math.max(0.01, litPass - MARGIN));
if (recPass >= recAct) recPass = r2(recAct - 0.01);

const lessons = okNoul(["lesson_relevant"]);
function bestLesson() {
  let best = { t: 0.5, acc: -1, fp: 0, fn: 0 };
  for (let t = 5; t <= 95; t++) {
    let fp = 0, fn = 0;
    for (const c of lessons) {
      const yes = c.p! >= t / 100;
      if (yes && c.label === false) fp++;
      if (!yes && c.label === true) fn++;
    }
    const acc = (lessons.length - fp - fn) / Math.max(1, lessons.length);
    // Prefer higher accuracy; on ties prefer the threshold closest to 0.5 (most margin).
    if (acc > best.acc || (acc === best.acc && Math.abs(t / 100 - 0.5) < Math.abs(best.t - 0.5))) best = { t: t / 100, acc, fp, fn };
  }
  return best;
}
const lessonBest = bestLesson();
const lessonAt = (t: number) => {
  let ok = 0;
  for (const c of lessons) if ((c.p! >= t) === (c.label === true)) ok++;
  return ok;
};

const cats = calls.filter((c) => c.ok && c.question === "failure_category");
const catOk = cats.filter((c) => c.choice === c.label).length;

const all = calls;
const okCalls = all.filter((c) => c.ok);
const failed = all.filter((c) => !c.ok);
const usd = all.reduce((s, c) => s + c.usd, 0);
const tin = all.reduce((s, c) => s + c.inputTokens, 0);
const tout = all.reduce((s, c) => s + c.outputTokens, 0);
const lat = okCalls.map((c) => c.latencyMs).sort((a, b) => a - b);
const pctile = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]! : 0);
const retried = all.filter((c) => c.attempts > 1).length;

// Misreads: wrong side of 0.5 (noul) or wrong option (choice).
const misreads = okCalls.filter((c) =>
  c.p !== undefined ? (c.p >= 0.5) !== (c.label === true) : c.choice !== c.label,
);
// Spread across repeats (stability).
function spread() {
  if (repeat < 2) return [];
  const byId = new Map<string, number[]>();
  for (const c of okCalls) if (c.p !== undefined) byId.set(c.id, [...(byId.get(c.id) ?? []), c.p]);
  return [...byId.entries()].map(([id, ps]) => ({ id, range: Math.max(...ps) - Math.min(...ps) })).sort((a, b) => b.range - a.range);
}
const spreads = spread();

// ---------- write ----------
writeFileSync(
  join(HERE, `results${suffix}.json`),
  JSON.stringify({ ranAt: new Date().toISOString(), endpoint: ENDPOINT, model: models.jev.model, questionsPath, timeoutMs: TIMEOUT_MS, repeat, wallMs, calls }, null, 2),
);

const exById = new Map(exFile.examples.map((e) => [e.id, e]));
const L: string[] = [];
const cur = evaluate(spec, thresholds.act, thresholds.pass);
const rec = evaluate(spec, recAct, recPass);
L.push(`# Jev calibration report${tag ? ` (${tag})` : ""}`);
L.push("");
L.push(`Generated by \`bench/jev-calibration/calibrate.ts\` on ${new Date().toISOString()}. **Real Jev calls, no mocks.**`);
L.push("");
L.push(`- Model: \`${models.jev.model}\` (served as \`${okCalls[0]?.model ?? "?"}\`) via \`${ENDPOINT}\``);
L.push(`- Questions: \`${questionsPath.replace(REPO + "/", "")}\``);
L.push(`- Examples: ${exFile.examples.length} (labels in \`examples.json\`), repeat ${repeat}, timeout ${TIMEOUT_MS} ms, 1 retry, concurrency ${concurrency}`);
L.push(`- Calls: ${all.length} ok ${okCalls.length}, failed ${failed.length}, needed a retry ${retried}`);
L.push(`- Latency (ok calls): p50 ${pctile(0.5)} ms, p90 ${pctile(0.9)} ms, max ${lat.at(-1) ?? 0} ms; wall ${wallMs} ms`);
L.push(`- Cost (from \`usage.cost\`): **$${usd.toFixed(6)}** total, $${(usd / Math.max(1, okCalls.length)).toFixed(7)} per call; tokens in ${tin}, out ${tout} (from \`usage\`)`);
L.push("");
L.push("## Recommended `config/thresholds.json`");
L.push("");
L.push(`Spec checks (instruction_conflicts_spec, fact_contradicts_spec, note_consistent_with_spec) pooled. Literal sweep: \`act\` = most permissive value (searched 0.50-0.99) with **zero false act** on clean examples; \`pass\` = highest value (searched 0.01-0.50; passing p >= 0.5 is never allowed) with **zero false pass** on problem examples. Recommended = literal sweep with a ${MARGIN} margin on each side.`);
L.push("");
L.push("```json");
L.push(JSON.stringify({ act: recAct, pass: recPass, lesson_relevant: lessonBest.t }, null, 2));
L.push("```");
L.push("");
if (pooled.act === undefined) L.push("> WARNING: no act threshold <= 0.99 has zero false acts. A clean example scored >= 0.99; see misreads.\n");
L.push(`Pooled: max p on clean = ${fmt(pooled.maxClean)}, min p on problems = ${fmt(pooled.minProb)}, separable = ${pooled.separable}.`);
L.push("");
L.push("| Setting | act | pass | acted ok / false | passed ok / false | escalated | escalation rate | accuracy on decided | Jev-only accuracy (escalations count as undecided) |");
L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [name, a, p, e] of [
  ["current config", thresholds.act, thresholds.pass, cur],
  ["literal sweep (no margin)", litAct, litPass, evaluate(spec, litAct, litPass)],
  ["recommended", recAct, recPass, rec],
  ["single cut at 0.5 (no fallback)", 0.5, 0.5, evaluate(spec, 0.5, 0.5)],
] as const) {
  L.push(`| ${name} | ${a} | ${p} | ${e.actOk} / ${e.actBad} | ${e.passOk} / ${e.passBad} | ${e.esc} | ${pct(e.esc, e.total)} | ${decidedAcc(e)} | ${jevOnlyAcc(e)} |`);
}
L.push("");
L.push("### Per question");
L.push("");
L.push("| Question | n | max p clean | min p problem | separable | min zero-false-act | max zero-false-pass | escalation @ recommended | accuracy on decided @ recommended |");
L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const q of SPEC_QS) {
  const s = perQ[q]!;
  const e = evaluate(okNoul([q]), recAct, recPass);
  L.push(`| ${q} | ${e.total} | ${fmt(s.maxClean)} | ${fmt(s.minProb)} | ${s.separable} | ${s.act ?? "none"} | ${s.pass ?? "none"} | ${pct(e.esc, e.total)} | ${decidedAcc(e)} |`);
}
L.push("");
L.push("## lesson_relevant (p = relevant)");
L.push("");
L.push(`Best threshold ${lessonBest.t}: accuracy ${pct(lessons.length - lessonBest.fp - lessonBest.fn, lessons.length)} (false relevant ${lessonBest.fp}, missed ${lessonBest.fn}). Current config ${thresholds.lesson_relevant}: ${lessonAt(thresholds.lesson_relevant)}/${lessons.length} correct.`);
L.push("");
L.push("## failure_category (choice)");
L.push("");
L.push(`Accuracy ${catOk}/${cats.length} (${pct(catOk, cats.length)}).`);
L.push("");
L.push("| id | label | Jev choice | confidence | top probabilities |");
L.push("| --- | --- | --- | --- | --- |");
for (const c of cats) {
  const top = Object.entries(c.probabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
  L.push(`| ${c.id} | ${c.label} | ${c.choice === c.label ? c.choice : `**${c.choice}**`} | ${fmt(c.confidence, 2)} | ${top} |`);
}
L.push("");
L.push("## Misreads (wrong side of 0.5, or wrong option)");
L.push("");
if (!misreads.length) L.push("None.");
for (const c of misreads) {
  const ex = exById.get(c.id)!;
  const shown = c.p !== undefined ? `p=${c.p.toFixed(3)}` : `chose ${c.choice}`;
  L.push(`- **${c.id}** (${c.question}, label ${c.label}, r${c.rep}): ${shown}. State: ${JSON.stringify(ex.state)}`);
}
L.push("");
if (spreads.length) {
  L.push("## Stability across repeats (largest p range)");
  L.push("");
  for (const s of spreads.slice(0, 8)) L.push(`- ${s.id}: ${s.range.toFixed(3)}`);
  L.push("");
}
if (failed.length) {
  L.push("## Failed calls");
  L.push("");
  for (const c of failed) L.push(`- ${c.id} r${c.rep}: ${c.error}`);
  L.push("");
}
L.push("## All noul scores");
L.push("");
L.push("| id | question | trap | hard | label | p | decision @ recommended |");
L.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const c of okCalls.filter((c) => c.p !== undefined)) {
  let d = "";
  if (SPEC_QS.includes(c.question)) d = c.p! >= recAct ? "act" : c.p! < recPass ? "pass" : "escalate";
  else d = c.p! >= lessonBest.t ? "relevant" : "not relevant";
  L.push(`| ${c.id} | ${c.question} | ${c.trap} | ${exById.get(c.id)?.hard ? "yes" : ""} | ${c.label} | ${c.p!.toFixed(3)} | ${d} |`);
}
L.push("");
const proposals = join(HERE, "wording-proposals.md");
if (!tag && existsSync(proposals)) {
  L.push(readFileSync(proposals, "utf8").trim());
  L.push("");
}
writeFileSync(join(HERE, `report${suffix}.md`), L.join("\n"));

console.log(`\n[calibrate] ok ${okCalls.length}/${all.length}, failed ${failed.length}, cost $${usd.toFixed(6)} (usage.cost), tokens in ${tin} out ${tout}`);
console.log(`[calibrate] pooled spec checks: maxClean=${fmt(pooled.maxClean)} minProblem=${fmt(pooled.minProb)} -> act=${recAct} pass=${recPass}`);
console.log(`[calibrate] recommended: escalation ${pct(rec.esc, rec.total)}, accuracy on decided ${decidedAcc(rec)}, false act ${rec.actBad}, false pass ${rec.passBad}`);
console.log(`[calibrate] current ${thresholds.act}/${thresholds.pass}: escalation ${pct(cur.esc, cur.total)}, accuracy on decided ${decidedAcc(cur)}, false act ${cur.actBad}, false pass ${cur.passBad}`);
console.log(`[calibrate] lesson_relevant best t=${lessonBest.t} fp=${lessonBest.fp} fn=${lessonBest.fn}; failure_category ${catOk}/${cats.length}`);
console.log(`[calibrate] misreads: ${misreads.map((c) => c.id).join(", ") || "none"}`);
console.log(`[calibrate] wrote results${suffix}.json, report${suffix}.md`);
