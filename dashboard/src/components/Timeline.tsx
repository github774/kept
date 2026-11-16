import { Hourglass, MessageSquareX, Network, Search, Send, ShieldCheck, Undo2 } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useDashboard, type CaseSummary, type Recovery, type RelayMessage, type Snapshot } from "../data";
import { Note, Retired, ShieldFilled, TestTubeCheck } from "./icons";
import { useStageRoster } from "./facts";
import { setHoverSlot } from "./hover";
import { agentLabel, categoryWords, faultTrusted, humanize, parseAgentId, recoveryMs, speaker } from "./names";
import { kindOf } from "./relay/format";
import { Button, EmptyState, cn, formatClock } from "./ui";

/**
 * "What just happened" (04): one plain-English timeline merging Relay messages, case files and the
 * recovery steps, newest first. Each line is a short headline in ink and one quieter line of detail,
 * marked by its icon in a paper disc. On the stage it shows the most recent meaningful lines that fit;
 * routine status chatter is left for the Details view. Hovering freezes it so nothing moves under the
 * reader; new lines are counted and can be pulled in.
 */

type Mark = "pathogen" | "accent" | "ink" | "quiet";

interface TimelineEvent {
  id: string;
  ts: number;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  mark: Mark;
  /** The agent it is about, when there is one (a fleet run's stage follows one team). */
  slot?: number;
  /** Routine status: hidden on the stage, quiet in Details. */
  quiet?: boolean;
  title: ReactNode;
  detail?: ReactNode;
}

function secs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function recoveryEvents(r: Recovery, cases: CaseSummary[]): TimelineEvent[] {
  const who = agentLabel(r.slot, r.gen);
  const c = cases.find((x) => x.id === r.caseId);
  const out: TimelineEvent[] = [];
  if (r.faultAt != null && faultTrusted(r))
    out.push({ id: `${r.caseId}:fault`, ts: r.faultAt, icon: Note, mark: "pathogen", title: <>{who} has a bad note</>, detail: <>Told to lie on its next step.</> });
  if (r.detectedAt != null)
    out.push({
      id: `${r.caseId}:caught`,
      ts: r.detectedAt,
      icon: Search,
      mark: "pathogen",
      title: <>A lie was caught</>,
      detail: <>{who} {c ? categoryWords(c.category) : "failed verification"}.</>,
    });
  const retired = r.retireBeganAt ?? r.retiredAt;
  if (retired != null) out.push({ id: `${r.caseId}:retired`, ts: retired, icon: Retired, mark: "ink", title: <>{who} was retired</>, detail: <>Its context is thrown away; only verified work is handed on.</> });
  if (r.respawnedAt != null)
    out.push({ id: `${r.caseId}:respawn`, ts: r.respawnedAt, icon: Hourglass, mark: "ink", title: <>{agentLabel(r.slot, r.gen + 1, true)} took its place</>, detail: <>On probation until two checks pass.</> });
  if (r.testsPassAt != null) {
    const ms = recoveryMs(r);
    out.push({
      id: `${r.caseId}:pass`,
      ts: r.testsPassAt,
      icon: TestTubeCheck,
      mark: "ink",
      title: <>Tests pass again</>,
      detail: ms != null ? <>{secs(ms)} after the {faultTrusted(r) ? "note" : "catch"}.</> : undefined,
    });
  }
  for (const e of out) e.slot = r.slot;
  return out;
}

function caseEvent(c: CaseSummary): TimelineEvent {
  return {
    id: `case:${c.id}`,
    ts: c.createdAt,
    slot: c.slot,
    icon: c.revoked ? Undo2 : Send,
    mark: "accent",
    title: c.lesson ? <>{c.revoked ? "A lesson was revoked" : "A lesson went to the fleet"}</> : <>A case file was written for {agentLabel(c.slot, c.gen)}</>,
    detail: c.lesson ? (c.revoked ? <>&ldquo;{humanize(c.lesson)}&rdquo;</> : <>From {agentLabel(c.slot, c.gen)}. Every later prompt in this run now carries it.</>) : <>No general lesson.</>,
  };
}

function firstLine(t: string): string {
  const nl = t.indexOf("\n");
  return humanize(nl < 0 ? t : t.slice(0, nl));
}

function relayEvent(m: RelayMessage, knownCases: Set<string>): TimelineEvent | null {
  const kind = kindOf(m);
  const who = speaker(m.from);
  const base = { id: `relay:${m.id}`, ts: m.ts, slot: parseAgentId(m.from)?.slot };
  if (m.blocked) {
    return {
      ...base,
      icon: MessageSquareX,
      mark: "pathogen",
      title: <>Blocked a message from {who}</>,
      detail: <span className="line-through decoration-pathogen/70">{firstLine(m.text)}</span>,
    };
  }
  switch (kind) {
    case "case":
      if (m.meta.caseId && knownCases.has(m.meta.caseId)) return null;
      return { ...base, icon: Send, mark: "accent", title: <>{who} sent a case file to the fleet</> };
    case "note":
      return { ...base, icon: ShieldCheck, mark: "ink", title: <>{who} shared a verified note</>, detail: firstLine(m.text) };
    case "case_reply":
      return { ...base, icon: ShieldFilled, mark: "accent", title: <>{who} kept the lesson</>, detail: <>&ldquo;{firstLine(m.text)}&rdquo;</> };
    case "revocation":
      return { ...base, icon: Undo2, mark: "pathogen", title: <>{who} revoked a lesson</>, detail: firstLine(m.text) };
    case "dm":
      return { ...base, icon: Network, mark: "quiet", quiet: true, title: <>{who} to {speaker(m.to)}</>, detail: firstLine(m.text) };
    default:
      return { ...base, icon: Network, mark: "quiet", quiet: true, title: <>{who}</>, detail: firstLine(m.text) };
  }
}

function buildEvents(s: Snapshot | null): TimelineEvent[] {
  if (!s) return [];
  const known = new Set(s.cases.map((c) => c.id));
  const all: TimelineEvent[] = [];
  for (const r of s.recoveries) all.push(...recoveryEvents(r, s.cases));
  for (const c of s.cases) all.push(caseEvent(c));
  for (const m of s.relay) {
    const e = relayEvent(m, known);
    if (e) all.push(e);
  }
  all.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
  return all;
}

export interface TimelineProps {
  /** Most lines shown (stage: 6). Routine status lines are left out when a limit is set. */
  limit?: number;
}

export function Timeline({ limit }: TimelineProps) {
  const { snapshot } = useDashboard();
  const stage = useStageRoster();
  // On a fleet run the stage shows one team: its timeline follows that team, so the four slots do not churn.
  const teamSlots = stage.fleet ? stage.agents.map((a) => a.slot).join(",") : null;
  const live = useMemo(() => {
    let all = buildEvents(snapshot);
    if (teamSlots != null && limit != null) {
      const team = new Set(teamSlots.split(",").map(Number));
      const mine = all.filter((e) => e.slot != null && team.has(e.slot));
      if (mine.length > 0) all = mine;
    }
    if (limit == null) return all.slice(0, 120);
    const meaningful = all.filter((e) => !e.quiet);
    // Early in a run there is nothing but status; show that rather than an empty list.
    return (meaningful.length > 0 ? meaningful : all).slice(0, limit);
  }, [snapshot, limit, teamSlots]);

  const [frozen, setFrozen] = useState<TimelineEvent[] | null>(null);
  const shown = frozen ?? live;
  const pending = frozen ? live.filter((e) => !frozen.some((f) => f.id === e.id)).length : 0;
  // Lines already shown never fade again (they only change slot); the first load does not fade at all.
  const seen = useRef(new Set<string>());

  // On the stage the list is a fixed number of fixed-height slots that fill the column. A new line
  // fades into the top slot (150 ms) and the others take the next slot's content in place: no row,
  // and nothing below the list, ever moves (no layout shift).
  const listRef = useRef<HTMLOListElement>(null);
  const [slots, setSlots] = useState(limit ?? 0);
  useLayoutEffect(() => {
    const ol = listRef.current;
    if (!ol || limit == null) return;
    const fit = () => {
      const rowH = parseFloat(getComputedStyle(document.documentElement).fontSize) * ROW_REM;
      setSlots(Math.max(1, Math.min(limit, Math.floor((ol.clientHeight + 1) / rowH))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ol);
    return () => ro.disconnect();
  }, [limit, shown.length > 0]);
  const rows = limit == null ? shown : shown.slice(0, slots);
  useEffect(() => {
    for (const e of rows) seen.current.add(e.id);
  });

  return (
    <section aria-label="What just happened" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-end gap-3 pb-2">
        <h2 className="font-display m-0 text-[2.9rem] leading-[0.95] font-semibold tracking-[-0.012em] text-ink">What just happened</h2>
        <div className="ml-auto flex items-center gap-2 pb-1">
          {frozen && pending === 0 && <span className="text-sm text-ink-3">Paused while you read</span>}
          {pending > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setFrozen(live)}>
              Show {pending} new
            </Button>
          )}
        </div>
      </header>
      {shown.length === 0 ? (
        <EmptyState title="Nothing yet">
          Agents report here as they work. A bad note shows up when it is caught, the agent is replaced, and the lesson is kept.
        </EmptyState>
      ) : (
        <ol
          ref={listRef}
          aria-label="What just happened, newest first"
          className={cn("m-0 min-h-0 flex-1 list-none p-0", limit == null ? "scroll-edge overflow-auto" : "overflow-hidden")}
          onMouseEnter={() => setFrozen(live)}
          onMouseLeave={() => setFrozen(null)}
        >
          {rows.map((e, i) => (
            <li
              key={limit == null ? e.id : i}
              tabIndex={e.slot != null ? 0 : undefined}
              onPointerEnter={() => setHoverSlot(e.slot ?? null)}
              onPointerLeave={() => setHoverSlot(null)}
              onFocus={() => setHoverSlot(e.slot ?? null)}
              onBlur={() => setHoverSlot(null)}
              className={cn("tl-row border-b border-line last:border-b-0", limit != null && "h-[6.2rem] overflow-hidden")}
            >
              <EventRow key={e.id} event={e} animate={i === 0 && seen.current.size > 0 && !seen.current.has(e.id)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const DISC: Record<Mark, string> = {
  pathogen: "text-pathogen",
  accent: "text-accent",
  ink: "text-ink",
  quiet: "text-ink-3",
};

/** Height of one stage slot in rem: a title line and two lines of detail. */
const ROW_REM = 6.2;

const EventRow = memo(function EventRow({ event: e, animate }: { event: TimelineEvent; animate: boolean }) {
  const [enter] = useState(animate);
  const Icon = e.icon;
  return (
    <div className={cn("flex items-start gap-4 py-[0.85rem]", enter && "animate-fade-fast")}>
      <span aria-hidden className={cn("grid size-[2.7rem] shrink-0 place-items-center rounded-full bg-raised", DISC[e.mark])}>
        <Icon className="size-[1.3rem]" strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-[0.1rem]">
        <p className="m-0 flex items-baseline gap-3">
          <span className={cn("line-clamp-1 min-w-0 flex-1 text-[1.15rem] leading-snug font-semibold", e.quiet ? "text-ink-2" : "text-ink")}>{e.title}</span>
          <time dateTime={new Date(e.ts).toISOString()} className="shrink-0 text-xs text-ink-3 tabular-nums">
            {formatClock(e.ts)}
          </time>
        </p>
        {e.detail != null && <p className="m-0 line-clamp-2 text-base leading-snug text-ink-3 [overflow-wrap:anywhere]">{e.detail}</p>}
      </div>
    </div>
  );
});
