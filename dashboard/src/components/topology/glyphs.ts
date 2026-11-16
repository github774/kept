// Lucide icon paths (ISC, lucide-react 1.66) drawn on canvas, so each status shows the same
// glyph as StatusPill (ShieldCheck, Hourglass, Microscope, ShieldOff, Ghost, OctagonX).
import type { AgentStatus } from "../../data";
import { STATUS_META } from "../ui/StatusPill";

const D = {
  shieldCheck: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ],
  hourglass: [
    "M5 22h14",
    "M5 2h14",
    "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22",
    "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
  ],
  microscope: [
    "M6 18h8",
    "M3 22h18",
    "M14 22a7 7 0 1 0 0-14h-1",
    "M9 14h2",
    "M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z",
    "M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3",
  ],
  shieldOff: [
    "m2 2 20 20",
    "M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71",
    "M9.309 3.652A12.252 12.252 0 0 0 11.24 2.28a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v7a9.784 9.784 0 0 1-.08 1.264",
  ],
  note: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
    "M14 2v6h6",
    "M8 13h8",
    "M8 17h5",
  ],
  ghost: [
    "M15 10v1",
    "M7.528 20.472a1.6 1.6 0 012.277 0l1.057 1.056a1.6 1.6 0 002.276 0l1.057-1.056a1.6 1.6 0 012.277 0l1.114 1.114a1.4 1.4 0 002.414-1V10a8 8 0 00-16 0v10.586a1.4 1.4 0 002.414 1z",
    "M9 10v1",
  ],
  octagonX: [
    "m15 9-6 6",
    "M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z",
    "m9 9 6 6",
  ],
  skull: [
    "m12.5 17-.5-1-.5 1h1z",
    "M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z",
    "M14 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
    "M8 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
  ],
  shieldPlus: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "M9 12h6",
    "M12 9v6",
  ],
  radioTower: [
    "M4.9 16.1C1 12.2 1 5.8 4.9 1.9",
    "M7.8 4.7a6.14 6.14 0 0 0-.8 7.5",
    "M16.2 4.8c2 2 2.26 5.11.8 7.47",
    "M19.1 1.9a9.96 9.96 0 0 1 0 14.1",
    "M9.5 18h5",
    "m8 22 4-11 4 11",
  ],
  check: ["M20 6 9 17l-5-5"],
} as const;

export type GlyphName = keyof typeof D;

let cache: Record<GlyphName, Path2D[]> | null = null;
function paths(name: GlyphName): Path2D[] {
  if (!cache) {
    cache = {} as Record<GlyphName, Path2D[]>;
    for (const k of Object.keys(D) as GlyphName[]) cache[k] = D[k].map((d) => new Path2D(d));
  }
  return cache[name];
}

/** Draws a 24-unit lucide glyph centered at (x, y), `size` px wide, in the current strokeStyle. */
export function drawGlyph(ctx: CanvasRenderingContext2D, name: GlyphName, x: number, y: number, size: number, color: string, weight = 2): void {
  const s = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of paths(name)) ctx.stroke(p);
  ctx.restore();
}

export const STATUS_GLYPH: Record<AgentStatus, GlyphName> = {
  trusted: "shieldCheck",
  probation: "hourglass",
  under_investigation: "microscope",
  retiring: "shieldOff",
  retired: "ghost",
  failed: "octagonX",
};

/** Labels come from STATUS_META so the graph and the pills never disagree. */
export const statusLabel = (s: AgentStatus): string => STATUS_META[s]?.label ?? s;

export type StatusTone = "trusted" | "probation" | "investigating" | "retiring" | "retired" | "failed";
export const STATUS_TONE: Record<AgentStatus, StatusTone> = {
  trusted: "trusted",
  probation: "probation",
  under_investigation: "investigating",
  retiring: "retiring",
  retired: "retired",
  failed: "failed",
};
