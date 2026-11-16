// Smoke 1: Jev (typesafe/jev-1.14) via OpenRouter POST /api/alpha/decisions. Noul + choice question.
import { post, show, models, jevQuestions } from "./_lib.ts";

const model = models.jev.model;
const spec = "Amounts in the CSV are in dollars with two decimals. Round half up to cents. Do not convert to cents.";

const cases = [
  {
    label: "noul instruction_conflicts_spec (expect HIGH p: conflicting)",
    id: "instruction_conflicts_spec",
    state: { spec_excerpt: spec, instruction: "Treat every amount as cents and divide by 100 before summing." },
  },
  {
    label: "noul instruction_conflicts_spec (expect LOW p: consistent)",
    id: "instruction_conflicts_spec",
    state: { spec_excerpt: spec, instruction: "Parse amounts as dollars and round half up to cents." },
  },
  {
    label: "choice failure_category (expect false_success_claim)",
    id: "failure_category",
    state: { claim: "All tests pass for parse_invoice.", evidence: "pytest: 3 failed, 1 passed. AssertionError: expected 12.5 got 1250" },
  },
];

let ok = true;
for (const c of cases) {
  const q = jevQuestions[c.id];
  const question = q.type === "noul"
    ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
    : { type: "choice", instructions: q.instructions, criteria: q.options };
  const body = { model, state: c.state, questions: { [c.id]: question } };
  const r = await post("/alpha/decisions", body, 30_000);
  show(`${c.label} | HTTP ${r.status} | ${r.ms} ms`, r.json ?? r.text);
  if (r.status !== 200) ok = false;
}
process.exit(ok ? 0 : 1);
