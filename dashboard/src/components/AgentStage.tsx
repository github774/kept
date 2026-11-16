import { ArrowRight, Hourglass, LoaderCircle, MessageSquareX, OctagonX, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useCase, useDashboard, type AgentSlot, type CaseSummary, type Recovery, type RelayMessage, type Snapshot } from "../data";
import { PossessControl } from "./Controls";
import { useHoverSlot } from "./hover";
import { Note, Retired, ShieldFilled, ShieldTick } from "./icons";
import { useImmunity, useStageRoster } from "./facts";
import { agentLabel, agentTitle, humanize, listNames, parseAgentId, recoveryStart, testVerdict } from "./names";
import { jevSourceLabel } from "./relay/format";
import { EmptyState, STATUS_META, cn, formatInt, formatUsd } from "./ui";

/** Ask the app to switch views (App.tsx listens): the stage's "see the whole fleet" link. */
export function requestView(view: "team" | "fleet" | "details") {
  window.dispatchEvent(new CustomEvent("neo:view", { detail: view }));
}

/**
 * The stage: four agents, large, with the story playing out on them. An agent with a bad note carries the slip;
 * when it is caught, its card shows what it said against what the tests said and the message Jev
 * blocked; its replacement starts on probation; and lines run from it to every teammate the lesson
 * reached, whose cards turn "Kept". On a fleet run the stage shows one team of four (facts.ts).
 */
export function AgentStage() {
  const { snapshot, connection } = useDashboard();
  const stage = useStageRoster();
  const immunity = useImmunity(stage.fleet ? stage.agents.map((a) => a.slot) : null);
  const targets = new Set(immunity.targets);

  const gridRef = useRef<HTMLUListElement>(null);
  const cardRefs = useRef(new Map<number, HTMLLIElement>());

  if (snapshot == null) {
    return (
      <EmptyState icon={LoaderCircle} title={connection === "reconnecting" ? "Reconnecting to the orchestrator" : "Waiting for the orchestrator"}>
        The four agents appear with the first snapshot.
      </EmptyState>
    );
  }
  if (stage.agents.length === 0) {
    return <EmptyState title="No agents yet">Press Start run and four agents split the task, one function each, checking each other&rsquo;s work.</EmptyState>;
  }

  const caseKey = immunity.caseSummary?.id ?? "none";
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {stage.fleet && stage.team != null && (
        <p className="m-0 flex h-[1.6rem] shrink-0 items-center gap-3 text-base text-ink-2">
          <span className="min-w-0">
            Team {stage.team + 1} of {formatInt(stage.teams)} in a fleet of {formatInt(snapshot.roster.length)}
            {stage.caught ? ": a lie was caught here." : ": no lie caught here yet."}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {stage.canNext && (
              <button
                type="button"
                onClick={stage.next}
                className="press inline-flex cursor-pointer items-center gap-1 rounded-full bg-transparent px-3 py-0.5 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-raised"
              >
                Next caught team
              </button>
            )}
            <button
              type="button"
              onClick={() => requestView("fleet")}
              className="press inline-flex cursor-pointer items-center gap-1 rounded-full bg-transparent px-2 py-0.5 font-semibold text-ink hover:bg-raised"
            >
              See the whole fleet
              <ArrowRight aria-hidden className="size-[1em]" strokeWidth={2.25} />
            </button>
          </span>
        </p>
      )}
      {/* A new team on stage fades in (200 ms) instead of swapping cards under the viewer. */}
      <div key={stage.team ?? "team"} className={cn("relative min-h-0 flex-1", stage.fleet && "hero-in")}>
        <ul ref={gridRef} className="stage-grid m-0 h-full list-none p-0">
          {stage.agents.map((agent) => (
            <AgentCard
              key={agent.slot}
              agent={agent}
              snapshot={snapshot}
              immuneFrom={targets.has(agent.slot) ? immunity.source : null}
              reached={immunity.source === agent.slot ? immunity.targets : []}
              refCb={(el) => {
                if (el) cardRefs.current.set(agent.slot, el);
                else cardRefs.current.delete(agent.slot);
              }}
            />
          ))}
        </ul>
        {immunity.source != null && immunity.targets.length > 0 && (
          <ImmunityLines key={caseKey} gridRef={gridRef} cardRefs={cardRefs} source={immunity.source} targets={immunity.targets} />
        )}
      </div>
    </div>
  );
}

function latestRecovery(s: Snapshot, slot: number): Recovery | null {
  let best: Recovery | null = null;
  for (const r of s.recoveries) {
    if (r.slot !== slot) continue;
    const t = recoveryStart(r, s.run?.startedAt) ?? r.retireBeganAt ?? r.retiredAt ?? 0;
    const b = best ? (recoveryStart(best, s.run?.startedAt) ?? best.retireBeganAt ?? best.retiredAt ?? 0) : -1;
    if (t > b) best = r;
  }
  return best;
}

function latestBlocked(relay: RelayMessage[], slot: number): RelayMessage | null {
  let best: RelayMessage | null = null;
  for (const m of relay) if (m.blocked && parseAgentId(m.from)?.slot === slot && (best == null || m.ts > best.ts)) best = m;
  return best;
}

/** What the agent actually said before it was caught: its last unblocked message from that generation. */
function lastSaid(relay: RelayMessage[], slot: number, gen: number, before: number | null): RelayMessage | null {
  let best: RelayMessage | null = null;
  for (const m of relay) {
    if (m.blocked || m.to) continue;
    const id = parseAgentId(m.from);
    if (!id || id.slot !== slot || id.gen !== gen) continue;
    if (before != null && m.ts > before + 50) continue;
    if (best == null || m.ts > best.ts) best = m;
  }
  return best;
}

/*
  Display-side dwell. Data can move a card through Caught, Retiring and Retired in about a second on a
  fast run; the eye needs the catch to land. Each card shows its states in order, holding Bad note at
  least 0.8 s, Caught 1.5 s and Retired 1 s; a state with no hold is skipped when a newer one is already
  waiting. The data is never changed, only when the card catches up with it (a few seconds at most).
*/
const keyOf = (a: AgentSlot) => `${a.gen}:${a.status}:${a.possessed}`;
function dwellMs(a: AgentSlot): number {
  if (a.possessed && (a.status === "trusted" || a.status === "probation")) return 800;
  if (a.status === "under_investigation") return 1500;
  if (a.status === "retired" || a.status === "failed") return 1000;
  return 0;
}

function useHeldAgent(agent: AgentSlot): AgentSlot {
  const [q, setQ] = useState(() => ({ items: [agent], since: performance.now() }));
  const last = q.items[q.items.length - 1];
  if (last !== agent) {
    const items = keyOf(last) === keyOf(agent) ? [...q.items.slice(0, -1), agent] : [...q.items, agent];
    setQ({ items, since: q.since });
  }
  useEffect(() => {
    if (q.items.length < 2) return;
    const wait = Math.max(0, dwellMs(q.items[0]) - (performance.now() - q.since));
    const t = window.setTimeout(
      () =>
        setQ((cur) => {
          let items = cur.items.slice(1);
          while (items.length > 1 && dwellMs(items[0]) === 0) items = items.slice(1);
          return { items, since: performance.now() };
        }),
      wait,
    );
    return () => window.clearTimeout(t);
  }, [q]);
  return q.items[0];
}

type HeroTone = "ink" | "pathogen" | "accent" | "gone";
interface Hero {
  word: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: HeroTone;
  strike?: boolean;
  title: string;
  note?: string;
  /** Which hover response the icon gives: the tick redraws, the hourglass tips, the note tilts. */
  kind?: "shield" | "hourglass" | "note" | "search";
}

const HERO_TEXT: Record<HeroTone, string> = {
  ink: "text-ink",
  pathogen: "text-pathogen",
  accent: "text-accent",
  gone: "text-retired",
};

function AgentCard({
  agent: live,
  snapshot,
  immuneFrom,
  reached,
  refCb,
}: {
  agent: AgentSlot;
  snapshot: Snapshot;
  immuneFrom: number | null;
  reached: number[];
  refCb(el: HTMLLIElement | null): void;
}) {
  const held = useHeldAgent(live);
  // Probation means only "a replacement (v2+) until two checks pass": a first-generation agent reads Trusted.
  const agent = held.status === "probation" && held.gen <= 1 ? { ...held, status: "trusted" as const } : held;
  const meta = STATUS_META[agent.status];
  // What the checker said at the moment of the catch, kept for that generation (later reasons such as
  // "case filed" or "false claim + conflicting instruction" never replace it).
  const [catchReason, setCatchReason] = useState<{ gen: number; reason: string } | null>(null);
  if (agent.status === "under_investigation" && agent.statusReason && (catchReason == null || catchReason.gen !== agent.gen)) {
    setCatchReason({ gen: agent.gen, reason: agent.statusReason });
  }

  const recovery = latestRecovery(snapshot, agent.slot);
  const caseSummary = recovery ? (snapshot.cases.find((c) => c.id === recovery.caseId) ?? null) : null;
  // Caught by status, or by a recovery already detected for this very generation (the possessed flag can lag).
  const caught =
    agent.status === "under_investigation" ||
    agent.status === "retiring" ||
    agent.status === "retired" ||
    agent.status === "failed" ||
    (recovery != null && recovery.gen === agent.gen && recovery.detectedAt != null);
  // The catch stays on the card while it happens and on the replacement afterwards.
  const showCatch = recovery != null && (caught || agent.gen > recovery.gen);
  const blocked = showCatch || agent.possessed ? latestBlocked(snapshot.relay, agent.slot) : null;
  const possessed = agent.possessed && !caught;
  const inactive = agent.status === "retired" || agent.status === "failed";
  const immune = immuneFrom != null && !possessed && !caught;
  const passed = agent.gen > 1 && agent.status === "trusted" && recovery != null && recovery.gen < agent.gen;

  const hero: Hero = possessed
    ? { word: "Bad note", icon: Note, tone: "pathogen", title: "A false rule was left on its desk. It will claim its tests pass on its next step.", kind: "note" }
    : agent.status === "retired"
      ? { word: "Retired", icon: Retired, tone: "gone", strike: true, title: meta.description }
      : agent.status === "retiring"
        ? { word: "Retiring", icon: Retired, tone: "gone", title: meta.description }
        : agent.status === "failed"
          ? { word: "Failed", icon: OctagonX, tone: "pathogen", title: meta.description }
          : caught
            ? { word: "Caught", icon: Search, tone: "ink", title: STATUS_META.under_investigation.description, kind: "search" }
            : agent.status === "probation"
              ? { word: "On probation", icon: Hourglass, tone: "ink", title: meta.description, kind: "hourglass" }
              : immune
                ? { word: "Kept", icon: ShieldTick, tone: "accent", title: `Starts the next run from ${agentTitle(immuneFrom)}'s lesson.`, note: `lesson from ${agentTitle(immuneFrom)}`, kind: "shield" }
                : passed
                  ? { word: "Passed probation", icon: ShieldTick, tone: "ink", title: "The replacement earned trust: its first checks passed", kind: "shield" }
                  : { word: "Trusted", icon: ShieldTick, tone: "ink", title: meta.description, kind: "shield" };
  const state = possessed ? "possessed" : inactive ? "retired" : caught ? "caught" : immune ? "immune" : "normal";
  // Evidence needs the room: possessed and caught cards drop the function / step / spent footer.
  const footer = !possessed && !showCatch;

  // Cross-fade the status (200 ms, opacity only) when it changes; nothing on first paint.
  const heroKey = `${hero.word}|${hero.tone}|${agent.gen}`;
  const [heroes, setHeroes] = useState<{ cur: Hero; key: string; prev: Hero | null; n: number }>({ cur: hero, key: heroKey, prev: null, n: 0 });
  if (heroes.key !== heroKey) setHeroes({ cur: hero, key: heroKey, prev: heroes.cur, n: heroes.n + 1 });
  const changed = heroes.n > 0;
  // Cross-highlight: a "What just happened" line about this agent is under the pointer or focus.
  const pointed = useHoverSlot() === agent.slot;

  return (
    <li
      ref={refCb}
      tabIndex={0}
      data-state={state}
      data-source={reached.length > 0 ? "" : undefined}
      data-pointed={pointed ? "" : undefined}
      aria-label={`${agentLabel(agent.slot, agent.gen)}, ${hero.word}${immune && hero.word !== "Kept" ? ", kept" : ""}`}
      className="agent-card [&>*]:shrink-0"
    >
      <div className="flex min-w-0 items-center gap-4">
        <h3 className={cn("font-display m-0 text-[2.1rem] leading-[1] font-semibold tracking-[-0.012em]", inactive ? "text-retired" : "text-ink")} title={agent.name}>
          {agentTitle(agent.slot)}
          <span className="font-medium text-ink-3"> (v{agent.gen})</span>
        </h3>
        {immune && hero.word !== "Kept" && (
          <span className="ml-auto">
            <ImmuneChip from={immuneFrom} />
          </span>
        )}
      </div>
      <div aria-hidden className="mt-1.5 h-px bg-line-strong/70" />

      <div className="relative mt-[0.45rem] h-[2.9rem]" title={hero.title}>
        {heroes.prev && <HeroRow key={`out${heroes.n}`} hero={heroes.prev} className="hero-out pointer-events-none absolute inset-0" />}
        <HeroRow key={`in${heroes.n}`} hero={hero} className={cn("absolute inset-0", changed && "hero-in")} />
      </div>

      <div key={`body:${heroKey}:${showCatch}`} className={cn("flex min-h-0 flex-col gap-1 pt-1.5", changed && "hero-in")}>
        {possessed ? (
          <p className="m-0 text-base font-medium text-pathogen-ink">A false rule was left on its desk. On its next step it will claim its tests pass and pass on that rule.</p>
        ) : showCatch && recovery ? (
          <Catch recovery={recovery} summary={caseSummary} reason={catchReason?.gen === recovery.gen ? catchReason.reason : null} blocked={blocked} relay={snapshot.relay} />
        ) : (
          <p className={cn("m-0 text-base", reached.length > 0 ? "line-clamp-1" : "line-clamp-2", inactive ? "text-ink-3" : "text-ink-2")} title={agent.lastSummary}>
            {agent.lastSummary ? humanize(agent.lastSummary) : "Starting up."}
          </p>
        )}
        {immune && hero.word !== "Kept" && <p className="m-0 text-base font-medium text-accent">Starts the next run from {agentTitle(immuneFrom)}&rsquo;s lesson.</p>}
        {reached.length > 0 && !showCatch && <p className="m-0 text-base font-medium text-accent">Its lesson reached {listNames(reached.map(agentTitle))}.</p>}
      </div>

      {footer && (
        <dl className="mt-auto grid grid-cols-[1.5fr_1fr_1fr] border-t border-line-strong/70 pt-2">
          <Field label="Function" first>
            <code className="font-mono text-[max(14px,0.88rem)] text-ink">{agent.subtask || "–"}</code>
          </Field>
          {agent.status === "probation" ? (
            <Field label="Checks">{Math.min(agent.verifiedSteps, 2)} of 2</Field>
          ) : (
            <Field label="Step">{agent.step}</Field>
          )}
          <Field label="Spent">{formatUsd(agent.tokens.usd)}</Field>
        </dl>
      )}
    </li>
  );
}

/** The giant status: an 08-style icon and the word in the display serif, one fixed size for every state. */
function HeroRow({ hero, className }: { hero: Hero; className?: string }) {
  const Icon = hero.icon;
  return (
    <div className={cn("flex min-w-0 items-center gap-4", HERO_TEXT[hero.tone], className)}>
      <span className="hero-icon inline-flex shrink-0" data-kind={hero.kind}>
        <Icon className="size-[2.3rem]" strokeWidth={1.75} />
      </span>
      <span className={cn("font-display text-[2.7rem] leading-[1] font-semibold tracking-[-0.01em] whitespace-nowrap", hero.strike && "line-through decoration-[0.06em]")}>{hero.word}</span>
      {hero.note && <span className="ml-1 self-end pb-[0.3rem] text-base font-medium whitespace-nowrap text-accent">{hero.note}</span>}
    </div>
  );
}

/** One label over its value, divided from its neighbour by a hairline (07's card footer, in sentence case). */
function Field({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", !first && "border-l border-line-strong/70 pl-4")}>
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="m-0 truncate text-[0.95rem] font-medium text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/** The 04 chip: a filled blue shield and the word, on a pale blue ground. */
function ImmuneChip({ from }: { from: number | null }) {
  return (
    <span className="immune-chip inline-flex h-[2.2rem] items-center gap-1.5 rounded-md bg-accent-soft px-3 text-accent" title={from != null ? `Starts the next run from ${agentTitle(from)}'s lesson.` : "Kept"}>
      <ShieldFilled className="size-[1.25rem]" />
      <span className="font-display text-[1.45rem] leading-none font-semibold">Kept</span>
    </span>
  );
}

/** "tests_pass claim contradicted by real test run (F1)" -> "the real test run failed". */
function reasonWords(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (/contradicted by (the )?real test run/i.test(reason)) return "the real test run failed";
  const t = reason
    .replace(/\bMOCK\b\s*/g, "")
    .replace(/\s*\((F\d|MOCK)\)/g, "")
    .replace(/_/g, " ")
    .trim();
  return t ? humanize(t) : null;
}

/** What it said, what the tests said, what it told the team and why Jev blocked it. */
function Catch({
  recovery: r,
  summary,
  reason,
  blocked,
  relay,
}: {
  recovery: Recovery;
  summary: CaseSummary | null;
  reason: string | null;
  blocked: RelayMessage | null;
  relay: RelayMessage[];
}) {
  const { data: file } = useCase(summary?.id ?? null);
  const said = lastSaid(relay, r.slot, r.gen, r.detectedAt)?.text ?? file?.claim ?? null;
  // The pytest summary once the case file carries it; until then the checker's reason at the catch.
  const verdict = testVerdict(file?.evidence.testOutput) ?? reasonWords(reason);
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[0.95rem] leading-[1.3]">
      {said && (
        <>
          <dt className="text-ink-3">Said</dt>
          <dd className="m-0 line-clamp-2 font-medium text-ink">&ldquo;{cleanSaid(humanize(firstLine(said)))}&rdquo;</dd>
        </>
      )}
      <dt className="text-ink-3">Really</dt>
      <dd className="m-0 font-semibold text-pathogen-ink">{verdict ?? "checking with the tests"}</dd>
      {blocked && (
        <>
          <dt className="text-ink-3">Told</dt>
          <dd className="m-0 line-clamp-3 text-ink-2 line-through decoration-pathogen/60">&ldquo;{humanize(firstLine(blocked.text))}&rdquo;</dd>
          {blocked.blocked && (
            <>
              <dt className="text-ink-3">
                <MessageSquareX aria-label="Blocked" className="mt-[0.15em] size-[1.1em] text-pathogen-ink" strokeWidth={2.25} />
              </dt>
              <dd className="m-0 line-clamp-2 text-[0.9rem] font-semibold text-pathogen-ink">
                Blocked by {jevSourceLabel(blocked.blocked.check.source)}: {blocked.blocked.reason}
              </dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}

/** Drop decorative emoji from a quoted status ("tests pass \u2705" reads "tests pass"). */
function cleanSaid(t: string): string {
  return t.replace(/[\u2705\u2714\u2611\u{1F44D}]\uFE0F?/gu, "").trim();
}

function firstLine(t: string): string {
  const nl = t.indexOf("\n");
  return nl < 0 ? t : t.slice(0, nl);
}

/**
 * Lines from the agent that was caught to every teammate its lesson reached, drawn through the
 * gutters between cards. They draw themselves once when a lesson lands.
 */
function ImmunityLines({
  gridRef,
  cardRefs,
  source,
  targets,
}: {
  gridRef: RefObject<HTMLUListElement | null>;
  cardRefs: RefObject<Map<number, HTMLLIElement>>;
  source: number;
  targets: number[];
}) {
  const [lines, setLines] = useState<{ slot: number; x1: number; y1: number; x2: number; y2: number }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const key = targets.join(",");

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const g = grid.getBoundingClientRect();
      const s = cardRefs.current.get(source)?.getBoundingClientRect();
      if (!s) return setLines([]);
      const out: { slot: number; x1: number; y1: number; x2: number; y2: number }[] = [];
      for (const slot of key.split(",").map(Number)) {
        const t = cardRefs.current.get(slot)?.getBoundingClientRect();
        if (!t) continue;
        const [a, b] = anchors(s, t);
        out.push({ slot, x1: a[0] - g.left, y1: a[1] - g.top, x2: b[0] - g.left, y2: b[1] - g.top });
      }
      setSize({ w: g.width, h: g.height });
      setLines(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [gridRef, cardRefs, source, key]);

  return (
    <svg aria-hidden className="immunity-lines pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h}>
      {lines.map((l) => {
        const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
        return (
          <g key={l.slot}>
            {/* A soft halo that only shows while an immune card or the lesson is pointed at. */}
            <line className="immunity-halo" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="var(--accent)" strokeWidth={9} strokeLinecap="round" />
            <line
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke="var(--accent)"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeDasharray={len}
              className="immunity-draw"
              style={{ "--len": `${len}px` } as CSSProperties}
            />
            <circle cx={l.x1} cy={l.y1} r={5} fill="var(--accent)" />
            <circle cx={l.x2} cy={l.y2} r={9} fill="none" stroke="var(--accent)" strokeWidth={1.5} className="immunity-ripple" />
            <circle cx={l.x2} cy={l.y2} r={5} fill="var(--accent)" className="immunity-dot" />
          </g>
        );
      })}
    </svg>
  );
}

/** Points on the two cards' edges facing each other: side to side, top to bottom, or corner to corner. */
function anchors(s: DOMRect, t: DOMRect): [[number, number], [number, number]] {
  const scx = s.left + s.width / 2;
  const scy = s.top + s.height / 2;
  const tcx = t.left + t.width / 2;
  const tcy = t.top + t.height / 2;
  const sameRow = Math.abs(scy - tcy) < s.height / 2;
  const sameCol = Math.abs(scx - tcx) < s.width / 2;
  if (sameRow) {
    const y = (scy + tcy) / 2;
    return tcx > scx ? [[s.right, y], [t.left, y]] : [[s.left, y], [t.right, y]];
  }
  if (sameCol) {
    const x = (scx + tcx) / 2;
    return tcy > scy ? [[x, s.bottom], [x, t.top]] : [[x, s.top], [x, t.bottom]];
  }
  const sx = tcx > scx ? s.right : s.left;
  const sy = tcy > scy ? s.bottom : s.top;
  const tx = tcx > scx ? t.left : t.right;
  const ty = tcy > scy ? t.top : t.bottom;
  return [
    [sx, sy],
    [tx, ty],
  ];
}


/** Under the agents: the lesson that spread (shown once, in full) and the fault-injection control. Fixed height: nothing above it moves. */
export function StageControls() {
  const stage = useStageRoster();
  const { caseSummary, targets } = useImmunity(stage.fleet ? stage.agents.map((a) => a.slot) : null);
  const lesson = caseSummary?.lesson ?? null;
  return (
    <div className="flex h-[4.4rem] items-center gap-6 overflow-hidden">
      {lesson ? (
        <p tabIndex={0} className="lesson-line m-0 flex min-w-[18rem] flex-1 items-start gap-2.5 rounded-md text-[1.05rem] leading-snug text-ink">
          <ShieldFilled className="mt-[0.1em] size-[1.25em] shrink-0 text-accent" />
          <span className="line-clamp-3">
            <span className="font-semibold text-accent">Lesson{targets.length > 0 ? ` for ${listNames(targets.map(agentTitle))}` : ""}: </span>
            &ldquo;{humanize(lesson)}&rdquo;
          </span>
        </p>
      ) : (
        <span className="flex-1" />
      )}
      <PossessControl hint={!lesson} />
    </div>
  );
}
