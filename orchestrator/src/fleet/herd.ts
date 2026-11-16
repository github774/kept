// Fleet-wide herd immunity: replaces runtime/herd.ts broadcastCase for fleet teams only (seams.ts routes by
// ctx). Same protocol, wider net:
//  - recipients: agents on the SAME function in other teams first (top-N by embedding similarity, agents
//    still working before finished ones; no Jev gate, so a case always opens a thread when another team
//    has that function), then same-trap-family / other functions filtered by Jev lesson_relevant;
//  - the lesson goes into the prompts of the case's team and every team with a recipient (so teams the
//    caucus did not reach form the control group of the wave-2 re-poison probe);
//    at most `caseRecipients` per case;
//  - one thread root (the source team warden's post on cases-<team>) cc'd to every recipient, so the
//    3-reply cap (caps.replies_per_case_thread) holds for the whole fleet;
import type { CaseFile } from "../contract.ts";
import { withRetry } from "../actors.ts";
import { cosine } from "../embeddings.ts";
import { relayNames, type RelayMeta } from "../relay/bus.ts";
import { caseSummary, embedCached, ensureWarden, herdCache, publishFeed } from "../runtime/herd.ts";
import { fnForSlot } from "../runtime/faults.ts";
import type { AgentRef, RunContext, TaskFn } from "../runtime/types.ts";
import { jevCheck, noul } from "../verify.ts";
import type { FleetBus } from "./bus.ts";

const ACTIVE = new Set(["trusted", "probation", "under_investigation"]);

export interface FleetHerdHost {
  apt: number;
  bus: FleetBus;
  caseRecipients: number;
  /** Live teams (started), with their contexts. */
  teams(): { team: number; ctx: RunContext }[];
  teamOf(ctx: RunContext): number;
  /** Agent loop finished with "done" (lower priority as recipient). */
  isDone(agent: number): boolean;
  /** Cached slot rows of a team (refreshed every tick), or null to read the shard. */
  slots(team: number): { slot: string; gen: number; status: string }[] | null;
  /** Agent loop is running now (it will read the routed case in its next step). */
  isRunning(agent: number): boolean;
  /** Restart a finished agent's loop (for one more step: read the case, reply). */
  wake(agent: number, why: string): Promise<boolean>;
  /** Lesson into the prompts of these teams (the case's team + every team with a recipient). */
  addLesson(teams: number[], lesson: string): void;
  log(line: string): void;
}

/** Trap families of a function (task.json traps[].family), e.g. amount_cents on parse_line + total_by_customer. */
function familiesOf(ctx: RunContext, fn: string): Set<string> {
  return new Set(ctx.task.traps.filter((t) => (t as { function?: string }).function === fn).map((t) => (t as { family?: string }).family ?? t.id));
}

interface Cand {
  team: number;
  slot: number;
  gen: number;
  ctx: RunContext;
  fn: TaskFn;
  name: string;
}

export async function fleetBroadcastCase(host: FleetHerdHost, src: RunContext, caseFile: CaseFile): Promise<{ recipients: AgentRef[] }> {
  const srcTeam = host.teamOf(src);
  const scope = { slot: caseFile.slot, gen: caseFile.gen, step: `herd.${caseFile.id}` };
  const lesson = caseFile.lesson && caseFile.lesson.trim() !== "NO_LESSON" ? caseFile.lesson.trim() : null;

  const chosen: Cand[] = [];
  if (lesson) {
    const caseFn = src.task.functions.find((f) => f.name === caseFile.subtask) ?? fnForSlot(src, caseFile.slot);
    const families = familiesOf(src, caseFn.name);
    const cands: Cand[] = [];
    for (const { team, ctx } of host.teams()) {
      // Slot rows from the runner's per-tick shard cache (one bulk read per shard); a snapshot per team
      // (250 RPCs per case) never finished under 1,000-agent load.
      const rows = host.slots(team) ?? (await withRetry(() => ctx.actors.fleet.snapshot())).slots;
      for (const s of rows) {
        const slot = Number(s.slot);
        if (!ACTIVE.has(s.status) || (team === srcTeam && slot === caseFile.slot)) continue;
        cands.push({ team, slot, gen: s.gen, ctx, fn: fnForSlot(ctx, slot), name: relayNames.agent(ctx.runId, slot, s.gen) });
      }
    }
    if (cands.length) {
      const subgoals = [...new Set(cands.map((c) => c.fn.subgoal))];
      const caseText = `${caseFile.claim}\n${lesson}`;
      const vecs = await embedCached(src, [caseText, ...subgoals], scope);
      const sim = new Map(subgoals.map((sg, i) => [sg, cosine(vecs[0]!, vecs[i + 1]!)]));
      const g = (c: Cand) => c.team * host.apt + c.slot;
      const rank = (xs: Cand[]) =>
        xs
          .map((c) => ({ c, score: (sim.get(c.fn.subgoal) ?? 0) + (host.isRunning(g(c)) ? 1 : 0) + (host.isDone(g(c)) ? -1 : 0) }))
          .sort((a, b) => b.score - a.score || Math.abs(b.c.team - srcTeam) - Math.abs(a.c.team - srcTeam) || g(a.c) - g(b.c))
          .map((x) => x.c);
      // 1. Same function in other teams: always related (same subgoal, same trap). No Jev gate.
      for (const c of rank(cands.filter((c) => c.team !== srcTeam && c.fn.name === caseFn.name))) {
        if (chosen.length >= host.caseRecipients) break;
        chosen.push(c);
      }
      // 2. Same trap family on another function, then other functions: Jev lesson_relevant filters them
      //    (one check per distinct function), ranked by embedding similarity.
      if (chosen.length < host.caseRecipients) {
        const rest = cands.filter((c) => c.fn.name !== caseFn.name && (sim.get(c.fn.subgoal) ?? 0) >= src.cfg.thresholds.case_similarity);
        const famFirst = [...rest.filter((c) => families.size && [...familiesOf(c.ctx, c.fn.name)].some((f) => families.has(f))), ...rest];
        const relevant = new Map<string, boolean>();
        for (const c of rank([...new Set(famFirst)])) {
          if (chosen.length >= host.caseRecipients) break;
          const k = `${c.fn.name}::${c.fn.subgoal}`;
          if (!relevant.has(k)) {
            const r = noul(await jevCheck(src, scope, "lesson_relevant", { lesson, subtask: `${c.fn.name}: ${c.fn.subgoal}` }));
            relevant.set(k, r.probability >= src.cfg.thresholds.lesson_relevant);
          }
          if (relevant.get(k)) chosen.push(c);
        }
      }
    }
  } else {
    host.log(`[fleet herd] case ${caseFile.id} has no lesson; posted without recipients`);
  }

  const names = chosen.map((c) => c.name);
  // Recipients are cached in every team context that holds one (readInbox filters case posts by it).
  for (const ctx of new Set([src, ...chosen.map((c) => c.ctx)])) herdCache(ctx).recipients.set(caseFile.id, names);

  const warden = await ensureWarden(src);
  const text = caseSummary(caseFile) + (names.length ? ` For: ${names.join(", ")}` : "");
  const meta: RelayMeta = { runId: src.runId, slot: caseFile.slot, gen: caseFile.gen, caseId: caseFile.id, kind: "case" };
  const msg = await host.bus.send({
    fromName: warden,
    to: `#${relayNames.cases(src.runId)}`,
    cc: names,
    text,
    idempotencyKey: `${caseFile.id}.broadcast`,
    metadata: meta,
    gen: caseFile.gen,
    isCurrentGen: () => true,
  });
  for (const ctx of new Set([src, ...chosen.map((c) => c.ctx)])) herdCache(ctx).caseRoot.set(caseFile.id, msg.id);
  for (const n of names) await withRetry(() => src.actors.cases.markReceived(caseFile.id, n));
  await withRetry(() => src.actors.cases.markBroadcast(caseFile.id, msg.id));

  if (lesson) host.addLesson([srcTeam, ...chosen.map((c) => c.team)], lesson);
  // Caucus: a finished recipient's loop has ended, so it would never read the case. Wake same-function
  // recipients (up to the thread cap) so the thread gets replies from the agents the lesson is about.
  let woken = 0;
  for (const c of chosen) {
    const g = c.team * host.apt + c.slot;
    if (woken >= src.caps.replies_per_case_thread) break;
    if (!host.isRunning(g) && (await host.wake(g, `case ${caseFile.id} routed to it`))) woken++;
  }

  publishFeed(src, msg, "case", { threadId: msg.id });
  src.bus.publish({
    type: "case.created",
    runId: src.runId,
    ts: Date.now(),
    case: { ...caseFile, recipients: names, replies: caseFile.replies ?? [] },
    ...(src.deps.mock.jev || src.deps.mock.embed || src.deps.mock.llm ? { mock: true as const } : {}),
  });
  return { recipients: chosen.map((c) => ({ slot: c.slot, gen: c.gen, name: c.name })) };
}
