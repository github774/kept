import { ArrowUp, MessagesSquare, Pause } from "lucide-react";
import { useEffect, useRef } from "react";
import { useDashboard } from "../data";
import { Button, EmptyState, Panel, formatInt } from "./ui";
import { newestCaseId } from "./case/newestCase";
import { RelayRow } from "./relay/RelayRow";
import { usePausableFeed } from "./relay/usePausableFeed";

/**
 * Live Relay traffic across the fleet, cases and DM channels, newest first.
 * Hovering or focusing the list freezes it so nothing moves under the reader;
 * new arrivals are counted and can be pulled in without un-pausing.
 */
export function RelayFeed() {
  const { snapshot, selectedCaseId, selectCase } = useDashboard();
  const { shown, paused, pending, primed, catchUp, handlers, ref, total } = usePausableFeed(snapshot?.relay);
  // Messages already shown never fade again; only a new one arriving in the top slot does.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const m of shown) seen.current.add(m.id);
  });
  // Highlight the case the viewer is actually showing (it defaults to the newest).
  const shownCaseId = selectedCaseId ?? newestCaseId(snapshot?.cases);

  let blockedCount = 0;
  for (const m of shown) if (m.blocked) blockedCount++;

  const meta =
    total === 0
      ? null
      : `${formatInt(total)} ${total === 1 ? "message" : "messages"}${blockedCount ? `, ${formatInt(blockedCount)} blocked` : ""}`;

  return (
    <Panel title="Message feed" meta={meta} padded={false} variant="bare">
      {shown.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="No Relay messages yet">
          Agents post status here as they work. Case files, replies, verified notes and anything Jev blocks show up as
          they happen.
        </EmptyState>
      ) : (
        <div {...handlers} ref={ref} tabIndex={-1} className="flex min-h-full flex-col outline-none">
          <ol aria-label="Relay messages, newest first" className="relative m-0 list-none p-0 before:absolute before:top-4 before:bottom-4 before:left-[0.8rem] before:w-px before:bg-line-strong">
            {shown.map((m, i) => (
              <RelayRow
                key={i}
                message={m}
                selected={m.meta.caseId != null && m.meta.caseId === shownCaseId}
                fresh={i === 0 && primed && !seen.current.has(m.id)}
                onOpenCase={selectCase}
              />
            ))}
          </ol>
          {/* Zero-height sticky host: the pause bar floats over the oldest
              visible rows, so pausing never shifts the list under the pointer. */}
          <div className="sticky bottom-0 z-10 mt-auto h-0">
            {paused && (
              <div className="absolute inset-x-2 bottom-2 flex min-h-11 animate-toast-in items-center gap-2 rounded-md bg-surface px-3 py-1.5 text-sm text-ink-2 shadow-pop">
                <Pause aria-hidden className="size-[1.05em] shrink-0 text-ink-3" strokeWidth={2.5} />
                <span>Paused while you read</span>
                {pending > 0 && (
                  <Button size="sm" variant="secondary" icon={ArrowUp} onClick={catchUp} className="ml-auto">
                    Show {formatInt(pending)} new
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {paused && pending > 0 ? `${pending} new messages while paused` : ""}
      </span>
    </Panel>
  );
}
