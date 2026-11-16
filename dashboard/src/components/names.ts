// Customer words for internal identifiers. The stage never shows `w3-g2-r7k2`, `slot` or `g2`:
// slot 3 generation 2 reads "Agent 4 (v2)". Raw IDs stay available in tooltips and the Details view.

const AGENT_ID = /^w(\d+)-g(\d+)(?:-|$)/;
/** Fleet workers: "t22w0-g1-mockfleet01" is team 22, worker 0 (teams of 4), so slot 88, "Agent 89". */
const FLEET_ID = /^@?t(\d+)w(\d+)-g(\d+)(?:-|$)/;
export const FLEET_TEAM_SIZE = 4;

/** "Agent 4" for slot 3 (slots are 0-based on the wire). */
export function agentTitle(slot: number): string {
  return `Agent ${slot + 1}`;
}

/** "Agent 4 (v2)" for slot 3 generation 2, "Agent 4 (v1)" for the first: one naming system everywhere. Pass `always = false` for the bare form. */
export function agentLabel(slot: number, gen: number, always = true): string {
  return gen > 1 || always ? `${agentTitle(slot)} (v${gen})` : agentTitle(slot);
}

/** Slot and generation from a worker name like "w3-g2-mock01"; null for anything else. */
export function parseAgentId(name: string | null | undefined): { slot: number; gen: number } | null {
  if (!name) return null;
  const m = AGENT_ID.exec(name);
  if (m) return { slot: Number(m[1]), gen: Number(m[2]) };
  const f = FLEET_ID.exec(name);
  return f ? { slot: Number(f[1]) * FLEET_TEAM_SIZE + Number(f[2]), gen: Number(f[3]) } : null;
}

/** Any sender on Relay in plain words: workers become "Agent 4 (v2)", the warden becomes "The checker". */
export function speaker(name: string | null | undefined): string {
  if (!name) return "Someone";
  const id = parseAgentId(name);
  if (id) return agentLabel(id.slot, id.gen);
  if (name.startsWith("warden")) return "The checker";
  if (name.startsWith("jev")) return "Jev";
  if (name.startsWith("orchestrator")) return "The orchestrator";
  return name;
}

/** Plain words for a failure category. */
export function categoryWords(category: string): string {
  switch (category) {
    case "false success claim":
      return "claimed its tests passed when they did not";
    case "invented API":
      return "used an API that does not exist";
    case "spec misread":
      return "misread the spec";
    case "conflicting instruction":
      return "told teammates to break the spec";
    default:
      return "failed verification";
  }
}

/** "pytest: 2 failed" from a test run's output, else its first non-empty line. */
export function testVerdict(output: string | undefined | null): string | null {
  if (!output) return null;
  const failed = /(\d+)\s+failed/i.exec(output);
  const passed = /(\d+)\s+passed/i.exec(output);
  if (failed) return `pytest: ${failed[1]} failed${passed ? `, ${passed[1]} passed` : ""}`;
  const line = output.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 80) : null;
}

const ID_IN_TEXT = /\bw(\d+)-g(\d+)-[a-z0-9]+\b/gi;
/** Case ids such as "mockfleet01.583.g1" or "mock01.3.g1": run, slot, generation. */
const CASE_ID_IN_TEXT = /\b[a-z][a-z0-9-]*\.(\d+)\.g(\d+)\b/gi;
/** "[false_success_claim]" or "(spec_misread)" read "[false success claim]". */
const CATEGORY_IN_TEXT = /([[(])([a-z]+(?:_[a-z]+)+)([\])])/g;
const FLEET_ID_IN_TEXT = /@?\bt(\d+)w(\d+)-g(\d+)-[a-z0-9]+\b/gi;
const SHORT_ID_IN_TEXT = /\bw(\d+)\b/g;

/** Message text with worker IDs rewritten: "note from w0-g1-mock01" reads "note from Agent 1". */
export function humanize(text: string): string {
  return text
    .replace(/\bcase\s+[a-z][a-z0-9-]*\.(\d+)\.g(\d+)\b/gi, (_, slot: string, gen: string) => `Case of ${agentLabel(Number(slot), Number(gen))}`)
    .replace(CASE_ID_IN_TEXT, (_, slot: string, gen: string) => `the case of ${agentLabel(Number(slot), Number(gen))}`)
    .replace(CATEGORY_IN_TEXT, (_, open: string, cat: string, close: string) => `${open}${cat.replace(/_/g, " ")}${close}`)
    .replace(FLEET_ID_IN_TEXT, (_, team: string, w: string, gen: string) => agentLabel(Number(team) * FLEET_TEAM_SIZE + Number(w), Number(gen), true))
    .replace(ID_IN_TEXT, (_, slot: string, gen: string) => agentLabel(Number(slot), Number(gen)))
    .replace(SHORT_ID_IN_TEXT, (_, slot: string) => agentTitle(Number(slot)));
}

/** A fault time more than this before detection (or before the run started) is a stale replay: ignore it. */
const MAX_FAULT_LEAD_MS = 5 * 60_000;
/** A recovery still "running" after this long is a leftover from an earlier loop, not a live catch. */
export const MAX_LIVE_RECOVERY_MS = 10 * 60_000;

type RecoveryTimes = { startAt: number | null; faultAt: number | null; detectedAt: number | null; testsPassAt: number | null; ms: number | null };

/** True when the fault time can be shown: present, after the run started, and close to the detection. */
export function faultTrusted(r: RecoveryTimes, runStartedAt?: number | null): boolean {
  if (r.faultAt == null) return false;
  if (runStartedAt != null && r.faultAt < runStartedAt - 1_000) return false;
  return r.detectedAt == null ? true : r.detectedAt >= r.faultAt && r.detectedAt - r.faultAt <= MAX_FAULT_LEAD_MS;
}

/** Where the recovery clock starts: the fault when it is trustworthy, else the detection. Null when neither is usable. */
export function recoveryStart(r: RecoveryTimes, runStartedAt?: number | null): number | null {
  if (faultTrusted(r, runStartedAt)) return r.faultAt;
  return r.detectedAt;
}

/** Recovery time as the screen states it: from the clock start to passing tests. */
export function recoveryMs(r: RecoveryTimes, runStartedAt?: number | null): number | null {
  if (r.testsPassAt == null) return null;
  const start = recoveryStart(r, runStartedAt);
  return start != null ? r.testsPassAt - start : r.ms;
}

/** How long the catch took: from a trustworthy fault to detection. */
export function catchMs(r: RecoveryTimes, runStartedAt?: number | null): number | null {
  return r.detectedAt != null && faultTrusted(r, runStartedAt) ? r.detectedAt - r.faultAt! : null;
}

/** "18.4 s", one decimal so a ticking value never changes shape. */
export function secs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** "Agent 2 and Agent 3", "Agent 1, Agent 2 and Agent 3". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
