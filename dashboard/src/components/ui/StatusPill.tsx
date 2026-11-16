import type { AgentStatus } from "../../data/model";
import { Hourglass, Microscope, OctagonX, ShieldCheck, ShieldOff, UserX, type LucideIcon } from "lucide-react";
import { cn } from "./cn";
import { toneText, toneVar, type Tone } from "./tone";

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** Raw CSS color, for inline styles and charts. */
  color: string;
  /** One-line meaning, used as the pill's tooltip. */
  description: string;
}

/** The single source of truth for how each agent status looks. Reuse it anywhere a status appears. */
export const STATUS_META: Record<AgentStatus, StatusMeta> = {
  trusted: {
    label: "Trusted",
    icon: ShieldCheck,
    tone: "trusted",
    color: toneVar.trusted,
    description: "Claims verified by tests; notes are shared with the fleet",
  },
  probation: {
    label: "On probation",
    icon: Hourglass,
    tone: "probation",
    color: toneVar.probation,
    description: "New or replaced agent; trusted after 2 verified steps",
  },
  under_investigation: {
    label: "Caught",
    icon: Microscope,
    tone: "investigating",
    color: toneVar.investigating,
    description: "A claim failed verification; Jev and the tests are checking it",
  },
  retiring: {
    label: "Retiring",
    icon: ShieldOff,
    tone: "retiring",
    color: toneVar.retiring,
    description: "Caught in a false claim; being stopped, its case file written and a replacement spawned",
  },
  retired: {
    label: "Retired",
    icon: UserX,
    tone: "retired",
    color: toneVar.retired,
    description: "Caught lying; stopped and replaced. Its case file spreads over Relay",
  },
  failed: {
    label: "Failed",
    icon: OctagonX,
    tone: "failed",
    color: toneVar.failed,
    description: "Crashed or ran out of steps without passing tests",
  },
};

export interface StatusPillProps {
  status: AgentStatus;
  size?: "sm" | "md" | "lg";
  /** Hide the text label (icon + color only). Only for very tight spots; the label is the accessible name either way. */
  iconOnly?: boolean;
  className?: string;
}

const sizes = {
  sm: "gap-1 text-sm",
  md: "gap-1.5 text-base",
  lg: "gap-2 text-lg",
} as const;

/** Icon + word in the status ink. No box: the colour and the word carry it. Re-animates on change. */
export function StatusPill({ status, size = "md", iconOnly, className }: StatusPillProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      // key on status so the entrance animation replays on every change
      key={status}
      title={meta.description}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap font-medium leading-none",
        sizes[size],
        toneText[meta.tone],
        status === "retiring" && "italic",
        className,
      )}
    >
      <Icon aria-hidden className="size-[1.1em] shrink-0" strokeWidth={2.25} />
      <span className={iconOnly ? "sr-only" : undefined}>{meta.label}</span>
    </span>
  );
}
