import { useMemo, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronsRight, FileSearch, FlaskConical, LoaderCircle, RotateCw, TriangleAlert, Undo2 } from "lucide-react";
import { useCase, useDashboard } from "../data";
import type { CaseSummary } from "../data/model";
import { Button, EmptyState, cn } from "./ui";
import { Drift, Evidence, JevVerdict, Recipients, Section } from "./case/CaseSections";
import { agentTitle, humanize, speaker, testVerdict } from "./names";

/**
 * The selected case file (or the newest one when nothing is selected): who
 * failed, what they falsely claimed, the evidence, the lesson, and who it
 * reached. The summary from the snapshot renders at once; the full file is
 * fetched and cached by the data layer, which refetches it when it changes.
 */
export function CaseViewer() {
  const { snapshot, selectedCaseId, selectCase } = useDashboard();
  const cases = snapshot?.cases;

  const ordered = useMemo(() => (cases ?? []).toSorted((a, b) => a.createdAt - b.createdAt), [cases]);
  const id = selectedCaseId ?? ordered.at(-1)?.id ?? null;
  const index = id ? ordered.findIndex((c) => c.id === id) : -1;
  const summary: CaseSummary | null = index >= 0 ? ordered[index] : null;

  // Cached by the data layer; refetched when a case event or reconnect says it changed.
  const { data: file, loading, error, reload: retry } = useCase(id);

  const head = file ?? summary;
  const revoked = head?.revoked ?? false;

  const nav =
    ordered.length > 1 ? (
      <nav aria-label="Case files" className="flex items-center gap-1 text-base">
        <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={index <= 0} onClick={() => selectCase(ordered[index - 1].id)}>
          Older
        </Button>
        <span className="min-w-[4.5rem] text-center text-sm text-ink-3 tabular-nums">
          {index >= 0 ? `${index + 1} of ${ordered.length}` : `${ordered.length} cases`}
        </span>
        <Button size="sm" variant="ghost" disabled={index < 0 || index >= ordered.length - 1} onClick={() => selectCase(ordered[index + 1].id)}>
          Newer
          <ArrowRight aria-hidden className="size-[1.1em]" strokeWidth={2.25} />
        </Button>
        {index < ordered.length - 1 && (
          <Button size="sm" variant="secondary" icon={ChevronsRight} onClick={() => selectCase(ordered[ordered.length - 1].id)}>
            Newest
          </Button>
        )}
      </nav>
    ) : null;

  if (!id || !head) {
    return (
      <section aria-label="Case file" className="flex flex-col gap-4">
        {nav}
        <h2 className="font-display m-0 text-[4.2rem] leading-[0.95] font-bold tracking-[-0.016em] text-ink">Case file</h2>
        {id && loading ? (
          <Loading />
        ) : id && error ? (
          <LoadError message={error} onRetry={retry} />
        ) : (
          <EmptyState icon={FileSearch} title="No case files yet">
            When an agent is caught in a false claim, it is retired and a case file opens here: the claim, the test output and Jev&rsquo;s verdict,
            the one-line lesson, and which teammates it reached.
          </EmptyState>
        )}
      </section>
    );
  }

  const verdict = testVerdict(file?.evidence.testOutput);
  return (
    <article aria-label="Case file" aria-busy={loading || undefined} className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        {nav}
        <h2 className="font-display m-0 text-[3.7rem] leading-[0.95] font-bold tracking-[-0.016em] text-ink">
          Case file: <span className="text-pathogen">{agentTitle(head.slot)}</span> (v{head.gen})
        </h2>
        <dl className="m-0 flex flex-wrap gap-x-8 gap-y-3 border-b border-line-strong/70 pb-4">
          <Meta label="Failure">{head.category}</Meta>
          {file && (
            <Meta label="Function">
              <code className="font-mono text-[0.92em]">{file.subtask}</code>
            </Meta>
          )}
          {file && (
            <Meta label="Task">
              <code className="font-mono text-[0.92em]">{file.task}</code>
            </Meta>
          )}
          {verdict && <Meta label="Tests">{verdict.replace(/^pytest: /, "")}</Meta>}
          {file?.replacement && <Meta label="Replaced by">{speaker(file.replacement)}</Meta>}
          {revoked && (
            <Meta label="Lesson">
              <span className="inline-flex items-center gap-1.5" title="This lesson was withdrawn and no longer goes into prompts">
                <Undo2 aria-hidden className="size-[1em]" strokeWidth={2.25} />
                Revoked
              </span>
            </Meta>
          )}
          {head.synthetic && (
            <Meta label="Source">
              <span className="inline-flex items-center gap-1.5" title="Planted for a test, not from a live failure">
                <FlaskConical aria-hidden className="size-[1em]" strokeWidth={2.25} />
                Synthetic
              </span>
            </Meta>
          )}
        </dl>
      </header>

      {file ? (
        <>
          <Section title="Claim">
            <p className="m-0 text-base text-ink">
              {speaker(file.agentName)} claimed: &ldquo;{humanize(file.claim)}&rdquo;
            </p>
          </Section>
          <Evidence evidence={file.evidence} />
          {file.evidence.jev && (
            <Section title="Verdict">
              <JevVerdict result={file.evidence.jev} testOutput={file.evidence.testOutput} />
            </Section>
          )}
        </>
      ) : error ? (
        <LoadError message={error} onRetry={retry} />
      ) : (
        <Loading />
      )}

      <Section title="Lesson">
        {head.lesson ? (
          <>
            <p className={cn("font-display m-0 text-[2.6rem] leading-[1] font-semibold tracking-[-0.012em] text-pretty text-ink", revoked && "text-ink-3 line-through decoration-2")}>
              {humanize(head.lesson)}
            </p>
            <p className="m-0 text-sm text-ink-3">{revoked ? "Lesson withdrawn: agents no longer receive it." : "Every later prompt in this run now carries it."}</p>
          </>
        ) : (
          <p className="m-0 text-lg text-ink-2">No lesson for this case: the lesson writer found nothing that would change how teammates work.</p>
        )}
      </Section>

      {file && (
        <>
          {file.driftTrace && file.driftTrace.length > 0 && <Drift trace={file.driftTrace} />}
          <Recipients recipients={file.recipients} replies={file.replies ?? undefined} />
          {loading && <p className="m-0 text-xs text-ink-3">Refreshing case file…</p>}
          {error && <LoadError message={error} onRetry={retry} compact />}
        </>
      )}
    </article>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="m-0 text-base font-medium text-ink">{children}</dd>
    </div>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-base text-ink-3" role="status">
      <LoaderCircle aria-hidden className="size-5 animate-spin" strokeWidth={2.25} />
      Loading the claim, evidence and recipients…
    </p>
  );
}

function LoadError({ message, onRetry, compact }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-md bg-pathogen-soft text-pathogen-ink",
        compact ? "px-3 py-2" : "px-4 py-3",
      )}
    >
      <TriangleAlert aria-hidden className="size-5 shrink-0" strokeWidth={2.5} />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold">Could not load the case file</p>
        <p className="text-sm text-ink-2">{message}. Check the orchestrator is running, then retry.</p>
      </div>
      <Button size="sm" variant="secondary" icon={RotateCw} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
