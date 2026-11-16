// Fleet-scale view: 1,000 agents as dots, teams of 4. Legend in plain words with counts on top,
// one caption line for the latest notable change at the bottom. Data: useFleetGrid (cells
// string, ~1/s), useFleetStats, useCases (case files send a lesson ripple through a team).
import { useEffect, useMemo, useRef, useState } from "react";
import { useCases, useFleetGrid, useFleetStats, useRoster, type AgentSlot, type FleetGridView } from "../../data";
import { FleetEngine } from "./fleetEngine";

type Code = "." | "T" | "P" | "I" | "R" | "F" | "D" | "X";

/** Legend order and words. Colors come from the same tokens the canvas uses. */
const LEGEND: { code: Code; word: string; swatch: string; hollow?: boolean; ring?: boolean; hideZero?: boolean }[] = [
  { code: "T", word: "working", swatch: "var(--ink)" },
  { code: "D", word: "done", swatch: "var(--ink-3)" },
  { code: "X", word: "possessed", swatch: "var(--pathogen)" },
  { code: "I", word: "caught", swatch: "var(--pathogen)", ring: true },
  { code: "R", word: "retired", swatch: "var(--retired)", hollow: true },
  { code: "P", word: "on probation", swatch: "var(--ink-2)", hollow: true },
  { code: ".", word: "queued", swatch: "var(--line-strong)", hollow: true, hideZero: true },
  { code: "F", word: "failed", swatch: "var(--pathogen-ink)", hideZero: true },
];

const n = (v: number) => v.toLocaleString("en-US");

interface Note {
  rank: number; // higher = more notable
  text: string;
  at: number;
}

/** The most notable change between two grid ticks, in plain words. */
function describe(g: FleetGridView, newCases: { slot: number }[], per: number): Note | null {
  const prev = g.prevCells;
  const t: Record<string, number> = {};
  let firstCaught = -1;
  if (prev && prev.length === g.cells.length) {
    for (let i = 0; i < g.cells.length; i++) {
      const a = prev[i]!;
      const b = g.cells[i]!;
      if (a === b) continue;
      const k = `${a}${b}`;
      t[k] = (t[k] ?? 0) + 1;
      if (k === "XI" && firstCaught < 0) firstCaught = i;
    }
  }
  const now = Date.now();
  const caught = t["XI"] ?? 0;
  if (caught) {
    const team = Math.floor(firstCaught / per) + 1;
    return {
      rank: 5,
      at: now,
      text: caught === 1 ? `Caught a lying agent in team ${team}. It is pulled out of its team before it can spread.` : `Caught ${caught} lying agents this second. Each is pulled out of its team.`,
    };
  }
  if (newCases.length) {
    const team = Math.floor(newCases[0]!.slot / per) + 1;
    return {
      rank: 4,
      at: now,
      text: newCases.length === 1 ? `Lesson from team ${team} sent to its teammates. They are now immune to that mistake.` : `${newCases.length} lessons sent to the teams that need them. Rings mark immune agents.`,
    };
  }
  const retired = t["IR"] ?? 0;
  if (retired) return { rank: 3, at: now, text: `${retired} caught agent${retired === 1 ? "" : "s"} retired.` };
  const replaced = t["RP"] ?? 0;
  if (replaced) return { rank: 3, at: now, text: `${replaced} replacement${replaced === 1 ? "" : "s"} started on probation, keeping only verified work.` };
  const possessed = Object.entries(t).filter(([k]) => k[1] === "X").reduce((s, [, v]) => s + v, 0);
  if (possessed) return { rank: 2, at: now, text: `${possessed} agent${possessed === 1 ? " was" : "s were"} possessed: a fault was injected to make ${possessed === 1 ? "it" : "them"} lie.` };
  const done = Object.entries(t).filter(([k]) => k[1] === "D").reduce((s, [, v]) => s + v, 0);
  if (done) return { rank: 1, at: now, text: `${n(g.counts.D)} of ${n(g.agents)} agents have finished their work with tests passing.` };
  const joined = (t[".P"] ?? 0) + (t[".T"] ?? 0);
  if (joined) return { rank: 1, at: now, text: `${n(g.agents - g.counts["."])} of ${n(g.agents)} agents started.` };
  return null;
}

/**
 * Probation means one thing on screen: a replacement (v2 or later) until two checks pass. The fleet grid
 * can mark first-generation agents "P" while they start up; for display those read as working ("T").
 */
function displayGrid(g: FleetGridView, roster: AgentSlot[] | null): FleetGridView {
  if (!roster || roster.length === 0 || !g.cells.includes("P")) return g;
  const gen = new Map<number, number>();
  for (const a of roster) gen.set(a.slot, a.gen);
  const fix = (cells: string) => {
    let out = "";
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      out += c === "P" && (gen.get(i) ?? 2) <= 1 ? "T" : c;
    }
    return out;
  };
  const cells = fix(g.cells);
  const counts = { ...g.counts };
  counts.T = 0;
  counts.P = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] as Code;
    if (c === "T") counts.T++;
    else if (c === "P") counts.P++;
  }
  return { ...g, cells, prevCells: g.prevCells ? fix(g.prevCells) : null, counts };
}

/** "Team 23 · 1 caught · immune": what one team of four is doing, for the hover tooltip. */
function teamWords(team: number, info: { codes: string; immune: boolean }): string {
  const count = (c: string) => [...info.codes].filter((x) => x === c).length;
  const parts = [`Team ${team + 1}`];
  const caught = count("I");
  const possessed = count("X");
  const retired = count("R");
  const probation = count("P");
  const done = count("D");
  if (possessed) parts.push(`${possessed} possessed`);
  if (caught) parts.push(`${caught} caught`);
  if (retired) parts.push(`${retired} retired`);
  if (probation) parts.push(`${probation} on probation`);
  if (done) parts.push(`${done} done`);
  if (info.immune) parts.push("immune");
  if (parts.length === 1) parts.push("all working");
  return parts.join(" · ");
}

export function FleetGrid() {
  const rawGrid = useFleetGrid();
  const roster = useRoster();
  // Recomputed when the roster moves, but the same object is kept while the displayed cells are unchanged,
  // so the canvas only redraws on a real change.
  const lastGrid = useRef<FleetGridView | null>(null);
  const grid = useMemo(() => {
    const next = rawGrid ? displayGrid(rawGrid, roster) : null;
    const prev = lastGrid.current;
    if (next && prev && prev.seq === next.seq && prev.runId === next.runId && prev.cells === next.cells) return prev;
    lastGrid.current = next;
    return next;
  }, [rawGrid, roster]);
  const stats = useFleetStats().current;
  const cases = useCases();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<FleetEngine | null>(null);
  const seenCases = useRef<Set<string>>(new Set());
  const runRef = useRef<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [tip, setTip] = useState<{ team: number; x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new FleetEngine(canvas);
    engineRef.current = engine;
    // A new engine starts empty: replay the run's cases into it (StrictMode remounts, view switches).
    runRef.current = null;
    seenCases.current = new Set();
    const size = () => {
      const r = wrap.getBoundingClientRect();
      engine.resize(r.width, r.height, window.devicePixelRatio || 1);
    };
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    size();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => engine.setReducedMotion(motion.matches);
    onMotion();
    motion.addEventListener("change", onMotion);
    const onVis = () => engine.setHidden(document.visibilityState === "hidden");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    const mo = new MutationObserver(() => engine.refreshTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    engine.start();
    return () => {
      engine.destroy();
      engineRef.current = null;
      ro.disconnect();
      mo.disconnect();
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Grid ticks and cases feed the engine; the caption keeps the most notable recent change.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!grid) {
      engine.setGrid(null);
      return;
    }
    const firstOfRun = runRef.current !== grid.runId;
    if (firstOfRun) {
      runRef.current = grid.runId;
      seenCases.current = new Set();
    }
    engine.setGrid({ cells: grid.cells, agentsPerTeam: grid.agentsPerTeam });
    const fresh = (cases ?? []).filter((c) => !seenCases.current.has(c.id));
    fresh.forEach((c) => seenCases.current.add(c.id));
    engine.setCases(
      fresh.map((c) => ({ id: c.id, slot: c.slot })),
      firstOfRun,
    );
    if (firstOfRun) return;
    const d = describe(grid, fresh, grid.agentsPerTeam || 4);
    if (d) setNote((cur) => (!cur || d.rank >= cur.rank || d.at - cur.at > 2500 ? d : cur));
  }, [grid, cases]);

  const counts = grid?.counts;
  const legend = useMemo(() => (counts ? LEGEND.filter((l) => !(l.hideZero && counts[l.code] === 0)) : []), [counts]);
  const summary = counts
    ? `Fleet of ${n(grid!.agents)} agents in teams of ${grid!.agentsPerTeam}: ${legend.map((l) => `${n(counts[l.code])} ${l.word}`).join(", ")}.`
    : "Fleet view: no fleet run yet.";

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1"
        onPointerMove={(e) => {
          const engine = engineRef.current;
          if (!engine || e.pointerType !== "mouse") return;
          const r = e.currentTarget.getBoundingClientRect();
          const hit = engine.teamAt(e.clientX - r.left, e.clientY - r.top);
          engine.setHover(hit?.team ?? null);
          setTip((cur) => (hit == null ? null : cur && cur.team === hit.team ? cur : { ...hit, text: teamWords(hit.team, engine.teamInfo(hit.team)) }));
        }}
        onPointerLeave={() => {
          engineRef.current?.setHover(null);
          setTip(null);
        }}
      >
        <canvas ref={canvasRef} role="img" aria-label={summary} className="absolute inset-0 block h-full w-full" />
        {tip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-0 left-0 z-10 animate-fade-fast rounded-md bg-ink px-2.5 py-1 text-sm font-medium whitespace-nowrap text-on-primary shadow-pop"
            style={{ transform: `translate(calc(${tip.x}px - 50%), calc(${tip.y}px - 100% - 1.4rem))` }}
          >
            {tip.text}
          </div>
        )}
      </div>
      {/* Two fixed rows (caption, legend): a longer caption never resizes the canvas above (no layout shift). */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-line px-5 py-2.5">
        <p className="m-0 line-clamp-1 h-[1.4em] text-base leading-snug text-ink" aria-live="polite" aria-atomic="true">
          {note ? note.text : counts ? `${n(grid!.agents)} agents in ${n(grid!.teams)} teams of ${grid!.agentsPerTeam}. Each dot is one agent.` : "Start a 1,000-agent run to see the fleet. Each dot will be one agent."}
        </p>
        <span className="flex h-[1.45em] w-full flex-nowrap items-center gap-x-5 overflow-hidden text-sm whitespace-nowrap" aria-hidden>
          {counts &&
            legend.map((l) => (
              <span key={l.code} className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={
                    l.hollow
                      ? { boxShadow: `inset 0 0 0 1.5px ${l.swatch}` }
                      : l.ring
                        ? { background: l.swatch, boxShadow: `0 0 0 2px var(--surface), 0 0 0 3.25px ${l.swatch}` }
                        : { background: l.swatch }
                  }
                />
                <span className="font-semibold tabular-nums text-ink">{n(counts[l.code])}</span> {l.word}
              </span>
            ))}
            {stats ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                <span className="inline-block size-3 rounded-full" style={{ boxShadow: "inset 0 0 0 1.5px var(--accent)" }} />
                <span className="font-semibold tabular-nums text-ink">{n(stats.lessonsDelivered)}</span> lessons delivered
              </span>
            ) : null}
        </span>
      </div>
    </div>
  );
}
