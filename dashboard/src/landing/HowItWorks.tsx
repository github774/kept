import { Fragment, type ReactNode } from "react";
import { Arrow, Check, Hourglass, Shield } from "./marks";
import { STORY } from "./story";

/*
  How it works (design/mockups/02-landing-how.png): four stacks of paper, read left to right, one stage each.
  A static layout; nothing here moves. The cards hold the demo task's real claim, failing test and lesson.
*/

function Head({ agent, fn, version }: { agent: string; fn?: string; version?: string }) {
  return (
    <header className="lp-card-head">
      <div>
        <h3 className="lp-card-name">{agent}</h3>
        {fn && <p className="lp-card-fn">{fn}</p>}
      </div>
      {version && <span className="lp-chip">{version}</span>}
    </header>
  );
}

/** One line of evidence: an icon and a short phrase, nothing else. */
function Line({
  icon,
  tone,
  keyLine,
  children,
}: {
  icon: ReactNode;
  tone?: "note";
  /** The card's one line that matters: highlighted when its stage is hovered. */
  keyLine?: "ink" | "note" | "fail" | "blue";
  children: ReactNode;
}) {
  return (
    <li className={tone ? `lp-row is-${tone}` : "lp-row"}>
      {icon}
      <span className={keyLine ? `lp-key is-${keyLine}` : undefined}>{children}</span>
    </li>
  );
}

const Cross = () => (
  <svg viewBox="0 0 20 20" className="lp-row-icon is-fail" aria-hidden="true">
    <circle cx="10" cy="10" r="9" fill="currentColor" />
    <path d="M6.8 6.8l6.4 6.4M13.2 6.8l-6.4 6.4" stroke="var(--paper-hi)" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const Dot = ({ tone }: { tone: "note" | "ink" }) => <span className={`lp-row-dot is-${tone}`} aria-hidden="true" />;

function BadNote() {
  return (
    <div className="lp-stack">
      <article className="lp-card">
        <Head agent={STORY.agent} fn={STORY.fn} version="v1" />
        <ul className="lp-rows">
          <Line icon={<Check className="lp-row-icon is-pass" />}>“{STORY.claim}”</Line>
          <Line icon={<Dot tone="note" />} tone="note" keyLine="note">
            “{STORY.rule}”
          </Line>
        </ul>
      </article>
    </div>
  );
}

function Caught() {
  return (
    <div className="lp-stack">
      <article className="lp-card">
        <Head agent={STORY.agent} fn={STORY.fn} version="v1" />
        <div className="lp-term" role="group" aria-label="Test output">
          <p className="lp-term-cmd">$ pytest</p>
          <p className="lp-term-fail lp-key is-fail">
            FAILED{" "}
            {/* Break only after underscores, never mid-word. */}
            {STORY.test.split("_").map((part, i, all) => (
              <Fragment key={i}>
                {part}
                {i < all.length - 1 && (
                  <>
                    _<wbr />
                  </>
                )}
              </Fragment>
            ))}
          </p>
        </div>
        <ul className="lp-rows">
          <Line icon={<Cross />}>Message blocked by Jev</Line>
        </ul>
      </article>
    </div>
  );
}

function Retired() {
  return (
    <div className="lp-stack lp-stack-retired">
      <article className="lp-card lp-card-back" aria-label={`${STORY.agent} v1, retired`}>
        <Head agent={STORY.agent} fn={STORY.fn} version="v1" />
        <div className="lp-card-pk-wrap">
          <svg className="lp-pencil" viewBox="0 0 200 80" aria-hidden="true">
            <path d="M6 70 C60 50 120 26 194 8" />
          </svg>
        </div>
      </article>
      <article className="lp-card lp-card-front">
        <Head agent={STORY.agent} fn={STORY.fn} version="v2" />
        <ul className="lp-rows">
          <Line icon={<Check className="lp-row-icon is-pass" />} keyLine="ink">
            Starts from passing code
          </Line>
          <Line icon={<Hourglass className="lp-row-icon" />}>On probation</Line>
        </ul>
      </article>
    </div>
  );
}

function Kept() {
  return (
    <div className="lp-tree">
      <article className="lp-card lp-card-case">
        <header className="lp-card-head">
          <div>
            <h3 className="lp-card-name">Case file</h3>
            <p className="lp-card-fn">{STORY.agent}, retired</p>
          </div>
        </header>
        <p className="lp-lesson">
          <span className="lp-key is-blue">1999 means $1,999.00.</span>
        </p>
      </article>
      <svg className="lp-tree-lines" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="M50 0 L24 40 M50 0 L76 40" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="lp-tree-kids">
        <article className="lp-card lp-card-sm">
          <Head agent={STORY.teammate.agent} />
          <Shield className="lp-card-shield" />
        </article>
        <article className="lp-card lp-card-sm">
          <Head agent={STORY.agent} version="v2" />
          <Shield className="lp-card-shield" />
        </article>
      </div>
    </div>
  );
}

const STAGES: { name: string; text: string; tone: string; art: ReactNode }[] = [
  {
    name: "Bad note",
    tone: "note",
    text: "A working agent is handed a false rule and claims its tests pass.",
    art: <BadNote />,
  },
  { name: "Caught", tone: "fail", text: "pytest fails the claim. The false rule never reaches the team.", art: <Caught /> },
  { name: "Retired", tone: "muted", text: "The replacement starts from the code that passed.", art: <Retired /> },
  { name: "Kept", tone: "blue", text: "That one true line is what the next run starts from.", art: <Kept /> },
];

export function HowItWorks() {
  return (
    <section id="how" className="lp-how" aria-labelledby="lp-how-title">
      <h2 id="lp-how-title" className="lp-h2 lp-how-title">
        How it works
      </h2>
      <ol className="lp-stages">
        {STAGES.map((s, i) => (
          <Fragment key={s.name}>
            {i > 0 && (
              <li className="lp-stage-arrow" aria-hidden="true">
                <Arrow />
              </li>
            )}
            <li className="lp-stage" data-tone={s.tone}>
              <div className="lp-stage-art">{s.art}</div>
              <h3 className="lp-stage-name">{s.name}</h3>
              <p className="lp-stage-text">{s.text}</p>
            </li>
          </Fragment>
        ))}
      </ol>
      <p className="lp-source">{STORY.source}</p>
    </section>
  );
}
