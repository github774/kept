import { useId } from "react";
import { NOTE_FOLD, NOTE_RULE, NOTE_SHEET } from "./ink/composition";

/*
  The page's marks: a slip of paper for the bad note, the shield for a kept lesson, the check for a passing
  test, the hourglass for probation. Drawn as printed marks, with a faint ink grain.
*/

export function Note({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 6 100 82" className={className} aria-hidden="true">
      <defs>
        <filter id={`${id}g`} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="1.4" result="d" />
          <feColorMatrix
            in="n"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.7 0.4"
            result="speck"
          />
          <feComposite in="speck" in2="d" operator="in" result="s" />
          <feMerge>
            <feMergeNode in="d" />
            <feMergeNode in="s" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#${id}g)`} fill="currentColor">
        <path d={NOTE_SHEET} />
        <path d={NOTE_FOLD} fill="var(--paper-hi)" />
        <path d={NOTE_RULE} fill="var(--paper-hi)" />
      </g>
    </svg>
  );
}

export function Shield({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 56" className={className} aria-hidden="true">
      <path
        d="M24 3 C30 7 37 9 44 9.5 V25 C44 39 35 48.5 24 53 C13 48.5 4 39 4 25 V9.5 C11 9 18 7 24 3 Z"
        fill="currentColor"
      />
      <path
        d="M24 15 C27.5 17 31 18 34.5 18.4 V26.5 C34.5 33.5 30.2 38.6 24 41.3 C17.8 38.6 13.5 33.5 13.5 26.5 V18.4 C17 18 20.5 17 24 15 Z"
        fill="none"
        stroke="var(--paper-hi)"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path d="M5.8 10.3 8.6 13 14.2 7.3" fill="none" stroke="var(--paper-hi)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Hourglass({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <path
        d="M5 2.5h10M5 17.5h10M6.2 2.5c0 4 3.8 5 3.8 7.5S6.2 13.5 6.2 17.5M13.8 2.5c0 4-3.8 5-3.8 7.5s3.8 3.5 3.8 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M7.6 16.6c.6-2 1.6-2.6 2.4-2.6s1.8.6 2.4 2.6z" fill="currentColor" />
    </svg>
  );
}

export function Arrow({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 16" className={className} aria-hidden="true">
      <path d="M1 8h36M30 1.5 37.5 8 30 14.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M2 8h11M9 3.5 13.5 8 9 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
