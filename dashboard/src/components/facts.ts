// One source of truth for the numbers that appear in more than one place (header, side column,
// cards, fleet view). Every component that shows one of these reads it from here.
import { useEffect, useMemo, useRef, useState } from "react";
import { useCase, useDashboard, useFleetStats, type AgentSlot, type CaseFile, type CaseSummary, type Recovery } from "../data";
import { newestCase } from "./case/newestCase";
import { FLEET_TEAM_SIZE, MAX_LIVE_RECOVERY_MS, parseAgentId, recoveryStart } from "./names";

/** More agents than this and the run is a fleet-scale run. */
export const TEAM_MAX = 4;

/** Spend for the whole screen: fleet stats on a fleet run, else the ledger (worker + overhead), else the run. */
export function useSpentUsd(): number | null {
  const { snapshot } = useDashboard();
  const { current } = useFleetStats();
  const run = snapshot?.run ?? null;
  if (run && run.agents > TEAM_MAX && current) return current.usd;
  const ledger = snapshot?.ledger ?? null;
  return ledger ? ledger.workerUsd + ledger.overheadUsd : (run?.usd ?? null);
}

/** Elapsed run time in ms: the fleet's own clock on a fleet run, else wall clock since startedAt (never negative). */
export function useRunElapsedMs(now: number): number | null {
  const { snapshot } = useDashboard();
  const { current } = useFleetStats();
  const run = snapshot?.run ?? null;
  if (!run) return null;
  if (run.agents > TEAM_MAX && current) return current.elapsedMs;
  return run.startedAt == null ? null : Math.max(0, now - run.startedAt);
}

/**
 * The recovery the screen talks about: the newest one with a usable clock start. One that has been
 * "running" for longer than a live catch could (a leftover from an earlier replay loop) is ignored.
 */
export function useCurrentRecovery(now: number, slots?: number[] | null): Recovery | null {
  const { snapshot } = useDashboard();
  const startedAt = snapshot?.run?.startedAt ?? null;
  const slotKey = slots ? slots.join(",") : null;
  return useMemo(() => {
    const only = slotKey == null ? null : new Set(slotKey.split(",").map(Number));
    const all = (snapshot?.recoveries ?? [])
      .filter((r) => only == null || only.has(r.slot))
      .map((r) => ({ r, start: recoveryStart(r, startedAt) }))
      .filter((x): x is { r: Recovery; start: number } => x.start != null)
      .filter((x) => x.r.testsPassAt != null || now - x.start < MAX_LIVE_RECOVERY_MS)
      .toSorted((a, b) => b.start - a.start);
    return all.find((x) => x.r.testsPassAt == null)?.r ?? all[0]?.r ?? null;
    // `now` only matters for the staleness cut, which a 1 s resolution covers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.recoveries, startedAt, slotKey, Math.floor(now / 1000)]);
}

/** The newest case, its file, and the slots its lesson reached (recipients and repliers, not the source). */
export function useImmunity(team?: number[] | null): { caseSummary: CaseSummary | null; file: CaseFile | null; source: number | null; targets: number[] } {
  const { snapshot } = useDashboard();
  // On a fleet run's stage, the newest case of the team on stage (its lesson, its lines).
  const teamKey = team ? team.join(",") : null;
  const c = useMemo(() => {
    if (teamKey == null) return newestCase(snapshot?.cases);
    const mine = new Set(teamKey.split(",").map(Number));
    return newestCase(snapshot?.cases?.filter((x) => mine.has(x.slot)));
  }, [snapshot?.cases, teamKey]);
  const { data: file } = useCase(c?.id ?? null);
  return useMemo(() => {
    if (!c || !file) return { caseSummary: c, file: file ?? null, source: c?.slot ?? null, targets: [] };
    const names = [...file.recipients.map((r) => r.agentName), ...(file.replies ?? []).map((r) => r.from)];
    const targets = new Set<number>();
    for (const n of names) {
      const id = parseAgentId(n);
      if (id && id.slot !== c.slot) targets.add(id.slot);
    }
    return { caseSummary: c, file, source: c.slot, targets: [...targets].sort((a, b) => a - b) };
  }, [c, file]);
}

/** How long the Team view stays on one fleet team before it may follow a newer catch elsewhere (or the presenter presses "Next caught team"). */
const TEAM_HOLD_MS = 15_000;

export interface StageRoster {
  /** The agents on stage: the whole roster for a 4-agent run, one team of four for a fleet run. */
  agents: AgentSlot[];
  /** Fleet runs only: the team on stage (0-based) and how many teams there are. */
  team: number | null;
  teams: number;
  fleet: boolean;
  /** Fleet runs: a lie has been caught in the team on stage. */
  caught: boolean;
  /** Fleet runs: a newer catch is waiting in another team; `next()` moves the stage there now. */
  canNext: boolean;
  next(): void;
}

/**
 * The agents the Team view puts on stage. A fleet run has a thousand: the stage shows the team of four
 * where the newest lie was caught (or a possessed agent, or team 1 before anything happens), and holds it
 * for 10 s so the stage never flickers between teams while catches stream in.
 */
export function useStageRoster(): StageRoster {
  const { snapshot } = useDashboard();
  const roster = snapshot?.roster ?? EMPTY_ROSTER;
  const fleet = roster.length > TEAM_MAX;
  const cases = snapshot?.cases;
  const c = newestCase(cases);
  const possessed = fleet ? roster.find((a) => a.possessed) : undefined;
  const candidate = !fleet ? 0 : c ? Math.floor(c.slot / FLEET_TEAM_SIZE) : possessed ? Math.floor(possessed.slot / FLEET_TEAM_SIZE) : 0;

  const [held, setHeld] = useState(() => ({ team: candidate, at: Date.now() }));
  const latest = useRef(candidate);
  // A team with no catch of its own yet gives way at once; one that has a catch on show is held 10 s.
  const heldHasCase = (cases ?? []).some((x) => Math.floor(x.slot / FLEET_TEAM_SIZE) === held.team);
  useEffect(() => {
    latest.current = candidate;
    if (!fleet || candidate === held.team) return;
    const wait = heldHasCase ? Math.max(0, TEAM_HOLD_MS - (Date.now() - held.at)) : 0;
    const t = window.setTimeout(() => setHeld({ team: latest.current, at: Date.now() }), wait);
    return () => window.clearTimeout(t);
  }, [candidate, fleet, held, heldHasCase]);

  const canNext = fleet && candidate !== held.team;
  return useMemo(() => {
    const next = () => setHeld({ team: latest.current, at: Date.now() });
    if (!fleet) return { agents: roster, team: null, teams: 1, fleet: false, caught: false, canNext: false, next };
    const teams = Math.ceil(roster.length / FLEET_TEAM_SIZE);
    const team = Math.min(held.team, teams - 1);
    const agents = roster.filter((a) => Math.floor(a.slot / FLEET_TEAM_SIZE) === team).toSorted((a, b) => a.slot - b.slot);
    return { agents, team, teams, fleet: true, caught: heldHasCase, canNext, next };
  }, [roster, fleet, held.team, heldHasCase, canNext]);
}

const EMPTY_ROSTER: AgentSlot[] = [];
