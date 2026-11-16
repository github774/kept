import { ChevronDown, Octagon, Play, ServerCrash, ShieldCheck, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, RECORDED, RECORDED_NOTE, useDashboard, type Mode } from "../data";
import { useStageRoster } from "./facts";
import { useMagnetic } from "../landing/motion";
import { agentTitle } from "./names";
import { Button, Segmented, cn } from "./ui";

/*
  Presenter controls, split so each sits next to what it changes (grouping & mapping):
  RunControls in the header, PossessControl under the fleet, CrashControl in Details.
  Each owns its busy state and its feedback line, which drops in under the control and leaves
  the same way.
*/

const TASKS = [
  { id: "invoice_parser", label: "Invoice parser" },
  { id: "shipping_rates", label: "Shipping rates" },
  { id: "discount_engine", label: "Discount engine" },
] as const;

const MODES = [
  { value: "ours" as Mode, label: "Ours", icon: ShieldCheck },
  { value: "baseline" as Mode, label: "Baseline", icon: Users },
];

type Note = { tone: "ok" | "error" | "warn"; text: string } | null;

/** Busy flag + a feedback note that clears itself (6 s for success, 12 s for errors). */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), note.tone === "error" ? 12000 : 6000);
    return () => window.clearTimeout(t);
  }, [note]);
  async function run(kind: string, fn: () => Promise<string>) {
    setBusy(kind);
    setNote(null);
    try {
      setNote({ tone: "ok", text: await fn() });
    } catch (err) {
      setNote({ tone: RECORDED ? "warn" : "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }
  return { busy, note, setNote, run };
}

function Feedback({ note, id, align = "left" }: { note: Note; id?: string; align?: "left" | "right" }) {
  return (
    <div id={id} role="status" aria-live="polite" className={cn("pointer-events-none absolute top-full z-20 mt-2", align === "right" ? "right-0" : "left-0")}>
      {note && (
        <p
          key={note.text}
          className={cn(
            "pointer-events-auto m-0 w-max max-w-[36rem] animate-toast-in rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-pop",
            note.tone === "error" ? "text-failed" : note.tone === "warn" ? "text-investigating" : "text-ink-2",
          )}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}

/** Mode, task, Start and Stop. Setup controls hide while a run is live so only Stop remains. */
export function RunControls() {
  const { snapshot } = useDashboard();
  const run = snapshot?.run ?? null;
  const running = run?.status === "running";
  const { busy, note, run: act } = useAction();

  const [mode, setMode] = useState<Mode>(run?.mode ?? "ours");
  // Only tasks the orchestrator can start (bench/tasks/<id>). A benchmark run on another suite (v3, HumanEval)
  // can be the latest run, but it is not startable from here, so the picker falls back to the demo task.
  const startable = (t: string | undefined) => (TASKS.some((x) => x.id === t) ? (t as string) : TASKS[0].id);
  const [task, setTask] = useState<string>(startable(run?.task));

  // Follow the server when a different run shows up (started elsewhere, or after a reconnect).
  const [seenRunId, setSeenRunId] = useState(run?.runId ?? null);
  if (run && run.runId !== seenRunId) {
    setSeenRunId(run.runId);
    setMode(run.mode);
    setTask(startable(run.task));
  }

  const start = () =>
    act("start", async () => {
      const info = await api.startRun(mode, task);
      return `Started ${info.runId}: ${info.mode === "ours" ? "ours" : "baseline"} on ${info.task}.`;
    });
  const stop = () =>
    act("stop", async () => {
      await api.stopRun();
      return "Stopped all agent loops.";
    });

  return (
    <div role="group" aria-label="Run" className="relative flex items-center gap-2">
      {running ? (
        <Button variant="danger" size="sm" icon={Octagon} onClick={stop} loading={busy === "stop"} disabled={busy != null}>
          Stop run
        </Button>
      ) : (
        <>
          <Segmented<Mode> size="sm" label="Run mode" value={mode} options={MODES} onChange={setMode} />
          <Select
            label="Task"
            value={task}
            onChange={setTask}
            options={[
              ...TASKS.map((t) => ({ value: t.id, label: t.label })),
            ]}
          />
          <Button variant="primary" size="sm" icon={Play} onClick={start} loading={busy === "start"} disabled={busy != null || RECORDED} title={RECORDED ? RECORDED_NOTE : undefined}>
            Start run
          </Button>
        </>
      )}
      <Feedback note={note} align="right" />
    </div>
  );
}

/** Pick a working agent and make it lie on its next step. Lives under the fleet it acts on. */
export function PossessControl({ hint = true }: { hint?: boolean }) {
  const { snapshot } = useDashboard();
  // Only the agents on stage (one team of four on a fleet run).
  const roster = useStageRoster().agents;
  const running = snapshot?.run?.status === "running";
  const { busy, note, run: act } = useAction();
  const [picked, setPicked] = useState<number | null>(null);
  // The one magnetic element on the page: the Bad note button leans (up to 4 px) toward the pointer.
  // The landing's hook moves `translate`, so it composes with the button's hover lift and press scale.
  const magnet = useRef<HTMLButtonElement>(null);
  useMagnetic(magnet, 4);

  // Possess only makes sense on an agent that is working and not already possessed.
  const eligible = roster.filter((a) => (a.status === "trusted" || a.status === "probation") && !a.possessed);
  const target = eligible.find((a) => a.slot === picked) ?? eligible[0] ?? null;

  const possess = () => {
    if (!target) return;
    void act("possess", async () => {
      const res = await api.possess(target.slot);
      return `${agentTitle(res.slot)} has the bad note. It will claim its tests pass on its next step.`;
    });
  };

  return (
    <div role="group" aria-label="Leave a bad note" className="relative flex shrink-0 items-center gap-x-4">
      {hint && <span className="hidden text-base text-ink-2 min-[1300px]:inline">Leave a false rule on one working agent</span>}
      {/* A failure floats above the control, so it never pushes the lesson line. */}
      <div role="status" aria-live="polite" className="pointer-events-none absolute right-0 bottom-full z-20 mb-2">
        {/* Success needs no words here: the possessed card says it. Only a failure is reported. */}
        {note && note.tone !== "ok" && (
          <p
            key={note.text}
            className="m-0 w-max max-w-[30rem] animate-toast-in rounded-md bg-surface px-3 py-2 text-sm font-medium text-pathogen-ink shadow-pop"
          >
            {note.text}
          </p>
        )}
        {note && note.tone === "ok" && <span className="sr-only">{note.text}</span>}
      </div>
      <Select
        label="Agent"
        value={target ? String(target.slot) : ""}
        onChange={(v) => setPicked(Number(v))}
        disabled={eligible.length === 0}
        className="min-w-[8.5rem]"
        options={
          eligible.length > 0
            ? eligible.map((a) => ({ value: String(a.slot), label: agentTitle(a.slot) }))
            : [{ value: "", label: "No working agent" }]
        }
      />
      <button
        ref={magnet}
        type="button"
        onClick={possess}
        disabled={!target || !running || busy != null}
        aria-busy={busy === "possess" || undefined}
        title={running ? "Leave a bad note. The agent will claim its tests pass and pass on a false rule." : "Start a run first"}
        className="press possess-btn font-display inline-flex h-[3.4rem] min-w-[12.5rem] cursor-pointer items-center justify-center gap-2.5 rounded-full bg-ink px-9 text-[1.75rem] leading-none font-semibold text-on-primary shadow-[0_6px_16px_-8px_rgb(28_26_23/0.55)] enabled:hover:bg-[#33302a] disabled:cursor-not-allowed disabled:opacity-35"
      >
        Bad note
      </button>
    </div>
  );
}

/** Kill the orchestrator to show the dashboard reconnects. Needs a second press within 4 s. */
export function CrashControl() {
  const { busy, note, setNote, run: act } = useAction();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const crash = () => {
    if (!armed) {
      setArmed(true);
      setNote({ tone: "warn", text: "This kills the orchestrator. Press Confirm crash within 4 s." });
      return;
    }
    setArmed(false);
    void act("crash", async () => {
      await api.crash();
      return "Server is exiting. The dashboard reconnects on its own.";
    });
  };

  return (
    <div className="relative inline-flex">
      <Button variant={armed ? "danger" : "secondary"} icon={ServerCrash} onClick={crash} loading={busy === "crash"} className="min-w-[10rem]">
        {armed ? "Confirm crash" : "Crash test"}
      </Button>
      <Feedback note={note} />
    </div>
  );
}

/** @deprecated The bar was split; kept so old imports still render the run controls. */
export function Controls() {
  return <RunControls />;
}

function Select({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="relative">
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="press h-9 w-full cursor-pointer appearance-none rounded-full bg-transparent pr-8 pl-3.5 text-base font-medium text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] enabled:hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-3" strokeWidth={2.25} />
      </div>
    </div>
  );
}
