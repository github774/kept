import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps {
  icon?: LucideIcon;
  /** What is missing and why, in the product's words: "No case files yet". */
  title: ReactNode;
  /** What will make it appear: "A case opens when Jev or the tests catch a false claim." */
  children?: ReactNode;
  action?: ReactNode;
  /** Smaller variant for short sections. */
  compact?: boolean;
  className?: string;
}

/** Fills a section when there is no data. Teaches what will show up here and what causes it. Left-aligned. */
export function EmptyState({ icon: Icon, title, children, action, compact, className }: EmptyStateProps) {
  return (
    <div className={cn("flex min-h-0 flex-col items-start gap-1.5", compact ? "py-1" : "py-3", className)}>
      <p className={cn("m-0 flex items-center gap-2 font-medium text-ink-2", compact ? "text-base" : "text-lg")}>
        {Icon && <Icon aria-hidden className="size-[1em] shrink-0 text-ink-3" strokeWidth={2} />}
        {title}
      </p>
      {children != null && <p className="m-0 max-w-[48ch] text-sm text-ink-3">{children}</p>}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  );
}
