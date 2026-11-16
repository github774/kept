import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface PanelProps {
  /** Sentence case, plain words: what this section answers ("What just happened", "Proof"). */
  title: ReactNode;
  /** Optional lucide icon before the title. Use sparingly; most sections need none. */
  icon?: LucideIcon;
  /** Short grey note after the title: a count, a freshness, "est.". */
  meta?: ReactNode;
  /** Right side of the title row: a quiet button or a toggle. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Classes on the outer <section> (grid placement, height). */
  className?: string;
  /** Classes on the body. */
  bodyClassName?: string;
  /** Body scrolls inside the section (default true). Set false for content that sizes itself. */
  scroll?: boolean;
  /** Kept for compatibility: sections have no inner padding of their own now. */
  padded?: boolean;
  /** Draw a 2px accent rule over the title: the one section the presenter is pointing at. */
  highlight?: boolean;
  /** default: a hairline rule over the title. bare: no rule (the first section in a column). */
  variant?: "default" | "bare" | "hero";
  /** Title size: md (2rem serif, default) or lg (2.5rem serif, a column's lead section). */
  size?: "md" | "lg";
  /** @deprecated Corner ticks were removed; ignored. */
  tick?: string;
  id?: string;
}

/**
 * One titled section of the page (06): a serif title, an optional grey note and actions, then the
 * content straight on the paper. The default variant has a hairline over the title. Icons are accepted
 * for compatibility but not drawn: the serif title carries the section.
 */
export function Panel({
  title,
  meta,
  actions,
  children,
  className,
  bodyClassName,
  scroll = true,
  highlight = false,
  variant = "default",
  size = "md",
  id,
}: PanelProps) {
  const ruled = variant === "default";
  return (
    <section
      id={id}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        ruled && "border-t",
        highlight ? "border-t-2 border-accent" : "border-line-strong/80",
        className,
      )}
    >
      <header className={cn("flex shrink-0 items-baseline gap-3 pb-3", ruled ? "pt-4" : "pt-0")}>
        <h2 className={cn("font-display m-0 min-w-0 truncate leading-[1] font-semibold tracking-[-0.012em] text-ink", size === "lg" ? "text-[2.6rem]" : "text-[2.05rem]")}>{title}</h2>
        {meta != null && <span className="min-w-0 shrink-[100] truncate text-sm text-ink-3">{meta}</span>}
        {actions != null && <div className="ml-auto flex shrink-0 items-center gap-2 self-center">{actions}</div>}
      </header>
      <div className={cn("relative min-h-0 flex-1", scroll ? "scroll-edge overflow-auto overscroll-contain" : "overflow-hidden", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
