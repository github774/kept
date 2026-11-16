// Drift calibration (raw and contrast modes) on SYNTHETIC step summaries (calibration-steps.json) against the SYNTHETIC
// seed cases (cases.json). Uses the shared embeddings adapter: real OpenRouter embeddings when a
// key is set, otherwise MOCK hashed vectors (labeled MOCK in output and result file).
//
//   bun --env-file=/Users/avneh/Code/SmarterSubagents/.env run bench/tasks-synthetic-cases/calibrate.ts
//
// Writes bench/tasks-synthetic-cases/calibration-result.json. Token counts come from usage fields.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEmbedder } from "../../orchestrator/src/embeddings.ts";
import { DRIFT_DEFAULT_MODE, DriftMonitor, calibrate, stepText, windowScores, type CaseLike, type DriftMode, type LabeledRun } from "../../orchestrator/src/drift.ts";
import type { LedgerDraft } from "../../orchestrator/src/ledger-entry.ts";

const dir = import.meta.dir;
const cases: CaseLike[] = (await Bun.file(join(dir, "cases.json")).json()).cases;
interface StepIn { summary: string; claims?: string[] }
interface RunIn { id: string; trapId: string; planted: boolean; failIndex?: number; steps: StepIn[] }
const runs: RunIn[] = (await Bun.file(join(dir, "calibration-steps.json")).json()).runs;

const embedder = await getEmbedder();
const label = embedder.mock ? "MOCK" : "real";
const usage: LedgerDraft[] = [];
const meta = { category: "embedding" as const, slot: "calibration", gen: 0, step: 0 };
const embed = async (texts: string[]) => {
  const r = await embedder.embed(texts, meta);
  usage.push(r.usage);
  return r.vectors;
};

// One batched call for all step texts, shared by both modes.
const allSteps = runs.flatMap((r) => r.steps);
const stepVecs = await embed(allSteps.map(stepText));
const stepUsage = usage.length;

const sum = (xs: LedgerDraft[], f: (u: LedgerDraft) => number) => xs.reduce((s, u) => s + f(u), 0);
const usageOf = (xs: LedgerDraft[]) => ({ input_tokens: sum(xs, (u) => u.input_tokens), usd: sum(xs, (u) => u.usd ?? 0), calls: xs.length });
const range = (xs: number[]) => (xs.length ? [round4(Math.min(...xs)), round4(Math.max(...xs))] : null);
function round4(x: number) {
  return Math.round(x * 1e4) / 1e4;
}

async function runMode(mode: DriftMode) {
  const before = usage.length;
  // threshold is irrelevant here (we only read per-step scores); calibrate() picks it after.
  const monitor = new DriftMonitor({ embed, cases: () => cases, threshold: 1, mode });
  const labeled: LabeledRun[] = [];
  const nearest: Record<string, string[]> = {};
  let k = 0;
  for (const r of runs) {
    const raws: number[] = [];
    nearest[r.id] = [];
    for (const [i, s] of r.steps.entries()) {
      const obs = await monitor.observe(r.id, { step: i, ...s, embedding: stepVecs[k++] });
      raws.push(obs.raw);
      nearest[r.id]!.push(obs.nearestCaseId ?? "-");
    }
    labeled.push({ id: r.id, planted: r.planted, raws, failIndex: r.failIndex });
  }
  const report = calibrate(labeled);
  // Per-step score ranges. "trapSteps" = planted-run steps before failIndex from index 1 on
  // (step 0 is the shared "read SPEC" step); windowed = the 3-step mean the threshold applies to.
  const honest = labeled.filter((r) => !r.planted);
  const planted = labeled.filter((r) => r.planted);
  const ranges = {
    honestSteps: range(honest.flatMap((r) => r.raws)),
    trapSteps: range(planted.flatMap((r) => r.raws.slice(1, r.failIndex ?? r.raws.length))),
    plantedRunAllSteps: range(planted.flatMap((r) => r.raws)),
    honestWindowed: range(honest.flatMap((r) => windowScores(r.raws))),
    plantedWindowedBeforeFail: range(planted.flatMap((r) => windowScores(r.raws).slice(0, r.failIndex ?? r.raws.length))),
  };
  console.log(`\n[${label}] mode=${mode}`);
  for (const r of labeled) {
    const p = report.perRun.find((x) => x.id === r.id)!;
    console.log(`${r.planted ? "TRAP  " : "HONEST"} ${r.id.padEnd(46)} raws=[${r.raws.map((x) => x.toFixed(3)).join(" ")}] flag@${p.flagIndex} fail@${p.failIndex ?? "-"} ${p.outcome}`);
  }
  console.log(
    `threshold=${report.threshold} flaggedEarly=${report.flaggedEarly} flaggedLate=${report.flaggedLate} missed=${report.missed} falseFlags=${report.falseFlags} (planted=${report.plantedRuns}, honest=${report.honestRuns})`,
  );
  console.log(`ranges ${JSON.stringify(ranges)}`);
  const caseUsage = usageOf(usage.slice(before));
  console.log(`case-embedding usage: ${JSON.stringify(caseUsage)}`);
  return { mode, ...report, ranges, caseEmbeddingUsage: caseUsage, scores: Object.fromEntries(labeled.map((r) => [r.id, r.raws.map(round4)])), nearest };
}

const raw = await runMode("raw");
const contrast = await runMode("contrast");
const total = usageOf(usage);
console.log(`\nembedding usage total: ${JSON.stringify(total)} (steps: ${JSON.stringify(usageOf(usage.slice(0, stepUsage)))})`);

writeFileSync(
  join(dir, "calibration-result.json"),
  JSON.stringify(
    {
      _comment:
        "Drift calibration on SYNTHETIC hand-written step summaries vs SYNTHETIC seed cases, both scoring modes. Not a measured hit rate on real agent runs. Thresholds are the zero-false-flag threshold per mode.",
      embeddings: label,
      measuredAt: new Date().toISOString(),
      defaultMode: DRIFT_DEFAULT_MODE,
      usage: { total, steps: usageOf(usage.slice(0, stepUsage)) },
      modes: { raw, contrast },
    },
    null,
    2,
  ) + "\n",
);
