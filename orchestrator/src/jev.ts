// Jev adapter (BUILD_SPEC "Verification"): OpenRouter POST /alpha/decisions, 2 s timeout,
// middle band escalates to the fallback LLM judge, 3 failures in a row => fallback-only for 60 s.
// Agent text goes only into `state` (as quoted string fields), never into instructions.
import type { JevQuestion, JevQuestionId, JevQuestions, Prices, Thresholds } from "./config.ts";
import { fromChatUsage, mockDraft, toDraft, type CallMeta, type LedgerDraft, type RawUsage } from "./ledger-entry.ts";
import { StepFailed, type FetchFn, type Llm } from "./llm.ts";

export type JevSource = "jev" | "fallback" | "mock";
/**
 * Routing outcome. 'act'/'pass' = Jev was confident; 'escalate' = Jev unsure or unavailable and the
 * fallback judge decided. In every case `value` is the final verdict (true = problem found).
 */
export type JevDecision = "act" | "escalate" | "pass";

interface CheckBase {
  source: JevSource;
  confidence: number;
  reason?: string;
  latencyMs: number;
  /** Input tokens across every call this check made (Jev + fallback). */
  inputTokens: number;
  /** One draft per API call made; all belong in the ledger. */
  ledger: LedgerDraft[];
}
export interface NoulCheck extends CheckBase {
  kind: "noul";
  value: boolean;
  /** P(problem) of whichever judge decided. */
  probability: number;
  /** Jev's P(problem) when Jev answered. */
  jevProbability?: number;
  decision: JevDecision;
}
export interface ChoiceCheck extends CheckBase {
  kind: "choice";
  choice: string;
  probabilities?: Record<string, number>;
}
export type CheckResult = NoulCheck | ChoiceCheck;

export interface JevStatus {
  online: boolean;
  until?: number;
}
export type JevEvent = { type: "jev_status"; online: boolean; until?: number; reason: string };

export interface FallbackVerdict {
  problem: boolean;
  probability: number;
  reason: string;
}

export interface JevDeps {
  baseUrl: string;
  /** undefined => MOCK (labeled). Never logged. */
  apiKey: string | undefined;
  model: string;
  fallbackModel: string;
  questions: JevQuestions;
  thresholds: Thresholds;
  prices: Prices;
  llm: Llm;
  /** Builds the fallback judge system prompt (prompts/fallback_judge.md) for a question. */
  fallbackPrompt: (question: string) => string;
  fetch?: FetchFn;
  now?: () => number;
  log?: (line: string) => void;
  onEvent?: (e: JevEvent) => void;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, { type?: string; noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  usage?: RawUsage;
}

const FALLBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["problem", "probability", "reason"],
  properties: {
    problem: { type: "boolean" },
    probability: { type: "number" },
    reason: { type: "string" },
  },
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const confidenceOf = (p: number) => Math.max(p, 1 - p);

export function createJev(deps: JevDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const fetchFn = deps.fetch ?? ((u, i) => fetch(u, i));
  const url = `${deps.baseUrl.replace(/\/$/, "")}/alpha/decisions`;
  const t = deps.thresholds;
  let failures = 0;
  let offlineUntil: number | undefined;
  let announcedOffline = false;
  const listeners = new Set<(e: JevEvent) => void>(deps.onEvent ? [deps.onEvent] : []);

  const emit = (e: JevEvent) => {
    log(`[jev] ${e.online ? "online" : `OFFLINE until ${new Date(e.until ?? 0).toISOString()}, using fallback`}: ${e.reason}`);
    for (const l of listeners) l(e);
  };

  function jevStatus(): JevStatus {
    if (!deps.apiKey) return { online: false };
    return offlineUntil !== undefined && now() < offlineUntil ? { online: false, until: offlineUntil } : { online: true };
  }

  /** Keeps only the question's declared state keys; values become quoted strings. */
  function buildState(q: JevQuestion, id: string, state: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of q.state_keys) {
      const v = state[k];
      if (v === undefined || v === null) throw new Error(`jev ${id}: state missing key ${k}`);
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  }

  async function callJev(id: string, q: JevQuestion, state: Record<string, string>, meta: CallMeta, signal?: AbortSignal) {
    const question =
      q.type === "noul"
        ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
        : { type: "choice", instructions: q.instructions, criteria: q.options };
    const timeout = AbortSignal.timeout(t.jev_timeout_ms);
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({ model: deps.model, state, questions: { [id]: question } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json()) as JevResponse;
    const answer = body.answers?.[id];
    if (!answer) throw new Error(`no answer for ${id}`);
    const model = body.model ?? deps.model;
    const usage = toDraft(fromChatUsage(body.usage, model, deps.prices, deps.model), { ...meta, category: "jev" });
    return { answer, usage };
  }

  async function fallbackNoul(q: JevQuestion & { type: "noul" }, state: Record<string, string>, meta: CallMeta, signal?: AbortSignal) {
    const question = `${q.instructions} problem=true means: ${q.criteria.true} problem=false means: ${q.criteria.false}`;
    const r = await deps.llm.chatStructured<FallbackVerdict>({
      model: deps.fallbackModel,
      schemaName: "fallback_judge",
      schema: FALLBACK_SCHEMA,
      messages: [
        { role: "system", content: deps.fallbackPrompt(question) },
        { role: "user", content: JSON.stringify(state) },
      ],
      meta: { ...meta, category: "fallback_judge" },
      signal,
    });
    return { verdict: r.data, ledger: [...r.extraUsages, r.usage], mock: r.model === "MOCK" };
  }

  async function fallbackChoice(q: JevQuestion & { type: "choice" }, state: Record<string, string>, meta: CallMeta, signal?: AbortSignal) {
    const ids = Object.keys(q.options);
    const opts = Object.entries(q.options).map(([k, v]) => `${k}: ${v}`).join("; ");
    const question = `${q.instructions} Options: ${opts}. Instead of problem, return choice (one option id) with its probability.`;
    const r = await deps.llm.chatStructured<{ choice: string; probability: number; reason: string }>({
      model: deps.fallbackModel,
      schemaName: "fallback_judge_choice",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["choice", "probability", "reason"],
        properties: { choice: { type: "string", enum: ids }, probability: { type: "number" }, reason: { type: "string" } },
      },
      messages: [
        { role: "system", content: deps.fallbackPrompt(question) },
        { role: "user", content: JSON.stringify(state) },
      ],
      meta: { ...meta, category: "fallback_judge" },
      signal,
    });
    return { data: r.data, ledger: [...r.extraUsages, r.usage], mock: r.model === "MOCK" };
  }

  function recordFailure(err: unknown) {
    failures++;
    log(`[jev] call failed (${failures} in a row): ${err instanceof Error ? err.message : String(err)}`);
    if (failures >= t.jev_fail_switch) {
      offlineUntil = now() + t.jev_fallback_window_ms;
      failures = 0;
      announcedOffline = true;
      emit({ type: "jev_status", online: false, until: offlineUntil, reason: `${t.jev_fail_switch} consecutive failures` });
    }
  }
  function recordSuccess() {
    failures = 0;
    if (announcedOffline) {
      announcedOffline = false;
      offlineUntil = undefined;
      emit({ type: "jev_status", online: true, reason: "Jev answered after offline window" });
    }
  }

  async function check(questionId: JevQuestionId, rawState: Record<string, unknown>, meta: CallMeta, signal?: AbortSignal): Promise<CheckResult> {
    const q = deps.questions[questionId];
    const state = buildState(q, questionId, rawState);
    const started = now();
    const ledger: LedgerDraft[] = [];
    const tokens = () => ledger.reduce((s, e) => s + e.input_tokens, 0);
    const done = <R extends CheckResult>(r: Omit<R, "latencyMs" | "inputTokens" | "ledger">): R =>
      ({ ...r, latencyMs: now() - started, inputTokens: tokens(), ledger }) as R;

    if (!deps.apiKey) {
      log(`[MOCK] jev ${questionId}: no OPENROUTER_API_KEY; returning pass`);
      ledger.push(mockDraft({ ...meta, category: "jev" }));
      const reason = "[MOCK] Jev not called (no OPENROUTER_API_KEY)";
      return q.type === "noul"
        ? done<NoulCheck>({ kind: "noul", value: false, probability: 0, decision: "pass", source: "mock", confidence: 0, reason })
        : done<ChoiceCheck>({ kind: "choice", choice: "other" in q.options ? "other" : Object.keys(q.options)[0]!, source: "mock", confidence: 0, reason });
    }

    let jevReason: string | undefined;
    if (jevStatus().online) {
      try {
        const { answer, usage } = await callJev(questionId, q, state, meta, signal);
        ledger.push(usage);
        if (q.type === "noul") {
          if (typeof answer.noul !== "number") throw new Error(`malformed noul answer for ${questionId}`);
          recordSuccess();
          const p = clamp01(answer.noul);
          if (p >= t.act) return done<NoulCheck>({ kind: "noul", value: true, probability: p, jevProbability: p, decision: "act", source: "jev", confidence: confidenceOf(p) });
          if (p < t.pass) return done<NoulCheck>({ kind: "noul", value: false, probability: p, jevProbability: p, decision: "pass", source: "jev", confidence: confidenceOf(p) });
          const fb = await fallbackNoul(q, state, meta, signal);
          ledger.push(...fb.ledger);
          const fp = clamp01(fb.verdict.probability);
          return done<NoulCheck>({
            kind: "noul", value: fb.verdict.problem, probability: fp, jevProbability: p, decision: "escalate",
            source: fb.mock ? "mock" : "fallback", confidence: confidenceOf(fp), reason: fb.verdict.reason,
          });
        }
        if (typeof answer.choice !== "string") throw new Error(`malformed choice answer for ${questionId}`);
        recordSuccess();
        return done<ChoiceCheck>({
          kind: "choice", choice: answer.choice, confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0,
          probabilities: answer.probabilities, source: "jev",
        });
      } catch (e) {
        if (e instanceof StepFailed || signal?.aborted) throw e; // fallback-judge failure or caller abort: not Jev's fault
        recordFailure(e);
        jevReason = `Jev unavailable (${e instanceof Error ? e.message : String(e)})`;
      }
    } else {
      jevReason = "Jev offline window; using fallback";
    }

    if (q.type === "noul") {
      const fb = await fallbackNoul(q, state, meta, signal);
      ledger.push(...fb.ledger);
      const fp = clamp01(fb.verdict.probability);
      return done<NoulCheck>({
        kind: "noul", value: fb.verdict.problem, probability: fp, decision: "escalate",
        source: fb.mock ? "mock" : "fallback", confidence: confidenceOf(fp), reason: `${jevReason}. ${fb.verdict.reason}`,
      });
    }
    const fb = await fallbackChoice(q, state, meta, signal);
    ledger.push(...fb.ledger);
    return done<ChoiceCheck>({
      kind: "choice", choice: fb.data.choice, confidence: clamp01(fb.data.probability),
      source: fb.mock ? "mock" : "fallback", reason: `${jevReason}. ${fb.data.reason}`,
    });
  }

  return {
    check,
    jevStatus,
    onEvent(fn: (e: JevEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
export type Jev = ReturnType<typeof createJev>;

let defaultJev: Promise<Jev> | undefined;
export function getJev(): Promise<Jev> {
  defaultJev ??= Promise.all([import("./config.ts"), import("./llm.ts")]).then(async ([c, { getLlm }]) =>
    createJev({
      baseUrl: c.config.env.jevBaseUrl,
      apiKey: c.config.env.openrouterApiKey,
      model: c.config.models.jev.model,
      fallbackModel: c.config.models.fallback_judge,
      questions: c.config.jevQuestions,
      thresholds: c.config.thresholds,
      prices: c.config.prices,
      llm: await getLlm(),
      fallbackPrompt: (question) => c.loadPrompt("fallback_judge", { question }),
    }),
  );
  return defaultJev;
}

export async function check(questionId: JevQuestionId, state: Record<string, unknown>, meta: CallMeta, signal?: AbortSignal): Promise<CheckResult> {
  return (await getJev()).check(questionId, state, meta, signal);
}
export async function jevStatus(): Promise<JevStatus> {
  return (await getJev()).jevStatus();
}
