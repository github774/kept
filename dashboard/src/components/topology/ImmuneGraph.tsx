// The hero view: the team channel at the center, Jev's ring around it, the agents around that.
// Events play one at a time with a plain-English caption underneath. Drawing happens in
// engine.ts (canvas, requestAnimationFrame); this component only feeds it data.
//
//   <ImmuneGraph />                      full view: agents, lines, packets, captions
//   <ImmuneGraph variant="overlay" />    lines/packets/Jev only, over the host's own agent cards:
//     place it inside a positioned parent that also holds elements with data-agent-slot="0..3"
//     (and optionally one data-topology-hub element). Pass onCaption to render captions yourself.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCase, useCases, useConnection, useHealth, useRelay, useRoster, useRun } from "../../data";
import { newestCaseIds, toTopoView } from "./adapt";
import { TopologyEngine, type AnchorFn, type Caption, type Rect } from "./engine";

export type { Caption } from "./engine";

export interface ImmuneGraphProps {
  variant?: "full" | "overlay";
  /** Overlay: selector for the host's agent cards (each carries data-agent-slot). */
  anchorSelector?: string;
  /** Overlay: selector for the host's hub element; without one the hub is drawn at the center. */
  hubSelector?: string;
  /** Show the caption bar (default: true in full, false in overlay). */
  caption?: boolean;
  /** Receives each caption as it plays (for hosts that render their own). */
  onCaption?: (c: Caption | null) => void;
}

export function ImmuneGraph({
  variant = "full",
  anchorSelector = "[data-agent-slot]",
  hubSelector = "[data-topology-hub]",
  caption: showCaption = variant === "full",
  onCaption,
}: ImmuneGraphProps = {}) {
  const run = useRun();
  const roster = useRoster();
  const relay = useRelay();
  const cases = useCases();
  const health = useHealth();
  const connection = useConnection();
  const [newest, previous] = newestCaseIds(cases, 2);
  const caseA = useCase(newest ?? null).data;
  const caseB = useCase(previous ?? null).data;

  const view = useMemo(
    () => toTopoView({ run, roster, relay, cases, caseFiles: [caseA, caseB], health, connection }),
    [run, roster, relay, cases, caseA, caseB, health, connection],
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TopologyEngine | null>(null);
  const [caption, setCaption] = useState<Caption | null>(null);
  const onCaptionRef = useRef(onCaption);
  onCaptionRef.current = onCaption;
  const overlay = variant === "overlay";
  const selectors = useRef({ anchorSelector, hubSelector });
  selectors.current = { anchorSelector, hubSelector };

  // Engine lifecycle: size, visibility, motion preference and theme all feed it directly.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let anchors: AnchorFn | undefined;
    if (overlay) {
      anchors = () => {
        const host = wrap.parentElement ?? wrap;
        const base = wrap.getBoundingClientRect();
        const rel = (el: Element): Rect => {
          const r = el.getBoundingClientRect();
          return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
        };
        const slots = new Map<number, Rect>();
        host.querySelectorAll<HTMLElement>(selectors.current.anchorSelector).forEach((el) => {
          const slot = Number(el.dataset.agentSlot);
          if (Number.isFinite(slot)) slots.set(slot, rel(el));
        });
        const hubEl = host.querySelector(selectors.current.hubSelector);
        return { slots, hub: hubEl ? rel(hubEl) : null };
      };
    }

    const engine = new TopologyEngine(canvas, {
      onCaption: (c) => {
        setCaption(c);
        onCaptionRef.current?.(c);
      },
      anchors,
    });
    engineRef.current = engine;

    const size = () => {
      const r = wrap.getBoundingClientRect();
      engine.resize(r.width, r.height, window.devicePixelRatio || 1);
      engine.redraw();
    };
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    if (overlay && wrap.parentElement) ro.observe(wrap.parentElement);
    size();

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => engine.setReducedMotion(motion.matches);
    onMotion();
    motion.addEventListener("change", onMotion);

    const onVis = () => engine.setHidden(document.visibilityState === "hidden");
    onVis();
    document.addEventListener("visibilitychange", onVis);

    // Theme: TopBar toggles data-theme on <html>; the OS scheme can change too.
    const mo = new MutationObserver(() => engine.refreshTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => engine.refreshTheme();
    scheme.addEventListener("change", onScheme);
    // Fonts arrive after first paint; re-measure labels once they do.
    document.fonts?.ready.then(() => engine.refreshTheme()).catch(() => {});

    engine.start();
    return () => {
      engine.destroy();
      engineRef.current = null;
      ro.disconnect();
      mo.disconnect();
      motion.removeEventListener("change", onMotion);
      scheme.removeEventListener("change", onScheme);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [overlay]);

  useEffect(() => {
    engineRef.current?.ingest(view);
  }, [view]);

  const summary = useMemo(() => {
    if (!view.agents.length) return "Agent map: no run yet.";
    const agents = view.agents
      .map((a) => `Agent ${a.slot + 1}${a.gen > 1 ? ` v${a.gen}` : ""} ${a.status.replace("_", " ")}${a.possessed ? ", possessed" : ""}`)
      .join("; ");
    return `Agent map around the team channel. ${agents}.`;
  }, [view.agents]);

  const reconnecting = view.connection === "reconnecting" || /reconnecting/i.test(view.banner ?? "");

  const captionBar = showCaption ? (
    <div className="flex min-h-[4.5rem] items-start gap-3 border-t border-line px-4 pt-2.5 pb-3" aria-live="polite" aria-atomic="true">
      {caption ? (
        <CaptionText key={caption.at} kicker={caption.kicker} color={caption.color} title={caption.title} detail={caption.detail} />
      ) : (
        <p className="text-base text-ink-3">Events appear here one at a time as the run plays.</p>
      )}
    </div>
  ) : (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {caption ? `${caption.kicker}: ${caption.title} ${caption.detail ?? ""}` : ""}
    </p>
  );

  if (overlay) {
    return (
      <div ref={wrapRef} className="pointer-events-none absolute inset-0">
        <canvas ref={canvasRef} role="img" aria-label={summary} className="absolute inset-0 block h-full w-full" />
        {showCaption ? <div className="absolute inset-x-0 bottom-0 bg-surface">{captionBar}</div> : captionBar}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} role="img" aria-label={summary} className="absolute inset-0 block h-full w-full" />
        {reconnecting ? (
          <p className="absolute top-2 left-3 text-base font-semibold text-info" role="status">
            Reconnecting… agents keep their state
          </p>
        ) : null}
      </div>
      {captionBar}
    </div>
  );
}

function CaptionText({ kicker, color, title, detail }: { kicker: string; color: string; title: string; detail?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Each new caption cross-fades in (opacity only, so it is fine under reduced motion too).
  useLayoutEffect(() => {
    ref.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(0, 0, 0.2, 1)" });
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      <p className="text-lg leading-snug text-ink">
        <span className="mr-2 font-semibold" style={{ color }}>
          {kicker}
        </span>
        {title}
      </p>
      {detail ? <p className="mt-0.5 line-clamp-2 text-base leading-snug text-ink-2">{detail}</p> : null}
    </div>
  );
}
