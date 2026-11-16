import { useCleansing } from "../data";
import { formatInt, formatTokens } from "../lib/format";
import { agentTitle } from "./names";
import { Panel } from "./ui";

/** How vector cleansing works, in two sentences, plus the latest hand-over it performed. */
export function Cleansing({ className }: { className?: string }) {
  const { recent, count } = useCleansing();
  const last = recent.at(-1) ?? null;
  return (
    <Panel title="Vector cleansing" meta={count > 0 ? `${formatInt(count)} hand-overs so far` : undefined} scroll={false} className={className}>
      <div className="flex flex-col gap-3">
        <p className="m-0 max-w-[62ch] text-base text-ink-2">
          When an agent is retired, its context is thrown away: the replacement starts from a short, verified handoff only, so the lie cannot ride
          along into its replacement. A shared note that later proves wrong is revoked, and every agent that reused it is told.
        </p>
        <p className="m-0 text-base text-ink-2">
          {last ? (
            <>
              Latest: {agentTitle(last.slot)} was replaced (v{last.fromGen} to v{last.toGen}). Dropped{" "}
              <strong className="font-semibold text-ink">{formatTokens(last.droppedPromptTokens)}</strong> prompt tokens, handed over{" "}
              {formatTokens(last.handoffPromptTokens)}.
            </>
          ) : (
            <span className="text-ink-3">No hand-over yet. The first one happens when an agent is retired.</span>
          )}
        </p>
      </div>
    </Panel>
  );
}
