import { memo } from "react";
import type { RelayMessage } from "../../data/model";
import {
  Activity,
  BadgeCheck,
  ChevronRight,
  Eye,
  FileWarning,
  MessageSquare,
  Reply,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { humanize } from "../names";
import { cn, formatClock, formatPct, toneText, type Tone } from "../ui";
import {
  CHANNEL_LABEL,
  JEV_QUESTION,
  KIND_LABEL,
  jevSourceLabel,
  kindOf,
  senderLabel,
  type MessageKind,
} from "./format";

// Kinds differ by icon and label first; color is a quiet second signal.
const KIND_STYLE: Record<MessageKind, { icon: LucideIcon; tone: Tone }> = {
  status: { icon: Activity, tone: "neutral" },
  case: { icon: FileWarning, tone: "accent" },
  case_reply: { icon: Reply, tone: "accent" },
  note: { icon: BadgeCheck, tone: "neutral" },
  revocation: { icon: Undo2, tone: "pathogen" },
  dm: { icon: MessageSquare, tone: "neutral" },
};

export interface RelayRowProps {
  message: RelayMessage;
  selected: boolean;
  /** A new message arriving in the top slot: its content fades in (150 ms). */
  fresh: boolean;
  onOpenCase: (caseId: string) => void;
}

export const RelayRow = memo(function RelayRow({ message: m, selected, fresh, onOpenCase }: RelayRowProps) {
  const kind = kindOf(m);
  const { icon: KindIcon, tone } = KIND_STYLE[kind];
  const caseId = m.meta.caseId;
  const blocked = m.blocked;
  // Multi-line messages (a status carrying test output) keep the first line as
  // prose and show the rest as a short monospace excerpt.
  const nl = m.text.indexOf("\n");
  const lead = nl < 0 ? m.text : m.text.slice(0, nl);
  const detail = nl < 0 ? "" : m.text.slice(nl + 1).trim();

  const body = (
    <>
      <span aria-hidden className="relative z-[1] flex h-[1.6rem] items-center justify-center">
        <span className={cn("size-[0.8rem] rounded-full ring-4 ring-canvas", blocked ? "bg-pathogen" : kind === "case" || kind === "case_reply" ? "bg-accent" : "bg-line-strong")} />
      </span>
      <time dateTime={new Date(m.ts).toISOString()} className="pt-[0.2rem] text-sm text-ink-3 tabular-nums">
        {formatClock(m.ts)}
      </time>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-2.5">
          <span className={cn("min-w-0 truncate text-base font-semibold", blocked ? "text-pathogen-ink" : "text-ink")}>
            {senderLabel(m.from)}
            {m.to && (
              <>
                <span className="px-1.5 font-normal text-ink-3">to</span>
                {senderLabel(m.to)}
              </>
            )}
          </span>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-sm", blocked ? "text-pathogen-ink" : toneText[tone])}>
            {!blocked && <KindIcon aria-hidden className="size-[1em]" strokeWidth={2.25} />}
            {!blocked && KIND_LABEL[kind]}
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-2">
            <span className="text-xs text-ink-3">
              <span className="sr-only">channel </span>
              {CHANNEL_LABEL[m.channel]}
            </span>
            {blocked && <span className="rounded-[3px] bg-pathogen-soft px-2 py-0.5 text-sm font-semibold text-pathogen-ink">Blocked</span>}
            {caseId &&
              (selected ? (
                <span className="inline-flex items-center text-accent" title="Shown in the case viewer">
                  <Eye aria-hidden className="size-[1.15em]" strokeWidth={2.25} />
                  <span className="sr-only">Shown in the case viewer</span>
                </span>
              ) : (
                <span className="inline-flex items-center text-ink-3 group-hover:text-ink">
                  <span className="sr-only">Open case</span>
                  <ChevronRight aria-hidden className="size-[1.15em]" strokeWidth={2.25} />
                </span>
              ))}
          </span>
        </span>

        <span
          title={detail ? `${lead}\n${detail}` : undefined}
          className={cn("mt-0.5 text-[0.95rem] [overflow-wrap:anywhere]", blocked ? "line-clamp-1 text-ink-2 line-through decoration-ink-3/70" : "line-clamp-2 text-ink-2")}
        >
          {blocked && <span className="sr-only">Blocked message: </span>}
          {humanize(lead)}
        </span>
        {blocked && (
          <span className="mt-0.5 line-clamp-1 text-sm" title={`${JEV_QUESTION[blocked.check.questionId]} ${formatPct(blocked.check.confidence)} likely a problem, answered by ${jevSourceLabel(blocked.check.source)}.${blocked.check.reason ? " " + blocked.check.reason : ""}`}>
            <span className="font-semibold text-pathogen-ink">{blocked.reason}</span>
            <span className="text-ink-3">
              {" "}
              {formatPct(blocked.check.confidence)} likely, per {jevSourceLabel(blocked.check.source)}
            </span>
          </span>
        )}
      </span>
    </>
  );

  // Fixed-height slot keyed by position (RelayFeed): a new message changes what the slots hold, never
  // where they are, so nothing in the feed moves when it arrives.
  const inner = cn("feed-row grid h-full w-full grid-cols-[1.6rem_4.6rem_minmax(0,1fr)] gap-x-3 py-3 pr-2 text-left", fresh && "animate-fade-fast");

  if (caseId) {
    return (
      <li className="h-[6rem] overflow-hidden">
        <button
          key={m.id}
          type="button"
          onClick={() => onOpenCase(caseId)}
          aria-current={selected || undefined}
          className={cn(inner, "group cursor-pointer rounded-[4px] transition-colors duration-150 hover:bg-raised/70 focus-visible:-outline-offset-2")}
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="h-[6rem] overflow-hidden">
      <div key={m.id} className={inner}>
        {body}
      </div>
    </li>
  );
});
