// Retire and respawn (BUILD_SPEC "Retire and respawn" -> "Protocol"). Owner: retire implementer.
// Every step is idempotent, so a crash halfway through resumes cleanly (resumeRetire).
// Persistent state lives in actors only (rule 3); the WeakMaps below are rebuildable caches.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCard, AgentStatus, CaseEvidence, CaseFile, CaseId, DriftPoint, FailureCategory, RecoveryStages } from "../contract.ts";
import { withRetry, type CaseFile as ActorCaseFile, type CaseInput } from "../actors.ts";
import type { LedgerScope } from "../ledger.ts";
import { appendLesson, lessonsFromCases, specExcerpt, writeLesson } from "../lessons.ts";
import { rememberCase } from "../memory/immune.ts";
import { RelayNameConflictError, relayNames } from "../relay/bus.ts";
import { runTests } from "../testrunner.ts";
import { jevCheck, jevEvidence } from "../verify.ts";
import { concreteEvidence, importerSlots, pushAlert } from "./evidence.ts";
import { broadcastCase } from "./herd.ts";

/** Collaborators tests may swap (instead of mock.module, which leaks across test files). */
export const retireDeps = {
  broadcastCase,
  /** Re-runs a function's tests on a copy of the CURRENT shared folder with `code` as its file (stale-checkpoint check). */
  checkpointTests: async (ctx: RunContext, fn: TaskFn, code: string) => {
    const tmp = mkdtempSync(join(tmpdir(), `ckpt-${fn.name}-`));
    try {
      cpSync(ctx.workDir, tmp, { recursive: true, filter: (src) => !/(__pycache__|\.pytest_cache)/.test(src) });
      writeFileSync(join(tmp, fn.file), code);
      return await runTests({ workDir: tmp, testFile: fn.test, timeoutMs: ctx.caps.test_timeout_ms, agentId: `handoff-${fn.name}` });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};
import type { AgentRef, Evidence, Handoff, RetireReason, RunContext, TaskFn } from "./types.ts";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "false_success_claim",
  "invented_api",
  "spec_misread",
  "conflicting_instruction",
  "other",
];
const RETIRE_REASONS: readonly RetireReason[] = ["false_claim", "conflicting_instruction", "accepted_poison", "stuck", "drift"];

export type RetireResult = { newRef: AgentRef | null; caseId: CaseId };

// ---------- small helpers ----------

const caseIdOf = (ctx: RunContext, slot: number, gen: number): CaseId => `${ctx.runId}.${slot}.g${gen}`;
const refOf = (ctx: RunContext, slot: number, gen: number): AgentRef => ({ slot, gen, name: relayNames.agent(ctx.runId, slot, gen) });
const retireScope = (ref: AgentRef): LedgerScope => ({ slot: ref.slot, gen: ref.gen, step: "retire" });
const anyMock = (ctx: RunContext) => Object.values(ctx.deps.mock).some(Boolean);
const mockFlag = (ctx: RunContext) => (anyMock(ctx) ? { mock: true as const } : {});
const call = <T>(ctx: RunContext, fn: () => Promise<T>) => withRetry(fn, { onWait: () => ctx.deps.log(`[retire] actors unavailable, retrying`) });

/** The slot's own function (slot index into task.functions); reassignments are tracked separately. */
export function slotFn(ctx: RunContext, slot: number): TaskFn | undefined {
  return ctx.task.functions[slot];
}

function publishStatus(ctx: RunContext, ref: AgentRef, status: AgentStatus, step: number, reason?: string, agent?: AgentCard) {
  ctx.bus.publish({ type: "agent.status", runId: ctx.runId, ts: Date.now(), slot: ref.slot, gen: ref.gen, status, step, ...(reason ? { reason } : {}), ...(agent ? { agent } : {}), ...mockFlag(ctx) });
}

/** Card for a freshly spawned generation, so subscribers learn the new Relay name with the status. */
function freshCard(ctx: RunContext, ref: AgentRef, status: AgentStatus): AgentCard {
  return {
    slot: ref.slot,
    name: ref.name,
    gen: ref.gen,
    status,
    step: 0,
    subtask: slotFn(ctx, ref.slot)?.name ?? "",
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 },
    possessed: false,
    verifiedSteps: 0,
  };
}

function stages(ctx: RunContext, slot: number): RecoveryStages {
  return ctx.recovery.get(slot) ?? { faultAt: null, detectedAt: null, retireBeganAt: null, caseFiledAt: null, respawnedAt: null, testsPassingAt: null };
}
/** Sets stage times by reassignment (never mutates the stored object); an already-set stage is kept. */
function setStages(ctx: RunContext, slot: number, patch: Partial<RecoveryStages>) {
  const cur = stages(ctx, slot);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch) as [keyof RecoveryStages, number | null][]) if (next[k] == null && v != null) next[k] = v;
  ctx.recovery.set(slot, next);
}

// ---------- evidence <-> case file ----------

function evidenceText(e: Evidence): string {
  const parts: string[] = [];
  if (e.failedTests?.length) parts.push(`failed tests: ${e.failedTests.slice(0, 10).join(", ")}`);
  if (e.testOutput) parts.push(`test output: ${e.testOutput.slice(-1500)}`);
  if (e.jev) parts.push(`${e.jev.questionId}: problem=${e.jev.result.value} p=${e.jev.result.probability.toFixed(2)} (${e.jev.result.source})${e.jev.result.reason ? ` reason: ${e.jev.result.reason}` : ""}`);
  if (e.driftTrace?.length) parts.push(`drift scores: ${e.driftTrace.map((d) => d.score.toFixed(2)).join(", ")}`);
  return parts.join("\n") || "(no evidence text)";
}

function caseEvidence(e: Evidence): CaseEvidence & { mock?: true } {
  return {
    ...(e.testOutput ? { testOutput: e.testOutput.slice(-4000) } : {}),
    ...(e.jev ? jevEvidence(e.jev.questionId, e.jev.result) : {}),
  };
}

/** Converts a CaseLibrary row to the contract CaseFile (evidence carries the extra fields retire stored). */
export function caseFromActor(ctx: RunContext, c: ActorCaseFile): CaseFile {
  const ev = (c.evidence ?? {}) as Record<string, unknown>;
  const { meta, ...evidence } = ev as { meta?: Record<string, unknown> } & CaseEvidence;
  const m = meta ?? {};
  const slot = Number(c.slot);
  const steps = Array.isArray(m.driftSteps) ? (m.driftSteps as number[]) : [];
  return {
    id: c.id,
    runId: c.runId,
    libraryId: typeof m.libraryId === "string" ? m.libraryId : ctx.libraryId,
    slot,
    gen: c.gen,
    agentName: typeof m.agentName === "string" ? m.agentName : relayNames.agent(c.runId, slot, c.gen),
    task: typeof m.task === "string" ? m.task : ctx.taskId,
    subtask: typeof m.subtask === "string" ? m.subtask : (slotFn(ctx, slot)?.name ?? ""),
    claim: c.claim,
    evidence: evidence as CaseEvidence,
    category: (FAILURE_CATEGORIES as readonly string[]).includes(c.category) ? (c.category as FailureCategory) : "other",
    ...(c.driftTrace.length ? { driftTrace: c.driftTrace.map((score, i) => ({ step: steps[i] ?? i, score })) } : {}),
    lesson: c.lesson ? c.lesson : null,
    recipients: c.receivers,
    ...(typeof m.replacement === "string" ? { replacement: m.replacement } : {}),
    replies: Array.isArray((c as { replies?: unknown }).replies) ? ((c as { replies: CaseFile["replies"] }).replies ?? []) : [],
    synthetic: c.synthetic,
    revoked: c.revoked,
    createdAt: c.createdAt,
  };
}

/**
 * Protocol step 4 on its own: evidence -> contract CaseFile (recipients [], replies [], synthetic false,
 * revoked false). Category = evidence.category ?? Jev failure_category. Lesson from the lesson writer
 * (spec excerpt + evidence only). Ledger rows under {slot, gen, step: "retire"}.
 */
export async function buildCaseFile(ctx: RunContext, ref: AgentRef, reason: RetireReason, evidence: Evidence): Promise<CaseFile> {
  const scope = retireScope(ref);
  const fn = slotFn(ctx, ref.slot);
  let category: FailureCategory = evidence.category ?? "other";
  if (!evidence.category) {
    try {
      const r = await jevCheck(ctx, scope, "failure_category", { claim: evidence.claim, evidence: evidenceText(evidence) });
      if (r.kind === "choice" && (FAILURE_CATEGORIES as readonly string[]).includes(r.choice)) category = r.choice as FailureCategory;
    } catch (e) {
      ctx.deps.log(`[retire] failure_category check failed (${e instanceof Error ? e.message : String(e)}); category "other"`);
    }
  }
  const ev = caseEvidence(evidence);
  const lesson = await writeLesson(ctx, scope, {
    specExcerpt: specExcerpt(ctx.task.specText),
    subtask: fn?.name ?? `slot ${ref.slot}`,
    category,
    claim: evidence.claim,
    testOutput: evidence.testOutput,
    failedTests: evidence.failedTests,
    check: evidence.jev ? `${evidence.jev.questionId} p=${evidence.jev.result.probability.toFixed(2)} (${evidence.jev.result.source})` : undefined,
    fallbackReason: ev.fallbackReason,
    ...concreteOrEmpty(ctx, ref.slot, fn, evidence),
  });
  if (ev.mock) ctx.deps.log(`[MOCK retire] case ${caseIdOf(ctx, ref.slot, ref.gen)} evidence came from a mocked judge`);
  const { mock: _m, ...cleanEvidence } = ev;
  void reason;
  return {
    id: caseIdOf(ctx, ref.slot, ref.gen),
    runId: ctx.runId,
    libraryId: ctx.libraryId,
    slot: ref.slot,
    gen: ref.gen,
    agentName: ref.name,
    task: ctx.taskId,
    subtask: fn?.name ?? "",
    claim: evidence.claim,
    evidence: cleanEvidence,
    category,
    ...(evidence.driftTrace?.length ? { driftTrace: evidence.driftTrace } : {}),
    lesson: lesson.lesson,
    recipients: [],
    replies: [],
    synthetic: false,
    revoked: false,
    createdAt: Date.now(),
  };
}

function concreteOrEmpty(ctx: RunContext, slot: number, fn: TaskFn | undefined, ev: Evidence) {
  try {
    return concreteEvidence(ctx, slot, fn, ev);
  } catch (e) {
    ctx.deps.log(`[retire] concrete evidence for slot ${slot} failed: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/**
 * Herd on: a filed case's lesson goes into the lessons block for every agent's NEXT step right away (the caucus thread
 * still runs in step 9 and dedups), and agents whose own file imports a shared module that changed since the failed
 * slot last passed also get it as a case message in their next inbox.
 */
function pushLessonNow(ctx: RunContext, ref: AgentRef, caseFile: CaseFile) {
  const lesson = caseFile.lesson!;
  if (!ctx.lessons().includes(lesson)) ctx.setLessons(appendLesson(ctx.lessons(), lesson, ctx.caps.max_lessons));
  try {
    const fn = slotFn(ctx, ref.slot);
    const { changedFiles } = concreteEvidence(ctx, ref.slot, fn, {});
    for (const cf of changedFiles) {
      const mod = cf.file.replace(/\.py$/, "");
      for (const slot of importerSlots(ctx, mod)) {
        if (slot === ref.slot) continue;
        pushAlert(ctx, slot, relayNames.warden(ctx.runId), caseFile.id, `CASE ${caseFile.id} (${fn?.name ?? "a teammate"} failed): ${cf.file} changed since it last passed, and your file imports ${mod}. Lesson: ${lesson}`);
      }
    }
  } catch (e) {
    ctx.deps.log(`[retire] targeted lesson push for ${caseFile.id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Step 5: CaseLibrary.add (idempotent on case id) with its embedding. Returns the stored case (repeat -> existing). */
async function fileCase(ctx: RunContext, ref: AgentRef, reason: RetireReason, caseFile: CaseFile, extra: { failedTests?: string[]; fault?: string; mock?: boolean }) {
  const scope = retireScope(ref);
  let embedding: number[] | undefined;
  try {
    const r = await ctx.deps.embedder.embed([`${caseFile.claim}\n${caseFile.lesson ?? ""}\n${caseFile.category}`], { category: "embedding", slot: String(ref.slot), gen: ref.gen, step: 0 });
    await ctx.ledger.record(scope, [r.usage]);
    embedding = r.vectors[0];
  } catch (e) {
    ctx.deps.log(`[retire] case embedding failed (${e instanceof Error ? e.message : String(e)}); filed without embedding`);
  }
  const drift: DriftPoint[] = caseFile.driftTrace ?? [];
  const input: CaseInput = {
    id: caseFile.id,
    runId: ctx.runId,
    slot: String(ref.slot),
    gen: ref.gen,
    category: caseFile.category,
    claim: caseFile.claim,
    evidence: {
      ...caseFile.evidence,
      meta: {
        libraryId: ctx.libraryId,
        task: ctx.taskId,
        subtask: caseFile.subtask,
        agentName: ref.name,
        reason,
        lessonNull: caseFile.lesson === null,
        ...(drift.length ? { driftSteps: drift.map((d) => d.step) } : {}),
        ...(extra.failedTests?.length ? { failedTests: extra.failedTests } : {}),
        ...(extra.fault ? { fault: extra.fault } : {}),
        ...(extra.mock ? { mock: true } : {}),
      },
    },
    // Actor stores a string; "" means the writer said NO_LESSON (caseFromActor maps it back to null).
    lesson: caseFile.lesson ?? "",
    ...(drift.length ? { driftTrace: drift.map((d) => d.score) } : {}),
    ...(embedding ? { embedding } : {}),
  };
  await call(ctx, () => ctx.actors.cases.add(input));
  await rememberCase(ctx, caseFile, embedding); // cross-run immune memory (Supabase); no-op unless configured
}

/** Protocol step 6 on its own: reads Agent.handoff() for ref and attaches the lesson. Only verified checkpoints carry over. */
export async function buildHandoff(ctx: RunContext, ref: AgentRef, caseFile: CaseFile): Promise<Handoff> {
  const h = await call(ctx, () => ctx.actors.agent(String(ref.slot), ref.gen).handoff());
  const fn = slotFn(ctx, ref.slot);
  // A checkpoint was verified against the shared folder as it was then. Re-run its tests against the folder as it is
  // NOW (helpers may have changed under it); a failing one is handed over marked STALE with the current failing output.
  const checkpoints: Handoff["checkpoints"] = [];
  const staleNotes: string[] = [];
  for (const c of h?.checkpoints ?? []) {
    const cfn = ctx.task.functions.find((f) => f.name === c.fn);
    let stale: string | undefined;
    if (cfn && existsSync(ctx.workDir)) {
      try {
        const t = await retireDeps.checkpointTests(ctx, cfn, c.code);
        if (!t.passed) {
          const failed = t.failedTests.map((x) => x.split("::").pop()).slice(0, 6).join(", ") || "tests failed";
          stale = `STALE: verified earlier, tests now fail (${failed}) — see evidence`;
          staleNotes.push(
            `STALE checkpoint ${c.fn}: it passed when it was verified, but ${cfn.test} FAILS now against the current shared files ` +
              `(failing: ${failed}). Current test output (trimmed):\n\`\`\`\n${t.output.slice(-1200)}\n\`\`\``,
          );
        }
      } catch (e) {
        ctx.deps.log(`[retire] re-testing checkpoint ${c.fn} for ${ref.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    checkpoints.push({ fn: c.fn, code: c.code, ...(stale ? { stale } : {}) });
  }
  const ownCp = fn ? checkpoints.find((c) => c.fn === fn.name) : undefined;
  const remaining = fn
    ? ownCp
      ? ownCp.stale
        ? `${fn.name}: the handed-over code is STALE (its tests fail against the folder as it is now); make ${fn.test} pass again and claim done only after running the tests`
        : `${fn.name}: verified code is in the handoff; keep ${fn.test} passing and claim done only after running the tests`
      : `${fn.name}: make ${fn.test} pass (${fn.subgoal})`
    : (h?.task ?? "finish the slot's subtask");
  // Evidence summary only (category + what fails now): never the failed agent's reasoning.
  const evidence = staleNotes.length ? `\n\nCase ${caseFile.id} evidence [${caseFile.category}]:\n${staleNotes.join("\n")}` : "";
  const inherited = ctx.dirtyRespawn ? await dirtyContext(ctx, ref, caseFile) : "";
  return { fromGen: ref.gen, checkpoints, remaining: remaining + evidence + inherited, lesson: caseFile.lesson, caseId: caseFile.id };
}

/**
 * Opt-in "dirty" respawn (ctx.dirtyRespawn, bench/ab only): the retired generation's full step log, its failing
 * test output and its current (unverified) code, carried into the replacement's handoff text as-is.
 */
async function dirtyContext(ctx: RunContext, ref: AgentRef, caseFile: CaseFile): Promise<string> {
  const st = await call(ctx, () => ctx.actors.agent(String(ref.slot), ref.gen).state());
  const fn = slotFn(ctx, ref.slot);
  let code = "";
  try {
    if (fn && existsSync(join(ctx.workDir, fn.file))) code = readFileSync(join(ctx.workDir, fn.file), "utf8");
  } catch {
    /* no code */
  }
  const steps = st.steps.map((s) => `- step ${s.step}: ${s.summary}${s.claims.length ? ` [${s.claims.join("; ")}]` : ""}`);
  const out = [
    `\n\n## Your context so far (you are continuing generation ${ref.gen}'s work; nothing was reset)`,
    `### All your steps`,
    steps.join("\n").slice(-6000) || "(none)",
    caseFile.evidence.testOutput ? `### Your last test output\n\`\`\`\n${caseFile.evidence.testOutput.slice(-1500)}\n\`\`\`` : "",
    code ? `### ${fn?.file ?? "your file"} as you left it (unverified, still in the folder)\n\`\`\`python\n${code.slice(0, 8000)}\n\`\`\`` : "",
  ];
  return out.filter(Boolean).join("\n");
}

// ---------- reassignment (generation limit) ----------

const reassigned = new WeakMap<RunContext, Map<string, number>>();
/**
 * fn name -> slot that took it over after its own slot failed. A cache of Fleet's reassignments table
 * (Fleet.reassign); recomputeReassignments reloads it after a restart.
 */
export function reassignments(ctx: RunContext): ReadonlyMap<string, number> {
  return reassigned.get(ctx) ?? new Map();
}

type Reassignee = AgentRef & { status: AgentStatus; done: boolean };

/**
 * Active agent to take a failed slot's function, excluding `exclude`. Agents whose loop is still running
 * come first (a "done" agent's loop has ended and must be restarted); then most verified checkpoints;
 * ties -> lowest slot.
 */
export async function pickReassignee(ctx: RunContext, exclude: number): Promise<Reassignee | null> {
  const snap = await call(ctx, () => ctx.actors.fleet.snapshot());
  let best: { ref: Reassignee; n: number } | null = null;
  for (const s of snap.slots) {
    const slot = Number(s.slot);
    if (slot === exclude || !["trusted", "probation", "under_investigation"].includes(s.status)) continue;
    const st = await call(ctx, () => ctx.actors.agent(s.slot, s.gen).state());
    const n = st.checkpoints.length;
    const done = !!s.done;
    const better = !best || (best.ref.done && !done) || (best.ref.done === done && (n > best.n || (n === best.n && slot < best.ref.slot)));
    if (better) best = { ref: { ...refOf(ctx, slot, s.gen), status: s.status, done }, n };
  }
  return best?.ref ?? null;
}

/** Reloads reassignments from Fleet after a restart (exact: the original picks are stored there). */
export async function recomputeReassignments(ctx: RunContext): Promise<ReadonlyMap<string, number>> {
  const snap = await call(ctx, () => ctx.actors.fleet.snapshot());
  const map = new Map<string, number>();
  for (const r of snap.reassignments ?? []) map.set(r.fn, Number(r.toSlot));
  reassigned.set(ctx, map);
  return map;
}

async function failSlot(ctx: RunContext, ref: AgentRef, reason: RetireReason, why?: string): Promise<void> {
  const r = await call(ctx, () => ctx.actors.fleet.setStatus(String(ref.slot), ref.gen, "failed"));
  if (!r.ok && r.reason !== "invalid_transition") ctx.deps.log(`[retire] setStatus failed for slot ${ref.slot}: ${r.reason}`);
  publishStatus(ctx, ref, "failed", 0, why ?? `generation limit (${ctx.caps.generations_per_slot}) reached after ${reason}`);
  const fn = slotFn(ctx, ref.slot);
  const to = fn ? await pickReassignee(ctx, ref.slot) : null;
  if (fn && to) {
    await call(ctx, () => ctx.actors.fleet.reassign(fn.name, String(to.slot), String(ref.slot)));
    const map = new Map(reassignments(ctx));
    map.set(fn.name, to.slot);
    reassigned.set(ctx, map);
    if (to.done) {
      // Its loop already returned "done": clear the marker and start a new loop for the reassigned function.
      await call(ctx, () => ctx.actors.fleet.clearDone(String(to.slot)));
      if (ctx.restartSlot) ctx.restartSlot(to.slot, to.gen);
      else ctx.deps.log(`[retire] ${to.name} had finished and no restart hook is set; ${fn.name} waits for a restart`);
    }
    publishStatus(ctx, to, to.status, 0, `reassigned ${fn.name} from failed slot ${ref.slot}`);
    ctx.deps.log(`[retire] slot ${ref.slot} failed; ${fn.name} reassigned to ${to.name}${to.done ? " (loop restarted)" : ""}`);
  } else {
    ctx.deps.log(`[retire] slot ${ref.slot} failed; no active agent to take ${fn?.name ?? "its subtask"}`);
  }
}

/**
 * Protocol step 6 (file side): nothing unverified carries over. Writes the slot's function file back to its
 * last verified checkpoint (from the handoff) or the starter. Idempotent, so a resumed retire repeats it.
 */
function restoreSlotFile(ctx: RunContext, ref: AgentRef, handoff: Handoff) {
  const fn = slotFn(ctx, ref.slot);
  if (!fn || !existsSync(ctx.workDir)) return;
  try {
    const cp = handoff.checkpoints.find((c) => c.fn === fn.name)?.code;
    const starter = join(ctx.task.dir, "starter", fn.file);
    const code = cp ?? (existsSync(starter) ? readFileSync(starter, "utf8") : null);
    if (code !== null) writeFileSync(join(ctx.workDir, fn.file), code);
  } catch (e) {
    ctx.deps.log(`[retire] restoring ${fn.file} for ${ref.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- step 7: respawn ----------

async function respawn(ctx: RunContext, old: AgentRef, handoff: Handoff): Promise<AgentRef> {
  const next = refOf(ctx, old.slot, old.gen + 1);
  const oldState = await call(ctx, () => ctx.actors.agent(String(old.slot), old.gen).state());
  const info = oldState.info;
  const fn = slotFn(ctx, old.slot);
  const agent = ctx.actors.agent(String(next.slot), next.gen);
  await call(ctx, () =>
    agent.init({
      runId: ctx.runId,
      slot: String(next.slot),
      gen: next.gen,
      task: info?.task ?? fn?.name ?? "",
      persona: info?.persona ?? "",
      handoff: handoff as unknown as Record<string, unknown>,
    }),
  );
  const channels = [relayNames.fleet(ctx.runId), relayNames.cases(ctx.runId)];
  const register = async () => {
    const reg = await ctx.relay.registerAgent(next.name, channels);
    const r = await call(ctx, () => agent.setRelay(next.gen, reg.name, reg.token));
    if (!r.ok) ctx.deps.log(`[retire] setRelay for ${next.name}: ${r.reason}`);
  };
  try {
    await register();
  } catch (e) {
    if (!(e instanceof RelayNameConflictError)) throw e;
    // Registered before a crash: reconnect with the token stored in the Agent actor.
    const st = await call(ctx, () => agent.state());
    const token = st.info?.relayToken;
    if (token) {
      await ctx.relay.reconnect(token, channels);
    } else {
      // The crash came between register and setRelay: release the orphaned identity and register again.
      // If the engine still refuses the name, this throws and the protocol fails the slot (never stuck retiring).
      ctx.deps.log(`[retire] ${next.name} registered but its token was never stored; releasing and re-registering`);
      await ctx.relay.release(next.name);
      await register();
    }
  }
  return next;
}

// ---------- protocol ----------

/** Steps 2 (abort + close; idempotent). */
async function stopGeneration(ctx: RunContext, ref: AgentRef, reason: RetireReason) {
  ctx.abort.get(ref.slot)?.abort(new Error(`retired: ${reason}`));
  ctx.abort.delete(ref.slot);
  ctx.pendingFaults.delete(ref.slot); // drop queued faults/output of this generation
  const r = await call(ctx, () => ctx.actors.agent(String(ref.slot), ref.gen).close(ref.gen, reason));
  if (!r.ok) ctx.deps.log(`[retire] Agent.close ${ref.name}: ${r.reason}`);
}

/** Steps 3-9, shared by retireAgent and resumeRetire. `evidence` null => rebuild from the stored case. */
async function protocolFrom3(ctx: RunContext, ref: AgentRef, reason: RetireReason, evidence: Evidence | null): Promise<RetireResult> {
  const caseId = caseIdOf(ctx, ref.slot, ref.gen);
  // 3. Release the Relay identity (idempotent).
  try {
    await ctx.relay.release(ref.name);
  } catch (e) {
    ctx.deps.log(`[retire] relay.release ${ref.name}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4 + 5. Case file (skip the writer when the case is already filed).
  const existing = await call(ctx, () => ctx.actors.cases.get(caseId));
  let caseFile: CaseFile;
  if (existing) {
    caseFile = caseFromActor(ctx, existing);
  } else {
    const ev = evidence ?? (await evidenceFromAgent(ctx, ref, reason));
    caseFile = await buildCaseFile(ctx, ref, reason, ev);
    await fileCase(ctx, ref, reason, caseFile, { failedTests: ev.failedTests, fault: ev.fault, mock: ctx.deps.mock.jev || ctx.deps.mock.llm });
  }
  setStages(ctx, ref.slot, { caseFiledAt: Date.now() });
  if (ctx.herd && caseFile.lesson) pushLessonNow(ctx, ref, caseFile);

  // 6. Handoff (verified checkpoints only); the shared file goes back to verified code or the starter.
  const handoff = await buildHandoff(ctx, ref, caseFile);
  if (!ctx.dirtyRespawn) restoreSlotFile(ctx, ref, handoff);

  // 7. Generation limit, else respawn.
  let newRef: AgentRef | null = null;
  if (ref.gen >= ctx.caps.generations_per_slot) {
    await failSlot(ctx, ref, reason);
  } else {
    try {
      newRef = await respawn(ctx, ref, handoff);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.deps.log(`[retire] respawn of slot ${ref.slot} failed (${msg}); failing the slot so the run can end`);
      await failSlot(ctx, ref, reason, `respawn failed: ${msg.slice(0, 160)}`);
    }
  }
  if (newRef) {
    // 8. Fleet.completeRetire -> probation.
    const r = await call(ctx, () => ctx.actors.fleet.completeRetire(String(ref.slot), ref.gen, { relayName: newRef!.name }));
    if (!r.ok) ctx.deps.log(`[retire] completeRetire ${ref.name}: ${r.reason}`);
    setStages(ctx, ref.slot, { respawnedAt: Date.now() });
    publishStatus(ctx, ref, "retired", 0, reason);
    publishStatus(ctx, newRef, "probation", 0, `replaces ${ref.name}`, freshCard(ctx, newRef, "probation"));
    caseFile = { ...caseFile, replacement: newRef.name };
  }

  // 9. Broadcast (herd publishes case.created with recipients). Baseline / herd failure: publish here.
  let published = false;
  if (ctx.herd) {
    try {
      const { recipients } = await retireDeps.broadcastCase(ctx, caseFile);
      caseFile = { ...caseFile, recipients: recipients.map((r) => r.name) };
      published = true;
    } catch (e) {
      ctx.deps.log(`[retire] broadcastCase ${caseId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!published) ctx.bus.publish({ type: "case.created", runId: ctx.runId, ts: Date.now(), case: caseFile, ...mockFlag(ctx) });
  return { newRef, caseId };
}

/**
 * Retires ref and respawns its slot (BUILD_SPEC protocol steps 1-9, each safe to repeat).
 * Step 1 guard: beginRetire not ok -> {newRef: null} and nothing else (someone else handles it).
 * The "recovery" event is published later via markTestsPassing (worker, when the slot's tests pass again).
 */
export async function retireAgent(ctx: RunContext, ref: AgentRef, reason: RetireReason, evidence: Evidence): Promise<RetireResult> {
  const caseId = caseIdOf(ctx, ref.slot, ref.gen);
  // 1. Guard against double retires.
  const begun = await call(ctx, () => ctx.actors.fleet.beginRetire(String(ref.slot), ref.gen, reason));
  if (!begun.ok) {
    ctx.deps.log(`[retire] ${ref.name} not retired by this caller: ${begun.reason}`);
    return { newRef: null, caseId };
  }
  setStages(ctx, ref.slot, { detectedAt: evidence.detectedAt, retireBeganAt: Date.now() });
  publishStatus(ctx, ref, "retiring", 0, reason);
  // 2. Abort in-flight call, close the generation.
  await stopGeneration(ctx, ref, reason);
  return protocolFrom3(ctx, ref, reason, evidence);
}

/** Evidence for a resumed retire whose case was never filed: the Agent's last step claims, category "other". */
async function evidenceFromAgent(ctx: RunContext, ref: AgentRef, reason: RetireReason): Promise<Evidence> {
  const st = await call(ctx, () => ctx.actors.agent(String(ref.slot), ref.gen).state());
  const last = st.steps.at(-1);
  const claim = last ? [last.summary, ...last.claims].filter(Boolean).join(" | ") : `(no step logged; retired for ${reason})`;
  return {
    claim,
    category: reason === "conflicting_instruction" ? "conflicting_instruction" : "other",
    detectedAt: st.closed?.at ?? Date.now(),
  };
}

/**
 * Reconcile path for a slot left in "retiring": resumes from step 3 using what the actors hold.
 * A slot that is not retiring is returned as-is (newRef = its current generation if active).
 */
export async function resumeRetire(ctx: RunContext, slot: number): Promise<RetireResult> {
  const snap = await call(ctx, () => ctx.actors.fleet.snapshot());
  const s = snap.slots.find((x) => Number(x.slot) === slot);
  if (!s) throw new Error(`resumeRetire: slot ${slot} not in Fleet ${ctx.runId}`);
  if (s.status !== "retiring") {
    const active = ["trusted", "probation", "under_investigation"].includes(s.status);
    return { newRef: active ? refOf(ctx, slot, s.gen) : null, caseId: caseIdOf(ctx, slot, Math.max(1, s.gen - 1)) };
  }
  const ref = refOf(ctx, slot, s.gen);
  const reason = (RETIRE_REASONS as readonly string[]).includes(s.reason ?? "") ? (s.reason as RetireReason) : "stuck";
  ctx.deps.log(`[retire] resuming retire of ${ref.name} (${reason}) from step 3`);
  // Real start of this retire from Fleet (beginRetire); never the resume time. Detection time is not stored,
  // so detectedAt stays null (unknown) on a resumed retire.
  setStages(ctx, slot, { retireBeganAt: s.retireStartedAt ?? null });
  // Step 2 is repeated (idempotent) so the generation is closed even if the crash came before it.
  await stopGeneration(ctx, ref, reason);
  return protocolFrom3(ctx, ref, reason, null);
}

// ---------- probation and recovery helpers (called by the worker) ----------

const verifiedCounts = new WeakMap<RunContext, Map<string, number>>();

/**
 * Worker calls this after every verified step (code passed its tests). On probation, after
 * thresholds.probation_verified_steps verified steps the slot becomes trusted (Fleet.setStatus) and
 * "agent.status" is published. Pass `count` when the caller knows the generation's verified-step total
 * (e.g. rebuilt after a restart); otherwise an in-memory counter is used (resets on restart, which only
 * keeps an agent on probation longer). Returns the status after the call.
 */
export async function noteVerifiedStep(ctx: RunContext, ref: AgentRef, step: number, count?: number): Promise<{ status: AgentStatus | null; verifiedSteps: number }> {
  const key = `${ref.slot}.g${ref.gen}`;
  const map = verifiedCounts.get(ctx) ?? new Map<string, number>();
  const n = count ?? (map.get(key) ?? 0) + 1;
  verifiedCounts.set(ctx, new Map(map).set(key, n));
  const snap = await call(ctx, () => ctx.actors.fleet.snapshot());
  const s = snap.slots.find((x) => Number(x.slot) === ref.slot);
  if (!s || s.gen !== ref.gen) return { status: null, verifiedSteps: n };
  if (s.status !== "probation" || n < ctx.cfg.thresholds.probation_verified_steps) return { status: s.status, verifiedSteps: n };
  const r = await call(ctx, () => ctx.actors.fleet.setStatus(String(ref.slot), ref.gen, "trusted"));
  if (!r.ok) return { status: s.status, verifiedSteps: n };
  publishStatus(ctx, ref, "trusted", step, `${n} verified steps on probation`);
  return { status: "trusted", verifiedSteps: n };
}

/**
 * Worker calls this when a slot's tests pass. If the slot has an open recovery (a retire happened and
 * the replacement had not passed yet), sets testsPassingAt and publishes "recovery" with
 * ms = testsPassingAt - detectedAt. Returns the event payload or null when nothing was open.
 */
export function markTestsPassing(ctx: RunContext, ref: AgentRef, at = Date.now()): { caseId: CaseId; ms: number; stages: RecoveryStages } | null {
  const cur = ctx.recovery.get(ref.slot);
  if (!cur || cur.respawnedAt == null || cur.testsPassingAt != null || ref.gen < 2) return null;
  const st: RecoveryStages = { ...cur, testsPassingAt: at };
  ctx.recovery.delete(ref.slot);
  const caseId = caseIdOf(ctx, ref.slot, ref.gen - 1);
  const start = cur.detectedAt ?? cur.retireBeganAt;
  if (start == null) {
    // No measured start (e.g. resumed retire without a stored begin time): publish nothing rather than invent one.
    ctx.recovery.delete(ref.slot);
    ctx.deps.log(`[retire] slot ${ref.slot}: recovery start unknown; no recovery event published`);
    return null;
  }
  const ms = at - start;
  ctx.bus.publish({ type: "recovery", runId: ctx.runId, ts: at, caseId, ms, slot: ref.slot, stages: st, ...mockFlag(ctx) });
  return { caseId, ms, stages: st };
}

/**
 * Run end: a respawned slot whose function passes the final pytest closes its open recovery at that
 * moment (a replacement can hit its step cap without an in-loop verified step although its code passes;
 * without this the dashboard's recovery clock never stops). Returns how many recoveries were closed.
 */
export async function closeRecoveriesOnFinalTests(ctx: RunContext, passingFns: ReadonlySet<string>, at = Date.now()): Promise<number> {
  const open = [...ctx.recovery].filter(([, st]) => st.respawnedAt != null && st.testsPassingAt == null);
  if (!open.length) return 0;
  const snap = await call(ctx, () => ctx.actors.fleet.snapshot());
  let closed = 0;
  for (const [slot] of open) {
    const fn = slotFn(ctx, slot);
    const s = snap.slots.find((x) => Number(x.slot) === slot);
    if (fn && s && passingFns.has(fn.name) && markTestsPassing(ctx, refOf(ctx, slot, s.gen), at)) closed++;
  }
  return closed;
}

/** Records when an injected fault fired (faults.ts / worker), so the recovery event can show faultAt. */
export function markFaultFired(ctx: RunContext, slot: number, at = Date.now()): void {
  setStages(ctx, slot, { faultAt: at });
}

/**
 * Reconcile helper: protocol step 9 for cases of this run whose delivery never finished (crash between
 * Fleet.completeRetire and the end of broadcastCase). broadcastCase is idempotent (relay idempotencyKey,
 * markReceived, markBroadcast). Returns the case ids re-broadcast.
 */
export async function rebroadcastPending(ctx: RunContext): Promise<string[]> {
  if (!ctx.herd) return [];
  const [cases, snap] = await Promise.all([
    call(ctx, () => ctx.actors.cases.list({ includeRevoked: true })),
    call(ctx, () => ctx.actors.fleet.snapshot()),
  ]);
  // A slot still retiring at the case's generation will broadcast in resumeRetire (step 9): skip it here.
  const retiring = new Set(snap.slots.filter((s) => s.status === "retiring").map((s) => `${s.slot}.g${s.gen}`));
  const done: string[] = [];
  for (const c of cases) {
    if (c.runId !== ctx.runId || c.synthetic || (c as { broadcast?: boolean }).broadcast) continue;
    if (retiring.has(`${c.slot}.g${c.gen}`)) continue;
    try {
      ctx.deps.log(`[retire] case ${c.id} was filed but never delivered; broadcasting now`);
      await retireDeps.broadcastCase(ctx, caseFromActor(ctx, c));
      done.push(c.id);
    } catch (e) {
      ctx.deps.log(`[retire] re-broadcast of ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return done;
}

/** Reconcile helper: rebuild the lessons block from the case library (rule 3). */
export async function rebuildLessons(ctx: RunContext): Promise<string[]> {
  const cases = await call(ctx, () => ctx.actors.cases.list());
  // The library is fresh per run in cold mode and shared in warm mode; both keep every non-revoked lesson.
  const block = lessonsFromCases(cases.map((c) => ({ id: c.id, lesson: c.lesson || null, revoked: c.revoked, createdAt: c.createdAt })), ctx.caps.max_lessons);
  ctx.setLessons(block);
  return block;
}
