// The few marks lucide does not have, drawn on its 24px grid with its stroke so they sit in the same set:
// a slip of paper (the bad note), a filled shield, a retired bust, a test tube with a check, the ink splat
// and the four-dot team. All take className for size and colour.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number };

function Svg({ strokeWidth = 2, children, ...rest }: IconProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** A slip of paper with a folded corner and one line. The bad-note mark. */
export function Note(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </Svg>
  );
}

/** Filled immunity shield with a paper check: the Immune chip. */
export function ShieldFilled(props: IconProps) {
  return (
    <Svg strokeWidth={1.6} {...props}>
      <path
        d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
        fill="currentColor"
      />
      <path d="m9 12.2 2.1 2.1 4-4.2" stroke="var(--surface)" strokeWidth={2} />
    </Svg>
  );
}

/** A bust struck through: retired (07). */
export function Retired(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5.2 20.2c0-3.9 3-6.9 6.8-6.9s6.8 3 6.8 6.9" />
      <path d="M3.5 20.5 20.5 3.5" />
    </Svg>
  );
}

/** Test tube with a check in a circle: tests pass. */
export function TestTubeCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 2.8h6.5M8 2.8v13.4a2.6 2.6 0 0 0 4 2.2" />
      <path d="M8 11h3.2" />
      <circle cx="16.4" cy="16.2" r="4.6" />
      <path d="m14.4 16.3 1.4 1.4 2.6-2.8" />
    </Svg>
  );
}

/** An ink splat: poison. */
export function Splat(props: IconProps) {
  return (
    <Svg strokeWidth={0} {...props}>
      <path
        fill="currentColor"
        d="M11.6 5.2c1.1-.3 1.5 1.4 2.4 1.7 1 .3 2.1-1 3-.3.8.7-.5 2 0 2.9.5.8 2.4.5 2.7 1.5.3 1-1.5 1.5-1.5 2.5s1.9 1.6 1.4 2.5c-.5 1-2.3.1-3.1.8-.8.7-.1 2.6-1.1 2.9-1 .4-1.7-1.5-2.8-1.5-1.1 0-1.8 1.9-2.8 1.5-1-.4-.2-2.3-.9-3-.8-.7-2.7.1-3-.9-.4-1 1.5-1.6 1.5-2.7S5.4 11.4 5.8 10.4c.4-1 2.3-.2 3-.9.8-.7 0-2.6 1-3 .9-.4 1.1 1 1.8.7Z"
      />
      <circle cx="4" cy="8.2" r="1" fill="currentColor" />
      <circle cx="20.6" cy="6.4" r="0.9" fill="currentColor" />
      <circle cx="19.8" cy="19.6" r="1.1" fill="currentColor" />
    </Svg>
  );
}

/** Four circles: one team of four agents. */
export function FourDots(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7.5" cy="7.5" r="2.8" />
      <circle cx="16.5" cy="7.5" r="2.8" />
      <circle cx="7.5" cy="16.5" r="2.8" />
      <circle cx="16.5" cy="16.5" r="2.8" />
    </Svg>
  );
}

/** Lucide's shield-check, with the tick as its own path (pathLength 1) so a hover can redraw it. */
export function ShieldTick(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path className="tick" pathLength={1} d="m9 12 2 2 4-4" />
    </Svg>
  );
}
