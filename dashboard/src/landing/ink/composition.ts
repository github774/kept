/*
  The hero composition, shared by the WebGL ink and its SVG fallback, so both draw the same picture.

  Units: one unit is 100 px of the 1672 px wide mockup (design/mockups/01-landing-hero.png); the origin is the
  possessed agent at the centre, y points down. Every agent is a team of four dots.

  The story, in seconds from the first frame (about five, then it holds). The fleet is already printed at frame 0
  (still wet, drying), so the picture is never empty:
    0.6 - 1.4  the centre team has the bad note: its black lifts, orange ink floods out and stains
    1.45 - 2.0 one pen stroke: a circle, then the slash through it (caught by its own tests)
    2.05 - 2.9 retired and replaced: the struck mark fades back and a fresh team of four prints over it
    2.7 - 4.0  print-blue rings spread from it like ink through water; the six teams they reach turn blue
    4.0 - 5.2  everything dries: wet gloss goes, edges settle, a faint tide line forms
*/

export const DOT_R = 0.088;
export const DOT_GAP = 0.135;

/** Ring radii, inner to outer. */
export const RINGS = [1.07, 1.55, 2.03, 2.55] as const;
/** Circle of the strike-out and its stroke width. */
export const STRIKE_R = 0.72;
export const STRIKE_W = 0.062;
/** The note mark's half size, centred on the origin. */
export const NOTE_HALF = 0.56;

export const T = {
  possess: 0.6,
  strike: 1.45,
  strikeDur: 0.55,
  retire: 2.05,
  replace: 2.25,
  rings: 2.7,
  ringGap: 0.11,
  ringDur: 1.2,
  end: 5.2,
} as const;

/** Which caption the story is on: 0 none, 1 possessed, 2 caught, 3 immune, 4 settled (labels only). */
export function phaseAt(t: number) {
  if (t >= T.end) return 4;
  if (t >= T.rings) return 3;
  if (t >= T.strike) return 2;
  if (t >= T.possess) return 1;
  return 0;
}

/** Black teams, the fleet. */
const FLEET: [number, number][] = [
  [-1.3, -2.83], [1.53, -2.9], [-2.5, -2.4], [2.75, -2.33], [-3.47, -1.35], [3.45, -1.08], [-2.78, -0.28],
  [2.75, -0.03], [-3.73, 0.62], [3.3, 1.19], [-2.98, 1.62], [2.47, 2.06], [-1.76, 2.47], [-3.68, 2.94],
  [1.15, 2.94], [3.13, 3.1], [-2.55, 3.45], [-0.6, 3.22], [1.95, 3.84],
];

/** The six teams the lesson reaches first: they turn print-blue as the third ring passes. */
const IMMUNE: [number, number][] = [
  [0.07, -2.0], [1.83, -1.13], [1.61, 0.87], [-0.15, 1.75], [-1.72, 0.82], [-1.62, -1.13],
];

export type Kind = 0 | 1 | 2; // 0 fleet, 1 becomes immune, 2 possessed

export interface Team {
  x: number;
  y: number;
  kind: Kind;
  /** When its ink lands, seconds. */
  t0: number;
  /** When it turns blue (kind 1 only), seconds. */
  tBlue: number;
}

// A fixed pseudo-random sequence, so every load lands the same drops in the same order.
function rand(i: number) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Time at which ring `i` (expanding with easeOutQuart over ringDur) reaches radius r. */
function ringArrival(i: number, r: number) {
  const R = RINGS[i];
  const p = Math.min(r / R, 0.999);
  // Invert 1 - (1 - x)^4 = p.
  const x = 1 - Math.pow(1 - p, 1 / 4);
  return T.rings + i * T.ringGap + x * T.ringDur;
}

// The fleet landed just before the first frame: full size, still glossy, drying over the first two seconds.
const landed = (i: number) => -0.95 + 0.5 * rand(i);

export const TEAMS: Team[] = [
  { x: 0, y: 0, kind: 2, t0: landed(1), tBlue: 0 },
  ...IMMUNE.map(([x, y], i) => ({
    x,
    y,
    kind: 1 as Kind,
    t0: landed(i + 3),
    tBlue: ringArrival(2, Math.hypot(x, y)) - 0.05,
  })),
  ...FLEET.map(([x, y], i) => ({ x, y, kind: 0 as Kind, t0: landed(i + 40), tBlue: 0 })),
  // The replacement, printed fresh over the retired mark.
  { x: 0, y: 0, kind: 0, t0: T.replace, tBlue: 0 },
];

/**
 * Words on the picture, in units. The film's caption sits in the clear wedge just above the struck mark (its
 * bottom edge at caption.y); the still's labels sit under the mark and beside the top immune team.
 */
export const LABELS = {
  caption: { x: 0, y: -0.86 },
  caught: { x: 0, y: 0.91 },
  immune: { x: 0.42, y: -2.0 },
} as const;

export const DOT_OFFSETS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

export interface Layout {
  /** Composition origin in CSS px from the canvas's top-left. */
  cx: number;
  cy: number;
  /** CSS px per unit. */
  scale: number;
}

/**
 * Where the composition sits in a canvas of w x h CSS px.
 * Wide: the canvas is the right 51% of the hero; the centre sits at 75% of the viewport width, as in the mockup.
 * Narrow: the canvas is a block under the copy; the centre is in the middle and the outer teams crop at the edges.
 */
export function layoutFor(w: number, h: number, wide: boolean): Layout {
  if (wide) {
    const vw = w / 0.51;
    const scale = Math.min(vw / 16.72, h / 9.1);
    return { cx: w * 0.51, cy: h * 0.5, scale };
  }
  return { cx: w / 2, cy: h / 2, scale: Math.min(w / 6.6, h / 6.6) };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* The note, in a 100 x 100 box: a sheet with a folded corner. The fold and the rule are cut out of the fill. */

export const NOTE_SHEET = "M22 28 H64 L78 42 V82 H22 Z";
export const NOTE_FOLD = "M64 28 V42 H78 Z";
export const NOTE_RULE = "M32 58 H66 V61.4 H32 Z";
