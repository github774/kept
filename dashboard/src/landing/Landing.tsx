import { useEffect, type MouseEvent } from "react";
import "./landing.css";
import { Close } from "./Close";
import { GetStarted } from "./GetStarted";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { Proof } from "./Proof";
import { LIVE_URL, navigate, preloadLive } from "./route";

/*
  Kept, the landing page. The page is the ordinary subagent run, kept.
  Normal scrolling, static sections; the only extended motion is the ink in the hero.
*/

const TITLE = "Kept. Elevate the ordinary.";
const DESCRIPTION =
  "Spawn a subagent. Trust what it says. Start over when it is wrong. Kept holds the one true line, so the next run starts higher.";

/** The page owns the document ground and its title while it is mounted. */
function useDocument() {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("lp-doc");
    const prevTitle = document.title;
    document.title = TITLE;
    const metas: HTMLMetaElement[] = [];
    const meta = (attr: "name" | "property", key: string, content: string) => {
      let m = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      if (!m) {
        m = document.createElement("meta");
        m.setAttribute(attr, key);
        document.head.appendChild(m);
        metas.push(m);
      }
      m.content = content;
    };
    meta("name", "description", DESCRIPTION);
    meta("property", "og:title", TITLE);
    meta("property", "og:description", DESCRIPTION);
    return () => {
      html.classList.remove("lp-doc");
      document.title = prevTitle;
      metas.forEach((m) => m.remove());
    };
  }, []);
}

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Into the dashboard, under 300 ms: a paper veil fades in (100 ms), the route swaps underneath it, and the veil
 * fades out (140 ms) once the dashboard has painted, so its mount cost is never seen. Opacity only, on the
 * compositor. The dashboard chunk is warmed on hover and focus, so normally nothing waits. The L shortcut skips
 * the veil entirely (keyboard actions get no animation).
 */
let leaving = false;
function goLive(from: HTMLElement | null) {
  if (leaving) return;
  leaving = true;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!from || reduced) {
    preloadLive()
      .catch(() => null)
      .then(() => {
        leaving = false;
        navigate(LIVE_URL);
      });
    return;
  }
  const veil = document.createElement("div");
  veil.className = "lp-handoff";
  document.body.appendChild(veil);
  const fadeIn = veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: EASE_OUT, fill: "forwards" });
  Promise.all([fadeIn.finished, preloadLive().catch(() => null)]).then(() => {
    navigate(LIVE_URL);
    leaving = false;
    requestAnimationFrame(() => {
      const out = veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE_OUT, fill: "forwards" });
      out.finished.then(() => veil.remove());
    });
  });
}

export default function Landing() {
  useDocument();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        goLive(null);
      }
    };
    window.addEventListener("keydown", onKey);
    // Warm the dashboard chunk once the ink has had the main thread to itself.
    const idle = window.setTimeout(() => void preloadLive().catch(() => null), 6500);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(idle);
    };
  }, []);

  const live = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    goLive(e.currentTarget);
  };
  const warm = () => void preloadLive().catch(() => null);

  return (
    <div className="lp" id="top">
      <header className="lp-nav">
        <a href="/" className="lp-wordmark" aria-label="Kept, home">
          Kept
        </a>
        <nav aria-label="Sections" className="lp-links">
          <a href="#how">How it works</a>
          <a href="#proof">Proof</a>
          <a href="#start">Get started</a>
          <a href={LIVE_URL} onClick={live} onPointerEnter={warm} onFocus={warm}>
            Live dashboard
          </a>
        </nav>
      </header>
      <main>
        <Hero onLive={goLive} />
        <HowItWorks />
        <Proof />
        <GetStarted onLive={goLive} />
      </main>
      <Close onLive={goLive} />
    </div>
  );
}
