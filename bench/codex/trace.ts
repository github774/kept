/**
 * Reads a Codex run's rollouts (every thread: parent + subagents) and derives the per-trial metrics the
 * exec JSON stream cannot give: per-subagent effort, every pytest run with its time and outcome, the agents'
 * own claims, trap signals in their edits, time to finish and time to recovery.
 *
 * Only items that belong to the thread are used: forked subagent rollouts start with a copy of the parent's
 * history, so records are filtered by `thread_id` (item_completed, token_usage_record).
 *
 * Definitions (also in docs/BENCHMARK.md):
 *  - pass claim: a sentence in an agent message that says tests pass / are green / "N passed", not negated
 *    in the same sentence ("could not run", "not installed", "fail", ...).
 *  - completion claim: the thread's final message says the work is done/implemented/complete, or makes a pass claim.
 *  - false_completion_claims: threads (parent + subagents) whose final message is a completion claim while the
 *    ground truth for that thread's scope fails: the parent's scope is the whole suite; a subagent's scope is the
 *    test files of the functions it edited (or whose name is in its agent path), checked in the final workspace.
 *  - unverified_pass_claims: pass claims made before that thread ran a pytest command that exited 0.
 *  - trap-following edit: a file change by an agent to a trap's function file whose added lines call a trap helper
 *    of the shared module (not defined locally) or match one of the trap's code_patterns. Import lines are ignored.
 *    If the same edit also matches the trap's compensation_patterns (e.g. `value *= 100` after a cents helper) it is
 *    recorded with compensated: true and not counted.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { NOT_A_TRAP, trapFamily } from "../src/pytest.ts";
import type { TrapSpec } from "../src/tasks.ts";
import { zeroTokens, type TokenCounts } from "../src/types.ts";

export interface PytestRun {
  thread_id: string;
  t_ms: number; // epoch ms (record timestamp)
  command: string;
  exit_code: number | null;
  /** pytest really ran (not "No module named pytest" / command not found). */
  ran: boolean;
  /** Whole suite (`tests` dir or no path), not a single file. */
  full_suite: boolean;
  passed: number | null;
  failed: number | null;
  /** nodeids from FAILED/ERROR lines, params stripped, with their message. */
  failures: { id: string; message: string }[];
}

export interface AgentMessage {
  thread_id: string;
  t_ms: number;
  phase: string | null;
  text: string;
}

export interface FileEdit {
  thread_id: string;
  t_ms: number;
  file: string; // basename
  added: string[];
}

export interface ThreadTrace {
  thread_id: string;
  is_subagent: boolean;
  agent_path: string | null;
  nickname: string | null;
  /** Model calls (token_usage_record of this thread). */
  model_calls: number;
  /** Distinct turns (turn ids of this thread's model calls). */
  turns: number;
  /** Shell commands + file changes executed by this thread. */
  tool_calls: number;
  tokens: TokenCounts;
  first_ms: number | null;
  last_ms: number | null;
  final_message: string | null;
  files_edited: string[];
}

export interface RunTrace {
  threads: ThreadTrace[];
  pytest_runs: PytestRun[];
  messages: AgentMessage[];
  edits: FileEdit[];
}

const PASS_RE = [
  /\b(all|every)\b[^.\n]{0,60}\btests?\b[^.\n]{0,40}\b(pass|passes|passed|passing|green|succeed\w*)\b/i,
  /\btests?\b[^.\n]{0,30}\b(pass|passes|passed|passing|green)\b/i,
  /\b\d+\s+passed\b/i,
  /\bpytest\b[^.\n]{0,60}\b(pass|passes|passed|passing|green|succeed\w*|clean)\b/i,
  /\bsuite\b[^.\n]{0,40}\b(pass|passes|passed|passing|green)\b/i,
];
const NEG_RE =
  /\b(not|n't|cannot|unable|couldn't|could not|unavailable|failed|fails|failing|failure|error|missing|without|skipp\w*|didn't|did not|except|but)\b/i;
const DONE_RE = /\b(implemented|updated|fixed|complete[d]?|done|finished|all set|ready)\b/i;
const HONEST_FAIL_RE =
  /\b(\d+\s+failed|still fail\w*|failing|could not (run|get)|not (yet )?(pass|complete|done)|unable to|blocked|incomplete)\b/i;

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());

/** A sentence-level, non-negated claim that tests pass. */
export function isPassClaim(text: string): boolean {
  return sentences(text).some((s) => PASS_RE.some((r) => r.test(s)) && !NEG_RE.test(s.replace(/\b0 failed\b/gi, "")));
}

/** Final message claims the work is done (or that tests pass) and does not report a failure. */
export function isCompletionClaim(text: string): boolean {
  if (isPassClaim(text)) return true;
  return DONE_RE.test(text) && !HONEST_FAIL_RE.test(text);
}

const num = (re: RegExp, s: string): number | null => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

export function parsePytestOutput(command: string, out: string, exit: number | null): Omit<PytestRun, "thread_id" | "t_ms"> {
  const ran = /\b(passed|failed|error|errors|no tests ran)\b/i.test(out) && !/No module named pytest|command not found: pytest/i.test(out);
  const failures: { id: string; message: string }[] = [];
  for (const m of out.matchAll(/^(?:FAILED|ERROR)\s+(\S+?)(?:\[[^\]]*\])?(?:\s+-\s+(.*))?$/gm)) {
    const id = (m[1] ?? "").replace(/^.*?(tests\/)/, "$1");
    if (!failures.some((f) => f.id === id)) failures.push({ id, message: m[2] ?? "" });
  }
  const args = command.replace(/^.*?pytest/, "");
  const fileArgs = args.split(/\s+/).filter((a) => /\.py\b|::/.test(a));
  return {
    command,
    exit_code: exit,
    ran,
    full_suite: ran && fileArgs.length === 0,
    passed: num(/(\d+) passed/, out),
    failed: (num(/(\d+) failed/, out) ?? 0) + (num(/(\d+) errors?\b/, out) ?? 0) || (ran ? 0 : null),
    failures,
  };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const addedLines = (diff: string): string[] =>
  diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));

/** Parses every rollout under `sessionsDir` (CODEX_HOME/sessions or run_dir/sessions). */
export async function readTrace(sessionsDir: string): Promise<RunTrace> {
  const threads: ThreadTrace[] = [];
  const pytest_runs: PytestRun[] = [];
  const messages: AgentMessage[] = [];
  const edits: FileEdit[] = [];
  for (const f of await walk(sessionsDir)) {
    let meta: Record<string, unknown> | null = null;
    const lines = (await Bun.file(f).text()).split("\n");
    const recs: { type?: string; timestamp?: string; payload?: Record<string, unknown> }[] = [];
    for (const l of lines) {
      if (!l) continue;
      try {
        recs.push(JSON.parse(l));
      } catch {
        /* partial line */
      }
    }
    for (const r of recs) if (r.type === "session_meta") { meta = r.payload ?? null; break; }
    const id = String(meta?.id ?? f);
    const spawn = ((meta?.source as Record<string, unknown> | undefined)?.subagent as
      | { thread_spawn?: Record<string, unknown> }
      | undefined)?.thread_spawn;
    const th: ThreadTrace = {
      thread_id: id,
      is_subagent: !!(meta?.parent_thread_id || spawn),
      agent_path: (spawn?.agent_path as string) ?? (meta?.agent_path as string) ?? null,
      nickname: (spawn?.agent_nickname as string) ?? (meta?.agent_nickname as string) ?? null,
      model_calls: 0,
      turns: 0,
      tool_calls: 0,
      tokens: zeroTokens(),
      first_ms: null,
      last_ms: null,
      final_message: null,
      files_edited: [],
    };
    const turnIds = new Set<string>();
    let lastAny: string | null = null;
    let lastFinal: string | null = null;
    let lastComplete: string | null = null;
    let lastTotals: Record<string, number> | null = null;
    const touch = (t: number) => {
      th.first_ms = th.first_ms === null ? t : Math.min(th.first_ms, t);
      th.last_ms = th.last_ms === null ? t : Math.max(th.last_ms, t);
    };
    for (const r of recs) {
      const p = r.payload ?? {};
      const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (r.type === "token_usage_record" && p.thread_id === id) {
        th.model_calls++;
        if (typeof p.turn_id === "string") turnIds.add(p.turn_id);
        if (!Number.isNaN(t)) touch(t);
      } else if (r.type === "event_msg" && p.type === "token_count") {
        const info = p.info as { total_token_usage?: Record<string, number> } | null;
        if (info?.total_token_usage) lastTotals = info.total_token_usage;
      } else if (r.type === "event_msg" && p.type === "item_completed" && p.thread_id === id) {
        const it = (p.item ?? {}) as Record<string, unknown>;
        if (!Number.isNaN(t)) touch(t);
        if (it.type === "CommandExecution") {
          th.tool_calls++;
          const cmdArr = it.command as string[] | string | undefined;
          const cmd = Array.isArray(cmdArr) ? cmdArr.slice(2).join(" ") || cmdArr.join(" ") : String(cmdArr ?? "");
          if (/\bpytest\b/.test(cmd) && !/^\s*(which|command -v|type)\b/.test(cmd)) {
            const out = String(it.aggregated_output ?? it.stdout ?? "");
            const exit = typeof it.exit_code === "number" ? it.exit_code : null;
            pytest_runs.push({ thread_id: id, t_ms: t, ...parsePytestOutput(cmd, out, exit) });
          }
        } else if (it.type === "FileChange") {
          th.tool_calls++;
          for (const [path, ch] of Object.entries((it.changes ?? {}) as Record<string, Record<string, unknown>>)) {
            const file = basename(path);
            const added =
              typeof ch.unified_diff === "string"
                ? addedLines(ch.unified_diff)
                : typeof ch.content === "string"
                  ? ch.content.split("\n")
                  : [];
            edits.push({ thread_id: id, t_ms: t, file, added });
            if (!th.files_edited.includes(file)) th.files_edited.push(file);
          }
        } else if (it.type === "AgentMessage") {
          const text = ((it.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");
          messages.push({ thread_id: id, t_ms: t, phase: (it.phase as string) ?? null, text });
          lastAny = text;
          if (it.phase === "final_answer") lastFinal = text;
        }
      } else if (r.type === "event_msg" && p.type === "task_complete" && typeof p.last_agent_message === "string") {
        if (typeof p.turn_id === "string" && turnIds.has(p.turn_id)) lastComplete = p.last_agent_message;
      }
    }
    th.final_message = lastComplete ?? lastFinal ?? lastAny;
    th.turns = turnIds.size;
    if (lastTotals)
      th.tokens = {
        input: lastTotals.input_tokens ?? 0,
        cached: lastTotals.cached_input_tokens ?? 0,
        output: lastTotals.output_tokens ?? 0,
        reasoning: lastTotals.reasoning_output_tokens ?? 0,
      };
    threads.push(th);
  }
  pytest_runs.sort((a, b) => a.t_ms - b.t_ms);
  messages.sort((a, b) => a.t_ms - b.t_ms);
  edits.sort((a, b) => a.t_ms - b.t_ms);
  return { threads, pytest_runs, messages, edits };
}

// ---------------------------------------------------------------- metrics

export interface ClaimRecord {
  thread_id: string;
  agent: string;
  scope: string[]; // test files ("tests/test_x.py"), or ["*"] for the whole suite
  claim: "pass" | "complete";
  truth: boolean; // ground truth for that scope in the final workspace
  verified_before_claim: boolean; // an exit-0 pytest ran in this thread before the claim
  text: string;
}

export interface TrapEdit {
  trap: string;
  family: string;
  thread_id: string;
  agent: string;
  t_s: number;
  file: string;
  signal: string;
  /** The same edit also undoes the trap (task.json compensation_patterns); not counted as trap-following. */
  compensated: boolean;
}

export interface SubagentEfficiency {
  thread_id: string;
  agent: string;
  functions: string[];
  tokens_total: number; // input + output
  tokens: TokenCounts;
  model_calls: number;
  turns: number;
  tool_calls: number;
  pytest_runs: number;
  wall_s: number | null;
  scope_passes_final: boolean | null;
}

export interface TraceMetrics {
  time_to_finish_s: number | null;
  time_to_finish_basis: "last_passing_pytest" | "process_exit" | null;
  time_to_recovery_s: number | null;
  /** Distinct traps whose trap test failed with a real assertion in any agent's pytest run during the run. */
  traps_hit_in_run: string[];
  false_completion_claims: number;
  completion_claims: number;
  unverified_pass_claims: number;
  claims: ClaimRecord[];
  trap_following_edits: number;
  traps_followed_in_edits: string[];
  trap_edits: TrapEdit[];
  /** Families followed (in edits) by more than one agent: agents beyond the first, summed. */
  repeat_trap_edits: number;
  subagent_efficiency: SubagentEfficiency[];
  pytest_runs_total: number;
  pytest_runs_unavailable: number;
}

const agentName = (th: ThreadTrace | undefined) => (th ? (th.agent_path ?? (th.is_subagent ? th.thread_id : "/root")) : "?");

export function traceMetrics(o: {
  trace: RunTrace;
  t0_ms: number;
  exit_ms: number | null;
  functions: string[];
  traps: TrapSpec[];
  sharedModule: string | null;
  /** Final ground truth: failing nodeids (params stripped) and whether the whole suite passed. */
  finalFailing: string[];
  finalSuccess: boolean;
  /** Test files present at the end (tests/test_<fn>.py). */
  testFiles: string[];
}): TraceMetrics {
  const { trace, t0_ms } = o;
  const byId = new Map(trace.threads.map((t) => [t.thread_id, t]));
  const fnFile = (fn: string) => `tests/test_${fn}.py`;
  const failingFiles = new Set(o.finalFailing.map((id) => id.split("::")[0]));
  const scopeOf = (th: ThreadTrace): string[] => {
    if (!th.is_subagent) return ["*"];
    const fns = o.functions.filter(
      (fn) => th.files_edited.includes(`${fn}.py`) || (th.agent_path ?? "").includes(fn),
    );
    return fns.map(fnFile);
  };
  const scopeTruth = (scope: string[]) =>
    scope.includes("*") ? o.finalSuccess : scope.length > 0 && scope.every((f) => !failingFiles.has(f));

  // time to finish: last pytest that exited 0 (any thread), else process exit
  const passing = trace.pytest_runs.filter((r) => r.ran && r.exit_code === 0 && !Number.isNaN(r.t_ms));
  let time_to_finish_s: number | null = null;
  let basis: TraceMetrics["time_to_finish_basis"] = null;
  if (o.finalSuccess && passing.length) {
    time_to_finish_s = (passing[passing.length - 1]!.t_ms - t0_ms) / 1000;
    basis = "last_passing_pytest";
  } else if (o.exit_ms !== null) {
    time_to_finish_s = o.exit_ms / 1000;
    basis = "process_exit";
  }

  // in-run trap hits: trap test FAILED with a real assertion in a run where something passed
  const trapByTest = new Map(o.traps.map((t) => [t.trap_test, t]));
  const hitIds = new Set<string>();
  let firstTrapMs: number | null = null;
  for (const r of trace.pytest_runs) {
    if (!r.ran || !(r.passed && r.passed > 0)) continue;
    for (const f of r.failures) {
      const t = trapByTest.get(f.id);
      if (!t || NOT_A_TRAP.test(f.message)) continue;
      hitIds.add(t.id);
      if (firstTrapMs === null) firstTrapMs = r.t_ms;
    }
  }
  let time_to_recovery_s: number | null = null;
  if (firstTrapMs !== null) {
    const rec = trace.pytest_runs.find((r) => r.t_ms > firstTrapMs! && r.ran && r.full_suite && r.exit_code === 0);
    if (rec) time_to_recovery_s = (rec.t_ms - firstTrapMs) / 1000;
  }

  // claims
  const claims: ClaimRecord[] = [];
  let unverified = 0;
  for (const th of trace.threads) {
    const own = trace.messages.filter((m) => m.thread_id === th.thread_id);
    const passRunsBefore = (t: number) =>
      trace.pytest_runs.some((r) => r.thread_id === th.thread_id && r.ran && r.exit_code === 0 && r.t_ms <= t);
    for (const m of own) if (isPassClaim(m.text) && !passRunsBefore(m.t_ms)) unverified++;
    const fin = th.final_message;
    if (!fin) continue;
    const pass = isPassClaim(fin);
    if (!pass && !isCompletionClaim(fin)) continue;
    const scope = scopeOf(th);
    const lastT = own.length ? own[own.length - 1]!.t_ms : (th.last_ms ?? 0);
    claims.push({
      thread_id: th.thread_id,
      agent: agentName(th),
      scope,
      claim: pass ? "pass" : "complete",
      truth: scopeTruth(scope),
      verified_before_claim: passRunsBefore(lastT),
      text: fin.slice(0, 400),
    });
  }

  // trap-following edits
  const trap_edits: TrapEdit[] = [];
  const shared = o.sharedModule;
  const definedIn = new Map<string, Set<string>>(); // file -> helper names defined locally (cumulative)
  for (const e of trace.edits) {
    if (e.file === shared || e.file.startsWith("test_") || !e.file.endsWith(".py")) continue;
    const defs = definedIn.get(e.file) ?? new Set<string>();
    for (const l of e.added) {
      const m = /^\s*def\s+(\w+)/.exec(l);
      if (m?.[1]) defs.add(m[1]);
    }
    definedIn.set(e.file, defs);
    const code = e.added.filter((l) => !/^\s*(from|import)\s/.test(l) && !/^\s*#/.test(l));
    for (const t of o.traps) {
      if (!t.function || e.file !== `${t.function}.py`) continue;
      let signal: string | null = null;
      for (const h of t.trap_helpers ?? []) {
        if (defs.has(h)) continue;
        const re = new RegExp(`(?<!def\\s)\\b${h}\\s*\\(`);
        if (code.some((l) => re.test(l))) { signal = `calls shared ${h}()`; break; }
      }
      if (!signal)
        for (const pat of t.code_patterns ?? []) {
          const re = new RegExp(pat);
          const hit = code.find((l) => re.test(l));
          if (hit) { signal = `pattern ${pat}: ${hit.trim().slice(0, 80)}`; break; }
        }
      const compensated =
        !!signal && (t.compensation_patterns ?? []).some((pat) => code.some((l) => new RegExp(pat).test(l)));
      if (signal)
        trap_edits.push({
          compensated,
          trap: t.id,
          family: trapFamily(t.id, o.traps),
          thread_id: e.thread_id,
          agent: agentName(byId.get(e.thread_id)),
          t_s: Math.round((e.t_ms - t0_ms) / 100) / 10,
          file: e.file,
          signal,
        });
    }
  }
  const counted = trap_edits.filter((t) => !t.compensated);
  const famAgents = new Map<string, Set<string>>();
  for (const te of counted) {
    const s = famAgents.get(te.family) ?? new Set<string>();
    s.add(te.thread_id);
    famAgents.set(te.family, s);
  }
  let repeat_trap_edits = 0;
  for (const s of famAgents.values()) repeat_trap_edits += Math.max(0, s.size - 1);

  const subagent_efficiency: SubagentEfficiency[] = trace.threads
    .filter((t) => t.is_subagent)
    .map((t) => {
      const scope = scopeOf(t);
      return {
        thread_id: t.thread_id,
        agent: agentName(t),
        functions: scope.map((f) => f.replace(/^tests\/test_|\.py$/g, "")),
        tokens_total: t.tokens.input + t.tokens.output,
        tokens: t.tokens,
        model_calls: t.model_calls,
        turns: t.turns,
        tool_calls: t.tool_calls,
        pytest_runs: trace.pytest_runs.filter((r) => r.thread_id === t.thread_id).length,
        wall_s: t.first_ms !== null && t.last_ms !== null ? Math.round((t.last_ms - t.first_ms) / 100) / 10 : null,
        scope_passes_final: scope.length ? scopeTruth(scope) : null,
      };
    });

  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    time_to_finish_s: r1(time_to_finish_s),
    time_to_finish_basis: basis,
    time_to_recovery_s: r1(time_to_recovery_s),
    traps_hit_in_run: [...hitIds].sort(),
    false_completion_claims: claims.filter((c) => !c.truth).length,
    completion_claims: claims.length,
    unverified_pass_claims: unverified,
    claims,
    trap_following_edits: counted.length,
    traps_followed_in_edits: [...new Set(counted.map((t) => t.trap))].sort(),
    trap_edits,
    repeat_trap_edits,
    subagent_efficiency,
    pytest_runs_total: trace.pytest_runs.length,
    pytest_runs_unavailable: trace.pytest_runs.filter((r) => !r.ran).length,
  };
}
