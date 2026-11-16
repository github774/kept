import { History, Moon, RefreshCw, Sun, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRunElapsedMs, useSpentUsd } from "./facts";
import { DEMO_REPLAY, RECORDED, useDashboard, type Connection, type DataOrigin, type Snapshot } from "../data";
import { RunControls } from "./Controls";
import { agentLabel, agentTitle } from "./names";
import { useNow } from "./Proof";
import { Banner, Button, LiveDot, cn, formatInt, formatUsd } from "./ui";

export type View = "team" | "fleet" | "details";

export interface TopBarProps {
  /** The view on screen. */
  view: View;
  /** True when the view follows the run (team for a few agents, fleet for many). */
  auto: boolean;
  onView(view: View): void;
}

/**
 * The masthead (06): the wordmark, one honest state pill and the run in quiet sentence case on the left;
 * the three views centred; run controls on the right. A hairline closes it. The headline and the proof
 * line live on the Team view itself (04). What is happening right now is announced to screen readers.
 */
export function TopBar({ view, auto, onView }: TopBarProps) {
  const { snapshot, connection } = useDashboard();
  const run = snapshot?.run ?? null;
  const health = snapshot?.health ?? null;
  const origin: DataOrigin | null = snapshot ? (snapshot.origin !== "live" ? snapshot.origin : (run?.origin ?? "live")) : null;

  return (
    <header className="page-pad relative z-10 grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-6 border-b border-line-strong/80 py-3">
      <div className="flex min-w-0 items-center gap-x-4">
        <a href="/" className="font-display shrink-0 text-[2.3rem] leading-none font-semibold tracking-[-0.01em] text-ink no-underline" title="Kept. Elevate the ordinary. Back to the landing page">
          Kept
        </a>
        <span className="hidden shrink-0 text-base text-ink-2 min-[1400px]:inline">Elevate the ordinary</span>
        <StatePill connection={connection} origin={origin} />
        {run && (
          <span className="hidden min-w-0 truncate text-sm text-ink-3 min-[1700px]:inline">
            {run.mode === "ours" ? "Ours" : "Baseline"}
            <Sep />
            {run.agents > 4 ? <>{formatInt(run.agents)} agents</> : taskLabel(run.task)}
            {run.status === "running" ? (
              <>
                <Sep />
                <Elapsed />
              </>
            ) : (
              <>
                <Sep />
                {run.status === "failed" ? "failed" : "done"}
              </>
            )}
          </span>
        )}
      </div>

      <ViewTabs view={view} auto={auto} onView={onView} />

      <div className="flex min-w-0 items-center justify-end gap-x-4">
        {health?.jevOffline && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-2" title="Claims are checked by the fallback judge until Jev is back">
            <TriangleAlert aria-hidden className="size-[1em]" strokeWidth={2.25} />
            Jev offline, using fallback
          </span>
        )}
        <RunControls />
        <ThemeToggle />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        <StatusSentence snapshot={snapshot} connection={connection} />
      </p>
      {DEMO_REPLAY && (
        <Banner compact tone="info" icon={History} className="col-span-3 mt-1" title="Recorded real runs, replayed 3× faster">
          Real models, recorded Oct 31, 2026. Start run and Bad note play them back; the costs and recovery times shown are the measured ones. To drive Kept live, run it locally (see the README).
        </Banner>
      )}
      {RECORDED && (
        <Banner compact tone="info" icon={History} className="col-span-3 mt-1" title={`Recorded run${run?.startedAt ? ` \u00b7 ${new Date(run.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}`}>
          Real models, replayed from a static snapshot. To run it live, start Kept locally (see the README).
        </Banner>
      )}
    </header>
  );
}

/** "invoice_parser" reads "Invoice parser". */
function taskLabel(task: string): string {
  const t = task.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function Sep() {
  return (
    <span aria-hidden className="px-2 text-line-strong">
      &bull;
    </span>
  );
}

/** One honest state: Live, Reconnecting, Mock data or Recording. Never two at once. */
function StatePill({ connection, origin }: { connection: Connection; origin: DataOrigin | null }) {
  let label = "Connecting";
  let cls = "text-ink-2 shadow-[inset_0_0_0_1px_var(--line-strong)]";
  let dot: string | null = null;
  let title = "Waiting for the orchestrator";
  if (connection === "reconnecting") {
    label = "Reconnecting";
    cls = "text-ink-2 shadow-[inset_0_0_0_1px_var(--line-strong)]";
    title = "The server is down; showing the last known state";
  } else if (connection === "open" && origin === "mock") {
    label = "Mock data";
    cls = "bg-ink text-on-primary";
    title = "Scripted demo data, not a live run";
  } else if (connection === "open" && origin === "replay") {
    label = "Recording";
    cls = "bg-raised text-ink";
    title = "Replaying a recorded run";
  } else if (connection === "open") {
    label = "Live";
    cls = "text-ink";
    dot = "var(--pass)";
    title = "Live data from the orchestrator";
  }
  return (
    <span title={title} className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.75 text-sm font-semibold", cls)}>
      {dot && <LiveDot color={dot} pulse={false} className="rounded-full" />}
      {connection === "reconnecting" && <RefreshCw aria-hidden className="size-[1em] animate-spin" strokeWidth={2.25} />}
      {label}
    </span>
  );
}

/**
 * What is happening right now, in one plain sentence built from the snapshot. A clause with no
 * data behind it is left out rather than guessed.
 */
function StatusSentence({ snapshot, connection }: { snapshot: Snapshot | null; connection: Connection }) {
  const spent = useSpentUsd();
  if (!snapshot) return <>{connection === "reconnecting" ? "Reconnecting to the orchestrator." : "Connecting to the orchestrator."}</>;
  const run = snapshot.run;
  if (!run) return <>No run yet. Press Start run: four agents split a task and check each other&rsquo;s work with real tests.</>;

  const roster = snapshot.roster;
  const working = roster.filter((a) => a.status !== "retired" && a.status !== "failed").length;
  const caughtNow =
    roster.find((a) => a.status === "under_investigation" || a.status === "retiring") ??
    roster.find((a) => a.possessed && snapshot.recoveries.some((r) => r.slot === a.slot && r.gen === a.gen && r.detectedAt != null));
  const possessed = caughtNow ? undefined : roster.find((a) => a.possessed);
  const newestCase = snapshot.cases.reduce<(typeof snapshot.cases)[number] | null>((b, c) => (b == null || c.createdAt > b.createdAt ? c : b), null);

  const parts: ReactNode[] = [];
  if (run.status === "running")
    parts.push(run.agents > 4 ? <>{formatInt(run.agents)} agents are working in teams, checking each other.</> : <>{working} agents are writing {run.task}, one function each.</>);
  else parts.push(<>Run {run.status === "failed" ? "failed" : "finished"}: {run.testsPassing} of {run.testsTotal} tests pass.</>);

  if (possessed) parts.push(<span className="font-medium text-pathogen">{agentTitle(possessed.slot)} has a bad note and is about to lie.</span>);
  else if (caughtNow) parts.push(<span className="font-medium text-pathogen">{agentLabel(caughtNow.slot, caughtNow.gen)} was just caught.</span>);
  else if (newestCase) parts.push(<>{agentLabel(newestCase.slot, newestCase.gen, true)} was caught and replaced. The next run starts from its lesson.</>);

  parts.push(<span className="text-ink-3">{formatUsd(spent)} spent.</span>);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " "}
          {p}
        </span>
      ))}
    </>
  );
}

/** Ticks once a second in its own component so nothing else re-renders; a fleet run uses the fleet's own clock. */
function Elapsed() {
  const now = useNow(true, 1000);
  const ms = useRunElapsedMs(now);
  if (ms == null) return null;
  const s = Math.floor(ms / 1000);
  return (
    <span className="tabular-nums">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

const TABS: { value: View; label: string; hint: string }[] = [
  { value: "team", label: "Team", hint: "Four agents and the catch, live" },
  { value: "fleet", label: "Fleet", hint: "A thousand agents: how much poison is caught at scale" },
  { value: "details", label: "Details", hint: "The live graph, raw messages, case file, costs, benchmark and swarm" },
];

/**
 * Text tabs, centred. One ink rule sits on the masthead's hairline under the current tab and slides
 * (transform only, 200 ms) to whichever tab the pointer or keyboard focus is on, then back.
 */
function ViewTabs({ view, auto, onView }: TopBarProps) {
  const navRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<View, HTMLButtonElement>());
  const [over, setOver] = useState<View | null>(null);
  const [rule, setRule] = useState<{ x: number; w: number; animate: boolean } | null>(null);
  const target = over ?? view;
  useLayoutEffect(() => {
    const place = () => {
      const el = tabRefs.current.get(target);
      if (!el) return;
      setRule((prev) => ({ x: el.offsetLeft, w: el.offsetWidth, animate: prev != null }));
    };
    place();
    const ro = new ResizeObserver(place);
    if (navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [target]);
  return (
    <nav ref={navRef} aria-label="View" className="relative flex items-center gap-[2.4rem] self-stretch" onPointerLeave={() => setOver(null)}>
      {TABS.map((t) => {
        const on = t.value === view;
        return (
          <button
            key={t.value}
            ref={(el) => {
              if (el) tabRefs.current.set(t.value, el);
              else tabRefs.current.delete(t.value);
            }}
            type="button"
            aria-current={on ? "page" : undefined}
            title={on && auto ? `${t.hint} (picked from the run)` : t.hint}
            onClick={() => onView(t.value)}
            onPointerEnter={() => setOver(t.value)}
            onFocus={(e) => e.currentTarget.matches(":focus-visible") && setOver(t.value)}
            onBlur={() => setOver(null)}
            className={cn(
              "relative -mb-3 cursor-pointer bg-transparent px-0.5 pb-3 text-[1.15rem] transition-colors duration-150",
              on ? "font-semibold text-ink" : "font-medium text-ink-3 hover:text-ink",
            )}
          >
            {t.label}
          </button>
        );
      })}
      {rule && (
        <span
          aria-hidden
          className={cn("tab-rule pointer-events-none absolute -bottom-[calc(0.75rem+1px)] left-0 h-[2.5px] w-[100px] origin-left rounded-full bg-ink", rule.animate && "tab-rule-move", over != null && over !== view && "opacity-45")}
          style={{ transform: `translateX(${rule.x}px) scaleX(${rule.w / 100})` }}
        />
      )}
    </nav>
  );
}

function readTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  useEffect(() => {
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("ss-theme-v2", theme);
    } catch {
      // storage blocked: the toggle still works for this session
    }
  }, [theme]);
  const next = theme === "dark" ? "light" : "dark";
  return <Button variant="ghost" size="sm" icon={theme === "dark" ? Sun : Moon} onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to the ${next} theme`} />;
}
