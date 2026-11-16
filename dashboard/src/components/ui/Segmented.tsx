import type { LucideIcon } from "lucide-react";
import { useId } from "react";
import { cn } from "./cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedProps<T extends string> {
  /** Accessible name for the group: "Run mode". */
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange(value: T): void;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/** Radio group drawn as a segmented switch: mode (ours / baseline), chart metric, etc. */
export function Segmented<T extends string>({ label, value, options, onChange, size = "md", disabled, className }: SegmentedProps<T>) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 rounded-md bg-raised p-0.5",
        disabled && "opacity-45",
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        const Icon = opt.icon;
        return (
          <label
            key={opt.value}
            className={cn(
              "press relative inline-flex cursor-pointer select-none items-center gap-1.5 rounded-sm font-medium leading-none",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent",
              size === "sm" ? "h-7 px-2.5 text-sm" : "h-8 px-3 text-sm",
              selected ? "bg-surface text-ink shadow-[0_1px_2px_oklch(0.2_0.02_70/0.12)]" : "text-ink-2 hover:text-ink",
              disabled && "cursor-not-allowed",
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            {Icon && <Icon aria-hidden className="size-[1.05em]" strokeWidth={2.25} />}
            {opt.label}
          </label>
        );
      })}
    </div>
  );
}
