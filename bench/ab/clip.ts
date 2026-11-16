#!/usr/bin/env bun
// Learning clip (one run each side): from bench/ab/results.json, one agent that hit the poisoned helper in a cold run
// (no lesson) next to the agent owning the same function in a warm run (library seeded with that cold run's case).
// Writes bench/ab/learning-clip.md + learning-clip.json only when the warm agent avoided the poison AND its own
// approach_note/summary says why (cites the lesson, the spec rounding rule or round_money); otherwise says so.
//   bun bench/ab/clip.ts [--cold <runId>] [--warm <runId>]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DIR = import.meta.dir;
const { values } = parseArgs({ options: { cold: { type: "string" }, warm: { type: "string" } } });
type Any = Record<string, any>; // raw rows (see run.ts)
const rows = JSON.parse(readFileSync(join(DIR, "results.json"), "utf8")) as Any[];
const SENS: Record<string, string[]> = {
  line_net: ["test_half_away_from_zero", "test_yen_line"],
  line_tax: ["test_distance_sale_uses_buyer_rates", "test_dutch_reduced_rate"],
  invoice_totals: ["test_distance_sale", "test_only_exempt_and_export_kwd"],
  convert: ["test_same_currency_rounds", "test_into_yen"],
  credit_note: ["test_negative_half_away_from_zero"],
};
const poisonRun = (r: Any, t: Any) => r.poison_s !== null && t.t_s >= r.poison_s && !t.passed && (SENS[t.fn] ?? []).some((s: string) => t.failed.includes(s));
const WHY = /lesson|ROUND_HALF_UP|half[- ]?(away|up)|round_money|banker|half[- ]even|helper|SPEC 2\.2|section 2\.2|2\.2/i;

const warmRows = rows.filter((r) => r.arm === "E" && (!values.warm || r.run_id === values.warm));
let picked: { cold: Any; warm: Any; fn: string; coldAgent: string; warmAgent: string } | null = null;
outer: for (const w of warmRows) {
  const cold = rows.find((r) => `lib-${r.run_id}` === w.library_id || r.library_id === w.library_id);
  if (!cold || (values.cold && cold.run_id !== values.cold)) continue;
  // cold side: agents that failed on the poison before any lesson reached their prompt
  const coldHit = (cold.test_runs as Any[]).filter((t) => poisonRun(cold, t)).sort((a, b) => a.t_s - b.t_s);
  for (const hit of coldHit) {
    const wAgents = (w.worker_calls as Any[]).filter((c) => c.slot === hit.slot && c.gen === 1);
    if (!wAgents.length) continue;
    const wRuns = (w.test_runs as Any[]).filter((t) => t.slot === hit.slot);
    const avoided = !wRuns.some((t) => poisonRun(w, t)) && !w.final.followed.includes(hit.fn) && w.final.passing.includes(hit.fn);
    const says = wAgents.some((c) => WHY.test(`${c.approach_note} ${c.summary}`));
    if (avoided && says) {
      picked = { cold, warm: w, fn: hit.fn, coldAgent: hit.agent, warmAgent: `w${hit.slot}-g1-${w.run_id}` };
      break outer;
    }
  }
}

if (!picked) {
  const lines = warmRows.map((w) => {
    const hits = (w.test_runs as Any[]).filter((t) => poisonRun(w, t));
    return `- run \`${w.run_id}\` (library \`${w.library_id}\`): lesson in every prompt from step 1: "${w.lessons_at_start.join(" / ")}"; round_money imported at poison by ${w.imports_at_poison.length} functions (${w.imports_at_poison.join(", ")}); ${hits.length} poison-induced failing test runs by ${new Set(hits.map((t: Any) => t.agent)).size} agents; poison in final code: ${w.final.followed.join(", ") || "none"}.`;
  });
  const msg = `# Learning clip\n\n**Not produced.** Rule: keep the clip only if an agent WITH the seeded lesson avoids the poisoned helper and its own note says why, next to the same function's agent in the cold run that seeded the library. No warm agent met it (${warmRows.length} warm runs checked, nothing cherry-picked). The seeded lesson (a real poison case) names the rounding rule, not the helper, so agents with it in their prompt still called \`billing_common.round_money\` as SPEC 0 tells them:\n\n${lines.join("\n")}\n\nWith-lesson side was seeded through \`libraryId\` (CaseLibrary of an arm-A run), not Supabase recall. Raw: bench/ab/results.json (arm E rows: worker_calls carry every approach_note, lesson_blocks the exact lessons block).\n`;
  writeFileSync(join(DIR, "learning-clip.md"), msg);
  writeFileSync(join(DIR, "learning-clip.json"), JSON.stringify({ produced: false, warm_runs_checked: warmRows.map((r) => r.run_id) }, null, 1));
  console.log("no clip");
  process.exit(0);
}
const { cold, warm, fn, coldAgent, warmAgent } = picked;
const side = (r: Any, agent: string) => {
  const slot = Number(/^w(\d+)-/.exec(agent)![1]);
  const gen = Number(/-g(\d+)-/.exec(agent)![1]);
  const calls = (r.worker_calls as Any[]).filter((c) => c.slot === slot && c.gen === gen).sort((a, b) => a.t_s - b.t_s);
  const runs = (r.test_runs as Any[]).filter((t) => t.slot === slot && t.gen === gen);
  return {
    run_id: r.run_id, arm: r.arm, library_id: r.library_id, agent, fn, poison_s: r.poison_s,
    lessons_block_step1: calls[0] ? r.lesson_blocks[calls[0].lessons_key] : null,
    lessons_block_last: calls.at(-1) ? r.lesson_blocks[calls.at(-1).lessons_key] : null,
    steps: calls.map((c) => ({ t_s: Math.round(c.t_s * 10) / 10, step: c.step, action: c.action, uses_round_money: c.uses_helper, approach_note: c.approach_note, summary: c.summary })),
    test_runs: runs.map((t) => ({ t_s: Math.round(t.t_s * 10) / 10, passed: t.passed, failed: t.failed, uses_round_money: t.usesHelper, poison_induced: poisonRun(r, t) })),
    retired: (r.cases as Any[]).some((c) => c.slot === slot && c.gen === gen),
    final_followed_poison: r.final.followed.includes(fn), final_pass: r.final.passing.includes(fn),
  };
};
const a = side(cold, coldAgent);
const b = side(warm, warmAgent);
const seedCase = (cold.cases as Any[]).find((c) => warm.lessons_at_start.includes(c.lesson)) ?? cold.cases[0];
writeFileSync(join(DIR, "learning-clip.json"), JSON.stringify({ produced: true, label: "one run", seed_case: seedCase, without_lesson: a, with_lesson: b }, null, 1));
const cell = (s: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const stepsTable = (x: typeof a) =>
  ["| t (s) | step | action | uses round_money | approach_note / summary |", "| --- | --- | --- | --- | --- |", ...x.steps.map((s) => `| ${s.t_s} | ${s.step} | ${s.action} | ${s.uses_round_money ? "yes" : "no"} | ${cell(s.approach_note)} / ${cell(s.summary)} |`)].join("\n");
const testsLine = (x: typeof a) => x.test_runs.map((t) => `${t.t_s}s ${t.passed ? "PASS" : `FAIL(${t.failed.join(",")})${t.poison_induced ? " [poison]" : ""}`}`).join("; ") || "(none)";
const md = `# Learning clip (one run each side)

Task \`invoicing_ab\`, function \`${fn}\`, same poison (billing_common.round_money silently switched to ROUND_HALF_EVEN
mid-run, file-level, Jev never sees it), same model (GPT-6 Luna), herd ON on both sides. Label: **one run**, not a rate.
Numbers across trials are in docs/BENCHMARK.md "Feature A/B" (Experiment 3).

- WITHOUT the lesson: cold library, run \`${a.run_id}\`, agent \`${a.agent}\` (poison landed at ${a.poison_s}s).
- WITH the lesson: library \`${warm.library_id}\` (cases from run \`${cold.run_id}\`), run \`${b.run_id}\`, agent \`${b.agent}\` (poison landed at ${b.poison_s}s).

Seed case: \`${seedCase?.id}\` [${seedCase?.category}], failed tests: ${(seedCase?.failed_tests ?? []).join(", ")}.

## Lessons block in the prompt at step 1 (prompt builder, system message part 3)

WITHOUT:
\`\`\`
${a.lessons_block_step1}
\`\`\`

WITH:
\`\`\`
${b.lessons_block_step1}
\`\`\`

## WITHOUT the lesson: ${a.agent}

${stepsTable(a)}

Test runs: ${testsLine(a)}

Outcome: retired ${a.retired ? "yes" : "no"}; final code follows the poison: ${a.final_followed_poison ? "yes" : "no"}; final tests pass: ${a.final_pass ? "yes" : "no"}.

## WITH the lesson: ${b.agent}

${stepsTable(b)}

Test runs: ${testsLine(b)}

Outcome: retired ${b.retired ? "yes" : "no"}; final code follows the poison: ${b.final_followed_poison ? "yes" : "no"}; final tests pass: ${b.final_pass ? "yes" : "no"}.

Raw: bench/ab/learning-clip.json (and the full rows in bench/ab/results.json).
`;
writeFileSync(join(DIR, "learning-clip.md"), md);
console.log(`clip: ${a.agent} vs ${b.agent} (${fn})`);
