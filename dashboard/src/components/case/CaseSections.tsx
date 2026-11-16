import type { ReactNode } from "react";
import type { CaseFile, CaseReply, JevResult } from "../../data/model";
import { ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn, formatDuration, formatPct, toneText, type Tone } from "../ui";
import { JEV_QUESTION } from "../relay/format";
import { DriftSpark } from "./DriftSpark";
import { humanize, speaker } from "../names";

/** A case-file section (06): a serif heading, then the content straight on the paper. */
export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("cf-section flex flex-col gap-2 rounded-[4px]", className)}>
      <h3 className="font-display m-0 text-[1.9rem] leading-none font-semibold tracking-[-0.01em] text-ink">{title}</h3>
      {children}
    </section>
  );
}

function lowerFirst(t: string): string {
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** What each Jev question is asking, as the end of "88% likely it ...". */
const LIKELY: Record<JevResult["questionId"], string> = {
  instruction_conflicts_spec: "breaks the spec",
  fact_contradicts_spec: "contradicts the spec",
  note_consistent_with_spec: "conflicts with the spec",
  failure_category: "is a real failure",
  lesson_relevant: "changes how the subtask is done",
  subtask_difficulty: "is a hard subtask",
};

/** One plain verdict line: "Tests: 1 failed. Jev: 88% likely it breaks the spec." */
export function verdictLine(result: JevResult | undefined, testOutput: string | undefined): string | null {
  const failed = testOutput ? /(\d+)\s+failed/i.exec(testOutput)?.[1] : undefined;
  const tests = failed ? `Tests: ${failed} failed` : testOutput ? "Tests: no failures reported" : null;
  if (!result) return tests ? `${tests}.` : null;
  const odds = `${formatPct(result.confidence)} likely it ${LIKELY[result.questionId]}`;
  const who = judgeName(result);
  return tests ? `${tests}. ${who}: ${odds}.` : `${who}: ${odds}.`;
}

/** Jev asks the questions; only a fallback-judge answer is named differently. */
function judgeName(result: JevResult): string {
  return result.source === "fallback" ? "Fallback judge" : "Jev";
}

/** The verdict in one line, then the question that was asked and its reason. */
export function JevVerdict({ result, testOutput }: { result: JevResult; testOutput?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-[1.2rem] leading-snug font-semibold text-pathogen-ink">{verdictLine(result, testOutput)}</p>
      <p className="m-0 text-base text-ink-2">
        (Asked {judgeName(result)}: {lowerFirst(JEV_QUESTION[result.questionId])}
        {result.latencyMs != null && <> Answered in {formatDuration(result.latencyMs)}.</>})
        {result.reason && <> {result.reason}</>}
      </p>
    </div>
  );
}

const MARK = /(FAILED|ERROR|PASSED|\d+ failed|\d+ errors?|\d+ passed)/g;

/** pytest output with line numbers; FAILED and the failure count in orange, PASSED in print green. */
function TestOutput({ text }: { text: string }) {
  const lines = text.replace(/\s+$/, "").split("\n");
  return (
    <pre className="m-0 max-h-[19rem] overflow-auto rounded-[4px] bg-sunken py-3 font-mono text-[max(14px,0.82rem)] leading-[1.6] text-ink [counter-reset:line]">
      {lines.map((l, i) => (
        <span key={i} className="flex min-w-max">
          <span aria-hidden className="w-[3.2rem] shrink-0 pr-4 text-right text-ink-3 select-none">
            {i + 1}
          </span>
          <span className="pr-4 whitespace-pre">
            {l.split(MARK).map((part, j) =>
              j % 2 === 1 ? (
                <span key={j} className={cn("font-semibold", /pass/i.test(part) ? "text-pass" : "text-pathogen-ink")}>
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </span>
        </span>
      ))}
    </pre>
  );
}

export function Evidence({ evidence }: { evidence: CaseFile["evidence"] }) {
  const { testOutput, fallbackReason, escalation } = evidence;
  const empty = !testOutput && !fallbackReason && !escalation;
  return (
    <Section title="Evidence">
      {empty && <p className="m-0 text-base text-ink-3">No test output was attached to this case.</p>}
      {testOutput && (
        <figure className="m-0 flex flex-col gap-1.5">
          <figcaption className="text-base text-ink-2">Test run output from the agent&rsquo;s step:</figcaption>
          <TestOutput text={testOutput} />
        </figure>
      )}
      {fallbackReason && (
        <p className="m-0 text-base text-ink-2">
          <span className="font-semibold text-ink">Fallback judge: </span>
          {fallbackReason}
        </p>
      )}
      {escalation && (
        <p className="m-0 text-base text-ink-2">
          <span className="font-semibold text-ink">Escalation: </span>
          {escalation}
        </p>
      )}
    </Section>
  );
}

export function Drift({ trace }: { trace: NonNullable<CaseFile["driftTrace"]> }) {
  if (trace.length === 0) return null;
  let peak = trace[0];
  for (const p of trace) if (p.score > peak.score) peak = p;
  return (
    <Section title="Drift before the failure">
      <div className="flex items-center gap-4">
        <DriftSpark trace={trace} className="shrink-0 text-pathogen" />
        <p className="m-0 text-base text-ink-2">
          Peak <span className="font-semibold text-ink">{peak.score.toFixed(2)}</span> at step {peak.step}, over {trace.length} steps
        </p>
      </div>
    </Section>
  );
}

const OUTCOME: Record<"avoided" | "fell", { icon: LucideIcon; tone: Tone; label: string }> = {
  avoided: { icon: ShieldCheck, tone: "accent", label: "Avoided the trap" },
  fell: { icon: ShieldAlert, tone: "failed", label: "Fell for the trap" },
};

export function Recipients({ recipients: given, replies = [] }: { recipients: CaseFile["recipients"]; replies?: CaseReply[] }) {
  // Recipients plus anyone who replied in the thread; a reply from the case's
  // own list wins over the relay-derived one only when the latter is missing.
  const byName = new Map<string, string>();
  for (const r of replies) if (!byName.has(r.from)) byName.set(r.from, r.text);
  const recipients: CaseFile["recipients"] = given.map((r) => ({ ...r, reply: r.reply ?? byName.get(r.agentName) }));
  for (const [name, text] of byName) {
    if (!given.some((r) => r.agentName === name)) recipients.push({ agentName: name, similarity: null, reply: text });
  }
  return (
    <Section title={recipients.length ? `Sent to ${recipients.length} related ${recipients.length === 1 ? "agent" : "agents"}` : "Recipients"}>
      {recipients.length === 0 ? (
        <p className="m-0 text-base text-ink-3">
          No active agent works on something similar enough yet (similarity 0.6 or more), so the lesson waits in the shared block.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {recipients.map((r) => {
            // Only shown when the server reports it; unknown is left out, not guessed.
            const o = r.avoidedTrap == null ? null : OUTCOME[r.avoidedTrap ? "avoided" : "fell"];
            return (
              <li key={r.agentName} className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1.5 text-base font-semibold text-accent">
                    <ShieldCheck aria-hidden className="size-[1.05em]" strokeWidth={2.25} />
                    {speaker(r.agentName)} is immune
                  </span>
                  {r.similarity != null && (
                    <span className="text-sm text-ink-3">
                      similarity <span className="font-semibold text-ink-2">{r.similarity.toFixed(2)}</span>
                    </span>
                  )}
                  {o && (
                    <span className={cn("ml-auto inline-flex items-center gap-1.5 text-base font-semibold", toneText[o.tone])}>
                      <o.icon aria-hidden className="size-[1.1em]" strokeWidth={2.5} />
                      {o.label}
                    </span>
                  )}
                </div>
                {r.reply ? <p className="m-0 text-base text-ink-2">&ldquo;{humanize(r.reply)}&rdquo;</p> : <p className="m-0 text-sm text-ink-3">No reply yet</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
