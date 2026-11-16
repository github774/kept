import { useRef, type MouseEvent } from "react";
import { ArrowRight, Check, Shield } from "./marks";
import { useTilt } from "./motion";
import { LIVE_URL, preloadLive } from "./route";
import { STORY } from "./story";

/*
  The close (design/mockups/03-landing-proof.png, bottom half): one line, one button, a sheet of paper either side.
  Left, the teammate that learned; right, the bad note and its false rule.
*/
export function Close({ onLive }: { onLive: (from: HTMLElement) => void }) {
  const sectionRef = useRef<HTMLElement>(null);
  useTilt(sectionRef, ".lp-close-sheet", 2);
  const live = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onLive(e.currentTarget);
  };
  const warm = () => void preloadLive().catch(() => null);
  return (
    <>
      <section ref={sectionRef} className="lp-close" aria-labelledby="lp-close-title">
        <div className="lp-close-sheet is-left" aria-hidden="true">
          <div className="lp-sheet">
            <p className="lp-sheet-title">
              {STORY.teammate.agent} <Shield className="lp-sheet-shield" />
            </p>
            <ul className="lp-sheet-list">
              <li>
                <Check className="lp-sheet-check" /> Reads the case file
              </li>
              <li>
                <Check className="lp-sheet-check" /> 1999 is $1,999.00
              </li>
              <li>
                <Check className="lp-sheet-check" /> Tests pass
              </li>
            </ul>
          </div>
        </div>

        <div className="lp-close-mid">
          <h2 id="lp-close-title" className="lp-h2 lp-close-title">
            Leave a bad note. Watch the next run start higher.
          </h2>
          <a href={LIVE_URL} className="lp-btn" onClick={live} onPointerEnter={warm} onFocus={warm}>
            Open the live dashboard
            <ArrowRight className="lp-btn-arrow" />
          </a>
        </div>

        <div className="lp-close-sheet is-right" aria-hidden="true">
          <div className="lp-sheet">
            <p className="lp-sheet-title">Bad note</p>
            <ul className="lp-sheet-list">
              <li>
                <span className="lp-sheet-o" /> {STORY.fn}
              </li>
              <li className="is-lie">
                <span className="lp-sheet-o" /> Divide by 100
              </li>
              <li>
                <span className="lp-sheet-o" /> “All tests pass”
              </li>
            </ul>
          </div>
        </div>
      </section>
      <footer className="lp-foot">
        <p>
          <strong>Kept</strong>. Elevate the ordinary. Built in a day at Haunted Hacks, October 31, 2026: Amar on the
          frontend and the demo, Avneh on the runtime.
        </p>
        <p>Jev by TypeSafe AI checks messages. Agent Relay carries them. Durable Actors by Terse hold the state. Supabase remembers the lessons.</p>
      </footer>
    </>
  );
}
