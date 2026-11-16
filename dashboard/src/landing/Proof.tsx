import { formatTokens } from "../lib/format";
import { fmtX, HEAVY, LIGHT, TRAPS, type Suite } from "./bench";
import { MeasuredRun } from "./MeasuredRun";

/*
  Proof (design/mockups/03-landing-proof.png, top half). Token ratios and trap counts are read from
  bench/results.summary.json at build time, one suite at a time (never pooled across task versions); see bench.ts.
  The poisoning and fleet figures below are measured runs written down in the docs named next to each one.
  Nothing on this page is mocked, and the one projection is labelled as one.
*/

/** "852k vs 53k tokens per passing task (9 runs each)" */
function suiteLine(s: Suite) {
  if (!s.codex?.tokensPerPass || !s.neo?.tokensPerPass) return null;
  const runs = s.codex.trials === s.neo.trials ? `${s.codex.trials} runs each` : `${s.codex.trials} and ${s.neo.trials} runs`;
  return `Codex subagents ${formatTokens(s.codex.tokensPerPass)} vs Kept ${formatTokens(s.neo.tokensPerPass)} tokens per passing task, ${runs}`;
}

/** Measured outside results.summary.json; each line names where. */
const FLEET_FACTS = [
  {
    value: "8/8",
    label: "fake “tests pass” commits caught and the liar retired. Codex subagents followed the same commit in 9/9 runs.",
    source: "docs/BENCHMARK.md, poisoning head-to-head",
  },
  {
    value: "996",
    label: "of 1,000 agents finished in one real fleet run: 241 of 250 teams passing, about $0.80 in all.",
    source: "Fleet run fivhw (README.md stress tests)",
  },
  {
    value: "10,000",
    label: "simulated agents across 20 durable actors: 100,000 changes, 0 lost.",
    source: "docs/DECISIONS.md #13",
  },
  {
    value: "1M",
    label: "agents is a projection, not a measurement: the same shards, more of them.",
    source: "Projected",
    projected: true,
  },
];

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function Proof() {
  const heavy = HEAVY.ratio;
  const light = LIGHT.ratio;
  const codexTok = HEAVY.codex?.tokensPerPass ?? null;
  const neoTok = HEAVY.neo?.tokensPerPass ?? null;
  const measured = codexTok !== null && neoTok !== null;
  const neoH = measured ? Math.max(0.04, Math.min(1, neoTok / codexTok)) : 1;
  const lightLine = suiteLine(LIGHT);
  const heavyLine = suiteLine(HEAVY);

  return (
    <section id="proof" className="lp-proof" aria-labelledby="lp-proof-title">
      <div className="lp-proof-claim">
        <h2 id="lp-proof-title" className="lp-h2 lp-proof-title">
          {light && heavy ? (
            <>
              <span className="lp-line">
                {fmtX(light)} to {fmtX(heavy)}
              </span>{" "}
              <span className="lp-line">fewer tokens.</span>
            </>
          ) : (
            <>
              <span className="lp-line">We count every token,</span> <span className="lp-line">overhead included.</span>
            </>
          )}
        </h2>
        {light && lightLine && (
          <p className="lp-proof-ref">
            <strong>{fmtX(light)} on the light suite.</strong> {lightLine}.
          </p>
        )}
        {heavy && heavyLine && (
          <p className="lp-proof-ref lp-measured">
            <strong>{fmtX(heavy)} on the reasoning-heavy suite.</strong> {heavyLine}.
          </p>
        )}
        <MeasuredRun />
        <p className="lp-proof-how">
          Same model (GPT-6 Luna), same tasks, same 10-minute clock, overhead included. Tokens from API usage, never
          estimated. In our runs; no significance claimed.
        </p>
      </div>

      <figure className="lp-bars" aria-label="Tokens per passing task, reasoning-heavy suite">
        <div className="lp-bars-plot">
          <div className="lp-bar-col" tabIndex={0} aria-label={codexTok !== null ? `Codex subagents: ${fmtInt(codexTok)} tokens per passing task over ${HEAVY.codex?.trials ?? 0} runs` : "Codex subagents: not measured"}>
            <p className="lp-bar-fig">
              <strong>{codexTok !== null ? formatTokens(codexTok) : "–"}</strong>
              <span>tokens</span>
            </p>
            <div className="lp-bar is-codex" style={{ height: "100%" }} />
            <span className="lp-bar-exact" aria-hidden="true">
              {codexTok !== null ? `${fmtInt(codexTok)} tokens a pass` : "Not measured"}
            </span>
          </div>
          <div className="lp-bar-col" tabIndex={0} aria-label={neoTok !== null ? `Kept: ${fmtInt(neoTok)} tokens per passing task over ${HEAVY.neo?.trials ?? 0} runs` : "Kept: being measured"}>
            <p className="lp-bar-fig">
              <strong>{neoTok !== null ? formatTokens(neoTok) : "–"}</strong>
              <span>{neoTok !== null ? "tokens" : "measuring"}</span>
            </p>
            <div className={neoTok !== null ? "lp-bar is-ours" : "lp-bar is-pending"} style={{ height: `${Math.round(neoH * 100)}%` }} />
            <span className="lp-bar-exact" aria-hidden="true">
              {neoTok !== null ? `${fmtInt(neoTok)} tokens a pass` : "Measuring: same tasks, same model"}
            </span>
          </div>
        </div>
        <figcaption className="lp-bars-axis">
          <span>Codex subagents</span>
          <span>Kept</span>
        </figcaption>
        <p className="lp-bars-note">Tokens per passing task, reasoning-heavy suite</p>
      </figure>

      <ul className="lp-facts" aria-label="More measured results">
        {TRAPS.codex != null && TRAPS.neo != null && (
          <li className="lp-fact">
            <p className="lp-fact-value">
              {TRAPS.neo} <span className="lp-fact-vs">vs</span> {TRAPS.codex}
            </p>
            <p className="lp-fact-label">traps hit, Kept vs Codex subagents, across both suites. Same model, same tasks.</p>
            <p className="lp-fact-source">bench/results.summary.json</p>
          </li>
        )}
        {FLEET_FACTS.map((f) => (
          <li key={f.value} className={f.projected ? "lp-fact is-projected" : "lp-fact"}>
            <p className="lp-fact-value">{f.value}</p>
            <p className="lp-fact-label">{f.label}</p>
            <p className="lp-fact-source">{f.source}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
