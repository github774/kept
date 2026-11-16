import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { toneText, type Tone } from "./tone";

export interface BannerProps {
  /** Usually investigating (warning), failed (error), info. */
  tone?: Tone;
  icon?: LucideIcon;
  /** The fact, stated plainly: "Jev offline, using fallback". */
  title: ReactNode;
  /** Optional second sentence: what is happening about it. */
  children?: ReactNode;
  /** Optional control on the right (a ghost Button). */
  action?: ReactNode;
  /** One slim line. */
  compact?: boolean;
  className?: string;
}

/** A system notice set as one line of text with its icon, in the tone's ink. No box. */
export function Banner({ tone = "info", icon: Icon, title, children, action, compact, className }: BannerProps) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center gap-2.5", compact ? "min-h-7 text-sm" : "py-1.5 text-base", className)}>
      {Icon && <Icon aria-hidden className={cn("size-[1.1em] shrink-0", toneText[tone])} strokeWidth={2.25} />}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn("font-semibold", toneText[tone])}>{title}</span>
        {children != null && <span className="text-ink-2">{children}</span>}
      </div>
      {action != null && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}
