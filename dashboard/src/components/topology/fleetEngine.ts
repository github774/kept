// Canvas engine for the 1,000-agent fleet view (design/mockups/05): one ink dot per agent, teams of 4 as
// 2x2 clusters scattered loosely over the paper (a fixed per-team jitter, so it reads hand-set, not gridded).
// Only cells that changed since the last grid animate; everything else lives in a cached
// static layer, and the frame loop sleeps when nothing moves.
//
//   X possessed -> I caught (dot steps out of its team and gets a ring) -> R retired (hollow)
//   -> P replacement (springs in) -> T trusted -> D done.
//   A case file sends the lesson to the caught agent's teammates: one ripple runs out from the
//   team (600 ms), a print-blue ring is drawn around the team and stays, and the three newest lesson
//   sources keep faint concentric rings, like ink spreading through water.
// Motion budget: state changes 240 ms, ring draw 480 ms, ripple 600 ms; nothing loops.
import { readTheme, rgba, mix, type RGB, type Theme } from "./theme";

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

const ANIM_MS = 240;
/** Cell codes drawn as a solid ink dot (sprite-stamped when settled). */
const FILLED = new Set(["T", "D", "X", "I", "F"]);
const RIPPLE_MS = 400;
const RING_MS = 380;
/** Per-team scatter, as a fraction of the team cell. */
const JITTER = 0.24;
const hash = (n: number) => {
  let x = (n + 1) * 0x9e3779b1;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

export interface FleetFrame {
  cells: string;
  agentsPerTeam: number;
}

export interface FleetCase {
  id: string;
  slot: number; // global agent index of the caught agent
}

interface Anim {
  from: string;
  to: string;
  t0: number;
}

export class FleetEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private theme: Theme;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private running = false;
  private hidden = false;
  private reduced = false;

  private cells = "";
  private per = 4;
  private cols = 1;
  private cell = 10; // team cell size (px): the smaller of cw and ch
  private cw = 10;
  private ch = 10;
  private slotOf: number[] = []; // team -> grid cell
  private ox = 0;
  private oy = 0;
  private dotR = 3;
  private anims = new Map<number, Anim>();
  private immune = new Map<number, number>(); // agent index -> t0
  private immuneTeams = new Map<number, number>(); // team -> t0 of its first lesson
  private sources: number[] = []; // teams that sent the newest lessons (newest last, at most 3)
  private baked = new Set<number>(); // team rings already drawn into the static layer
  private hover: { team: number; t0: number } | null = null;
  private ripples: { x: number; y: number; t0: number }[] = [];
  private seenCases = new Set<string>();
  private staticLayer: HTMLCanvasElement | null = null;
  private staticDirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.theme = readTheme(canvas);
  }

  start(): void {
    this.running = true;
    this.kick();
  }
  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  setHidden(h: boolean): void {
    this.hidden = h;
    if (h) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      // Coming back: settle everything that changed while hidden.
      this.anims.clear();
      this.ripples = [];
      this.staticDirty = true;
      this.kick();
    }
  }
  setReducedMotion(r: boolean): void {
    this.reduced = r;
    this.staticDirty = true;
    this.kick();
  }
  refreshTheme(): void {
    this.theme = readTheme(this.canvas);
    this.staticDirty = true;
    this.kick();
  }
  resize(w: number, h: number, dpr: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    dpr = clamp(dpr || 1, 1, 3);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.layout();
    this.staticDirty = true;
    this.kick();
  }

  /** New grid tick. Diffs against what is on screen, so missed ticks still animate correctly. */
  setGrid(f: FleetFrame | null): void {
    if (!f) {
      this.cells = "";
      this.anims.clear();
      this.immune.clear();
      this.immuneTeams.clear();
      this.baked.clear();
      this.sources = [];
      this.seenCases.clear();
      this.staticDirty = true;
      this.kick();
      return;
    }
    const now = performance.now();
    const prev = this.cells;
    const fresh = prev.length !== f.cells.length || f.agentsPerTeam !== this.per;
    this.per = f.agentsPerTeam || 4;
    if (fresh) {
      this.cells = f.cells;
      this.anims.clear();
      this.immune.clear();
      this.immuneTeams.clear();
      this.baked.clear();
      this.sources = [];
      this.layout();
      this.staticDirty = true;
      this.kick();
      return;
    }
    if (!this.reduced) {
      for (let i = 0; i < f.cells.length; i++) {
        const a = prev.charCodeAt(i);
        const b = f.cells.charCodeAt(i);
        if (a !== b) this.anims.set(i, { from: prev[i]!, to: f.cells[i]!, t0: now });
      }
    }
    this.cells = f.cells;
    this.staticDirty = true;
    this.kick();
  }

  /** The team under the pointer, or null: it grows to 1.15x (150 ms) above the others. */
  setHover(team: number | null): void {
    if ((this.hover?.team ?? null) === team) return;
    this.hover = team == null ? null : { team, t0: performance.now() };
    this.staticDirty = true;
    this.kick();
  }

  /** The team whose centre is nearest (x, y) in CSS px, within reach of its dots; null otherwise. */
  teamAt(x: number, y: number): { team: number; x: number; y: number } | null {
    const teams = Math.ceil(this.cells.length / this.per);
    let best: { team: number; x: number; y: number } | null = null;
    let bestD = this.cell * 0.42;
    for (let t = 0; t < teams; t++) {
      const c = this.teamCenter(t);
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = { team: t, x: c.x, y: c.y };
      }
    }
    return best;
  }

  /** The codes of a team's agents and whether its lesson made it immune. */
  teamInfo(team: number): { codes: string; immune: boolean } {
    return { codes: this.cells.slice(team * this.per, team * this.per + this.per), immune: this.immuneTeams.has(team) };
  }

  /** Cases seen so far. New ones send a ripple through the caught agent's team. */
  setCases(cases: FleetCase[], seed: boolean): void {
    const now = performance.now();
    for (const c of cases) {
      if (this.seenCases.has(c.id)) continue;
      this.seenCases.add(c.id);
      const team = Math.floor(c.slot / this.per);
      const t0 = seed || this.reduced ? -1e9 : now;
      for (let k = 0; k < this.per; k++) {
        const i = team * this.per + k;
        if (i !== c.slot && i < this.cells.length) this.immune.set(i, t0);
      }
      if (!this.immuneTeams.has(team)) this.immuneTeams.set(team, t0);
      this.sources = [...this.sources.filter((t) => t !== team), team].slice(-3);
      if (!seed && !this.reduced) {
        const p = this.teamCenter(team);
        this.ripples.push({ x: p.x, y: p.y, t0: now });
      }
    }
    this.staticDirty = true;
    this.kick();
  }

  private layout(): void {
    const n = Math.max(this.cells.length, 1);
    const teams = Math.ceil(n / this.per);
    // Leave a margin for the scatter and the team rings.
    const W = this.w - 28;
    const H = this.h - 28;
    // Columns that make the cells closest to square, then stretch the cells to fill the sheet.
    const cols = Math.max(1, Math.round(Math.sqrt((teams * W) / Math.max(H, 1))));
    const rows = Math.max(1, Math.ceil(teams / cols));
    this.cols = cols;
    this.cw = W / cols;
    this.ch = H / rows;
    this.cell = Math.min(this.cw, this.ch);
    this.ox = (this.w - W) / 2;
    this.oy = (this.h - H) / 2;
    this.dotR = Math.max(1.6, this.cell * 0.062);
    // Spread the empty cells over the sheet instead of leaving a ragged last row.
    const total = rows * cols;
    const empty = total - teams;
    const skip = new Set<number>();
    for (let k = 0; k < empty; k++) skip.add(Math.floor(((k + 0.5) * total) / empty));
    this.slotOf = [];
    for (let c = 0; c < total && this.slotOf.length < teams; c++) if (!skip.has(c)) this.slotOf.push(c);
  }

  private teamCenter(team: number): { x: number; y: number } {
    const slot = this.slotOf[team] ?? team;
    const col = slot % this.cols;
    const row = Math.floor(slot / this.cols);
    const jx = (hash(team * 2) - 0.5) * 2 * JITTER * this.cell;
    const jy = (hash(team * 2 + 1) - 0.5) * 2 * JITTER * this.cell;
    return { x: this.ox + (col + 0.5) * this.cw + jx, y: this.oy + (row + 0.5) * this.ch + jy };
  }

  /** Dot position: 2x2 inside the team cell (wider teams wrap to rows of 2). */
  private pos(i: number): { x: number; y: number; dx: number; dy: number } {
    const team = Math.floor(i / this.per);
    const m = i % this.per;
    const c = this.teamCenter(team);
    const pitch = this.cell * 0.2;
    const across = 2;
    const rows = Math.ceil(this.per / across);
    const gx = (m % across) - (across - 1) / 2;
    const gy = Math.floor(m / across) - (rows - 1) / 2;
    return { x: c.x + gx * pitch, y: c.y + gy * pitch, dx: gx, dy: gy };
  }

  private kick(): void {
    if (!this.running || this.hidden || !this.w || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    for (const [i, a] of this.anims) if (now - a.t0 > ANIM_MS) {
      this.anims.delete(i);
      this.staticDirty = true;
    }
    this.ripples = this.ripples.filter((r) => now - r.t0 < RIPPLE_MS);
    for (const [team, t0] of this.immuneTeams)
      if (!this.baked.has(team) && (t0 < 0 || this.reduced || now - t0 >= RING_MS)) {
        this.baked.add(team);
        this.staticDirty = true;
      }
    if (this.staticDirty) this.buildStatic(now);
    this.draw(now);
    const immuneFresh = [...this.immuneTeams.values()].some((t) => now - t < RING_MS);
    const hoverGrowing = this.hover != null && !this.reduced && now - this.hover.t0 < 170;
    if (this.anims.size || this.ripples.length || immuneFresh || hoverGrowing) this.raf = requestAnimationFrame(this.frame);
  };

  // ------------------------------------------------------------------ drawing
  private color(code: string): RGB {
    const th = this.theme;
    switch (code) {
      case "T":
        return th.ink;
      case "D":
        return th.ink3;
      case "P":
        return th.ink2;
      case "X":
      case "I":
        return th.pathogen;
      case "R":
        return th.retired;
      case "F":
        return th.failed;
      default:
        return th.lineStrong;
    }
  }

  /** Draws one agent's dot in its settled state for `code` (k = 0..1 animation progress, 1 = settled). */
  private dot(ctx: CanvasRenderingContext2D, i: number, code: string, k: number, from?: string): void {
    const p = this.pos(i);
    const r = this.dotR;
    const th = this.theme;
    let x = p.x;
    let y = p.y;
    // Caught: the dot steps out of its team (isolation), away from the team center.
    if (code === "I" || code === "R") {
      const out = this.cell * 0.08 * (code === "I" && from === "X" ? easeOut(k) : 1);
      const d = Math.hypot(p.dx, p.dy) || 1;
      x += (p.dx / d) * out;
      y += (p.dy / d) * out;
    }
    let scale = 1;
    if ((code === "P" && (from === "R" || from === ".")) || (code === "T" && from === ".")) scale = easeOut(k);
    let col = this.color(code);
    if (from && from !== code && k < 1) col = mix(this.color(from), col, easeOut(k));
    const rr = r * (code === "." ? 0.7 : 1) * (0.35 + 0.65 * scale);

    if (code === "." || code === "R" || code === "P") {
      ctx.lineWidth = code === "." ? 1 : 1.4;
      ctx.strokeStyle = rgba(col, code === "." ? 0.9 : 1);
      ctx.beginPath();
      ctx.arc(x, y, code === "R" ? r * (1 - 0.15 * (from === "I" ? 1 - easeOut(k) : 0)) : code === "P" ? rr * 0.92 : rr, 0, Math.PI * 2);
      ctx.stroke();
      if (code === "R" && from === "I" && k < 1) {
        ctx.fillStyle = rgba(th.pathogen, 1 - easeOut(k));
        ctx.beginPath();
        ctx.arc(x, y, r * (1 - easeOut(k)), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = rgba(col, 1);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    // Caught ring
    if (code === "I") {
      ctx.strokeStyle = rgba(th.pathogen, 1);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 2 * (from === "X" ? easeOut(k) : 1), 0, Math.PI * 2);
      ctx.stroke();
      if (from === "X" && k < 1 && !this.reduced) {
        // One pulse at the moment of the catch.
        ctx.strokeStyle = rgba(th.pathogen, 1 - easeOut(k));
        ctx.beginPath();
        ctx.arc(x, y, r + 3 + easeOut(k) * this.cell * 0.45, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** The print-blue ring around a team its lesson reached; it draws itself once (480 ms), then stays. */
  private teamRing(ctx: CanvasRenderingContext2D, team: number, now: number): void {
    const t0 = this.immuneTeams.get(team);
    if (t0 === undefined) return;
    const k = this.reduced || t0 < 0 ? 1 : clamp((now - t0) / RING_MS, 0, 1);
    const p = this.teamCenter(team);
    ctx.strokeStyle = rgba(this.theme.accent, 0.95);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.cell * 0.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * easeOut(k));
    ctx.stroke();
  }

  /** Faint concentric rings around the newest lesson sources: where the immunity spread from. */
  private echoes(ctx: CanvasRenderingContext2D): void {
    this.sources.forEach((team, idx) => {
      const p = this.teamCenter(team);
      const age = this.sources.length - 1 - idx; // 0 = newest
      for (let ring = 1; ring <= 5; ring++) {
        ctx.strokeStyle = rgba(this.theme.accent, (0.5 - ring * 0.075) * (1 - age * 0.22));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.cell * (0.3 + ring * 0.3), 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }

  private sprites = new Map<string, { canvas: HTMLCanvasElement; size: number }>();
  private sprite(code: string): { canvas: HTMLCanvasElement; size: number } | null {
    const col = this.color(code);
    const key = `${code}:${this.dotR.toFixed(2)}:${this.dpr}:${col.join(",")}:${this.theme.dark}`;
    let spr = this.sprites.get(key);
    if (spr) return spr;
    const size = Math.ceil(this.dotR * 2 + 6);
    const c = document.createElement("canvas");
    c.width = Math.round(size * this.dpr);
    c.height = Math.round(size * this.dpr);
    const g = c.getContext("2d");
    if (!g) return null;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!this.theme.dark) {
      g.shadowColor = "rgba(40,30,15,0.28)";
      g.shadowBlur = 1.5;
      g.shadowOffsetY = 0.8;
    }
    g.fillStyle = rgba(col, 1);
    g.beginPath();
    g.arc(size / 2, size / 2, this.dotR, 0, Math.PI * 2);
    g.fill();
    spr = { canvas: c, size };
    if (this.sprites.size > 40) this.sprites.clear();
    this.sprites.set(key, spr);
    return spr;
  }

  private buildStatic(now: number): void {
    this.staticDirty = false;
    const c = this.staticLayer ?? document.createElement("canvas");
    this.staticLayer = c;
    c.width = Math.round(this.w * this.dpr);
    c.height = Math.round(this.h * this.dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    this.echoes(g);
    const hovered = this.hover?.team ?? -1;
    for (const [team, t0] of this.immuneTeams) if (team !== hovered && (this.reduced || t0 < 0 || now - t0 >= RING_MS)) this.teamRing(g, team, now);
    // Settled filled dots are stamped from a pre-rendered sprite (ink with a one-pixel contact shadow,
    // light theme only): no per-dot blur, so a rebuild of 1,000 dots stays well under a frame.
    for (let i = 0; i < this.cells.length; i++) {
      if (this.anims.has(i)) continue;
      if (Math.floor(i / this.per) === hovered) continue;
      const code = this.cells[i]!;
      const spr = FILLED.has(code) ? this.sprite(code) : null;
      if (spr) {
        const p = this.pos(i);
        let x = p.x;
        let y = p.y;
        if (code === "I") {
          const d = Math.hypot(p.dx, p.dy) || 1;
          x += (p.dx / d) * this.cell * 0.08;
          y += (p.dy / d) * this.cell * 0.08;
        }
        const half = spr.size / 2;
        g.drawImage(spr.canvas, x - half, y - half, spr.size, spr.size);
        if (code === "I") this.dot(g, i, code, 1); // the caught ring on top
      } else this.dot(g, i, code, 1);
    }
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Ripples under the moving dots.
    for (const r of this.ripples) {
      const k = (now - r.t0) / RIPPLE_MS;
      ctx.strokeStyle = rgba(this.theme.accent, 0.85 * (1 - easeOut(k)));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, this.cell * 0.3 + easeOut(k) * this.cell * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const [team, t0] of this.immuneTeams) if (!this.reduced && t0 >= 0 && now - t0 < RING_MS) this.teamRing(ctx, team, now);
    if (this.hover) {
      const team = this.hover.team;
      const c = this.teamCenter(team);
      const s = this.reduced ? 1 : 1 + 0.15 * easeOut((now - this.hover.t0) / 150);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(s, s);
      ctx.translate(-c.x, -c.y);
      for (let k = 0; k < this.per; k++) {
        const i = team * this.per + k;
        if (i < this.cells.length && !this.anims.has(i)) this.dot(ctx, i, this.cells[i]!, 1);
      }
      if (this.immuneTeams.has(team)) this.teamRing(ctx, team, now);
      else {
        ctx.strokeStyle = rgba(this.theme.ink3, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, this.cell * 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const [i, a] of this.anims) {
      const k = clamp((now - a.t0) / ANIM_MS, 0, 1);
      this.dot(ctx, i, a.to, k, a.from);
    }
  }
}
