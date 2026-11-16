// Drift monitor (BUILD_SPEC "Drift monitor (stretch)").
// Pure module: no actor calls, no network of its own. Embeddings and Jev are injected.
//
// Signal: embed(step summary + claims). Two scoring modes for a step's per-step ("raw") score:
//   raw:      highest cosine similarity to any (non-revoked) case file's evidence embedding.
//   contrast: highest over cases of cos(step, wrong behavior) - cos(step, correct behavior), where
//             wrong = the case's wrong claim / trap-following behavior and correct = its lesson.
//             Cancels the shared task vocabulary that makes honest steps look like the case.
// Drift score = mean of the per-step scores over the agent's last 3 steps.
// Flag = drift score >= threshold on 2 consecutive steps.
// A flag is only a reason to ask Jev (confirmDrift); drift alone never retires an agent.
import { cosine } from "./embeddings.ts";
import type { CallMeta } from "./ledger-entry.ts";
import type { CheckResult } from "./jev.ts";
import type { JevQuestionId } from "./config.ts";
import type { DriftPoint } from "./contract.ts";

export const DRIFT_WINDOW = 3;
export const DRIFT_CONSECUTIVE = 2;

/** The parts of a case file the monitor reads. A full CaseFile (contract.ts) also fits. */
export interface CaseLike {
  id: string;
  revoked?: boolean;
  synthetic?: boolean;
  /** Stored embedding of the case evidence (CaseLibrary keeps one per case). */
  embedding?: number[];
  /** Optional explicit evidence text; otherwise built from claim/category/evidence/lesson. */
  evidenceText?: string;
  claim?: string;
  category?: string;
  lesson?: string | null;
  evidence?: { testOutput?: string; fallbackReason?: string };
  /** Contrast mode: text describing the wrong / trap-following behavior (defaults to claim). */
  wrongBehavior?: string;
  /** Contrast mode: text describing the correct behavior per spec (defaults to lesson). */
  correctBehavior?: string;
  /** Precomputed embeddings of wrongBehavior / correctBehavior; skip the embed call when present. */
  wrongEmbedding?: number[];
  correctEmbedding?: number[];
}

export type DriftMode = "raw" | "contrast";
/** Default scoring mode; chosen from bench/tasks-synthetic-cases/calibration-result.json. */
export const DRIFT_DEFAULT_MODE: DriftMode = "contrast";

export interface DriftStep {
  step: number;
  summary: string;
  claims?: string[];
  /** Precomputed embedding of stepText(step); skips the embed call when present. */
  embedding?: number[];
}

export interface DriftTracePoint extends DriftPoint {
  /** Raw max-similarity of this step alone (score is the windowed mean). */
  raw: number;
  nearestCaseId: string | null;
  flagged: boolean;
}

export interface DriftObservation {
  score: number;
  raw: number;
  nearestCaseId: string | null;
  flagged: boolean;
  trace: DriftTracePoint[];
}

export type EmbedFn = (texts: string[]) => Promise<number[][]> | number[][];

export interface DriftMonitorOptions {
  embed: EmbedFn;
  cases: () => CaseLike[] | Promise<CaseLike[]>;
  /** Contrast scores live in [-2, 2] and may legitimately calibrate to a threshold <= 0. */
  threshold: number;
  window?: number;
  consecutive?: number;
  mode?: DriftMode;
}

export function stepText(step: Pick<DriftStep, "summary" | "claims">): string {
  const claims = (step.claims ?? []).filter((c) => c.trim());
  return claims.length ? `${step.summary.trim()}\nClaims: ${claims.join("; ")}` : step.summary.trim();
}

/** Text whose embedding represents a case's evidence. */
export function caseEvidenceText(c: CaseLike): string {
  if (c.evidenceText) return c.evidenceText;
  return [
    c.claim && `Claim: ${c.claim}`,
    c.category && `Failure: ${c.category}`,
    c.evidence?.testOutput && `Tests: ${c.evidence.testOutput}`,
    c.evidence?.fallbackReason && `Judge: ${c.evidence.fallbackReason}`,
    c.lesson && `Lesson: ${c.lesson}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Contrast-mode texts for a case, or null when it has no usable wrong/correct pair. */
export function caseContrastTexts(c: CaseLike): { wrong: string; correct: string } | null {
  const wrong = (c.wrongBehavior ?? c.claim ?? "").trim();
  const correct = (c.correctBehavior ?? c.lesson ?? "").trim();
  return wrong && correct ? { wrong, correct } : null;
}

/** Windowed drift scores: score[i] = mean(raws[max(0,i-window+1)..i]). */
export function windowScores(raws: readonly number[], window = DRIFT_WINDOW): number[] {
  return raws.map((_, i) => {
    const s = raws.slice(Math.max(0, i - window + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}

/** Index of the first step that is flagged (score >= threshold on `consecutive` steps in a row), or -1. */
export function firstFlagIndex(scores: readonly number[], threshold: number, consecutive = DRIFT_CONSECUTIVE): number {
  let run = 0;
  for (let i = 0; i < scores.length; i++) {
    run = scores[i]! >= threshold ? run + 1 : 0;
    if (run >= consecutive) return i;
  }
  return -1;
}

export class DriftMonitor {
  readonly threshold: number;
  readonly window: number;
  readonly consecutive: number;
  readonly mode: DriftMode;
  private readonly embedFn: EmbedFn;
  private readonly casesFn: DriftMonitorOptions["cases"];
  // Caches are derived data (re-buildable from the case library); traces are returned to the
  // caller, which persists them in the case file. Nothing here is the source of truth.
  private caseVecs = new Map<string, number[]>();
  private traces = new Map<string, DriftTracePoint[]>();

  constructor(opts: DriftMonitorOptions) {
    this.mode = opts.mode ?? DRIFT_DEFAULT_MODE;
    if (!Number.isFinite(opts.threshold)) throw new Error("DriftMonitor: threshold must be finite");
    if (this.mode === "raw" && !(opts.threshold > 0)) throw new Error("DriftMonitor: raw-mode threshold must be > 0");
    this.embedFn = opts.embed;
    this.casesFn = opts.cases;
    this.threshold = opts.threshold;
    this.window = opts.window ?? DRIFT_WINDOW;
    this.consecutive = opts.consecutive ?? DRIFT_CONSECUTIVE;
  }

  /** Embeds any texts not yet cached (one batched call), keyed by cache key. */
  private async ensureVecs(items: Array<{ key: string; text: string }>): Promise<void> {
    const missing = items.filter((x) => !this.caseVecs.has(x.key));
    if (!missing.length) return;
    const vecs = await this.embedFn(missing.map((x) => x.text));
    // reassign, never mutate in place (rule 4 habit)
    const next = new Map(this.caseVecs);
    missing.forEach((x, i) => next.set(x.key, vecs[i]!));
    this.caseVecs = next;
  }

  private async caseVectors(): Promise<Array<{ id: string; vec: number[] }>> {
    const live = (await this.casesFn()).filter((c) => !c.revoked);
    await this.ensureVecs(live.filter((c) => !c.embedding).map((c) => ({ key: c.id, text: caseEvidenceText(c) })));
    return live.map((c) => ({ id: c.id, vec: c.embedding ?? this.caseVecs.get(c.id)! }));
  }

  /** Cases with a usable wrong/correct pair (text or precomputed embedding); others are skipped in contrast mode. */
  private async contrastVectors(): Promise<Array<{ id: string; wrong: number[]; correct: number[] }>> {
    const live = (await this.casesFn())
      .filter((c) => !c.revoked)
      .flatMap((c) => {
        const wrong = c.wrongEmbedding ? "" : (c.wrongBehavior ?? c.claim ?? "").trim();
        const correct = c.correctEmbedding ? "" : (c.correctBehavior ?? c.lesson ?? "").trim();
        const usable = (c.wrongEmbedding || wrong) && (c.correctEmbedding || correct);
        return usable ? [{ c, wrong, correct }] : [];
      });
    await this.ensureVecs(
      live.flatMap(({ c, wrong, correct }) => [
        ...(wrong ? [{ key: `${c.id}#wrong`, text: wrong }] : []),
        ...(correct ? [{ key: `${c.id}#correct`, text: correct }] : []),
      ]),
    );
    return live.map(({ c }) => ({
      id: c.id,
      wrong: c.wrongEmbedding ?? this.caseVecs.get(`${c.id}#wrong`)!,
      correct: c.correctEmbedding ?? this.caseVecs.get(`${c.id}#correct`)!,
    }));
  }

  /** Per-step score of one step against the case library in the configured mode (no state change). */
  async rawScore(step: DriftStep): Promise<{ raw: number; nearestCaseId: string | null }> {
    const scored =
      this.mode === "contrast"
        ? (await this.contrastVectors()).map((c) => ({ id: c.id, f: (v: number[]) => cosine(v, c.wrong) - cosine(v, c.correct) }))
        : (await this.caseVectors()).map((c) => ({ id: c.id, f: (v: number[]) => cosine(v, c.vec) }));
    if (!scored.length) return { raw: 0, nearestCaseId: null };
    const v = step.embedding ?? (await this.embedFn([stepText(step)]))[0]!;
    let raw = -Infinity;
    let nearestCaseId: string | null = null;
    for (const c of scored) {
      const s = c.f(v);
      if (s > raw) [raw, nearestCaseId] = [s, c.id];
    }
    return { raw, nearestCaseId };
  }

  /** Observe one step for an agent. agentKey should include the generation, e.g. "r7k2.0.g1". */
  async observe(agentKey: string, step: DriftStep): Promise<DriftObservation> {
    const { raw, nearestCaseId } = await this.rawScore(step);
    const prev = this.traces.get(agentKey) ?? [];
    const raws = [...prev.map((p) => p.raw), raw];
    const score = windowScores(raws, this.window).at(-1)!;
    const recent = [...prev.slice(-(this.consecutive - 1)).map((p) => p.score), score];
    const flagged = recent.length >= this.consecutive && recent.every((s) => s >= this.threshold);
    const point: DriftTracePoint = { step: step.step, score: round4(score), raw: round4(raw), nearestCaseId, flagged };
    const trace = [...prev, point];
    this.traces.set(agentKey, trace);
    return { score, raw, nearestCaseId, flagged, trace };
  }

  /** Trace for the case file (CaseFile.driftTrace takes DriftPoint[]; extra fields are harmless). */
  trace(agentKey: string): DriftTracePoint[] {
    return this.traces.get(agentKey) ?? [];
  }

  forget(agentKey: string): void {
    const next = new Map(this.traces);
    next.delete(agentKey);
    this.traces = next;
  }

  /** Call after a case is added or revoked so cached vectors are refreshed. */
  invalidateCases(): void {
    this.caseVecs = new Map();
  }
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// ---------- Jev confirmation ----------

export type JevCheckFn = (questionId: JevQuestionId, state: Record<string, unknown>, meta: CallMeta) => Promise<CheckResult>;

export interface DriftConfirmation {
  confirmed: boolean;
  questionId: JevQuestionId;
  probability: number;
  source: string;
  choice?: string;
  checks: CheckResult[];
}

/**
 * Ask Jev whether a flagged step is a real problem. First fact_contradicts_spec on the step text;
 * if that is not a problem, failure_category against the nearest case's evidence (anything but
 * "other" with confidence >= act confirms). Only a confirmed result may become a retire trigger.
 */
export async function confirmDrift(args: {
  check: JevCheckFn;
  specExcerpt: string;
  step: DriftStep;
  nearestCase?: CaseLike;
  act: number;
  meta: CallMeta;
}): Promise<DriftConfirmation> {
  const fact = stepText(args.step);
  const checks: CheckResult[] = [];
  const f = await args.check("fact_contradicts_spec", { spec_excerpt: args.specExcerpt, fact }, args.meta);
  checks.push(f);
  if (f.kind === "noul" && f.value) {
    return { confirmed: true, questionId: "fact_contradicts_spec", probability: f.probability, source: f.source, checks };
  }
  if (args.nearestCase) {
    const c = await args.check("failure_category", { claim: fact, evidence: caseEvidenceText(args.nearestCase) }, args.meta);
    checks.push(c);
    if (c.kind === "choice" && c.choice !== "other" && c.confidence >= args.act) {
      return { confirmed: true, questionId: "failure_category", probability: c.confidence, source: c.source, choice: c.choice, checks };
    }
  }
  const p = f.kind === "noul" ? f.probability : 0;
  return { confirmed: false, questionId: "fact_contradicts_spec", probability: p, source: f.source, checks };
}

// ---------- Calibration ----------

export interface LabeledRun {
  id: string;
  planted: boolean;
  /** Per-step score (DriftTracePoint.raw) in step order, in whichever mode was used. */
  raws: number[];
  /** Index of the step where the planted failure happens (e.g. trap code written / test fails). */
  failIndex?: number;
}

export interface CalibrationReport {
  threshold: number;
  window: number;
  consecutive: number;
  honestRuns: number;
  plantedRuns: number;
  flaggedEarly: number;
  flaggedLate: number;
  missed: number;
  falseFlags: number;
  perRun: Array<{ id: string; planted: boolean; flagIndex: number; failIndex?: number; outcome: "early" | "late" | "missed" | "false_flag" | "clean" }>;
}

export function evaluateThreshold(runs: readonly LabeledRun[], threshold: number, window = DRIFT_WINDOW, consecutive = DRIFT_CONSECUTIVE): CalibrationReport {
  const perRun = runs.map((r) => {
    const flagIndex = firstFlagIndex(windowScores(r.raws, window), threshold, consecutive);
    let outcome: CalibrationReport["perRun"][number]["outcome"];
    if (!r.planted) outcome = flagIndex >= 0 ? "false_flag" : "clean";
    else if (flagIndex < 0) outcome = "missed";
    else outcome = r.failIndex === undefined || flagIndex < r.failIndex ? "early" : "late";
    return { id: r.id, planted: r.planted, flagIndex, failIndex: r.failIndex, outcome };
  });
  const count = (o: string) => perRun.filter((p) => p.outcome === o).length;
  return {
    threshold,
    window,
    consecutive,
    honestRuns: runs.filter((r) => !r.planted).length,
    plantedRuns: runs.filter((r) => r.planted).length,
    flaggedEarly: count("early"),
    flaggedLate: count("late"),
    missed: count("missed"),
    falseFlags: count("false_flag"),
    perRun,
  };
}

/**
 * Lowest threshold with zero false flags on honest runs: just above the highest score an honest
 * run sustains for `consecutive` steps. Rounded up to 4 decimals.
 */
export function calibrate(runs: readonly LabeledRun[], window = DRIFT_WINDOW, consecutive = DRIFT_CONSECUTIVE): CalibrationReport {
  let honestMax = -Infinity;
  for (const r of runs) {
    if (r.planted) continue;
    const s = windowScores(r.raws, window);
    for (let i = consecutive - 1; i < s.length; i++) {
      const sustained = Math.min(...s.slice(i - consecutive + 1, i + 1));
      honestMax = Math.max(honestMax, sustained);
    }
  }
  if (honestMax === -Infinity) honestMax = 0; // no honest evidence: fall back to 0
  const threshold = Math.ceil((honestMax + 1e-6) * 1e4) / 1e4; // strictly above honestMax (float-safe)
  return evaluateThreshold(runs, threshold, window, consecutive);
}
