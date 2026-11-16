import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * primary: the one main action on screen (ink). secondary: grey pill. danger: stop / crash.
   * ghost: text only. pathogen: fault injection (Possess).
   */
  variant?: "primary" | "secondary" | "danger" | "ghost" | "pathogen";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  /** Shows a spinner in place of the icon and disables the button. */
  loading?: boolean;
  children?: ReactNode;
}

const variants = {
  primary: "bg-primary text-on-primary enabled:hover:bg-[#33302a]",
  secondary: "bg-transparent text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] enabled:hover:bg-raised",
  danger: "bg-transparent text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] enabled:hover:bg-ink enabled:hover:text-on-primary enabled:hover:shadow-none",
  ghost: "bg-transparent text-ink-2 enabled:hover:bg-raised enabled:hover:text-ink",
  pathogen: "bg-pathogen text-on-pathogen enabled:hover:opacity-85",
} as const;

const sizes = {
  sm: "h-8 gap-1.5 px-3 text-sm",
  md: "h-9 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-4 text-base",
} as const;

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "press inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-full font-medium leading-none",
        "disabled:cursor-not-allowed disabled:opacity-40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle aria-hidden className="size-[1.1em] shrink-0 animate-spin" strokeWidth={2.25} />
      ) : (
        Icon && <Icon aria-hidden className="size-[1.1em] shrink-0" strokeWidth={2.25} />
      )}
      {children}
    </button>
  );
}
