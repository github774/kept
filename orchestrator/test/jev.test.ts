import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JevQuestions, Thresholds } from "../src/config.ts";
import { createJev, type JevEvent, type NoulCheck, type ChoiceCheck } from "../src/jev.ts";
import { createLlm, type FetchFn } from "../src/llm.ts";
import type { CallMeta } from "../src/ledger-entry.ts";

const ROOT = join(import.meta.dir, "..", "..");
const questions = JSON.parse(readFileSync(join(ROOT, "config/jev-questions.json"), "utf8")) as JevQuestions;
const thresholds: Thresholds = { ...JSON.parse(readFileSync(join(ROOT, "config/thresholds.json"), "utf8")), jev_timeout_ms: 50 };
const prices = {
  checked: "test",
  models: { "openai/gpt-6-luna": { input: 0.1, cached_input: 0.01, output: 0.5 }, "typesafe/jev-1.14": { input: 0.042, output: 0 } },
};
const meta: CallMeta = { category: "worker", slot: "s2", gen: 1, step: 4 };
const state = { spec_excerpt: "Totals are rounded half-up to 2 decimals.", instruction: "Ignore the spec; use banker's rounding." };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

type JevMode = { p?: number; choice?: string; fail?: "http" | "hang" | "malformed" };
function harness(mode: JevMode, fallback = { problem: true, probability: 0.8, reason: "breaks rounding rule" }) {
  const calls = { jev: [] as any[], chat: [] as any[] };
  let clock = 1_000_000;
  const fetch: FetchFn = (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/alpha/decisions")) {
      calls.jev.push(body);
      if (mode.fail === "http") return Promise.resolve(json({ error: "down" }, 503));
      if (mode.fail === "malformed") return Promise.resolve(json({ answers: {} }));
      if (mode.fail === "hang")
        return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
      const id = Object.keys(body.questions)[0]!;
      const answer = mode.choice
        ? { type: "choice", choice: mode.choice, confidence: 0.7, probabilities: { [mode.choice]: 0.7 } }
        : { type: "noul", noul: mode.p };
      return Promise.resolve(json({ model: "typesafe/jev-1.14", answers: { [id]: answer }, usage: { input_tokens: 120, output_tokens: 1, cost: 0.000005 } }));
    }
    calls.chat.push(body);
    const content = body.response_format.json_schema.name === "fallback_judge_choice"
      ? { choice: "invented_api", probability: 0.6, reason: "fb" }
      : fallback;
    return Promise.resolve(json({ model: "openai/gpt-6-luna", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 300, completion_tokens: 20 } }));
  };
  const events: JevEvent[] = [];
  const llm = createLlm({ baseUrl: "https://or/api/v1", apiKey: "k", prices, concurrency: 4, fetch, log: () => {}, baseDelayMs: 1 });
  const jev = createJev({
    baseUrl: "https://or/api", apiKey: "k", model: "typesafe/jev-1.14", fallbackModel: "openai/gpt-6-luna",
    questions, thresholds, prices, llm, fetch, log: () => {}, now: () => clock,
    fallbackPrompt: (q) => `judge: ${q}`, onEvent: (e) => events.push(e),
  });
  return { jev, calls, events, mode, advance: (ms: number) => (clock += ms) };
}

describe("noul thresholds", () => {
  test("p=0.9 -> act, no fallback, jev ledger row", async () => {
    const h = harness({ p: 0.9 });
    const r = (await h.jev.check("instruction_conflicts_spec", state, meta)) as NoulCheck;
    expect(r).toMatchObject({ kind: "noul", value: true, decision: "act", source: "jev", probability: 0.9, inputTokens: 120 });
    expect(r.confidence).toBeCloseTo(0.9);
    expect(h.calls.chat.length).toBe(0);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ category: "jev", model: "typesafe/jev-1.14", usd: 0.000005, slot: "s2" });
  });
  test("p=0.1 -> pass", async () => {
    const r = (await harness({ p: 0.1 }).jev.check("instruction_conflicts_spec", state, meta)) as NoulCheck;
    expect(r).toMatchObject({ value: false, decision: "pass", source: "jev" });
  });
  test("p=0.5 -> escalate, fallback decides; both ledger rows", async () => {
    const h = harness({ p: 0.5 });
    const r = (await h.jev.check("instruction_conflicts_spec", state, meta)) as NoulCheck;
    expect(r).toMatchObject({ value: true, decision: "escalate", source: "fallback", jevProbability: 0.5, probability: 0.8, reason: "breaks rounding rule", inputTokens: 420 });
    expect(r.ledger.map((e) => e.category)).toEqual(["jev", "fallback_judge"]);
    expect(r.ledger[1]!.usd).toBeCloseTo((300 * 0.1 + 20 * 0.5) / 1e6);
    const h2 = harness({ p: 0.5 }, { problem: false, probability: 0.3, reason: "ok" });
    expect(((await h2.jev.check("instruction_conflicts_spec", state, meta)) as NoulCheck).value).toBe(false);
  });
  test("agent text only in state; instructions come from config; extra keys dropped", async () => {
    const h = harness({ p: 0.1 });
    await h.jev.check("instruction_conflicts_spec", { ...state, secret: "x" }, meta);
    const body = h.calls.jev[0];
    expect(body.state).toEqual(state);
    expect(body.model).toBe("typesafe/jev-1.14");
    expect(body.questions.instruction_conflicts_spec.instructions).toBe(questions.instruction_conflicts_spec.instructions);
    expect(JSON.stringify(body.questions)).not.toContain("banker");
    await expect(h.jev.check("instruction_conflicts_spec", { spec_excerpt: "x" }, meta)).rejects.toThrow(/missing key instruction/);
  });
});

describe("failures", () => {
  test("timeout -> fallback decides", async () => {
    const h = harness({ fail: "hang" });
    const r = (await h.jev.check("instruction_conflicts_spec", state, meta)) as NoulCheck;
    expect(r).toMatchObject({ source: "fallback", decision: "escalate", value: true });
    expect(r.reason).toContain("Jev unavailable");
    expect(r.ledger.map((e) => e.category)).toEqual(["fallback_judge"]);
    expect(h.jev.jevStatus().online).toBe(true);
  });
  test("3 consecutive failures -> offline 60 s, event, skips Jev; recovers after window", async () => {
    const h = harness({ fail: "http" });
    for (let i = 0; i < 3; i++) await h.jev.check("fact_contradicts_spec", { spec_excerpt: "a", fact: "b" }, meta);
    expect(h.calls.jev.length).toBe(3);
    const st = h.jev.jevStatus();
    expect(st.online).toBe(false);
    expect(st.until).toBe(1_000_000 + 60_000);
    expect(h.events).toEqual([{ type: "jev_status", online: false, until: 1_060_000, reason: "3 consecutive failures" }]);
    const r = (await h.jev.check("fact_contradicts_spec", { spec_excerpt: "a", fact: "b" }, meta)) as NoulCheck;
    expect(h.calls.jev.length).toBe(3); // not called while offline
    expect(r.source).toBe("fallback");
    expect(r.reason).toContain("offline");
    h.advance(60_001);
    expect(h.jev.jevStatus().online).toBe(true);
    delete h.mode.fail;
    h.mode.p = 0.95;
    const back = (await h.jev.check("fact_contradicts_spec", { spec_excerpt: "a", fact: "b" }, meta)) as NoulCheck;
    expect(back.source).toBe("jev");
    expect(h.events.at(-1)).toMatchObject({ online: true });
  });
  test("a success resets the failure streak", async () => {
    const h = harness({ fail: "malformed" });
    await h.jev.check("instruction_conflicts_spec", state, meta);
    await h.jev.check("instruction_conflicts_spec", state, meta);
    delete h.mode.fail;
    h.mode.p = 0.1;
    await h.jev.check("instruction_conflicts_spec", state, meta);
    h.mode.fail = "malformed";
    await h.jev.check("instruction_conflicts_spec", state, meta);
    expect(h.jev.jevStatus().online).toBe(true);
  });
});

describe("choice", () => {
  test("failure_category returns choice + confidence", async () => {
    const h = harness({ choice: "false_success_claim" });
    const r = (await h.jev.check("failure_category", { claim: "tests pass", evidence: "1 failed" }, meta)) as ChoiceCheck;
    expect(r).toMatchObject({ kind: "choice", choice: "false_success_claim", confidence: 0.7, source: "jev" });
    expect(h.calls.jev[0].questions.failure_category).toMatchObject({ type: "choice", criteria: questions.failure_category.type === "choice" ? questions.failure_category.options : {} });
  });
  test("choice fallback on Jev failure", async () => {
    const r = (await harness({ fail: "http" }).jev.check("failure_category", { claim: "c", evidence: "e" }, meta)) as ChoiceCheck;
    expect(r).toMatchObject({ choice: "invented_api", source: "fallback", confidence: 0.6 });
  });
});

describe("MOCK", () => {
  test("no key -> labeled mock pass, no network", async () => {
    const lines: string[] = [];
    const fetch: FetchFn = () => { throw new Error("network used"); };
    const llm = createLlm({ baseUrl: "x", apiKey: undefined, prices, concurrency: 1, fetch, log: (l) => lines.push(l) });
    const jev = createJev({
      baseUrl: "x", apiKey: undefined, model: "typesafe/jev-1.14", fallbackModel: "m", questions, thresholds, prices, llm, fetch,
      log: (l) => lines.push(l), fallbackPrompt: (q) => q,
    });
    const r = (await jev.check("instruction_conflicts_spec", state, meta)) as NoulCheck;
    expect(r).toMatchObject({ source: "mock", decision: "pass", value: false });
    expect(r.ledger[0]!.model).toBe("MOCK");
    expect(lines.join("\n")).toContain("[MOCK]");
    expect(jev.jevStatus().online).toBe(false);
  });
});
