import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { AgentStage, StageControls } from "./components/AgentStage";
import { BenchmarkChart } from "./components/BenchmarkChart";
import { CaseViewer } from "./components/CaseViewer";
import { CrashControl } from "./components/Controls";
import { LedgerPanel } from "./components/LedgerPanel";
import { HeaderProof, RunNumbers } from "./components/Proof";
import { Cleansing } from "./components/Cleansing";
import { RelayFeed } from "./components/RelayFeed";
import { SwarmPanel } from "./components/SwarmPanel";
import { Timeline } from "./components/Timeline";
import { TopBar, type View } from "./components/TopBar";
import { EmptyState, Panel, STATUS_META } from "./components/ui";
import { agentLabel } from "./components/names";
import { TEAM_MAX } from "./components/facts";
import { useDashboard, useRoster, useRun } from "./data";

const VIEWS: View[] = ["team", "fleet", "details"];

/** `/live?view=fleet` opens Fleet; team and details likewise. Anything else falls back to the run's own pick. */
function viewFromUrl(): View | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("view");
  return VIEWS.includes(v as View) ? (v as View) : null;
}

/**
 * The page stays invisible (not unmounted) until the display faces are in and the first snapshot has
 * arrived, or 2.5 s pass: it then appears once at its final size, so neither a font swap nor the
 * first data moves anything on screen (load layout shift).
 */
function useFirstPaintReady(): boolean {
  const { snapshot } = useDashboard();
  const [fonts, setFonts] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        setFonts(true);
      }
    };
    const faces = ['700 80px "Imbue"', '600 40px "Imbue"', '400 16px "Albert Sans"', '600 16px "Albert Sans"', '400 14px "Geist Mono"'];
    if (typeof document !== "undefined" && document.fonts?.load) {
      Promise.all(faces.map((f) => document.fonts.load(f))).then(finish, finish);
    } else finish();
    const t = window.setTimeout(() => setLate(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  return late || (fonts && snapshot != null);
}

/*
  The hero graph and the fleet view are built in parallel and loaded lazily. import.meta.glob
  resolves to an empty map while a file does not exist, so the app builds either way, and an error
  boundary keeps a crash in either one from taking the rest of the page down.
*/
type GraphModule = { ImmuneGraph: ComponentType };
const graphLoader = import.meta.glob<GraphModule>("./components/topology/ImmuneGraph.tsx")["./components/topology/ImmuneGraph.tsx"];
const ImmuneGraph = graphLoader ? lazy(() => graphLoader().then((m) => ({ default: m.ImmuneGraph }))) : null;
const loadFleetView = () => import("./components/FleetView");
const FleetView = lazy(() => loadFleetView().then((m) => ({ default: m.FleetView })));
type FleetGridModule = { FleetGrid: ComponentType };
const fleetGridLoader = import.meta.glob<FleetGridModule>("./components/topology/FleetGrid.tsx")["./components/topology/FleetGrid.tsx"];
const FleetGrid = fleetGridLoader ? lazy(() => fleetGridLoader().then((m) => ({ default: m.FleetGrid }))) : null;

/** Above this many agents the radial graph gives way to the dot grid in Details. */
const RADIAL_MAX = 12;

export default function App() {
  const run = useRun();
  // /live always opens on Team. Only a fleet-scale run that starts after arrival switches to Fleet by itself.
  const [arrivalRunId] = useState(() => run?.runId ?? null);
  const [firstRunId, setFirstRunId] = useState<string | null | undefined>(undefined);
  if (firstRunId === undefined && run) setFirstRunId(run.runId);
  const startedHere = run != null && firstRunId !== undefined && run.runId !== (arrivalRunId ?? firstRunId);
  const [picked, setPicked] = useState<View | null>(viewFromUrl);
  const autoView: View = startedHere && run.agents > TEAM_MAX ? "fleet" : "team";
  const view = picked ?? autoView;
  useEffect(() => {
    document.title = "Kept · Live";
  }, []);
  const ready = useFirstPaintReady();
  // Warm the Fleet chunk while the page is idle, so the first switch to Fleet does no loading work.
  useEffect(() => {
    if (!ready) return;
    const warm = () => {
      void loadFleetView();
      void fleetGridLoader?.();
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (ric) ric(warm);
    else window.setTimeout(warm, 600);
  }, [ready]);
  // The stage's "see the whole fleet" link (components/AgentStage.tsx) asks for a view by event.
  useEffect(() => {
    const on = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (VIEWS.includes(v as View)) pickRef.current(v as View);
    };
    window.addEventListener("neo:view", on);
    return () => window.removeEventListener("neo:view", on);
  }, []);
  const pick = (v: View) => {
    setPicked(v);
    // Keep the address shareable: /live?view=fleet reopens Fleet.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("view", v);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // history blocked: the view still switches
    }
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  return (
    <div className={view === "details" ? "page" : "page one-screen"} style={ready ? undefined : { visibility: "hidden" }}>
      <a href="#main" className="absolute -top-24 left-4 z-50 rounded-full bg-primary px-4 py-2 text-base font-medium text-on-primary focus:top-3">
        Skip to the agents
      </a>
      <TopBar view={view} auto={picked == null} onView={pick} />
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
        {view === "team" && <TeamView />}
        {view === "fleet" && <h1 className="sr-only">Kept fleet view: a thousand agents in teams of four</h1>}
        {view === "details" && <h1 className="sr-only">Kept details: case file, messages and costs</h1>}
        {view === "fleet" && (
          <Guard label="The fleet view">
            <Suspense fallback={<Loading what="the fleet view" />}>
              <FleetView />
            </Suspense>
          </Guard>
        )}
        {view === "details" && <DetailsView />}
      </main>
    </div>
  );
}

/** 04: the headline and this run's proof; four agents on stage with the catch playing out on them; what just happened beside. */
function TeamView() {
  return (
    <div className="team">
      <div className="team-hero flex flex-col items-center gap-[0.8rem] pt-[0.85rem] pb-[1.15rem]">
        <h1 className="font-display m-0 text-center text-[4.7rem] leading-[0.9] font-bold tracking-[-0.016em] text-ink">The ordinary run, kept.</h1>
        <HeaderProof />
      </div>
      <section aria-label="The agents" className="team-stage">
        <AgentStage />
        <StageControls />
      </section>
      <div aria-hidden className="team-rule" />
      <div className="team-side">
        <Timeline limit={6} />
        <RunNumbers />
      </div>
    </div>
  );
}

/** Everything one level deeper: the live graph, the raw feed, the full case file, the ledger, the benchmark, the swarm. */
function DetailsView() {
  const run = useRun();
  const big = run != null && run.agents > RADIAL_MAX;
  return (
    <div className="details">
      <div className="span-6 min-w-0">
        <CaseViewer />
      </div>
      <div className="span-6 flex min-w-0 flex-col gap-6 min-[1100px]:border-l min-[1100px]:border-line-strong/80 min-[1100px]:pl-[2.6rem]">
        <div className="h-[34rem] min-h-0 [&>*]:h-full">
          <RelayFeed />
        </div>
        <LedgerPanel />
      </div>
      <WhenVisible className="span-12 h-[36rem] min-h-0 [&>*]:h-full">
        {big && FleetGrid ? (
          <Guard label="The fleet grid">
            <Suspense fallback={<Loading what="the fleet grid" />}>
              <section aria-label="The fleet" className="sheet h-full overflow-hidden">
                <FleetGrid />
              </section>
            </Suspense>
          </Guard>
        ) : ImmuneGraph ? (
          <Guard label="The live graph" fallback={<FleetSchematic />}>
            <Suspense fallback={<FleetSchematic />}>
              <ImmuneGraph />
            </Suspense>
          </Guard>
        ) : (
          <FleetSchematic />
        )}
      </WhenVisible>
      <div className="span-7">
        <BenchmarkChart />
      </div>
      <div className="span-5">
        <Cleansing />
      </div>
      <div className="span-8">
        <SwarmPanel />
      </div>
      <div className="span-4">
        <Panel title="Crash test" scroll={false}>
          <div className="flex flex-col items-start gap-3">
            <p className="m-0 text-base text-ink-2">Kill the orchestrator mid-run. The dashboard keeps the last known state and reconnects on its own.</p>
            <CrashControl />
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * Mounts its children only once the slot is near the viewport (and the browser is idle), so the heavy
 * canvas below the fold never costs a frame while Details opens.
 */
function WhenVisible({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || show) return;
    let idle = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (ric) idle = ric(() => setShow(true), { timeout: 500 });
        else idle = window.setTimeout(() => setShow(true), 50);
      },
      { rootMargin: "0px 0px 160px 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      const cic = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (cic) cic(idle);
      else window.clearTimeout(idle);
    };
  }, [show]);
  return (
    <div ref={ref} className={className}>
      {show ? children : <div aria-hidden className="sheet h-full" />}
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <div className="page-pad py-6">
      <EmptyState title={`Loading ${what}`} />
    </div>
  );
}

class Guard extends Component<{ label: string; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.label} failed`, error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      this.props.fallback ?? (
        <div className="page-pad py-6">
          <EmptyState title={`${this.props.label} hit an error`}>The rest of the dashboard keeps working. Reload to try again.</EmptyState>
        </div>
      )
    );
  }
}

/* ---------- Fallback hero: a static map of the team around Relay, in ink on paper ---------- */

const W = 800;
const H = 460;

function FleetSchematic() {
  const roster = useRoster() ?? [];
  const cx = W / 2;
  const cy = H / 2;
  const nodes = roster.map((a, i) => {
    const angle = (-3 * Math.PI) / 4 + (i * 2 * Math.PI) / Math.max(roster.length, 1);
    return { agent: a, x: cx + 280 * Math.cos(angle), y: cy + 150 * Math.sin(angle) };
  });
  return (
    <Panel variant="bare" title="The team on Relay" meta="Every message passes through Relay, where claims are checked" className="h-full" scroll={false}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block size-full border-t border-line" role="img" aria-label={`${roster.length} agents connected through Relay`}>
        {nodes.map(({ agent, x, y }) => (
          <line
            key={`l${agent.slot}`}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke={agent.possessed ? "var(--pathogen)" : "var(--line-strong)"}
            strokeWidth={1.25}
            strokeDasharray={agent.status === "trusted" ? undefined : "4 5"}
          />
        ))}
        <circle cx={cx} cy={cy} r={34} fill="var(--canvas)" stroke="var(--ink)" strokeWidth={1.5} />
        <text x={cx} y={cy + 5} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--ink)">
          Relay
        </text>
        {nodes.map(({ agent, x, y }) => {
          const meta = STATUS_META[agent.status];
          const color = agent.possessed ? "var(--pathogen)" : meta.color;
          return (
            <g key={agent.slot}>
              <circle cx={x} cy={y} r={9} fill={color} />
              <text x={x} y={y + 32} textAnchor="middle" fontSize={16} fontWeight={600} fill="var(--ink)">
                {agentLabel(agent.slot, agent.gen)}
              </text>
              <text x={x} y={y + 52} textAnchor="middle" fontSize={14} fill={color}>
                {agent.possessed ? "Bad note" : meta.label}
              </text>
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}
