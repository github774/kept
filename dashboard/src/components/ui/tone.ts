// Shared tone vocabulary for Badge, Banner, Stat and anything status-coloured.
// Class strings are written out in full so Tailwind can see them.

export type Tone =
  | "neutral"
  | "accent"
  | "pathogen"
  | "gold"
  | "trusted"
  | "probation"
  | "investigating"
  | "retiring"
  | "retired"
  | "failed"
  | "info";

/** Foreground text colour for a tone. */
export const toneText: Record<Tone, string> = {
  neutral: "text-ink-2",
  accent: "text-accent",
  pathogen: "text-pathogen",
  gold: "text-gold",
  trusted: "text-trusted",
  probation: "text-probation",
  investigating: "text-investigating",
  retiring: "text-retiring",
  retired: "text-retired",
  failed: "text-failed",
  info: "text-info",
};

/** A faint wash of the tone behind its own ink: quiet flags and notices. No border. */
export const toneSoft: Record<Tone, string> = {
  neutral: "bg-raised text-ink-2 border-transparent",
  accent: "bg-accent/10 text-accent border-transparent",
  pathogen: "bg-pathogen/10 text-pathogen border-transparent",
  gold: "bg-gold/12 text-gold border-transparent",
  trusted: "bg-trusted/10 text-trusted border-transparent",
  probation: "bg-probation/12 text-probation border-transparent",
  investigating: "bg-investigating/12 text-investigating border-transparent",
  retiring: "bg-retiring/10 text-retiring border-transparent",
  retired: "bg-retired/10 text-retired border-transparent",
  failed: "bg-failed/10 text-failed border-transparent",
  info: "bg-info/10 text-info border-transparent",
};

/** Solid fill: the MOCK flag and the possessed marker only. */
export const toneSolid: Record<Tone, string> = {
  neutral: "bg-ink-2 text-canvas border-transparent",
  accent: "bg-accent text-on-accent border-transparent",
  pathogen: "bg-pathogen text-on-pathogen border-transparent",
  gold: "bg-gold text-canvas border-transparent",
  trusted: "bg-trusted text-canvas border-transparent",
  probation: "bg-probation text-canvas border-transparent",
  investigating: "bg-investigating text-canvas border-transparent",
  retiring: "bg-retiring text-canvas border-transparent",
  retired: "bg-retired text-canvas border-transparent",
  failed: "bg-failed text-canvas border-transparent",
  info: "bg-info text-canvas border-transparent",
};

/** Raw CSS colour for a tone, for inline styles, SVG and charts. */
export const toneVar: Record<Tone, string> = {
  neutral: "var(--ink-3)",
  accent: "var(--accent)",
  pathogen: "var(--pathogen)",
  gold: "var(--gold)",
  trusted: "var(--trusted)",
  probation: "var(--probation)",
  investigating: "var(--investigating)",
  retiring: "var(--retiring)",
  retired: "var(--retired)",
  failed: "var(--failed)",
  info: "var(--info)",
};
