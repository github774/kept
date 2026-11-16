import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { toneSoft, toneSolid, toneText, type Tone } from "./tone";

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  /** soft (default): a faint wash. solid: MOCK / possessed only. outline: coloured text, no fill. */
  variant?: "soft" | "solid" | "outline";
  icon?: LucideIcon;
  size?: "sm" | "md" | "lg";
  /** Monospace ID text (g2, run-7f3a). */
  mono?: boolean;
  className?: string;
  title?: string;
}

const sizes = {
  sm: "h-6 gap-1 px-1.5 text-xs",
  md: "h-7 gap-1.5 px-2 text-sm",
  lg: "h-8 gap-1.5 px-2.5 text-sm",
} as const;

/** Small inline flag. Rare by design: prefer a plain word in the tone colour. */
export function Badge({ children, tone = "neutral", variant = "soft", icon: Icon, size = "md", mono, className, title }: BadgeProps) {
  const toneCls = variant === "solid" ? toneSolid[tone] : variant === "outline" ? cn(toneText[tone], "bg-transparent px-0") : toneSoft[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-sm font-medium leading-none",
        sizes[size],
        mono && "font-mono",
        toneCls,
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-[1.05em] shrink-0" strokeWidth={2.25} />}
      {children}
    </span>
  );
}
