#!/usr/bin/env bun
// Round-2 learning clip (one run each side), from bench/ab/results.fix.json: an agent in a herd-ON run (arm A) whose
// lessons block gained a lesson naming round_money / billing_common, which then wrote code without round_money and
// whose own note says why, next to the same function's agent in a herd-OFF run (arm B) that failed on the poison.
// Writes bench/ab/learning-clip.md + learning-clip.json only when such a pair exists; otherwise says so in the md.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Any = Record<string, any>;
const DIR = import.meta.dir;
const rows = JSON.parse(readFileSync(join(DIR, "results.fix.json"), "utf8")) as Any[];
const SENS: Record<string, string[]> = {
  line_net: ["test_half_away_from_zero", "test_yen_line"],
  line_tax: ["test_distance_sale_uses_buyer_rates", "test_dutch_reduced_rate"],
  invoice_totals: ["test_distance_sale", "test_only_exempt_and_export_kwd"],
  convert: ["test_same_currency_rounds", "test_into_yen"],
  credit_note: ["test_negative_half_away_from_zero"],
};
const FNS = ["line_net", "line_tax", "invoice_totals", "convert", "due_date", "credit_note", "late_fee"];
const NAMES = /round_money|billing_common/;
const WHY = /round_money|billing_common|helper|lesson|half[- ]?even|FIN-3/i;
const poisonRun = (r: Any, t: Any) => r.poison_s !== null && t.t_s >= r.poison_s && !t.passed && (SENS[t.fn] ?? []).some((s) => t.failed.includes(s));

interface Pick { run: Any; agent: string; slot: number; gen: number; lessonAt: number; key: string }
const picks: Pick[] = [];
for (const r of rows.filter((x) => x.arm === "A" && x.poison_s !== null)) {
  const blocks = r.lesson_blocks as Record<string, string>;
  const naming = new Set(Object.entries(blocks).filter(([, b]) => NAMES.test(b)).map(([k]) => k));
  if (!naming.size) continue;
  const agents = new Set((r.worker_calls as Any[]).map((w) => `${w.slot}.${w.gen}`));
  for (const a of agents) {
    const [slot, gen] = a.split(".").map(Number) as [number, number];
    if (!SENS[FNS[slot]!]) continue;
    const calls = (r.worker_calls as Any[]).filter((w) => w.slot === slot && w.gen === gen).sort((x, y) => x.t_s - y.t_s);
    const first = calls.findIndex((c) => naming.has(c.lessons_key));
    if (first < 0) continue;
    const after = calls.slice(first);
    const wrote = after.filter((c) => c.action === "write_code");
    const avoided = wrote.length > 0 && wrote.every((c) => !c.uses_helper);
    const says = after.some((c) => WHY.test(`${c.approach_note} ${c.summary}`));
    const failedAfter = (r.test_runs as Any[]).some((t) => t.slot === slot && t.gen === gen && t.t_s >= calls[first].t_s && poisonRun(r, t));
    if (avoided && says && !failedAfter && !r.final.followed.includes(FNS[slot])) picks.push({ run: r, agent: `w${slot}-g${gen}-${r.run_id}`, slot, gen, lessonAt: calls[first].t_s, key: calls[first].lessons_key });
  }
}
const without = (fn: string) => {
  for (const r of rows.filter((x) => x.arm === "B" && x.poison_s !== null)) {
    const hit = (r.test_runs as Any[]).filter((t) => t.fn === fn && poisonRun(r, t)).sort((a, b) => a.t_s - b.t_s)[0];
    if (hit) return { run: r, agent: hit.agent as string, slot: hit.slot as number, gen: hit.gen as number };
  }
  return null;
};
let pair: { w: Pick; o: NonNullable<ReturnType<typeof without>> } | null = null;
// Prefer a first-generation agent: its lesson came through the lessons block / case alert, not through a handoff.
picks.sort((a, b) => a.gen - b.gen || a.lessonAt - b.lessonAt);
console.log(`candidates: ${picks.map((p) => p.agent).join(", ")}`);
for (const p of picks) {
  const o = without(FNS[p.slot]!);
  if (o) { pair = { w: p, o }; break; }
}
if (!pair) {
  appendFileSync(join(DIR, "learning-clip.md"), `\n## Round 2 (after the fixes)\n\n**Not produced.** Rule: an agent in a herd-ON run whose lessons block gained a lesson naming round_money/billing_common, then wrote code without round_money, its own note says why, no poison failure afterwards; next to the same function's agent in a herd-OFF run that failed on the poison. Candidates found: ${picks.length}; none had a herd-OFF counterpart, or none qualified. \n`);
  console.log(`no clip (candidates ${picks.length})`);
  process.exit(0);
}
const side = (r: Any, slot: number, gen: number) => {
  const calls = (r.worker_calls as Any[]).filter((c) => c.slot === slot && c.gen === gen).sort((a, b) => a.t_s - b.t_s);
  return {
    run_id: r.run_id, arm: r.arm, agent: `w${slot}-g${gen}-${r.run_id}`, fn: FNS[slot], poison_s: r.poison_s,
    steps: calls.map((c) => ({ t_s: Math.round(c.t_s * 10) / 10, step: c.step, action: c.action, uses_round_money: c.uses_helper, lessons_block: r.lesson_blocks[c.lessons_key], approach_note: c.approach_note, summary: c.summary })),
    test_runs: (r.test_runs as Any[]).filter((t) => t.slot === slot && t.gen === gen).map((t) => ({ t_s: Math.round(t.t_s * 10) / 10, passed: t.passed, failed: t.failed, uses_round_money: t.usesHelper, poison_induced: poisonRun(r, t) })),
    retired: (r.cases as Any[]).some((c) => c.slot === slot && c.gen === gen),
    final_followed_poison: r.final.followed.includes(FNS[slot]), final_pass: r.final.passing.includes(FNS[slot]),
  };
};
const W = side(pair.w.run, pair.w.slot, pair.w.gen);
const O = side(pair.o.run, pair.o.slot, pair.o.gen);
const seed = (pair.w.run.cases as Any[]).filter((c) => NAMES.test(c.lesson ?? "")).sort((a, b) => a.created_s - b.created_s)[0];
writeFileSync(join(DIR, "learning-clip.json"), JSON.stringify({ produced: true, label: "one run", round: 2, lesson_case: seed, with_lesson: W, without_lesson: O }, null, 1));
const cell = (s: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (x: typeof W) => ["| t (s) | step | action | uses round_money | approach_note / summary |", "| --- | --- | --- | --- | --- |", ...x.steps.map((s) => `| ${s.t_s} | ${s.step} | ${s.action} | ${s.uses_round_money ? "yes" : "no"} | ${cell(s.approach_note)} / ${cell(s.summary)} |`)].join("\n");
const tests = (x: typeof W) => x.test_runs.map((t) => `${t.t_s}s ${t.passed ? "PASS" : `FAIL(${t.failed.join(",")})${t.poison_induced ? " [poison]" : ""}`}`).join("; ") || "(none)";
const md = `# Learning clip (round 2, one run each side)

Task \`invoicing_ab\`, function \`${W.fn}\`. Same poison (billing_common.round_money silently switched to ROUND_HALF_EVEN
mid-run, file-level), same model (GPT-6 Luna), same code (commit with the stale-checkpoint and culprit-naming fixes).
Label: **one run**, not a rate; the rates are in docs/BENCHMARK.md "Feature A/B", round 2.

- WITH the lesson: herd ON, run \`${W.run_id}\`, agent \`${W.agent}\` (poison at ${W.poison_s}s; first step whose prompt carried a lesson naming round_money returned at ${Math.round(pair.w.lessonAt)}s).
- WITHOUT: herd OFF, run \`${O.run_id}\`, agent \`${O.agent}\` (poison at ${O.poison_s}s).

Lesson that reached it (case \`${seed?.id}\`, filed at ${Math.round(seed?.created_s ?? 0)}s from slot ${seed?.slot}'s failure): "${seed?.lesson}"

## Lessons block in the WITH agent's prompt once the lesson arrived

\`\`\`
${pair.w.run.lesson_blocks[pair.w.key]}
\`\`\`

## WITH the lesson: ${W.agent}

${table(W)}

Test runs: ${tests(W)}

Outcome: retired ${W.retired ? "yes" : "no"}; final code follows the poison: ${W.final_followed_poison ? "yes" : "no"}; final tests pass: ${W.final_pass ? "yes" : "no"}.

## WITHOUT (herd OFF): ${O.agent}

${table(O)}

Test runs: ${tests(O)}

Outcome: retired ${O.retired ? "yes" : "no"}; final code follows the poison: ${O.final_followed_poison ? "yes" : "no"}; final tests pass: ${O.final_pass ? "yes" : "no"}.

Raw: bench/ab/learning-clip.json and bench/ab/results.fix.json. Round 1 (before the fixes) produced no clip: the
lesson named the rule, not the helper (docs/BENCHMARK.md "Feature A/B", Experiment 3).
`;
writeFileSync(join(DIR, "learning-clip.md"), md);
console.log(`clip: ${W.agent} vs ${O.agent}`);
