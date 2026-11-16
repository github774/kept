// Herd-immunity signals as native Relay reactions, posted by the run's warden identity:
//   ✅ on a case's root post once a recipient adopts the lesson (its case reply was recorded),
//   🚫 on a teammate message that Jev blocked before delivery.
// Best effort: a reaction is a visible signal, never load-bearing, so these never throw.
// The observer (observer.ts) sees them come back as `message.reacted` and puts them on the feed.
import { relayNames, type RelayBus } from "./bus.ts";

export const RELAY_REACTIONS = { adopted: "✅", blocked: "🚫" } as const;

export type ReactResult = { ok: true } | { ok: false; reason: string };

async function reactAsWarden(relay: RelayBus, runId: string, messageId: string | undefined | null, emoji: string): Promise<ReactResult> {
  if (!messageId) return { ok: false, reason: "no Relay message id (message never reached Relay)" };
  if (!relay.react) return { ok: false, reason: "bus has no react()" };
  try {
    await relay.react({ fromName: relayNames.warden(runId), messageId, emoji });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** ✅ on the case thread root (the warden's case post) when a recipient's reply is recorded. */
export function reactLessonAdopted(relay: RelayBus, runId: string, caseRootMessageId: string | undefined | null): Promise<ReactResult> {
  return reactAsWarden(relay, runId, caseRootMessageId, RELAY_REACTIONS.adopted);
}

/** 🚫 on a Relay message that was blocked before delivery (inbound Jev check). */
export function reactBlocked(relay: RelayBus, runId: string, relayMessageId: string | undefined | null): Promise<ReactResult> {
  return reactAsWarden(relay, runId, relayMessageId, RELAY_REACTIONS.blocked);
}
