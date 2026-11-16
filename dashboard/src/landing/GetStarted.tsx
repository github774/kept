import type { MouseEvent } from "react";
import { LIVE_URL, preloadLive } from "./route";

/*
  Get started: the real commands, from scripts/start-all.sh and the orchestrator's POST /api/runs, and the stack
  it runs on.
*/

const RUN_CMD = `curl -X POST localhost:3000/api/runs \\
  -H 'content-type: application/json' \\
  -d '{"taskId": "invoice_parser", "mode": "ours", "agents": 1000, "poisonRate": 0.05}'`;

const STACK = [
  { name: "Durable Actors", by: "Terse", role: "Hold the state: roster, ledger and case files survive a kill -9 and come back." },
  { name: "Agent Relay", by: null, role: "Carries the messages: every case thread, caucus and lesson between agents." },
  { name: "Supabase", by: null, role: "Lessons kept across runs: case files in Postgres with pgvector, recalled by similarity." },
  { name: "Jev", by: "TypeSafe AI", role: "Checks every message before a teammate reads it, about $0.00002 a check." },
];

export function GetStarted({ onLive }: { onLive: (from: HTMLElement) => void }) {
  const live = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onLive(e.currentTarget);
  };
  const warm = () => void preloadLive().catch(() => null);
  return (
    <section id="start" className="lp-start" aria-labelledby="lp-start-title">
      <h2 id="lp-start-title" className="lp-h2 lp-section-title">
        Get started.
      </h2>
      <ol className="lp-steps">
        <li className="lp-step">
          <p className="lp-step-name">1. Start the stack</p>
          <p className="lp-step-text">Durable Actors, Agent Relay and the orchestrator, from the repo root.</p>
          <pre className="lp-code">
            <code>scripts/start-all.sh</code>
          </pre>
        </li>
        <li className="lp-step">
          <p className="lp-step-name">2. Launch a fleet</p>
          <p className="lp-step-text">1,000 agents, 5% handed a false rule. Any number from 1 to 10,000.</p>
          <pre className="lp-code">
            <code>{RUN_CMD}</code>
          </pre>
        </li>
        <li className="lp-step">
          <p className="lp-step-name">3. Watch it</p>
          <p className="lp-step-text">A bad note gets caught, the agent is replaced, and the next run starts from the lesson. Every token is counted.</p>
          <a href={LIVE_URL} className="lp-btn lp-btn-sm" onClick={live} onPointerEnter={warm} onFocus={warm}>
            Open the live dashboard
          </a>
        </li>
      </ol>

      <h3 className="lp-stack-title">Built on</h3>
      <ul className="lp-stack-list">
        {STACK.map((s) => (
          <li key={s.name} className="lp-stack-item">
            <p className="lp-stack-name">
              {s.name}
              {s.by && <span className="lp-stack-by"> by {s.by}</span>}
            </p>
            <p className="lp-stack-role">{s.role}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
