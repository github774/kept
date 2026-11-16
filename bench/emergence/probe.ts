// Turns one finished run into one AgentRow per slot. `buildAgentRows` is pure (tested); the readers
// below do the I/O. Anything a source does not expose stays null with the reason in `notes`.
import type { AgentCard, CaseFile, LedgerTotals, RunSummary, TokenCounts } from "../../orchestrator/src/contract.ts";
import { trapFamily, trapFollowed, type TaskJson, type TaskTrap } from "../ours/metrics.ts";
import type { Snapshot } from "../ours/pytest.ts";
import { ROW_SCHEMA, type AgentRow, type Arm } from "./types.ts";

/** Ledger row as stored by the Ledger actor (actors/src/actors.ts LedgerEntry). */
export interface LedgerRow {
  id: string;
  category: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  usd: number;
  slot?: string;
  gen?: number;
  mock?: boolean;
}
export interface ChunkRow {
  id: string;
  slot: string;
  reusers: string[];
}
/**
 * Optional service extension (not in contract.ts): what each agent's prompts carried.
 * `getAgentTelemetry(runId)` -> one entry per slot+gen. Without it lesson_in_prompt stays null.
 */
export interface AgentTelemetry {
  slot: number;
  gen: number;
  /** Case ids whose lessons were in any of this agent's prompts (Fleet lessons block, handoff, inbox). */
  lessonCaseIds: string[];
  /** Chunk ids put into any of this agent's prompts. */
  reusedChunkIds?: string[];
}

export interface RunMeta {
  experiment: string;
  key: string;
  arm: Arm;
  armRunIndex: number;
  launchSeq: number;
  wave: number;
  agentsPerRun: number;
  task: TaskJson;
  startedAt: number;
  endedAt: number;
  summary: RunSummary;
  killed: boolean;
  capped: boolean;
  stoppedByBudget: boolean;
  crash: string | null;
}

export interface RunEvidence {
  snapshots: Snapshot[];
  roster: AgentCard[] | null;
  runCases: CaseFile[] | null;
  /** Library contents listed right after startRun; only cases created before launch count. */
  libraryAtLaunch: CaseFile[] | null;
  /** Library at the end (to resolve telemetry case ids). */
  libraryAtEnd: CaseFile[] | null;
  ledgerRows: LedgerRow[] | null;
  ledgerTotals: LedgerTotals | null;
  chunks: ChunkRow[] | null;
  telemetry: AgentTelemetry[] | null;
}

/** "3", "w3", "slot3" -> 3. */
export function slotNumber(s: string | number | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  if (typeof s === "number") return s;
  const m = /(\d+)$/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Agent id or name -> slot: "w2-g1-r7k2", "agent.r7k2.2.g1", "r7k2.2.g1". */
export function agentIdSlot(id: string): number | null {
  const w = /^w(\d+)-g\d+/.exec(id);
  if (w) return Number(w[1]);
  const a = /\.[A-Za-z_]*(\d+)\.g\d+$/.exec(id);
  return a ? Number(a[1]) : null;
}

const taskMatches = (caseTask: string, taskId: string) => caseTask === taskId || taskId.startsWith(`${caseTask}_`);
export const hasLesson = (c: CaseFile) => !c.revoked && !!c.lesson && c.lesson.trim() !== "" && c.lesson.trim() !== "NO_LESSON";

type V2Trap = TaskTrap & { function?: string; family?: string };
export const familyOf = (t: V2Trap, all: TaskTrap[]) => t.family ?? trapFamily(t.id, all);
/** The function a trap belongs to: task.json `function` (v2), else the function owning the trap test file. */
export function trapFunction(task: TaskJson, t: V2Trap): string {
  if (t.function) return t.function;
  const file = t.trap_test.split("::")[0];
  return task.functions.find((f) => f.test === file)?.name ?? "";
}
export const trapsOf = (task: TaskJson, fn: { name: string }) => task.traps.filter((t) => trapFunction(task, t) === fn.name);

/** A case is about trap T when its test output names T's trap test, or it is from T's task and T's function. */
export function caseIsAboutTrap(c: CaseFile, taskId: string, trap: TaskTrap, fnName: string): boolean {
  const testName = trap.trap_test.split("::").pop() ?? trap.trap_test;
  if (c.evidence?.testOutput && c.evidence.testOutput.includes(testName)) return true;
  return taskMatches(String(c.task), taskId) && c.subtask === fnName;
}

const zero = (): TokenCounts => ({ input: 0, cached: 0, output: 0, reasoning: 0 });
const addRow = (t: TokenCounts, r: LedgerRow) => {
  t.input += r.input_tokens;
  t.cached += r.cached_input_tokens;
  t.output += r.output_tokens;
  t.reasoning += r.reasoning_tokens;
};

export function buildAgentRows(m: RunMeta, ev: RunEvidence): AgentRow[] {
  const task = m.task;
  const runNotes: string[] = [];
  const last = ev.snapshots.at(-1);
  if (!last) runNotes.push("no ground-truth snapshot");

  // Slots from the roster; without it, slot numbers only (function unknown).
  const cards = new Map<number, AgentCard>();
  for (const c of ev.roster ?? []) {
    const prev = cards.get(c.slot);
    if (!prev || c.gen > prev.gen) cards.set(c.slot, c);
  }
  if (!ev.roster) runNotes.push("roster unavailable: function/generations unknown");
  const slots = cards.size ? [...cards.keys()].sort((a, b) => a - b) : Array.from({ length: m.agentsPerRun }, (_, i) => i);

  // Ledger rows per slot.
  const bySlot = new Map<number, { t: TokenCounts; usd: number }>();
  let unattributed: number | null = null;
  const reuseEstSlots = new Set<number>();
  let mockRows = 0;
  if (ev.ledgerRows) {
    unattributed = 0;
    for (const r of ev.ledgerRows) {
      const s = slotNumber(r.slot);
      if (r.category === "reuse_est") {
        if (s !== null) reuseEstSlots.add(s);
        continue;
      }
      if (r.mock) mockRows++;
      if (s === null) {
        unattributed += r.input_tokens + r.output_tokens;
        continue;
      }
      const e = bySlot.get(s) ?? { t: zero(), usd: 0 };
      addRow(e.t, r);
      e.usd += r.usd;
      bySlot.set(s, e);
    }
  } else runNotes.push("ledger rows unavailable: per-agent tokens not measured");
  if (mockRows) runNotes.push(`${mockRows} MOCK ledger rows`);

  const chunkReusers = new Set<number>();
  if (ev.chunks) for (const c of ev.chunks) for (const a of c.reusers) {
    const s = agentIdSlot(a);
    if (s !== null) chunkReusers.add(s);
  }

  const libCases = ev.libraryAtLaunch?.filter((c) => c.createdAt < m.startedAt) ?? null;
  const caseById = new Map<string, CaseFile>();
  for (const c of [...(ev.libraryAtEnd ?? []), ...(ev.libraryAtLaunch ?? []), ...(ev.runCases ?? [])]) caseById.set(c.id, c);

  const runTokens = ev.ledgerTotals ? { ...ev.ledgerTotals.tokens } : null;
  const runUsd = ev.ledgerTotals ? round6(ev.ledgerTotals.worker_usd + ev.ledgerTotals.overhead_usd) : null;
  const isMock = !!m.summary.mock || mockRows > 0;

  return slots.map((slot): AgentRow => {
    const notes = [...runNotes];
    const card = cards.get(slot);
    const fnName = card?.subtask ?? null;
    const fn = fnName ? task.functions.find((f) => f.name === fnName) : undefined;
    if (fnName && !fn) notes.push(`roster subtask ${fnName} is not a function of ${task.id}`);
    const traps = fn ? trapsOf(task, fn) : [];

    const followedAny = new Set<string>();
    for (const s of ev.snapshots) for (const t of traps) if (trapFollowed(s, t)) followedAny.add(t.id);
    const followedFinal = last ? traps.filter((t) => trapFollowed(last, t)).map((t) => t.id) : [];
    const mine = fn && last ? last.cases.filter((c) => c.nodeid.startsWith(`${fn.test}::`)) : [];

    const slotCases = ev.runCases?.filter((c) => c.slot === slot && !c.synthetic) ?? null;
    const generations = card ? Math.max(card.gen, ...(slotCases ?? []).map((c) => c.gen + 1)) : null;
    const retired = card || slotCases ? (generations ?? 1) > 1 || card?.status === "retired" || card?.status === "failed" || (slotCases?.length ?? 0) > 0 : null;

    // A lesson is "for" this agent's trap when it is about any trap of the same family (e.g. the cents
    // trap in parse_line and its twin in total_by_customer).
    const fams = new Set(traps.map((t) => familyOf(t, task.traps)));
    const related = task.traps.filter((t) => fams.has(familyOf(t, task.traps)));
    const about = (c: CaseFile) => related.some((t) => caseIsAboutTrap(c, task.id, t, trapFunction(task, t)));

    let lessonInPrompt: boolean | null = null;
    let lessonSrc: string | null = null;
    if (ev.telemetry && fn) {
      const mineT = ev.telemetry.filter((t) => t.slot === slot);
      if (mineT.length) {
        lessonInPrompt = mineT.some((t) => t.lessonCaseIds.some((id) => { const c = caseById.get(id); return !!c && hasLesson(c) && about(c); }));
        lessonSrc = "service getAgentTelemetry lessonCaseIds";
      }
    }
    if (lessonInPrompt === null) notes.push("lesson_in_prompt not exposed by service");

    let chunkReused: boolean | null = null;
    let chunkSrc: string | null = null;
    const telReuse = ev.telemetry?.filter((t) => t.slot === slot && t.reusedChunkIds);
    if (telReuse?.length) {
      chunkReused = telReuse.some((t) => (t.reusedChunkIds?.length ?? 0) > 0);
      chunkSrc = "service getAgentTelemetry reusedChunkIds";
    } else if (ev.chunks || ev.ledgerRows) {
      chunkReused = chunkReusers.has(slot) || reuseEstSlots.has(slot);
      chunkSrc = [ev.chunks ? "ReasoningStore reusers" : null, ev.ledgerRows ? "Ledger reuse_est rows" : null].filter(Boolean).join(" + ");
    }

    const tok = bySlot.get(slot);
    return {
      schema: ROW_SCHEMA,
      experiment: m.experiment,
      arm: m.arm,
      run_key: m.key,
      arm_run_index: m.armRunIndex,
      arm_agent_index: m.armRunIndex * m.agentsPerRun + slot,
      launch_seq: m.launchSeq,
      wave: m.wave,
      run_id: m.summary.runId,
      library_id: m.summary.libraryId ?? null,
      task: task.id,
      model: m.summary.model,
      slot,
      function: fnName,
      launched_at: m.startedAt,
      ended_at: m.endedAt,
      run_status: m.summary.status,
      run_wall_ms: m.endedAt - m.startedAt,
      killed: m.killed,
      capped_usd: m.capped,
      stopped_by_budget: m.stoppedByBudget,
      crash: m.crash,
      generations,
      retired,
      retire_cases: slotCases ? slotCases.length : null,
      trap_ids: traps.map((t) => t.id),
      exposed: traps.length > 0,
      trap_hit_final: fn && last ? followedFinal.length > 0 : null,
      trap_hit_any: fn && ev.snapshots.length ? followedAny.size > 0 : null,
      traps_followed: [...followedAny].sort(),
      function_pass_final: fn && last ? !last.broken && mine.length > 0 && mine.every((c) => c.outcome === "passed") : null,
      tokens: ev.ledgerRows ? (tok?.t ?? zero()) : null,
      usd: ev.ledgerRows ? round6(tok?.usd ?? 0) : null,
      tokens_source: ev.ledgerRows ? "Ledger actor rows with this slot (usage fields; reuse_est excluded)" : null,
      lesson_in_prompt: lessonInPrompt,
      lesson_in_prompt_source: lessonSrc,
      trap_lesson_in_library_at_launch: libCases && fn ? libCases.some((c) => hasLesson(c) && about(c)) : null,
      library_cases_at_launch: libCases ? libCases.filter((c) => !c.synthetic).length : null,
      library_lessons_at_launch: libCases ? libCases.filter((c) => !c.synthetic && hasLesson(c)).length : null,
      library_synthetic_at_launch: libCases ? libCases.filter((c) => c.synthetic).length : null,
      chunk_reused: chunkReused,
      chunk_reuse_source: chunkSrc,
      run_tokens: runTokens,
      run_usd: runUsd,
      run_unattributed_tokens: unattributed,
      snapshots: ev.snapshots.length,
      notes,
      ...(isMock ? { mock: true as const } : {}),
    };
  });
}

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ---------- I/O: Durable Actors reads (read-only; optional) ----------

type ActorsMod = typeof import("../../orchestrator/src/actors.ts");
let actorsMod: ActorsMod | null | undefined;
let actorsErr = "";

async function actorsClient(): Promise<ActorsMod | null> {
  if (actorsMod !== undefined) return actorsMod;
  try {
    actorsMod = (await import("../../orchestrator/src/actors.ts")) as ActorsMod;
  } catch (e) {
    actorsErr = e instanceof Error ? e.message : String(e);
    actorsMod = null;
  }
  return actorsMod;
}

export const actorsError = () => actorsErr;

/** All Ledger rows of a run (per-slot tokens). null if the actor client is unavailable. */
export async function readLedgerRows(runId: string): Promise<LedgerRow[] | null> {
  const a = await actorsClient();
  if (!a) return null;
  try {
    return (await a.runActors(runId).ledger.list({ limit: 1_000_000 })) as LedgerRow[];
  } catch (e) {
    actorsErr = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export async function readChunks(runId: string): Promise<ChunkRow[] | null> {
  const a = await actorsClient();
  if (!a) return null;
  try {
    return ((await a.runActors(runId).chunks.list({ includeRevoked: true })) as ChunkRow[]).map((c) => ({ id: c.id, slot: c.slot, reusers: c.reusers }));
  } catch (e) {
    actorsErr = e instanceof Error ? e.message : String(e);
    return null;
  }
}
