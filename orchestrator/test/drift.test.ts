// Drift monitor unit tests. All embeddings here are deterministic MOCK vectors (no network).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DRIFT_DEFAULT_MODE,
  DriftMonitor,
  calibrate,
  caseContrastTexts,
  caseEvidenceText,
  confirmDrift,
  evaluateThreshold,
  firstFlagIndex,
  stepText,
  windowScores,
  type CaseLike,
  type JevCheckFn,
} from "../src/drift.ts";
import type { CheckResult } from "../src/jev.ts";

// MOCK embedding: text "e<i>:<w> e<j>:<u> ..." -> unit vector with weight w on axis i, u on axis j,
// and the rest on axis 0. Lets tests dial exact cosine similarity against cases pinned to axes.
function mockEmbed(texts: string[]): number[][] {
  return texts.map((t) => {
    const v = new Array(8).fill(0);
    let sq = 0;
    for (const m of t.matchAll(/e(\d+):([\d.]+)/g)) {
      const w = Number(m[2]);
      v[Number(m[1])] = w;
      sq += w * w;
    }
    v[0] = Math.sqrt(Math.max(0, 1 - sq));
    return v;
  });
}
const axis = (i: number, w = 1): number[] => {
  const v = new Array(8).fill(0);
  v[i] = w;
  return v;
};
const axisCase = (id: string, axis: number, extra: Partial<CaseLike> = {}): CaseLike => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  return { id, embedding: v, ...extra };
};
const meta = { category: "jev" as const, slot: "0", gen: 1, step: 0 };

describe("pure helpers", () => {
  test("windowScores averages the last 3", () => {
    windowScores([0.3, 0.6, 0.9, 0.0]).forEach((x, i) => expect(x).toBeCloseTo([0.3, 0.45, 0.6, 0.5][i]!, 9));
  });
  test("firstFlagIndex needs 2 consecutive", () => {
    expect(firstFlagIndex([0.9, 0.1, 0.9, 0.9], 0.8)).toBe(3);
    expect(firstFlagIndex([0.9, 0.1, 0.9], 0.8)).toBe(-1);
  });
  test("stepText joins summary and claims", () => {
    expect(stepText({ summary: " s ", claims: ["a", " ", "b"] })).toBe("s\nClaims: a; b");
    expect(stepText({ summary: "s" })).toBe("s");
  });
  test("caseEvidenceText builds from case fields", () => {
    const t = caseEvidenceText({ id: "x", claim: "c", category: "spec_misread", evidence: { testOutput: "FAILED" }, lesson: "L" });
    expect(t).toContain("Claim: c");
    expect(t).toContain("Tests: FAILED");
    expect(t).toContain("Lesson: L");
  });
});

describe("DriftMonitor", () => {
  test("score is windowed max-cosine; flags only after 2 consecutive steps over threshold", async () => {
    const m = new DriftMonitor({ embed: mockEmbed, cases: () => [axisCase("c1", 1), axisCase("c2", 2)], threshold: 0.6, mode: "raw" });
    const k = "r1.0.g1";
    const a = await m.observe(k, { step: 0, summary: "e1:0.3" });
    expect(a.raw).toBeCloseTo(0.3, 6);
    expect(a.nearestCaseId).toBe("c1");
    expect(a.flagged).toBe(false);
    const b = await m.observe(k, { step: 1, summary: "e2:0.9" });
    expect(b.nearestCaseId).toBe("c2");
    expect(b.score).toBeCloseTo(0.6, 6); // (0.3+0.9)/2
    expect(b.flagged).toBe(false); // only one step at/over threshold
    const c = await m.observe(k, { step: 2, summary: "e2:0.9" });
    expect(c.score).toBeCloseTo(0.7, 6);
    expect(c.flagged).toBe(true);
    expect(c.trace.map((p) => p.step)).toEqual([0, 1, 2]);
    expect(m.trace(k).at(-1)!.flagged).toBe(true);
  });

  test("agents are independent; revoked cases are ignored; no cases => 0", async () => {
    let cases = [axisCase("c1", 1, { revoked: true })];
    const m = new DriftMonitor({ embed: mockEmbed, cases: () => cases, threshold: 0.5, mode: "raw" });
    expect((await m.observe("a", { step: 0, summary: "e1:0.9" })).raw).toBe(0);
    cases = [axisCase("c1", 1)];
    await m.observe("b", { step: 0, summary: "e1:0.9" });
    const b2 = await m.observe("b", { step: 1, summary: "e1:0.9" });
    expect(b2.flagged).toBe(true);
    expect(m.trace("a")).toHaveLength(1);
    m.forget("b");
    expect(m.trace("b")).toHaveLength(0);
  });

  test("embeds cases lacking an embedding once, and uses precomputed step embeddings", async () => {
    let calls = 0;
    const embed = (t: string[]) => {
      calls++;
      return mockEmbed(t);
    };
    const m = new DriftMonitor({ embed, cases: () => [{ id: "t", evidenceText: "e3:1" }], threshold: 0.5, mode: "raw" });
    const v = mockEmbed(["e3:0.8"])[0]!;
    const o = await m.observe("a", { step: 0, summary: "ignored", embedding: v });
    expect(o.raw).toBeCloseTo(0.8, 6);
    await m.observe("a", { step: 1, summary: "ignored", embedding: v });
    expect(calls).toBe(1); // only the case text, once
  });

  test("raw mode rejects non-positive threshold; contrast allows <= 0 but not NaN", () => {
    expect(() => new DriftMonitor({ embed: mockEmbed, cases: () => [], threshold: 0, mode: "raw" })).toThrow();
    expect(new DriftMonitor({ embed: mockEmbed, cases: () => [], threshold: -0.1, mode: "contrast" }).threshold).toBe(-0.1);
    expect(() => new DriftMonitor({ embed: mockEmbed, cases: () => [], threshold: NaN, mode: "contrast" })).toThrow();
  });

  test("default mode is DRIFT_DEFAULT_MODE", () => {
    expect(new DriftMonitor({ embed: mockEmbed, cases: () => [], threshold: 0.5 }).mode).toBe(DRIFT_DEFAULT_MODE);
  });
});

describe("DriftMonitor contrast mode", () => {
  // Case: wrong behavior on axis 1, correct behavior on axis 2; evidence embedding mixes both
  // (shared vocabulary), so raw similarity cannot tell the two steps apart.
  const shared: CaseLike = {
    id: "c",
    embedding: [0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, 0, 0],
    wrongEmbedding: axis(1),
    correctEmbedding: axis(2),
  };
  const trapStep = { step: 0, summary: "e1:0.7 e2:0.5" };
  const honestStep = { step: 0, summary: "e1:0.5 e2:0.7" };

  test("score = cos(step, wrong) - cos(step, correct); raw mode ties on shared vocabulary", async () => {
    const raw = new DriftMonitor({ embed: mockEmbed, cases: () => [shared], threshold: 0.5, mode: "raw" });
    const con = new DriftMonitor({ embed: mockEmbed, cases: () => [shared], threshold: 0.1, mode: "contrast" });
    const rt = await raw.rawScore(trapStep);
    const rh = await raw.rawScore(honestStep);
    expect(rt.raw).toBeCloseTo(rh.raw, 9); // indistinguishable
    expect((await con.rawScore(trapStep)).raw).toBeCloseTo(0.2, 9);
    expect((await con.rawScore(honestStep)).raw).toBeCloseTo(-0.2, 9);
  });

  test("max over cases picks the nearest case; window and 2-consecutive flag still apply", async () => {
    const other: CaseLike = { id: "d", wrongEmbedding: axis(3), correctEmbedding: axis(4) };
    const m = new DriftMonitor({ embed: mockEmbed, cases: () => [shared, other], threshold: 0.3, mode: "contrast" });
    const a = await m.observe("k", { step: 0, summary: "e1:0.5 e2:0.7" }); // c: -0.2, d: 0
    expect(a.raw).toBeCloseTo(0, 9);
    expect(a.nearestCaseId).toBe("d");
    const b = await m.observe("k", { step: 1, summary: "e3:0.6 e4:0.1" }); // c: 0, d: 0.5
    expect(b.raw).toBeCloseTo(0.5, 9);
    expect(b.score).toBeCloseTo(0.25, 9);
    expect(b.flagged).toBe(false);
    const c = await m.observe("k", { step: 2, summary: "e3:0.6 e4:0.1" });
    expect(c.score).toBeCloseTo(1 / 3, 9);
    expect(c.flagged).toBe(false); // previous score 0.25 < 0.3
    const d = await m.observe("k", { step: 3, summary: "e3:0.6 e4:0.1" });
    expect(d.score).toBeCloseTo(0.5, 9);
    expect(d.flagged).toBe(true); // 0.333 and 0.5 both >= 0.3
    expect(d.trace.map((p) => p.nearestCaseId)).toEqual(["d", "d", "d", "d"]);
  });

  test("embeds wrong/correct texts once (falling back to claim/lesson); skips cases without a pair", async () => {
    const batches: string[][] = [];
    const embed = (t: string[]) => (batches.push(t), mockEmbed(t));
    const cases: CaseLike[] = [
      { id: "x", wrongBehavior: "e1:1", correctBehavior: "e2:1", claim: "ignored", lesson: "ignored" },
      { id: "y", claim: "e3:1", lesson: "e4:1" },
      { id: "z", claim: "e5:1" }, // no lesson -> no pair -> skipped
      { id: "r", wrongBehavior: "e6:1", correctBehavior: "e7:1", revoked: true },
    ];
    const m = new DriftMonitor({ embed, cases: () => cases, threshold: 0.1, mode: "contrast" });
    const o = await m.observe("a", { step: 0, summary: "s", embedding: mockEmbed(["e3:0.8 e4:0.2"])[0]! });
    expect(o.raw).toBeCloseTo(0.6, 9);
    expect(o.nearestCaseId).toBe("y");
    await m.observe("a", { step: 1, summary: "s", embedding: mockEmbed(["e5:1"])[0]! });
    expect(batches).toEqual([["e1:1", "e2:1", "e3:1", "e4:1"]]);
    const none = new DriftMonitor({ embed, cases: () => [{ id: "z", claim: "e5:1" }], threshold: 0.1, mode: "contrast" });
    expect(await none.rawScore({ step: 0, summary: "e5:1" })).toEqual({ raw: 0, nearestCaseId: null });
  });

  test("caseContrastTexts prefers explicit fields, trims, and needs both sides", () => {
    expect(caseContrastTexts({ id: "a", wrongBehavior: " w ", correctBehavior: "c", claim: "x", lesson: "y" })).toEqual({ wrong: "w", correct: "c" });
    expect(caseContrastTexts({ id: "a", claim: "x", lesson: "y" })).toEqual({ wrong: "x", correct: "y" });
    expect(caseContrastTexts({ id: "a", claim: "x", lesson: null })).toBeNull();
    expect(caseContrastTexts({ id: "a", wrongBehavior: " ", lesson: "y" })).toBeNull();
  });
});

describe("confirmDrift (drift alone never retires)", () => {
  const noul = (value: boolean, probability: number): CheckResult => ({
    kind: "noul", value, probability, confidence: Math.max(probability, 1 - probability), decision: value ? "act" : "pass",
    source: "mock", latencyMs: 0, inputTokens: 0, ledger: [],
  });
  const choice = (c: string, confidence: number): CheckResult => ({
    kind: "choice", choice: c, confidence, source: "mock", latencyMs: 0, inputTokens: 0, ledger: [],
  });
  const step = { step: 3, summary: "amounts are cents", claims: ["divide by 100"] };

  test("fact_contradicts_spec true confirms", async () => {
    const asked: string[] = [];
    const check: JevCheckFn = async (q) => (asked.push(q), noul(true, 0.93));
    const r = await confirmDrift({ check, specExcerpt: "always dollars", step, act: 0.85, meta });
    expect(r).toMatchObject({ confirmed: true, questionId: "fact_contradicts_spec", probability: 0.93 });
    expect(asked).toEqual(["fact_contradicts_spec"]);
  });
  test("falls back to failure_category against nearest case", async () => {
    const check: JevCheckFn = async (q, state) => {
      if (q === "failure_category") {
        expect(String(state.evidence)).toContain("Lesson: dollars");
        return choice("spec_misread", 0.9);
      }
      return noul(false, 0.2);
    };
    const r = await confirmDrift({ check, specExcerpt: "x", step, nearestCase: { id: "c", lesson: "dollars" }, act: 0.85, meta });
    expect(r).toMatchObject({ confirmed: true, questionId: "failure_category", choice: "spec_misread" });
  });
  test("'other' or low confidence does not confirm", async () => {
    const check1: JevCheckFn = async (q) => (q === "failure_category" ? choice("other", 0.99) : noul(false, 0.1));
    expect((await confirmDrift({ check: check1, specExcerpt: "x", step, nearestCase: { id: "c" }, act: 0.85, meta })).confirmed).toBe(false);
    const check2: JevCheckFn = async (q) => (q === "failure_category" ? choice("spec_misread", 0.6) : noul(false, 0.1));
    expect((await confirmDrift({ check: check2, specExcerpt: "x", step, nearestCase: { id: "c" }, act: 0.85, meta })).confirmed).toBe(false);
  });
});

describe("calibration", () => {
  const runs = [
    { id: "h1", planted: false, raws: [0.2, 0.5, 0.5, 0.3] }, // windowed: .2 .35 .4 .433
    { id: "h2", planted: false, raws: [0.6, 0.1, 0.1, 0.1] }, // spike, not sustained
    { id: "p1", planted: true, failIndex: 4, raws: [0.2, 0.8, 0.9, 0.9, 0.9] },
    { id: "p2", planted: true, failIndex: 2, raws: [0.2, 0.2, 0.9, 0.9, 0.9] },
    { id: "p3", planted: true, failIndex: 3, raws: [0.1, 0.1, 0.1, 0.1] },
  ];
  test("picks lowest threshold with zero false flags and counts outcomes", () => {
    const r = calibrate(runs);
    // h1 windowed .2 .35 .4 .433 -> best sustained pair min = .4; h2 -> .35; so threshold = .4001
    expect(r.threshold).toBe(0.4001);
    expect(r.falseFlags).toBe(0);
    expect(r.flaggedEarly).toBe(1); // p1 flags at index 2 (< 4)
    expect(r.flaggedLate).toBe(1); // p2 flags at index 3 (>= 2)
    expect(r.missed).toBe(1);
    expect(r.perRun.find((p) => p.id === "p1")!.flagIndex).toBe(2);
  });
  test("a lower threshold produces false flags", () => {
    expect(evaluateThreshold(runs, 0.3).falseFlags).toBeGreaterThan(0);
  });
  test("contrast scores: honest runs all negative give a negative threshold", () => {
    const r = calibrate([
      { id: "h", planted: false, raws: [-0.2, -0.1, -0.1, -0.3] }, // windowed -.2 -.15 -.1333 -.1667
      { id: "p", planted: true, failIndex: 4, raws: [0, 0.2, 0.2, 0.2, 0.2] },
    ]);
    expect(r.threshold).toBe(-0.1499); // just above best sustained pair min(-.15, -.1333)
    expect(r.falseFlags).toBe(0);
    expect(r.flaggedEarly).toBe(1);
  });
});

describe("synthetic seed cases file", () => {
  test("one synthetic case per planted trap across all tasks", async () => {
    const root = join(import.meta.dir, "../../bench");
    const { cases } = await Bun.file(join(root, "tasks-synthetic-cases/cases.json")).json();
    const traps: string[] = [];
    for (const t of ["invoice_parser", "shipping_rates", "discount_engine"]) {
      const task = await Bun.file(join(root, "tasks", t, "task.json")).json();
      traps.push(...task.traps.map((x: { id: string }) => x.id));
    }
    expect(cases.map((c: { trapId: string }) => c.trapId).sort()).toEqual(traps.sort());
    for (const c of cases) {
      expect(c.synthetic).toBe(true);
      expect(c.id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
      expect(caseEvidenceText(c).length).toBeGreaterThan(20);
      // contrast mode needs explicit wrong/correct behavior texts on every seed case
      expect(c.wrongBehavior.length).toBeGreaterThan(20);
      expect(c.correctBehavior.length).toBeGreaterThan(20);
      expect(caseContrastTexts(c)).not.toBeNull();
    }
  });
});
