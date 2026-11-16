import { useEffect, useRef, useState, type MouseEvent } from "react";
import { LABELS, layoutFor, type Layout } from "./ink/composition";
import type { InkField } from "./ink/InkField";
import { StaticInk } from "./ink/StaticInk";
import { fmtX, HEAVY, LIGHT, TRAPS } from "./bench";
import { ArrowRight } from "./marks";
import { useMagnetic } from "./motion";
import { LIVE_URL, preloadLive } from "./route";

/*
  The first screen (design/mockups/01-landing-hero.png): the claim on the left, the fleet in ink on the right.
  The ink tells the story in about five seconds (the agent with the bad note at the centre is caught, a pen strikes
  it out, it is retired and a fresh team prints in its place, blue rings mark teams that kept the lesson), then
  holds still. Three short captions follow the ink; the still keeps two labels, Caught and Kept, so reduced motion
  gets them too. The ink chunk is loaded after first paint; without WebGL the same composition is drawn as SVG.
*/

const WIDE = "(min-width: 900px)";

type Mode = "pending" | "webgl" | "svg";

// Set in two short lines so each fits in the clear space just above the struck mark, beside the cluster it names.
const CAPTIONS: string[][] = [[], ["A bad note."], ["Caught by", "its own tests."], ["The next run", "starts higher."]];

export function Hero({ onLive }: { onLive: (from: HTMLElement) => void }) {
  const heroRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctaRef = useRef<HTMLAnchorElement>(null);
  useMagnetic(ctaRef, 4);
  // ?ink=svg forces the fallback (review); otherwise the WebGL ink is tried first.
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).get("ink") === "svg" ? "svg" : "pending",
  );
  const [box, setBox] = useState<{ w: number; h: number; layout: Layout } | null>(null);
  // Story phase from the ink's clock: 1-3 show a caption, 4 is the still with its labels.
  const [phase, setPhase] = useState(-1);

  useEffect(() => {
    const hero = heroRef.current!;
    const canvas = canvasRef.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const params = new URLSearchParams(window.location.search);
    // ?t=3 pins the story to one moment (review screenshots).
    const pinnedRaw = Number.parseFloat(params.get("t") ?? "");
    const pinned = Number.isFinite(pinnedRaw) ? pinnedRaw : null;
    const wide = window.matchMedia(WIDE);
    const layout = (w: number, h: number) => layoutFor(w, h, wide.matches);
    let field: InkField | null = null;
    let disposed = false;

    const measure = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      setBox({ w, h, layout: layout(w, h) });
      field?.resize();
    };
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);

    const io = new IntersectionObserver(([e]) => field?.setVisible(e.isIntersecting));
    io.observe(canvas);

    // Pointer-only: the ring water ripples (motion allowed) and the team under the pointer inks a shade darker
    // (a colour change, so it stays on under reduced motion, without a transition).
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const onMove = (e: PointerEvent) => {
      if (!field) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      field.hoverAt({ x, y });
      if (!reduced) field.disturb(x, y);
    };
    const onLeave = () => field?.hoverAt(null);
    if (fine) {
      hero.addEventListener("pointermove", onMove, { passive: true });
      hero.addEventListener("pointerleave", onLeave);
    }

    if (params.get("ink") !== "svg")
      import("./ink/InkField")
        .then(({ InkField }) => InkField.create(canvas, { still: reduced, pinned, layout, onPhase: setPhase }))
        .then((made) => {
          if (disposed) return made?.dispose();
          field = made;
          if (!field) return setMode("svg");
          if (params.has("inkstats")) (window as unknown as { __ink: InkField }).__ink = field;
          field.play();
          setMode("webgl");
        })
        .catch(() => !disposed && setMode("svg"));

    return () => {
      disposed = true;
      ro.disconnect();
      io.disconnect();
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerleave", onLeave);
      field?.dispose();
    };
  }, []);

  const live = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onLive(e.currentTarget);
  };
  const warm = () => void preloadLive().catch(() => null);

  return (
    <section ref={heroRef} className="lp-hero" aria-labelledby="lp-hero-title">
      <div className="lp-hero-copy">
        <p className="lp-tagline">Elevate the ordinary.</p>
        {/* Two fixed lines, so the swap from the fallback face to Imbue cannot rewrap the title and shift the page. */}
        <h1 id="lp-hero-title" className="lp-display">
          <span className="lp-line">The ordinary run,</span> <span className="lp-line">kept.</span>
        </h1>
        <p className="lp-lead">
          Spawn a subagent. Trust what it says. Start over when it is wrong. Kept holds the one true line, so the next
          run starts higher.
        </p>
        {LIGHT.ratio && HEAVY.ratio && (
          <p className="lp-hero-proof">
            {fmtX(LIGHT.ratio)} to {fmtX(HEAVY.ratio)} fewer tokens than Codex subagents on the same model
            {TRAPS.neo != null && TRAPS.codex != null && (
              <>
                {" "}
                · {TRAPS.neo} traps hit vs {TRAPS.codex}
              </>
            )}
          </p>
        )}
        <a ref={ctaRef} href={LIVE_URL} className="lp-btn" onClick={live} onPointerEnter={warm} onFocus={warm}>
          Open the live dashboard
          <ArrowRight className="lp-btn-arrow" />
        </a>
      </div>
      <div className="lp-hero-art">
        <div
          className="lp-hero-ink"
          role="img"
          aria-label="Teams of four agents drawn as ink dots. The agent with the bad note at the centre is caught and struck out, and a fresh team prints in its place; blue rings mark teams that kept the lesson."
        >
          <canvas ref={canvasRef} className="lp-ink" data-ready={mode === "webgl" ? "" : undefined} />
          {mode === "svg" && box && <StaticInk w={box.w} h={box.h} layout={box.layout} />}
        </div>
        {box && (
          <div className="lp-hero-notes" aria-hidden="true">
            {phase >= 1 && phase <= 3 && (
              <p
                key={phase}
                className="lp-ink-caption"
                style={{
                  left: box.layout.cx + LABELS.caption.x * box.layout.scale,
                  top: box.layout.cy + LABELS.caption.y * box.layout.scale,
                }}
              >
                {CAPTIONS[phase].map((line) => (
                  <span key={line} className="lp-line">
                    {line}
                  </span>
                ))}
              </p>
            )}
            {(phase === 4 || mode === "svg") && (
              <>
                <span
                  className="lp-ink-label is-caught"
                  style={{
                    left: box.layout.cx + LABELS.caught.x * box.layout.scale,
                    top: box.layout.cy + LABELS.caught.y * box.layout.scale,
                  }}
                >
                  Caught
                </span>
                <span
                  className="lp-ink-label is-immune"
                  style={{
                    left: box.layout.cx + LABELS.immune.x * box.layout.scale,
                    top: box.layout.cy + LABELS.immune.y * box.layout.scale,
                  }}
                >
                  Kept
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
