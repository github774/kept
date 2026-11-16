// Labels shared by the relay feed and the case viewer. Number and time
// formatting comes from ../ui (formatClock, formatPct, formatDuration).
import type { JevQuestionId, JevResult, RelayMessage } from "../../data/model";
import { speaker } from "../names";

/** The question each Jev check asks, in plain words. */
export const JEV_QUESTION: Record<JevQuestionId, string> = {
  instruction_conflicts_spec: "Does this instruction break the spec?",
  fact_contradicts_spec: "Does this fact contradict the spec?",
  note_consistent_with_spec: "Is this note consistent with the spec?",
  failure_category: "What kind of failure is this?",
  lesson_relevant: "Would this lesson change how the subtask is done?",
  subtask_difficulty: "Is this subtask routine or hard?",
};

export function jevSourceLabel(source: JevResult["source"]): string {
  if (source === "jev") return "Jev";
  if (source === "tests") return "the test run";
  return "the fallback judge";
}

/** Any sender in plain words: "w3-g2-r7k2" reads "Agent 4 (v2)", the warden "The checker". */
export function senderLabel(from: string): string {
  return speaker(from);
}

export type MessageKind = NonNullable<RelayMessage["kind"]>;

/** Older servers may omit kind; infer a sensible one from the channel. */
export function kindOf(m: RelayMessage): MessageKind {
  if (m.kind) return m.kind;
  if (m.channel === "cases") return "case";
  if (m.channel === "dm") return "dm";
  return "status";
}

export const KIND_LABEL: Record<MessageKind, string> = {
  status: "Status",
  case: "Case file",
  case_reply: "Case reply",
  note: "Verified note",
  revocation: "Revocation",
  dm: "Direct message",
};

export const CHANNEL_LABEL: Record<RelayMessage["channel"], string> = {
  fleet: "fleet",
  cases: "cases",
  dm: "DM",
};
