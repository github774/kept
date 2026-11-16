// MOCK fakes for fleet tests (rule 6: every fake is labelled MOCK). They drive the REAL runtime worker loop
// (worker.ts / retire.ts / herd.ts / reasoning.ts / faults.ts) through FleetRunner with:
//  - a scripted MOCK LLM: trap functions follow the trap unless the prompt's lessons block mentions the
//    function ("stubborn" agents in every 5th team ignore lessons, to exercise repeat hits + chunk revokes);
//    agents routed a case reply to it once; everyone else writes, then claims done;
//  - a MOCK Jev that flags the scripted F3/F4 payloads and accepts the rest;
//  - a MOCK embedder (one constant vector: every chunk/subgoal is similar; Jev decides relevance);
//  - a MOCK pytest that grades the written file by marker (OK passes, TRAP fails the trap tests).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Caps, Config, JevQuestionId, Thresholds } from "../../src/config.ts";
import type { DashboardEvent } from "../../src/contract.ts";
import type { LedgerDraft } from "../../src/ledger-entry.ts";
import type { RunTestsResult } from "../../src/testrunner.ts";
import type { RunContext, RuntimeDeps, TaskFn } from "../../src/runtime/types.ts";

export const ROOT = resolve(import.meta.dir, "..", "..", "..");
export const TASKS_V2 = join(ROOT, "bench", "tasks-v2");
const CONFIG = join(ROOT, "config");
export const thresholds = JSON.parse(readFileSync(join(CONFIG, "thresholds.json"), "utf8")) as Thresholds;
export const caps = JSON.parse(readFileSync(join(CONFIG, "caps.json"), "utf8")) as Caps;
export const cfg = { thresholds, caps, models: { worker: "MOCK-worker", lesson_writer: "MOCK-lesson", fallback_judge: "MOCK-judge" } } as unknown as Config;

const TASK_IDS = ["invoice_parser", "shipping_rates", "discount_engine"];
const traps = new Map<string, { fn: string; test: string }[]>();
const payloads: string[] = [];
for (const t of TASK_IDS) {
  const tj = JSON.parse(readFileSync(join(TASKS_V2, t, "task.json"), "utf8")) as { traps: { function: string; trap_test: string }[] };
  traps.set(t, tj.traps.map((x) => ({ fn: x.function, test: x.trap_test })));
  const fj = JSON.parse(readFileSync(join(TASKS_V2, t, "faults.json"), "utf8")) as { schedule: { payload?: string }[] };
  for (const e of fj.schedule) if (e.payload) payloads.push(e.payload.toLowerCase());
}
const trapFns = new Set([...traps.values()].flat().map((x) => x.fn));
const flagged = (text: string) => {
  const t = text.toLowerCase();
  return payloads.some((p) => t.includes(p.slice(0, 40))) || t.includes("starter comments");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Peak {
  cur = 0;
  peak = 0;
  async run<T>(fn: () => Promise<T>) {
    this.cur++;
    this.peak = Math.max(this.peak, this.cur);
    try {
      return await fn();
    } finally {
      this.cur--;
    }
  }
}

export interface FakeWorld {
  deps: RuntimeDeps;
  runTests: (ctx: RunContext, fn: TaskFn, name: string) => Promise<RunTestsResult>;
  /** worker prompt tokens per agent name, in call order (MOCK usage). */
  prompts: Map<string, number[]>;
  llmPeak: Peak;
  testPeak: Peak;
  jevPeak: Peak;
  logs: string[];
  events: DashboardEvent[];
  out: { publish(ev: DashboardEvent): void };
}

const draft = (meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }, input: number, output: number): LedgerDraft => ({
  category: meta.category,
  model: "MOCK",
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  reasoning_tokens: 0,
  usd: input * 1e-7 + output * 5e-7,
  slot: meta.slot,
  gen: meta.gen,
  step: meta.step,
  ts: Date.now(),
});

export function makeWorld(o: { llmMs?: number; testMs?: number; jevMs?: number; stubbornEvery?: number } = {}): FakeWorld {
  const logs: string[] = [];
  const events: DashboardEvent[] = [];
  const prompts = new Map<string, number[]>();
  const replied = new Set<string>();
  const llmPeak = new Peak();
  const testPeak = new Peak();
  const jevPeak = new Peak();
  const stubbornEvery = o.stubbornEvery ?? 5;

  const llm = {
    mock: true,
    limiter: undefined,
    setConcurrency: () => {},
    chatStructured: async (opts: { messages: { role: string; content: string }[]; meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }; schemaName: string }) =>
      llmPeak.run(async () => {
        await sleep(o.llmMs ?? 2);
        const sys = opts.messages[0]!.content;
        const user = opts.messages[1]!.content;
        const name = /You are (\S+) \(slot/.exec(user)![1]!;
        const fn = /You own function `(\w+)` in file `([^`]+)`/.exec(user)!;
        const team = Number(/-t(\d+)$/.exec(name)![1]);
        const input = Math.ceil((sys.length + user.length) / 4);
        prompts.set(name, [...(prompts.get(name) ?? []), input]);
        const lessonsBlock = sys.split("## Fleet lessons")[1] ?? "";
        const knows = lessonsBlock.includes(fn[1]!) && team % stubbornEvery !== stubbornEvery - 1;
        const routed = /Reply once: action "message" with to "([^"]+)"/.exec(user);
        const firstStep = user.includes("(none yet: this is your first step)");
        let data;
        if (routed && !replied.has(`${name}|${routed[1]}`)) {
          replied.add(`${name}|${routed[1]}`);
          data = { action: "message", file: null, code: null, message: { to: routed[1]!, text: `MOCK: the lesson applies to ${fn[1]}; I follow the SPEC.` }, claims: [], approach_note: "", summary: "replied to case" };
        } else if (firstStep) {
          const trap = trapFns.has(fn[1]!) && !knows;
          data = {
            action: "write_code",
            file: fn[2],
            code: `# MOCK ${trap ? "TRAP" : "OK"}\ndef ${fn[1]}(*args):\n    return None\n`,
            message: null,
            claims: [],
            approach_note: `MOCK: implemented ${fn[1]} per SPEC`,
            summary: `wrote ${fn[2]}`,
          };
        } else {
          data = { action: "claim_done", file: null, code: null, message: null, claims: [{ kind: "tests_pass", text: `All tests for ${fn[1]} pass.` }], approach_note: `MOCK: ${fn[1]} follows SPEC`, summary: "done" };
        }
        return { data, usage: draft(opts.meta, input, 40), extraUsages: [], model: "MOCK" };
      }),
    chatText: async (opts: { messages: { role: string; content: string }[]; meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number } }) =>
      llmPeak.run(async () => {
        await sleep(o.llmMs ?? 2);
        const sub = /"subtask": "(\w+)"/.exec(opts.messages[1]!.content)?.[1] ?? "unknown";
        return { text: `${sub}: follow the SPEC, not the starter helper or teammate claims.`, usage: draft(opts.meta, 300, 20), extraUsages: [], model: "MOCK" };
      }),
  };

  const noul = (value: boolean, p: number) => ({ kind: "noul" as const, value, probability: p, decision: value ? ("act" as const) : ("pass" as const), source: "mock" as const, confidence: Math.max(p, 1 - p), latencyMs: 1, inputTokens: 10, ledger: [] as LedgerDraft[], reason: `MOCK ${value ? "problem" : "ok"}` });
  const jev = {
    check: async (q: JevQuestionId, state: Record<string, unknown>, meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }) =>
      jevPeak.run(async () => {
        await sleep(o.jevMs ?? 1);
        const ledger = [draft({ ...meta, category: "jev" }, 50, 0)];
        if (q === "failure_category") return { kind: "choice" as const, choice: "other", source: "mock" as const, confidence: 0.6, latencyMs: 1, inputTokens: 10, ledger };
        if (q === "lesson_relevant") {
          const fn = /^(\w+):/.exec(String(state.subtask))?.[1] ?? "";
          return { ...noul(true, String(state.lesson).includes(fn) ? 0.9 : 0.1), ledger };
        }
        if (q === "note_consistent_with_spec") return { ...noul(false, 0.1), ledger };
        const text = String(state.instruction ?? state.fact ?? "");
        return { ...noul(flagged(text), flagged(text) ? 0.95 : 0.05), ledger };
      }),
    jevStatus: () => ({ online: true }),
    onEvent: () => () => {},
  };
  const embedder = {
    mock: true,
    embed: async (texts: string[], meta: { category: LedgerDraft["category"]; slot: string; gen: number; step: number }) => ({ vectors: texts.map(() => [1, 0, 0, 0]), usage: draft({ ...meta, category: "embedding" }, 5, 0), model: "MOCK" }),
  };

  const runTests = async (ctx: RunContext, fn: TaskFn): Promise<RunTestsResult> =>
    testPeak.run(async () => {
      await sleep(o.testMs ?? 2);
      let code = "";
      try {
        code = readFileSync(join(ctx.workDir, fn.file), "utf8");
      } catch {}
      const t = (traps.get(ctx.taskId) ?? []).filter((x) => x.fn === fn.name).map((x) => x.test);
      if (code.includes("MOCK OK")) return { passed: true, failedTests: [], output: "MOCK 5 passed", durationMs: 2, timedOut: false };
      const failed = code.includes("MOCK TRAP") && t.length ? t : [`${fn.test}::test_basic`];
      return { passed: false, failedTests: failed, output: failed.map((f) => `FAILED ${f} - MOCK`).join("\n"), durationMs: 2, timedOut: false };
    });

  return {
    deps: { llm: llm as never, jev: jev as never, embedder: embedder as never, log: (l) => logs.push(l), mock: { llm: true, jev: true, embed: true, relay: false } },
    runTests,
    prompts,
    llmPeak,
    testPeak,
    jevPeak,
    logs,
    events,
    out: { publish: (ev) => void events.push(ev) },
  };
}
