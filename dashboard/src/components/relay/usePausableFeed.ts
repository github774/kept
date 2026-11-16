import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent } from "react";
import type { RelayMessage } from "../../data/model";

const EMPTY: RelayMessage[] = [];

/**
 * Newest-first view of the relay that freezes while the pointer is over the
 * feed or keyboard focus is inside it, so a row never moves out from under a
 * reader. Mouse clicks do not hold the pause (a presenter who clicks a case
 * row and walks away gets a live feed back). `pending` counts messages that
 * arrived while frozen. Spread `handlers` and `ref` on the feed container.
 */
export function usePausableFeed(relay: RelayMessage[] | undefined) {
  const incoming = useMemo(
    () => (relay && relay.length ? relay.toSorted((a, b) => b.ts - a.ts) : EMPTY),
    [relay],
  );

  // Batch inserts: the feed takes new messages at most every 2 s, so a burst moves the list once,
  // not once per message (fewer layout shifts while someone is reading Details).
  const [live, setLive] = useState(incoming);
  const applied = useRef(0);
  useEffect(() => {
    if (incoming === live) return;
    const wait = live.length === 0 ? 0 : Math.max(0, 2000 - (Date.now() - applied.current));
    const t = window.setTimeout(() => {
      applied.current = Date.now();
      setLive(incoming);
    }, wait);
    return () => window.clearTimeout(t);
  }, [incoming, live]);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [frozen, setFrozen] = useState<RelayMessage[] | null>(null);
  const paused = hovered || focused;

  // Capture the list at the moment the pause starts; release it when it ends.
  // Adjusting state during render (not in an effect) avoids a frame of drift.
  if (paused && frozen === null) setFrozen(live);
  if (!paused && frozen !== null) setFrozen(null);

  const shown = frozen ?? live;

  const pending = useMemo(() => {
    if (!frozen) return 0;
    const seen = new Set(frozen.map((m) => m.id));
    let n = 0;
    for (const m of live) if (!seen.has(m.id)) n++;
    return n;
  }, [frozen, live]);

  // Rows that mount after the first non-empty commit are "new" and may animate.
  // This must flip after that commit (rows capture it at mount), so it is an
  // effect on purpose; deriving it during render would animate the backlog.
  const [primed, setPrimed] = useState(false);
  const hasRows = live.length > 0;
  useEffect(() => {
    if (hasRows) setPrimed(true);
  }, [hasRows]);

  const ref = useRef<HTMLDivElement>(null);

  // "Show N new": catch the frozen view up without un-pausing. The button that
  // calls this unmounts once nothing is pending, so park focus on the
  // container instead of letting it fall to <body> with no blur event.
  const catchUp = useCallback(() => {
    if (!paused) return;
    setFrozen(live);
    ref.current?.focus({ preventScroll: true });
  }, [paused, live]);

  const handlers = useMemo(
    () => ({
      onPointerEnter: () => setHovered(true),
      onPointerLeave: (e: { currentTarget: HTMLElement }) => {
        setHovered(false);
        // Re-check focus: a focused node that was removed fires no blur.
        const active = document.activeElement;
        if (!active || !e.currentTarget.contains(active) || !active.matches(":focus-visible")) setFocused(false);
      },
      onFocus: (e: FocusEvent<HTMLElement>) => {
        setFocused(e.target.matches(":focus-visible"));
      },
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      },
    }),
    [],
  );

  return { shown, paused, pending, primed, catchUp, handlers, ref, total: live.length };
}
