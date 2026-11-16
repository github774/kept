// The ONLY place the topology reads data-layer field names. If ../../data/model.ts changes
// shape, fix it here; engine.ts consumes the Topo* types below and nothing else.
import type { AgentSlot, AgentStatus, CaseFile, CaseSummary, Connection, Health, RelayMessage, RunInfo } from "../../data";

export interface TopoAgent {
  slot: number;
  gen: number;
  name: string;
  status: AgentStatus;
  subtask: string;
  step: number;
  verifiedSteps: number;
  possessed: boolean;
  reason: string | null; // last agent.status reason ("tests_pass claim contradicted ...")
}

export type TopoMsgKind = "status" | "note" | "note_reuse" | "case" | "case_reply" | "dm" | "revocation" | "blocked";

export interface TopoMsg {
  id: string;
  seq: number;
  kind: TopoMsgKind;
  fromName: string;
  fromSlot: number | null; // null = warden / system
  toName: string | null;
  toSlot: number | null;
  text: string;
  caseId: string | null;
  blocked: { reason: string; pct: number; source: string } | null;
  estTokens: number | null; // "≈610 output tokens, est." on note reuse
}

export interface TopoCase {
  id: string;
  createdAt: number;
  slot: number;
  gen: number;
  agentName: string;
  lesson: string | null;
  recipients: string[] | null; // agent names; null = not loaded yet
  replied: string[];
}

export interface TopoView {
  /** Changes when a new run starts: visual state resets. */
  epoch: string | null;
  runId: string | null;
  agentCount: number;
  agents: TopoAgent[];
  messages: TopoMsg[];
  cases: TopoCase[];
  jevOffline: boolean;
  connection: Connection;
  banner: string | null;
}

const NAME = /^w(\d+)-g(\d+)/;
export const slotOfName = (name: string | null | undefined): number | null => {
  const m = name ? NAME.exec(name) : null;
  return m ? Number(m[1]) : null;
};
const isAgentName = (name: string) => NAME.test(name);

export function toTopoAgent(a: AgentSlot): TopoAgent {
  return {
    slot: a.slot,
    gen: a.gen,
    name: a.name,
    status: a.status,
    subtask: a.subtask,
    step: a.step,
    verifiedSteps: a.verifiedSteps,
    possessed: a.possessed,
    reason: a.statusReason,
  };
}

const REUSE = /from (\S+) reused by (\S+)/;
const EST = /≈\s?([\d,]+)/;

export function toTopoMsg(m: RelayMessage): TopoMsg {
  const fromAgent = isAgentName(m.from);
  const metaSlot = m.meta.slot;
  let kind: TopoMsgKind;
  let fromName = m.from;
  let fromSlot: number | null = fromAgent ? (metaSlot ?? slotOfName(m.from)) : null;
  let toName: string | null = m.to ?? null;
  let toSlot: number | null = toName ? slotOfName(toName) : null;
  let estTokens: number | null = null;

  if (m.blocked) kind = "blocked";
  else if (m.kind === "case") kind = "case";
  else if (m.kind === "case_reply") kind = "case_reply";
  else if (m.kind === "revocation") kind = "revocation";
  else if (m.kind === "note" && !fromAgent) {
    // Warden reports a reuse: "verified note from w0-g1-x reused by w3-g1-x (≈610 output tokens, est.)"
    kind = "note_reuse";
    const r = REUSE.exec(m.text);
    if (r) {
      fromName = r[1]!;
      fromSlot = slotOfName(r[1]);
      toName = r[2]!;
      toSlot = slotOfName(r[2]);
    } else {
      toSlot = metaSlot;
    }
    const e = EST.exec(m.text);
    if (e) estTokens = Number(e[1]!.replace(/,/g, ""));
  } else if (m.kind === "note") kind = "note";
  else if (m.kind === "dm" || m.channel === "dm") kind = "dm";
  else kind = "status";

  return {
    id: m.id,
    seq: m.seq,
    kind,
    fromName,
    fromSlot,
    toName,
    toSlot,
    text: m.text,
    caseId: m.meta.caseId ?? null,
    blocked: m.blocked
      ? { reason: m.blocked.reason, pct: Math.round(m.blocked.check.confidence * 100), source: m.blocked.check.source === "jev" ? "Jev" : "fallback judge" }
      : null,
    estTokens,
  };
}

export function toTopoCase(c: CaseSummary, file: CaseFile | null, relay: readonly RelayMessage[]): TopoCase {
  const replied = new Set<string>();
  for (const r of relay) if (r.kind === "case_reply" && r.meta.caseId === c.id) replied.add(r.from);
  if (file) for (const r of file.recipients) if (r.reply) replied.add(r.agentName);
  return {
    id: c.id,
    createdAt: c.createdAt,
    slot: c.slot,
    gen: c.gen,
    agentName: c.agentName,
    lesson: c.lesson,
    recipients: file && file.id === c.id ? file.recipients.map((r) => r.agentName) : null,
    replied: [...replied],
  };
}

export interface TopoInputs {
  run: RunInfo | null;
  roster: AgentSlot[] | null;
  relay: RelayMessage[] | null;
  cases: CaseSummary[] | null;
  caseFiles: (CaseFile | null)[];
  health: Health | null;
  connection: Connection;
}

/** Newest case ids (the component loads their CaseFiles for recipients). */
export function newestCaseIds(cases: CaseSummary[] | null, n = 2): string[] {
  if (!cases?.length) return [];
  return [...cases].sort((a, b) => b.createdAt - a.createdAt).slice(0, n).map((c) => c.id);
}

export function toTopoView(i: TopoInputs): TopoView {
  const runId = i.run?.runId ?? null;
  const relay = (i.relay ?? []).filter((m) => !runId || m.meta.runId === runId);
  const files = new Map<string, CaseFile>();
  for (const f of i.caseFiles) if (f) files.set(f.id, f);
  const agents = (i.roster ?? []).map(toTopoAgent).sort((a, b) => a.slot - b.slot);
  return {
    // runId only: REST snapshots and live events can disagree on startedAt (the mock shifts it).
    // A replay under the same id is detected by the engine (roster and relay are cleared).
    epoch: i.run?.runId ?? null,
    runId,
    agentCount: Math.max(i.run?.agents ?? 0, agents.length, ...agents.map((a) => a.slot + 1)),
    agents,
    messages: relay.map(toTopoMsg),
    cases: (i.cases ?? []).map((c) => toTopoCase(c, files.get(c.id) ?? null, relay)),
    jevOffline: i.health?.jevOffline ?? false,
    connection: i.connection,
    banner: i.run?.banner ?? null,
  };
}
