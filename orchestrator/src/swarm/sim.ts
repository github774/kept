// Per-agent state machine for the swarm simulator (local, engine-side view).
//   trusted --(flagged)--> under_investigation --(cleared)--> trusted
//   under_investigation --(retire)--> [retired -> respawn gen+1] --> probation
//   probation --(N verified steps)--> trusted
// "retired" is transient: the SwarmShard's `retire` change atomically retires the generation and
// respawns gen+1 on probation, so stale-generation writes are rejected by the shard (BUILD_SPEC rule 5).
import { rand } from "./rng.ts";
import type { SwarmAgentStatus, SwarmChange } from "./types.ts";

export interface SimAgent {
  id: string;
  index: number;
  gen: number;
  status: SwarmAgentStatus;
  probationSteps: number;
  seq: number; // per-agent change counter -> deterministic change ids
}

export interface SimRates {
  /** P(trusted agent gets flagged) per tick. */
  flag: number;
  /** P(under_investigation agent is retired) per tick. */
  retire: number;
  /** P(under_investigation agent is cleared back to trusted) per tick. */
  clear: number;
  /** Verified steps on probation before returning to trusted (config/thresholds.json probation_verified_steps). */
  probationSteps: number;
}

export const DEFAULT_RATES: SimRates = { flag: 0.04, retire: 0.4, clear: 0.3, probationSteps: 2 };

export function newAgent(prefix: string, index: number): SimAgent {
  return { id: `${prefix}.${index}`, index, gen: 1, status: "trusted", probationSteps: 0, seq: 0 };
}

export type Transition = "step" | "flag" | "clear" | "retire" | "promote";

/**
 * Decides this tick's event for `a`, mutates the local model, and returns the change to send.
 * Exactly one change per agent per tick. `change.gen` is the generation the write is made under.
 */
export function tickAgent(a: SimAgent, runId: string, seed: number, tick: number, rates: SimRates): { change: SwarmChange; transition: Transition } {
  const r = rand(seed, a.index, tick);
  const id = `${runId}:${a.id}:${a.seq++}`;
  const base = { id, agentId: a.id, gen: a.gen };
  switch (a.status) {
    case "trusted":
      if (r < rates.flag) {
        a.status = "under_investigation";
        return { change: { ...base, kind: "status", status: "under_investigation" }, transition: "flag" };
      }
      return { change: { ...base, kind: "step" }, transition: "step" };
    case "under_investigation":
      if (r < rates.retire) {
        a.gen += 1;
        a.status = "probation";
        a.probationSteps = 0;
        return { change: { ...base, kind: "retire" }, transition: "retire" };
      }
      if (r < rates.retire + rates.clear) {
        a.status = "trusted";
        return { change: { ...base, kind: "status", status: "trusted" }, transition: "clear" };
      }
      return { change: { ...base, kind: "step" }, transition: "step" };
    case "probation":
      if (a.probationSteps >= rates.probationSteps) {
        a.status = "trusted";
        a.probationSteps = 0;
        return { change: { ...base, kind: "status", status: "trusted" }, transition: "promote" };
      }
      a.probationSteps += 1;
      return { change: { ...base, kind: "step" }, transition: "step" };
  }
}
