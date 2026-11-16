import type { ReactNode } from "react";
import { cn } from "./cn";

/** Keyboard key: <Kbd>P</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-sm border border-line-strong border-b-2 bg-surface px-1.5 font-mono text-xs text-ink-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
