// Reads the dashboard's CSS tokens (src/index.css) at draw time so the canvas follows the
// theme. Every token resolves to plain sRGB through a 1x1 canvas, so oklch() and
// color-mix() values work and we can build rgba() strings with any alpha.

export type RGB = readonly [number, number, number];

export interface Theme {
  dark: boolean;
  canvas: RGB;
  surface: RGB;
  raised: RGB;
  sunken: RGB;
  line: RGB;
  lineStrong: RGB;
  ink: RGB;
  ink2: RGB;
  ink3: RGB;
  accent: RGB; // verified notes, Relay, selection
  pathogen: RGB; // possession
  gold: RGB; // case files / herd immunity
  trusted: RGB;
  probation: RGB;
  investigating: RGB;
  retiring: RGB;
  retired: RGB;
  failed: RGB;
  info: RGB;
  mono: string;
  sans: string;
}

const DARK: Omit<Theme, "dark" | "mono" | "sans"> = {
  canvas: [14, 20, 23],
  surface: [20, 27, 31],
  raised: [28, 36, 41],
  sunken: [10, 15, 18],
  line: [42, 53, 58],
  lineStrong: [72, 87, 94],
  ink: [238, 246, 247],
  ink2: [196, 210, 214],
  ink3: [152, 168, 174],
  accent: [64, 224, 236],
  pathogen: [236, 72, 170],
  gold: [246, 190, 72],
  trusted: [74, 222, 128],
  probation: [240, 204, 80],
  investigating: [250, 146, 60],
  retiring: [196, 136, 108],
  retired: [150, 160, 166],
  failed: [242, 92, 84],
  info: [120, 170, 250],
};

// Warm paper fallback (the light redesign): cream ground, near-black ink, print-like hues.
const LIGHT: Omit<Theme, "dark" | "mono" | "sans"> = {
  canvas: [246, 241, 231], // #F6F1E7
  surface: [250, 247, 240],
  raised: [239, 233, 221],
  sunken: [238, 231, 217],
  line: [221, 213, 198],
  lineStrong: [176, 166, 148],
  ink: [26, 24, 20], // #1A1814
  ink2: [74, 69, 60],
  ink3: [110, 103, 92],
  accent: [38, 84, 124],
  pathogen: [204, 102, 28], // the bad-note orange
  gold: [158, 112, 20],
  trusted: [46, 110, 64],
  probation: [150, 110, 20],
  investigating: [176, 92, 30],
  retiring: [140, 92, 66],
  retired: [120, 114, 104],
  failed: [176, 48, 40],
  info: [52, 90, 150],
};

const TOKENS: Record<keyof Omit<Theme, "dark" | "mono" | "sans">, string[]> = {
  canvas: ["--canvas"],
  surface: ["--surface"],
  raised: ["--raised"],
  sunken: ["--sunken"],
  line: ["--line"],
  lineStrong: ["--line-strong"],
  ink: ["--ink"],
  ink2: ["--ink-2"],
  ink3: ["--ink-3"],
  accent: ["--accent"],
  pathogen: ["--note", "--possessed", "--pathogen"], // bad note / caught accent
  gold: ["--case", "--gold", "--warning", "--amber"],
  trusted: ["--trusted"],
  probation: ["--probation"],
  investigating: ["--investigating"],
  retiring: ["--retiring"],
  retired: ["--retired"],
  failed: ["--failed"],
  info: ["--info"],
};

let probe: CanvasRenderingContext2D | null = null;
function resolve(value: string): RGB | null {
  if (!value) return null;
  if (!probe) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    probe = c.getContext("2d", { willReadFrequently: true });
    if (!probe) return null;
  }
  // Two sentinels: an unparsable value leaves fillStyle unchanged, so both differ.
  probe.fillStyle = "#010203";
  probe.fillStyle = value;
  const a = probe.fillStyle;
  probe.fillStyle = "#fefdfc";
  probe.fillStyle = value;
  if (a !== probe.fillStyle) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Reads tokens from `el` (inherits :root / [data-theme]). Missing tokens fall back per mode. */
export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const get = (names: string[]): RGB | null => {
    for (const n of names) {
      const v = resolve(cs.getPropertyValue(n).trim());
      if (v) return v;
    }
    return null;
  };
  const canvas = get(TOKENS.canvas);
  // No canvas token at all: assume the paper redesign (light).
  const dark = canvas ? lum(canvas) < 0.5 : false;
  const base = dark ? DARK : LIGHT;
  const out = { dark } as Theme;
  for (const k of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) out[k] = get(TOKENS[k]) ?? base[k];
  const mono = cs.getPropertyValue("--font-mono").trim();
  out.mono = mono || `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  const sans = cs.getPropertyValue("--font-sans").trim();
  out.sans = sans || `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`;
  return out;
}

export const rgba = (c: RGB, a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a < 0 ? 0 : a > 1 ? 1 : a})`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
