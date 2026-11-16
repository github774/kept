import type { DataOrigin, SwarmState } from "../data/model";
import { Activity, CircleAlert, CirclePause, FlaskConical, Network } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, useRun, useSwarm } from "../data";
import { formatDuration, formatInt, formatPct, formatRate } from "../lib/format";
import { Badge, Button, Panel, cn, toneText } from "./ui";

/** Spec order: 100, then 1,000, then 10,000. */
const SIZES = [100, 1_000, 10_000] as const;

/**
 * Swarm simulator: one actor per simulated agent. "Claim only what was
 * measured": every number here comes from SwarmState, and a mock origin is said
 * out loud on the panel. Sized for a narrow cell (2 of 12 columns at 1920).
 */
export function SwarmPanel() {
  const swarm = useSwarm();
  const origin = useRun()?.origin ?? null;
  const simulated = origin !== null && origin !== "live";

  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(agents: number) {
    setPending(agents);
    setError(null);
    try {
      await api.startSwarm(agents);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  // Suggest the next step up as the primary action.
  const current = swarm?.agents ?? 0;
  const next = SIZES.find((n) => n > current) ?? SIZES[SIZES.length - 1];
  const hasData = !!swarm && (swarm.running || swarm.stateChanges > 0);

  return (
    <Panel title="Swarm" icon={Network} actions={simulated && origin ? <MockBadge origin={origin} /> : null}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {swarm?.running ? (
            <Badge tone="trusted" icon={Activity} size="sm">
              Running
            </Badge>
          ) : (
            <Badge tone="neutral" icon={CirclePause} size="sm">
              Idle
            </Badge>
          )}
          <span className="text-sm text-ink-3">
            {simulated ? "Mock: scripted, not measured" : "Measured, not extrapolated"}
          </span>
        </div>

        <div className="flex items-center gap-1.5" role="group" aria-label="Start the swarm simulator">
          <span aria-hidden className="mr-0.5 text-sm font-medium text-ink-2">
            Start
          </span>
          {SIZES.map((n) => (
            <Button
              key={n}
              size="sm"
              variant={n === next ? "primary" : "secondary"}
              loading={pending === n}
              disabled={pending !== null && pending !== n}
              aria-label={`Start swarm with ${formatInt(n)} agents`}
              className="min-w-0 flex-1 px-1.5"
              onClick={() => void start(n)}
            >
              {formatInt(n)}
            </Button>
          ))}
        </div>

        {hasData && swarm ? (
          <SwarmStats swarm={swarm} />
        ) : (
          <p className="m-0 text-sm text-ink-2">Start with 100 simulated agents, one actor each, then scale up.</p>
        )}

        {error && (
          <p role="alert" className="m-0 flex items-start gap-1.5 text-sm font-medium text-failed">
            <CircleAlert aria-hidden className="mt-0.5 size-[1.1em] shrink-0" strokeWidth={2.5} />
            Could not start the swarm: {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

function MockBadge({ origin }: { origin: DataOrigin }) {
  return (
    <Badge
      tone="neutral"
      variant="outline"
      icon={FlaskConical}
      size="sm"
      title="Scripted mock run, not a measurement"
    >
      {origin === "mock" ? "Mock" : "Replay"}
    </Badge>
  );
}

function SwarmStats({ swarm }: { swarm: SwarmState }) {
  const elapsed = useElapsedSec(swarm.running ? swarm.startedAt : null);
  const lossShare = swarm.stateChanges > 0 ? swarm.lost / swarm.stateChanges : null;
  const lostTone = swarm.stateChanges === 0 ? null : swarm.lost === 0 ? "trusted" : "failed";
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2.5">
      <Cell label="Agents" value={formatInt(swarm.agents)} />
      <Cell label="Rate" value={formatRate(swarm.ratePerSec)} />
      <Cell
        label="State changes"
        value={formatInt(swarm.stateChanges)}
        note={elapsed !== null ? `handled in ${formatDuration(elapsed * 1000)}` : "handled"}
      />
      <Cell
        label="Lost, measured"
        value={formatInt(swarm.lost)}
        valueClass={lostTone ? toneText[lostTone] : undefined}
        note={lossShare === null ? undefined : `${formatPct(lossShare, 2)} of changes`}
      />
    </dl>
  );
}

function Cell({
  label,
  value,
  note,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="truncate text-sm text-ink-3">{label}</dt>
      <dd className={cn("m-0 truncate text-2xl font-semibold leading-tight text-ink", valueClass)}>{value}</dd>
      {note && <dd className="m-0 truncate text-xs text-ink-3">{note}</dd>}
    </div>
  );
}

/** Seconds since `since`, ticking once a second; null when not running. */
function useElapsedSec(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? null : Math.max(0, (now - since) / 1000);
}
