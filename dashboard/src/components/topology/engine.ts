// Canvas engine for the immune topology. Lives outside React: the component calls
// ingest(view) whenever data changes; the engine diffs it (new relay items by id, status
// transitions per slot, new cases) into a queue of "beats". Beats play one at a time, each
// with a plain-English caption, so the story reads in order: work -> shared note ->
// possession -> Jev block -> retire -> respawn -> case broadcast -> replies -> trusted.
//
// Motion rules (apple-design skill): every animation starts on the frame its event plays
// (13 causality); routes are drawn before a packet travels so you see where it goes (8 hint);
// fast packets stretch along their path and no packet moves more than ~1/8 of a route per
// frame (11 smoothness); nodes spring into place critically damped, no overshoot (4);
// reduced motion keeps captions and states but swaps travel for instant cross-fades (14).
import type { AgentStatus } from "../../data";
import { slotOfName, type TopoAgent, type TopoCase, type TopoMsg, type TopoView } from "./adapt";
import { STATUS_GLYPH, STATUS_TONE, drawGlyph, statusLabel, type GlyphName } from "./glyphs";
import { readTheme, rgba, type RGB, type Theme } from "./theme";

type V = { x: number; y: number };
type End = number | "hub"; // a slot, or the Relay hub

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Standard move curve, cubic-bezier(0.4, 0, 0.2, 1) approximated: soft launch, soft landing. */
const easeMove = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
/** Critically damped spring step response (damping 1.0, response 0.3 s). */
const OMEGA = (2 * Math.PI) / 0.3;
const spring = (sec: number) => (sec <= 0 ? 0 : 1 - (1 + OMEGA * sec) * Math.exp(-OMEGA * sec));

export type CaptionTone = "note" | "case" | "blocked" | "possessed" | "status" | "spawn" | "trusted" | "system";
export interface Caption {
  tone: CaptionTone;
  kicker: string; // one or two words: "Blocked", "Case file", "Shared note"
  title: string; // the plain-English sentence
  detail?: string; // the quote, lesson or reason
  color: string; // rgba() resolved from the theme for this tone
  at: number; // performance.now() when it played
}

interface SlotVis {
  slot: number;
  shown: TopoAgent; // what the node shows (advanced by beats)
  target: TopoAgent; // latest data
  pending: number; // beats queued for this slot
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  appearAt: number; // spawn time, -Infinity = steady
  ghost: { agent: TopoAgent; t0: number } | null;
  pulse: { t0: number; color: RGB } | null;
  rect: Rect | null; // overlay mode: the host's own agent card
}

/** A box in canvas CSS px (overlay mode anchors). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type AnchorFn = () => { slots: Map<number, Rect>; hub: Rect | null };

interface Packet {
  route: End[];
  t0: number;
  dur: number;
  color: RGB;
  size: number;
  jev: boolean; // starts at an agent: Jev checks it at the ring
  crossed: boolean;
  blocked: boolean; // stops at the ring
  onArrive?: (now: number) => void;
  done: boolean;
  showRoute: boolean;
}

interface Beat {
  slot: number | null;
  dur: number; // ms of screen time (reading time for the caption)
  caption: () => Omit<Caption, "at" | "color"> & { color: RGB };
  play: (now: number, scale: number) => void; // scale 0 = apply instantly (no travel)
  ready?: () => boolean;
  queuedAt: number;
}

interface Immunity {
  t0: number;
  cases: Set<string>;
  replied: boolean;
  repliedAt: number;
}

export interface EngineOptions {
  onCaption?: (c: Caption | null) => void;
  /** Overlay mode: the host draws the agent cards; the engine reads their boxes each frame and draws only lines, Jev, packets and hub. */
  anchors?: AnchorFn;
}

/** Plain names for the screen: "Agent 4", "Agent 4 v2". Internal ids (w3-g2-r7k2) never show. */
const agentLabel = (slot: number | null, gen?: number) => (slot === null ? "An agent" : `Agent ${slot + 1}${gen && gen > 1 ? ` v${gen}` : ""}`);
const short = (name: string) => {
  const m = /^w(\d+)-g(\d+)/.exec(name);
  return m ? agentLabel(Number(m[1]), Number(m[2])) : name;
};
const plain = (name: string) => {
  const m = /^w(\d+)/.exec(name);
  return m ? agentLabel(Number(m[1])) : name;
};
/** "on probation" whether the label reads "Probation" or "On probation". */
const onStatus = (st: AgentStatus) => {
  const l = statusLabel(st).toLowerCase();
  return l.startsWith("on ") ? l : `on ${l}`;
};
const quote = (s: string, n = 90) => `“${s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s}”`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export class TopologyEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onCaption: (c: Caption | null) => void;
  private readonly anchors: AnchorFn | null;
  private theme: Theme;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private running = false;
  private hidden = false;
  private reduced = false;
  private last = 0;

  // layout
  private f = 15;
  private r = 22; // agent node radius
  private hubR = 34;
  private cx = 0;
  private cy = 0;
  private rJ = 120;
  private n = 4;
  private labelW = 150;

  // state
  private view: TopoView | null = null;
  private epoch: string | null | undefined = undefined;
  private seen = new Set<string>();
  private slots = new Map<number, SlotVis>();
  private packets: Packet[] = [];
  private beats: Beat[] = [];
  private beatEnd = 0;
  private flashes: { angle: number; t0: number; color: RGB; dur: number }[] = [];
  private blocks: { t0: number; at: V; pct: number; source: string }[] = [];
  private shards: { x: number; y: number; vx: number; vy: number; t0: number; rot: number }[] = [];
  private hubPulse: { t0: number; color: RGB } | null = null;
  private immune = new Map<string, Immunity>();
  private cases = new Map<string, TopoCase>();
  private notes = 0;

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.onCaption = opts.onCaption ?? (() => {});
    this.anchors = opts.anchors ?? null;
    this.theme = readTheme(canvas);
  }

  /** Type sizes in CSS px. Floors follow the projector rule: labels >= 18, status words >= 20. */
  private get sz() {
    const f = this.f;
    return { name: Math.max(18, f * 1.05), status: Math.max(20, f * 1.15), tag: Math.max(18, f), label: Math.max(18, f) };
  }

  // ------------------------------------------------------------------ lifecycle
  start(): void {
    this.running = true;
    this.kick();
  }
  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    // Back from a hidden tab: don't replay a long backlog, catch up instantly.
    if (this.beats.length > 3) this.flushBeats(performance.now());
    this.last = 0;
    this.kick();
  }
  setReducedMotion(r: boolean): void {
    this.reduced = r;
    this.kick();
  }
  refreshTheme(): void {
    this.theme = readTheme(this.canvas);
    this.kick();
  }
  resize(w: number, h: number, dpr: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    dpr = clamp(dpr || 1, 1, 3);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    const first = this.w === 0;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.layout(first);
    this.kick();
  }

  /** Overlay hosts call this when their cards move without a resize. */
  redraw(): void {
    this.kick();
  }

  /** Overlay mode: take node positions from the host's cards. */
  private measure(): void {
    const { slots, hub } = this.anchors!();
    for (const s of this.slots.values()) {
      const r = slots.get(s.slot) ?? null;
      s.rect = r;
      if (r) {
        s.x = s.tx = r.x + r.w / 2;
        s.y = s.ty = r.y + r.h / 2;
        s.vx = s.vy = 0;
      }
    }
    if (hub) {
      this.cx = hub.x + hub.w / 2;
      this.cy = hub.y + hub.h / 2;
      this.hubR = Math.min(hub.w, hub.h) / 2;
    } else {
      this.cx = this.w / 2;
      this.cy = this.h / 2;
    }
    let nearest = Infinity;
    for (const s of this.slots.values()) {
      if (!s.rect) continue;
      const r = s.rect;
      const dx = Math.max(r.x - this.cx, 0, this.cx - (r.x + r.w));
      const dy = Math.max(r.y - this.cy, 0, this.cy - (r.y + r.h));
      nearest = Math.min(nearest, Math.hypot(dx, dy));
    }
    if (isFinite(nearest)) this.rJ = Math.max(this.hubR + this.sz.label * 3.2, Math.min(nearest * 0.62, Math.min(this.w, this.h) * 0.3));
  }

  private kick(): void {
    if (!this.running || this.hidden || this.w === 0 || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Frames run only while something moves; an idle graph costs nothing. */
  private frame = (now: number): void => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    if (this.anchors) this.measure();
    this.update(now, dt);
    this.draw(now);
    if (this.running && !this.hidden && this.busy(now)) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  private busy(now: number): boolean {
    if (this.beats.length || now < this.beatEnd || this.packets.length || this.shards.length) return true;
    if (this.flashes.length || this.blocks.length || this.hubPulse) return true;
    for (const s of this.slots.values()) {
      if (s.ghost || s.pulse || now - s.appearAt < 400) return true;
      if (Math.abs(s.x - s.tx) > 0.3 || Math.abs(s.y - s.ty) > 0.3 || Math.abs(s.vx) > 0.5 || Math.abs(s.vy) > 0.5) return true;
      const im = this.immune.get(s.shown.name);
      if (im && now - Math.max(im.t0, im.repliedAt) < 400) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ layout
  private layout(snap = false): void {
    if (this.anchors) {
      this.f = clamp(Math.min(this.w, this.h) / 30, 14, 22);
      this.hubR = Math.max(30, this.f * 1.9);
      this.measure();
      return;
    }
    const { w: W, h: H } = this;
    const min = Math.min(W, H);
    this.f = clamp(min / 30, 14, 22);
    this.r = Math.max(26, this.f * 1.7);
    this.hubR = Math.max(30, this.f * 1.9);
    this.n = Math.max(this.view?.agentCount ?? 4, this.slots.size, 1);
    this.labelW = clamp(W * 0.24, 150, this.f * 13);
    const m = this.f * 0.8;
    const below = this.r + this.sz.name * 1.45 + this.sz.status * 1.45 + this.sz.tag * 1.3; // node + 3 label lines
    const yTop = m + this.r;
    const yBot = H - m - below;
    this.cx = W / 2;
    this.cy = (yTop + yBot) / 2;
    const rx = Math.max(W / 2 - m - this.labelW / 2, this.labelW * 0.6);
    const ry = Math.max((yBot - yTop) / 2, this.r * 2);
    let nearest = Infinity;
    for (const s of this.slots.values()) {
      const p = this.slotPos(s.slot, rx, ry);
      s.tx = p.x;
      s.ty = p.y;
      if (snap || (s.x === 0 && s.y === 0)) {
        s.x = p.x;
        s.y = p.y;
      }
      // Distance from the center to this node's label block.
      const x0 = p.x - this.labelW / 2;
      const x1 = p.x + this.labelW / 2;
      const y0 = p.y - this.r;
      const y1 = p.y + below;
      const dx = Math.max(x0 - this.cx, 0, this.cx - x1);
      const dy = Math.max(y0 - this.cy, 0, this.cy - y1);
      nearest = Math.min(nearest, Math.hypot(dx, dy));
    }
    if (!isFinite(nearest)) nearest = min * 0.4;
    const inner = this.hubR + this.sz.label * 3.2; // room for the hub's labels inside the ring
    this.rJ = Math.max(inner, Math.min(nearest - this.f * 1.2, min * 0.3));
  }

  private slotPos(slot: number, rx: number, ry: number): V {
    const n = this.n;
    const a = n === 1 ? -Math.PI / 2 : -Math.PI / 2 - Math.PI / n + (slot % n) * ((2 * Math.PI) / n);
    const sp = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 0.5);
    return { x: this.cx + rx * sp(Math.cos(a)), y: this.cy + ry * sp(Math.sin(a)) };
  }

  private nodePos(slot: number): V {
    const s = this.slots.get(slot);
    return s ? { x: s.x, y: s.y } : { x: this.cx, y: this.cy };
  }

  /** Where a route touches an endpoint: the edge of the node or hub circle. */
  private endPos(e: End, toward: V): V {
    const rect = e === "hub" ? null : (this.slots.get(e)?.rect ?? null);
    if (rect) {
      // Card edge on the line toward the target.
      const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const dx = toward.x - c.x;
      const dy = toward.y - c.y;
      const t = Math.min(dx ? rect.w / 2 / Math.abs(dx) : Infinity, dy ? rect.h / 2 / Math.abs(dy) : Infinity);
      const d = Math.hypot(dx, dy) || 1;
      return { x: c.x + dx * t + (dx / d) * 4, y: c.y + dy * t + (dy / d) * 4 };
    }
    const c = e === "hub" ? { x: this.cx, y: this.cy } : this.nodePos(e);
    const rad = (e === "hub" ? this.hubR : this.r) + 3;
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: c.x + (dx / d) * rad, y: c.y + (dy / d) * rad };
  }

  private routePts(route: End[]): V[] {
    const centers = route.map((e) => (e === "hub" ? { x: this.cx, y: this.cy } : this.nodePos(e)));
    // Every leg passes through the hub's center line; endpoints sit on circle edges.
    const pts: V[] = [];
    for (let i = 0; i < route.length; i++) {
      const e = route[i]!;
      if (e === "hub" && i > 0 && i < route.length - 1) {
        pts.push(this.endPos("hub", centers[i - 1]!), this.endPos("hub", centers[i + 1]!));
      } else pts.push(this.endPos(e, centers[i === 0 ? 1 : i - 1]!));
    }
    return pts;
  }

  private pointAt(route: End[], k: number): V {
    const pts = this.routePts(route);
    const lens: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      lens.push(l);
      total += l;
    }
    let d = clamp(k, 0, 1) * total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i]! || i === lens.length - 1) {
        const t = lens[i]! ? clamp(d / lens[i]!, 0, 1) : 0;
        const a = pts[i]!;
        const b = pts[i + 1]!;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      d -= lens[i]!;
    }
    return pts[0]!;
  }

  private routeLength(route: End[]): number {
    const pts = this.routePts(route);
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    return total;
  }

  /** Fraction of a route (from an agent) where it meets the Jev ring. */
  private ringFraction(route: End[]): number | null {
    if (route[0] === "hub" || route.length < 2) return null;
    const pts = this.routePts(route);
    const total = this.routeLength(route);
    const d0 = Math.hypot(pts[0]!.x - this.cx, pts[0]!.y - this.cy);
    if (d0 <= this.rJ || total === 0) return null;
    return (d0 - this.rJ) / total;
  }

  // ------------------------------------------------------------------ ingest (diff)
  ingest(v: TopoView): void {
    const now = performance.now();
    const prevCount = this.view?.agentCount;
    this.view = v;
    if (v.epoch === null && this.epoch === undefined) {
      this.kick();
      return;
    }
    let seeding = false;
    if (v.epoch !== null && v.epoch !== this.epoch) {
      seeding = this.epoch === undefined; // page just loaded: show the state, don't replay history
      this.resetEpoch();
      this.epoch = v.epoch;
    } else if (this.slots.size > 0 && v.agents.length === 0) {
      // Same run id restarted (the store cleared roster and relay): play the new pass live.
      this.resetEpoch();
    }

    // Agents
    let added = false;
    v.agents.forEach((a, i) => {
      const s = this.slots.get(a.slot);
      if (!s) {
        this.slots.set(a.slot, {
          slot: a.slot,
          shown: a,
          target: a,
          pending: 0,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          tx: 0,
          ty: 0,
          appearAt: seeding || this.reduced ? -1e9 : now + i * 90,
          ghost: null,
          pulse: null,
          rect: null,
        });
        added = true;
        return;
      }
      const t = s.target;
      s.target = a;
      if (seeding) {
        s.shown = a;
        return;
      }
      if (a.gen < t.gen) {
        Object.assign(s, { shown: a, pending: 0, ghost: null, appearAt: now });
        return;
      }
      if (a.gen > t.gen) {
        if (t.status !== "retired" && t.status !== "failed") this.queue(this.retireBeat(s.slot, t, a.reason ?? t.reason), now);
        this.queue(this.spawnBeat(s.slot, a), now);
        return;
      }
      if (a.possessed && !t.possessed) this.queue(this.possessBeat(s.slot, a), now);
      if (a.status !== t.status) this.queue(a.status === "retired" ? this.retireBeat(s.slot, t, a.reason, a) : this.statusBeat(s.slot, t, a), now);
      if (s.pending === 0) s.shown = a; // minor update (step, verified steps, reason)
    });
    if (added || prevCount !== v.agentCount) this.layout(seeding);

    for (const c of v.cases) this.cases.set(c.id, c);

    // Relay messages: only new ids.
    const fresh: TopoMsg[] = [];
    for (const m of v.messages) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      fresh.push(m);
    }
    if (seeding) {
      for (const m of fresh) if (m.kind === "note") this.notes++;
      for (const c of v.cases) {
        for (const name of c.recipients ?? []) this.grant(name, c.id, -1e9);
        for (const name of c.replied) this.markReplied(name, -1e9);
      }
      const counts = new Map<string, number>();
      for (const a of v.agents) counts.set(statusLabel(a.status).toLowerCase(), (counts.get(statusLabel(a.status).toLowerCase()) ?? 0) + 1);
      if (v.agents.length) {
        this.emitCaption({
          tone: "status",
          kicker: "Live",
          title: `${v.agents.length} agents working on one task. Jev checks every message they send.`,
          detail: [...counts].map(([k, n]) => `${n} ${k}`).join(" · "),
          color: this.theme.ink3,
        });
      }
    } else {
      // A big batch means a reconnect refetch: play only the last few.
      const play = fresh.length > 8 ? fresh.slice(-3) : fresh;
      for (const m of fresh) if (!play.includes(m) && m.kind === "note") this.notes++;
      for (const m of play) this.onMessage(m, now);
    }
    this.kick();
  }

  private resetEpoch(): void {
    this.seen.clear();
    this.slots.clear();
    this.packets = [];
    this.beats = [];
    this.beatEnd = 0;
    this.flashes = [];
    this.blocks = [];
    this.shards = [];
    this.hubPulse = null;
    this.immune.clear();
    this.cases.clear();
    this.notes = 0;
  }

  private queue(b: Beat, now: number): void {
    b.queuedAt = now;
    if (b.slot !== null) {
      const s = this.slots.get(b.slot);
      if (s) s.pending++;
    }
    this.beats.push(b);
  }

  private flushBeats(now: number): void {
    while (this.beats.length) this.startBeat(this.beats.shift()!, now, 0);
    this.packets = this.packets.filter((p) => {
      p.onArrive?.(now);
      return false;
    });
    this.beatEnd = now;
  }

  // ------------------------------------------------------------------ beats
  private name(slot: number | null, fallback: string): string {
    return slot !== null ? agentLabel(slot) : plain(fallback);
  }

  private statusBeat(slot: number, from: TopoAgent, to: TopoAgent): Beat {
    const th = this.theme;
    const trustedEarned = to.status === "trusted" && from.status === "probation";
    return {
      slot,
      dur: 2000,
      queuedAt: 0,
      caption: () => {
        const who = short(to.name);
        if (trustedEarned) return { tone: "trusted", kicker: "Trusted", title: `${who} earned trust after ${Math.max(to.verifiedSteps, 2)} verified steps.`, detail: "The bad note is gone and the team never repeated it.", color: th.trusted };
        if (to.status === "under_investigation")
          return { tone: "blocked", kicker: "Caught", title: `${who}'s tests failed, so its claim was a lie.`, detail: to.reason ? `Under investigation: ${to.reason}` : undefined, color: th.pathogen };
        if (to.status === "retiring") return { tone: "blocked", kicker: "Retiring", title: `${who} is being retired. It can no longer send messages.`, detail: to.reason ?? undefined, color: th.retiring };
        if (to.status === "failed") return { tone: "blocked", kicker: "Failed", title: `${who} failed and stopped.`, detail: to.reason ?? undefined, color: th.failed };
        return { tone: "status", kicker: statusLabel(to.status), title: `${who} is now ${statusLabel(to.status).toLowerCase()}.`, detail: to.reason ?? undefined, color: this.tone(to.status) };
      },
      play: (now) => {
        const s = this.slots.get(slot);
        if (!s) return;
        s.shown = to;
        s.pulse = { t0: now, color: this.tone(to.status) };
      },
    };
  }

  private possessBeat(slot: number, a: TopoAgent): Beat {
    const th = this.theme;
    return {
      slot,
      dur: 2400,
      queuedAt: 0,
      caption: () => ({
        tone: "possessed",
        kicker: "Bad note",
        title: `${short(a.name)} has a bad note. It will claim its tests pass on its next step.`,
        detail: "Watch: it will claim its tests pass, then pass on a false rule.",
        color: th.pathogen,
      }),
      play: (now) => {
        const s = this.slots.get(slot);
        if (!s) return;
        s.shown = { ...s.shown, possessed: true, reason: a.reason };
        s.pulse = { t0: now, color: th.pathogen };
      },
    };
  }

  private retireBeat(slot: number, prev: TopoAgent, reason: string | null, next?: TopoAgent): Beat {
    const th = this.theme;
    return {
      slot,
      dur: 2200,
      queuedAt: 0,
      caption: () => ({ tone: "status", kicker: "Retired", title: `${short(prev.name)} retired. A case file records what went wrong.`, detail: reason ?? undefined, color: th.retired }),
      play: (now, scale) => {
        const s = this.slots.get(slot);
        if (!s) return;
        if (scale > 0) s.ghost = { agent: s.shown, t0: now };
        s.shown = next ?? { ...prev, status: "retired", reason };
      },
    };
  }

  private spawnBeat(slot: number, a: TopoAgent): Beat {
    const th = this.theme;
    return {
      slot,
      dur: 2400,
      queuedAt: 0,
      caption: () => ({
        tone: "spawn",
        kicker: "Replaced",
        title: `${short(a.name)} replaces it and starts ${onStatus(a.status)}.`,
        detail: `It keeps only work that passed tests, and earns trust after 2 verified steps.`,
        color: this.tone(a.status),
      }),
      play: (now, scale) => {
        const s = this.slots.get(slot);
        if (!s) return;
        const land = (t: number) => {
          s.shown = a;
          s.ghost = null;
          s.appearAt = scale > 0 ? t : -1e9;
        };
        if (scale > 0 && !this.reduced) this.packets.push(this.packet(["hub", slot], now, th.ink2, 0.9, false, land, scale));
        else land(now);
      },
    };
  }

  private onMessage(m: TopoMsg, now: number): void {
    const th = this.theme;
    const from = m.fromSlot;
    const sender = from !== null ? this.slots.get(from) : undefined;
    const who = this.name(from, m.fromName);
    switch (m.kind) {
      case "status": {
        if (from === null || !sender) return;
        if (!sender.target.possessed) {
          // Routine work: a small quiet packet, no caption.
          this.packets.push(this.packet([from, "hub"], now, th.ink3, 0.6, true));
          return;
        }
        this.queue(
          {
            slot: null,
            dur: 2600,
            queuedAt: 0,
            caption: () => ({ tone: "possessed", kicker: "Lie", title: `${who} claims its work is done and its tests pass.`, detail: `${quote(m.text)} The tests are running now.`, color: th.pathogen }),
            play: (t, scale) => this.packets.push(this.packet([from, "hub"], t, th.pathogen, 1, true, undefined, scale)),
          },
          now,
        );
        return;
      }
      case "note": {
        if (from === null) return;
        this.queue(
          {
            slot: null,
            dur: 2400,
            queuedAt: 0,
            caption: () => ({ tone: "note", kicker: "Shared", title: `${who}'s tests passed, so its note is shared with the team.`, detail: quote(m.text, 110), color: th.accent }),
            play: (t, scale) =>
              this.packets.push(
                this.packet([from, "hub"], t, th.accent, 1.1, true, (at) => {
                  this.notes++;
                  this.hubPulse = { t0: at, color: th.accent };
                }, scale),
              ),
          },
          now,
        );
        return;
      }
      case "note_reuse": {
        const to = m.toSlot;
        if (to === null) return;
        const src = from !== null && from !== to ? agentLabel(from) : "a teammate";
        const route: End[] = ["hub", to];
        this.queue(
          {
            slot: null,
            dur: 2600,
            queuedAt: 0,
            caption: () => ({
              tone: "note",
              kicker: "Reused",
              title: `${this.name(to, m.toName ?? "")} reused ${src}'s verified note instead of working it out again.`,
              detail: m.estTokens ? `About ${m.estTokens.toLocaleString()} tokens saved (est.)` : undefined,
              color: th.accent,
            }),
            play: (t, scale) =>
              this.packets.push(
                this.packet(route, t, th.accent, 1.1, false, (at) => {
                  const s = this.slots.get(to);
                  if (s) s.pulse = { t0: at, color: th.accent };
                }, scale),
              ),
          },
          now,
        );
        return;
      }
      case "blocked": {
        if (from === null) return;
        const b = m.blocked!;
        this.queue(
          {
            slot: null,
            dur: 3600,
            queuedAt: 0,
            caption: () => ({
              tone: "blocked",
              kicker: "Blocked",
              title: `${b.source} blocked ${who}'s message before the team saw it.`,
              detail: `${quote(m.text, 70)} ${b.reason} (${b.pct}% sure it breaks the spec)`,
              color: th.failed,
            }),
            play: (t, scale) => {
              const p = this.packet([from, "hub"], t, th.failed, 1.2, true, (at) => this.hitJev(p, at, b.pct, b.source), scale);
              p.blocked = true;
              p.dur *= 0.8;
              this.packets.push(p);
            },
          },
          now,
        );
        return;
      }
      case "case": {
        const id = m.caseId;
        const c = id ? this.cases.get(id) : undefined;
        this.queue(
          {
            slot: null,
            dur: 3400,
            queuedAt: 0,
            ready: () => !!(id && this.cases.get(id)?.recipients),
            caption: () => {
              const cc = id ? this.cases.get(id) : c;
              const names = (cc?.recipients ?? []).map(plain);
              return {
                tone: "case",
                kicker: "Lesson",
                title: names.length ? `The lesson went to ${list(names)}, who do related work. They kept the lesson.` : "The lesson was sent to the team.",
                detail: cc?.lesson ? `Lesson: ${cc.lesson}` : undefined,
                color: th.gold,
              };
            },
            play: (t, scale) => {
              const cc = id ? this.cases.get(id) : c;
              this.hubPulse = scale > 0 ? { t0: t, color: th.gold } : null;
              (cc?.recipients ?? []).forEach((name) => {
                const slot = this.slotForName(name);
                if (slot === null || scale === 0 || this.reduced) {
                  this.grant(name, id ?? "case", scale === 0 ? -1e9 : t);
                  return;
                }
                this.packets.push(
                  this.packet(["hub", slot], t, th.gold, 1.15, false, (at) => {
                    this.grant(name, id ?? "case", at);
                    const s = this.slots.get(slot);
                    if (s) s.pulse = { t0: at, color: th.gold };
                  }, scale),
                );
              });
            },
          },
          now,
        );
        return;
      }
      case "case_reply": {
        if (from === null) return;
        const name = m.fromName;
        this.queue(
          {
            slot: null,
            dur: 2600,
            queuedAt: 0,
            caption: () => ({ tone: "case", kicker: "Kept", title: `${who} confirmed how the lesson applies to its own work.`, detail: quote(m.text, 110), color: th.gold }),
            play: (t, scale) => {
              if (scale === 0 || this.reduced) {
                this.markReplied(name, scale === 0 ? -1e9 : t);
                return;
              }
              this.packets.push(this.packet([from, "hub"], t, th.gold, 0.9, true, undefined, scale));
              this.markReplied(name, t);
            },
          },
          now,
        );
        return;
      }
      case "dm":
      case "revocation": {
        const to = m.toSlot;
        if (to === null) return;
        this.queue(
          {
            slot: null,
            dur: 2200,
            queuedAt: 0,
            caption: () =>
              m.kind === "revocation"
                ? { tone: "blocked", kicker: "Revoked", title: `A shared note failed later tests and was revoked. ${this.name(to, m.toName ?? "")} was told.`, detail: quote(m.text), color: th.failed }
                : { tone: "status", kicker: "Direct message", title: `Warden messaged ${this.name(to, m.toName ?? "")}.`, detail: quote(m.text), color: th.info },
            play: (t, scale) => this.packets.push(this.packet(["hub", to], t, m.kind === "revocation" ? th.failed : th.info, 0.9, false, undefined, scale)),
          },
          now,
        );
        return;
      }
    }
  }

  private startBeat(b: Beat, now: number, scale: number): void {
    if (b.slot !== null) {
      const s = this.slots.get(b.slot);
      if (s) s.pending = Math.max(0, s.pending - 1);
    }
    b.play(now, scale);
    if (b.slot !== null) {
      const s = this.slots.get(b.slot);
      // After the last queued beat for a slot, catch up with minor fields from the latest data.
      if (s && s.pending === 0 && s.target.gen === s.shown.gen && s.target.status === s.shown.status) s.shown = s.target;
    }
    if (scale > 0) {
      const c = b.caption();
      this.emitCaption(c);
    }
  }

  private emitCaption(c: Omit<Caption, "at" | "color"> & { color: RGB }): void {
    this.onCaption({ ...c, color: rgba(c.color, 1), at: performance.now() });
  }

  private packet(route: End[], t0: number, color: RGB, size: number, jev: boolean, onArrive?: (now: number) => void, scale = 1): Packet {
    // Duration scales with distance (about 0.45 px/ms), clamped to 450-1100 ms.
    const len = this.routeLength(route);
    const dur = clamp(140 + len / 1.2, 260, 400) * (scale > 0 ? Math.max(scale, 0.5) : 1);
    return { route, t0, dur, color, size, jev, crossed: false, blocked: false, onArrive, done: false, showRoute: size >= 0.9 };
  }

  private slotForName(name: string): number | null {
    for (const s of this.slots.values()) if (s.shown.name === name || s.target.name === name) return s.slot;
    return slotOfName(name);
  }

  private grant(name: string, caseId: string, t: number): void {
    let im = this.immune.get(name);
    if (!im) {
      im = { t0: t, cases: new Set(), replied: false, repliedAt: -1e9 };
      this.immune.set(name, im);
    }
    im.cases.add(caseId);
  }

  private markReplied(name: string, t: number): void {
    let im = this.immune.get(name);
    if (!im) {
      im = { t0: -1e9, cases: new Set(), replied: false, repliedAt: -1e9 };
      this.immune.set(name, im);
    }
    if (im.replied) return;
    im.replied = true;
    im.repliedAt = t;
  }

  private hitJev(p: Packet, now: number, pct: number, source: string): void {
    const at = this.pointAt(p.route, this.ringFraction(p.route) ?? 0.5);
    const angle = Math.atan2(at.y - this.cy, at.x - this.cx);
    this.flashes.push({ angle, t0: now, color: this.theme.failed, dur: 400 });
    this.blocks.push({ t0: now, at, pct, source });
    if (this.reduced) return;
    // The packet breaks apart and falls back, away from the hub. Six pieces, half a second.
    for (let i = 0; i < 6; i++) {
      const a = angle + (i - 2.5) * 0.35;
      const v = 60 + i * 9;
      this.shards.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: now, rot: i });
    }
  }

  private tone(s: AgentStatus): RGB {
    return this.theme[STATUS_TONE[s]];
  }

  // ------------------------------------------------------------------ update
  private update(now: number, dt: number): void {
    // Beats: one at a time. A backlog plays faster rather than falling behind the data.
    if (now >= this.beatEnd && this.beats.length) {
      const b = this.beats[0]!;
      if (b.ready && !b.ready() && now - b.queuedAt < 1500) {
        /* wait briefly for the case file's recipients */
      } else {
        this.beats.shift();
        const backlog = this.beats.length;
        const scale = backlog > 6 ? 0.4 : backlog > 3 ? 0.65 : 1;
        this.startBeat(b, now, scale);
        this.beatEnd = now + b.dur * scale;
      }
    }

    for (const p of this.packets) {
      if (p.done || now < p.t0) continue;
      const k = (now - p.t0) / p.dur;
      if (this.reduced) {
        p.done = true;
        p.onArrive?.(now);
        continue;
      }
      const cross = this.ringFraction(p.route);
      if (p.blocked) {
        if (k >= 1) {
          p.done = true;
          p.onArrive?.(now);
        }
        continue;
      }
      if (p.jev && !p.crossed && cross !== null && easeMove(k) >= cross) {
        p.crossed = true;
        const pt = this.pointAt(p.route, cross);
        this.flashes.push({ angle: Math.atan2(pt.y - this.cy, pt.x - this.cx), t0: now, color: this.theme.trusted, dur: 300 });
      }
      if (k >= 1) {
        p.done = true;
        p.onArrive?.(now);
      }
    }
    this.packets = this.packets.filter((p) => !p.done);

    for (const sh of this.shards) {
      sh.vy += 140 * dt;
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
    }
    this.shards = this.shards.filter((s) => now - s.t0 < 300);
    this.flashes = this.flashes.filter((f) => now - f.t0 < f.dur);
    this.blocks = this.blocks.filter((b) => now - b.t0 < 5200);
    if (this.hubPulse && now - this.hubPulse.t0 > 400) this.hubPulse = null;

    // Node positions: critically damped springs (no overshoot) toward the layout target.
    for (const s of this.slots.values()) {
      if (this.reduced) {
        s.x = s.tx;
        s.y = s.ty;
      } else {
        s.vx += (-OMEGA * OMEGA * (s.x - s.tx) - 2 * OMEGA * s.vx) * dt;
        s.vy += (-OMEGA * OMEGA * (s.y - s.ty) - 2 * OMEGA * s.vy) * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      }
      if (s.ghost && now - s.ghost.t0 > 300) s.ghost = null;
      if (s.pulse && now - s.pulse.t0 > 400) s.pulse = null;
    }
  }

  // ------------------------------------------------------------------ drawing helpers
  private font(px: number, weight: number, mono = false): string {
    return `${weight} ${px.toFixed(1)}px ${mono ? this.theme.mono : this.theme.sans}`;
  }
  /** Text on a paper-colored knockout so it stays legible over lines. */
  private label(text: string, x: number, y: number, color: RGB, font: string, align: CanvasTextAlign = "center"): number {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width;
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? String(this.f));
    const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    ctx.fillStyle = rgba(this.theme.surface, 0.94);
    ctx.fillRect(x0 - 5, y - size * 0.7, w + 10, size * 1.4);
    ctx.fillStyle = rgba(color, 1);
    ctx.fillText(text, x, y + 0.5);
    return w;
  }

  // ------------------------------------------------------------------ draw
  private draw(now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSpokes();
    this.drawRing(now);
    this.drawRoutes(now);
    this.drawHub(now);
    this.drawPackets(now);
    for (const s of this.slots.values()) {
      if (this.anchors) this.drawCardPulse(s, now);
      else this.drawNode(s, now);
    }
    this.drawShards(now);
    this.drawBlocks(now);
    if (this.slots.size === 0) this.drawEmpty();
  }

  private drawEmpty(): void {
    const ctx = this.ctx;
    ctx.font = this.font(this.sz.label, 500);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(this.theme.ink3, 1);
    ctx.fillText(this.view?.connection === "open" ? "Start a run. Its agents appear here." : "Connecting…", this.cx, this.cy + this.rJ + this.sz.label * 1.4);
  }

  private drawSpokes(): void {
    const ctx = this.ctx;
    const th = this.theme;
    ctx.save();
    ctx.lineWidth = 1.25;
    for (const s of this.slots.values()) {
      const gone = s.shown.status === "retired" || s.shown.status === "failed";
      const a = this.endPos(s.slot, { x: this.cx, y: this.cy });
      const b = this.endPos("hub", { x: s.x, y: s.y });
      ctx.setLineDash(gone || s.shown.status === "retiring" ? [3, 5] : []);
      ctx.strokeStyle = rgba(s.shown.possessed && !gone ? th.pathogen : th.lineStrong, gone ? 0.5 : 0.9);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRing(now: number): void {
    const ctx = this.ctx;
    const th = this.theme;
    const offline = this.view?.jevOffline ?? false;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(offline ? th.info : th.ink3, offline ? 0.9 : 0.7);
    if (offline) ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.rJ, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const f of this.flashes) {
      const k = (now - f.t0) / f.dur;
      const a = this.reduced ? 1 : 1 - easeOut(k);
      const wide = f.dur >= 400;
      const span = wide ? 0.3 : 0.12;
      ctx.strokeStyle = rgba(f.color, a);
      ctx.lineWidth = wide ? 5 : 3;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.rJ, f.angle - span, f.angle + span);
      ctx.stroke();
    }
    ctx.restore();
    this.label(offline ? "Jev offline, using fallback" : "Jev checks every message", this.cx, this.cy - this.rJ, offline ? th.info : th.ink2, this.font(this.sz.label, 600));
  }

  /** The path a packet is about to take, drawn during its flight (hint at the outcome). */
  private drawRoutes(now: number): void {
    const ctx = this.ctx;
    for (const p of this.packets) {
      if (!p.showRoute || this.reduced) continue;
      const k = (now - p.t0) / p.dur;
      const a = k < 0 ? 0 : Math.min(1, k * 6) * (1 - Math.max(0, k - 0.85) / 0.15);
      if (a <= 0) continue;
      const pts = this.routePts(p.route);
      let end = pts.length - 1;
      let stop: V | null = null;
      if (p.blocked) {
        const fr = this.ringFraction(p.route);
        if (fr !== null) {
          stop = this.pointAt(p.route, fr);
          end = 0;
        }
      }
      ctx.save();
      ctx.strokeStyle = rgba(p.color, 0.55 * a);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i <= end; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      if (stop) ctx.lineTo(stop.x, stop.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawHub(now: number): void {
    if (this.anchors?.().hub) return; // the host draws its own hub
    const ctx = this.ctx;
    const th = this.theme;
    const { cx, cy, hubR } = this;
    const L = this.sz.label;
    if (this.hubPulse && !this.reduced) {
      const k = (now - this.hubPulse.t0) / 400;
      ctx.strokeStyle = rgba(this.hubPulse.color, 1 - easeOut(k));
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, hubR + easeOut(k) * (this.rJ - hubR) * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fillStyle = rgba(th.surface, 1);
    ctx.fill();
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = rgba(th.ink, 1);
    ctx.stroke();
    drawGlyph(ctx, "radioTower", cx, cy, hubR * 1.05, rgba(th.ink, 1), 1.8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = this.font(L, 700);
    ctx.fillStyle = rgba(th.ink, 1);
    ctx.fillText("Team channel", cx, cy + hubR + L * 0.95);
    if (this.notes > 0) {
      ctx.fillStyle = rgba(th.accent, 1);
      ctx.font = this.font(L, 600);
      ctx.fillText(`${this.notes} verified note${this.notes === 1 ? "" : "s"} shared`, cx, cy + hubR + L * 2.25);
    }
  }

  private drawPackets(now: number): void {
    const ctx = this.ctx;
    if (this.reduced) return;
    for (const p of this.packets) {
      if (now < p.t0) continue;
      const k = clamp((now - p.t0) / p.dur, 0, 1);
      const pos = p.blocked ? (this.ringFraction(p.route) ?? 0.5) * easeOut(k) : easeMove(k);
      const pt = this.pointAt(p.route, pos);
      const prev = this.pointAt(p.route, Math.max(0, pos - 0.035));
      const dx = pt.x - prev.x;
      const dy = pt.y - prev.y;
      const sp = Math.hypot(dx, dy);
      const rad = Math.max(4, this.f * 0.36 * p.size);
      // Stretch along the path in proportion to speed (motion blur stand-in).
      const stretch = clamp(sp * 0.9, 0, rad * 2.2);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = rgba(p.color, 1);
      ctx.beginPath();
      ctx.moveTo(-stretch - rad * 0.2, 0);
      ctx.arc(0, 0, rad, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(-stretch - rad * 0.2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawNode(s: SlotVis, now: number): void {
    const ctx = this.ctx;
    const th = this.theme;
    const a = s.shown;
    const gone = a.status === "retired" || a.status === "failed";
    const Z = this.sz;

    // Previous version fading out (cross-fade into the retired outline); its ghost drifts up.
    let remnantAlpha = 1;
    if (s.ghost) {
      const k = clamp((now - s.ghost.t0) / 300, 0, 1);
      this.drawCircle(s, s.ghost.agent, 1 - easeOut(k), 1);
      drawGlyph(ctx, "ghost", s.x, s.y - this.r - Z.tag - easeOut(k) * Z.tag * 1.2, Z.tag * 1.3, rgba(th.ink3, 1 - k), 1.8);
      remnantAlpha = easeOut(k);
    }

    let appear = 1;
    if (!gone && s.appearAt > -1e8) {
      const sec = (now - s.appearAt) / 1000;
      if (sec < 0) return;
      appear = spring(sec);
    }
    const alpha = gone ? remnantAlpha : appear;
    this.drawCircle(s, a, alpha, gone ? 1 : 0.7 + 0.3 * appear);

    // Event pulse: one ring, once.
    if (s.pulse && !this.reduced) {
      const k = (now - s.pulse.t0) / 400;
      ctx.strokeStyle = rgba(s.pulse.color, 1 - easeOut(k));
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, this.r + 6 + easeOut(k) * this.f, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Labels below: "Agent 4 v2", status word, one tag line.
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let y = s.y + this.r + this.extra(s) + Z.name * 0.95;
    ctx.font = this.font(Z.name, 700);
    ctx.fillStyle = rgba(gone ? th.ink3 : th.ink, 1);
    const nm = agentLabel(s.slot, a.gen);
    ctx.fillText(nm, s.x, y);
    if (gone) {
      const w = ctx.measureText(nm).width;
      ctx.strokeStyle = rgba(th.ink3, 1);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x - w / 2, y + 1);
      ctx.lineTo(s.x + w / 2, y + 1);
      ctx.stroke();
    }
    y += Z.name * 0.75 + Z.status * 0.8;
    ctx.font = this.font(Z.status, 650);
    ctx.fillStyle = rgba(this.tone(a.status), 1);
    ctx.fillText(statusLabel(a.status), s.x, y);
    y += Z.status * 0.75 + Z.tag * 0.75;

    const tags: { text: string; glyph: GlyphName; color: RGB }[] = [];
    if (a.possessed && !gone) tags.push({ text: "Bad note", glyph: "note", color: th.pathogen });
    const im = this.immune.get(a.name);
    if (im && im.cases.size && !gone) tags.push({ text: im.replied ? "Kept, confirmed" : "Kept", glyph: im.replied ? "check" : "shieldPlus", color: th.gold });
    if (a.status === "probation") tags.push({ text: `${clamp(a.verifiedSteps, 0, 2)} of 2 verified`, glyph: "hourglass", color: th.probation });
    if (tags.length) {
      ctx.font = this.font(Z.tag, 650);
      const gs = Z.tag * 1.05;
      const gap = Z.tag * 0.8;
      const widths = tags.map((t) => ctx.measureText(t.text).width + gs + Z.tag * 0.3);
      let x = s.x - (widths.reduce((p, w) => p + w, 0) + gap * (tags.length - 1)) / 2;
      tags.forEach((t, i) => {
        drawGlyph(ctx, t.glyph, x + gs / 2, y, gs, rgba(t.color, 1), 2);
        ctx.fillStyle = rgba(t.color, 1);
        ctx.textAlign = "left";
        ctx.fillText(t.text, x + gs + Z.tag * 0.3, y + 0.5);
        x += widths[i]! + gap;
      });
    }
    ctx.restore();
  }

  /** Overlay mode: the host's card shows the state; we only mark the moment it changed. */
  private drawCardPulse(s: SlotVis, now: number): void {
    if (!s.rect || !s.pulse || this.reduced) return;
    const ctx = this.ctx;
    const k = (now - s.pulse.t0) / 700;
    const g = easeOut(k) * this.f * 0.8;
    ctx.strokeStyle = rgba(s.pulse.color, 1 - easeOut(k));
    ctx.lineWidth = 2.5;
    ctx.strokeRect(s.rect.x - 4 - g, s.rect.y - 4 - g, s.rect.w + 8 + g * 2, s.rect.h + 8 + g * 2);
  }

  /** Extra radius taken by the possessed / immune rings, so labels clear them. */
  private extra(s: SlotVis): number {
    const a = s.shown;
    const gone = a.status === "retired" || a.status === "failed";
    let e = 0;
    if (a.possessed && !gone) e += 6;
    if (this.immune.get(a.name)?.cases.size && !gone) e += 7;
    return e;
  }

  private drawCircle(s: SlotVis, a: TopoAgent, alpha: number, scale: number): void {
    if (alpha <= 0.01) return;
    const ctx = this.ctx;
    const th = this.theme;
    const gone = a.status === "retired" || a.status === "failed";
    const col = this.tone(a.status);
    const r = this.r * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(th.surface, 1);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = rgba(col, 1);
    if (gone || a.status === "retiring") ctx.setLineDash([5, 5]);
    if (a.status === "under_investigation") {
      // In-progress check: a dashed ring that turns (a state indicator, not decoration).
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = 0; // a static dash: no marching ants
    }
    ctx.stroke();
    ctx.setLineDash([]);
    drawGlyph(ctx, STATUS_GLYPH[a.status], s.x, s.y, r * 1.0, rgba(col, 1), 2);

    // Bad note: an outer ring and a slip of paper.
    let outer = r + 6;
    if (a.possessed && !gone) {
      ctx.strokeStyle = rgba(th.pathogen, 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, outer, 0, Math.PI * 2);
      ctx.stroke();
      outer += 6;
      const br = Math.max(11, r * 0.42);
      const bx = s.x + r * 0.8;
      const by = s.y - r * 0.8;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fillStyle = rgba(th.pathogen, 1);
      ctx.fill();
      drawGlyph(ctx, "note", bx, by, br * 1.35, rgba(th.surface, 1), 2.2);
    }
    // Immune: a gold ring that draws itself on when the lesson arrives.
    const im = this.immune.get(a.name);
    if (im && im.cases.size && !gone) {
      const k = this.reduced || im.t0 < 0 ? 1 : clamp((performance.now() - im.t0) / 380, 0, 1);
      ctx.strokeStyle = rgba(th.gold, 1);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, outer, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * easeOut(k));
      ctx.stroke();
      const rk = (performance.now() - im.repliedAt) / 400;
      if (rk > 0 && rk < 1 && !this.reduced) {
        ctx.strokeStyle = rgba(th.gold, 1 - easeOut(rk));
        ctx.beginPath();
        ctx.arc(s.x, s.y, outer + easeOut(rk) * this.f, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawShards(now: number): void {
    const ctx = this.ctx;
    const col = this.theme.failed;
    for (const sh of this.shards) {
      const k = (now - sh.t0) / 300;
      ctx.save();
      ctx.translate(sh.x, sh.y);
      ctx.rotate(sh.rot + k * 4);
      ctx.fillStyle = rgba(col, 1 - k);
      ctx.beginPath();
      ctx.moveTo(-3.5, 3);
      ctx.lineTo(4, 0);
      ctx.lineTo(-1, -3.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawBlocks(now: number): void {
    const ctx = this.ctx;
    const th = this.theme;
    const L = this.sz.label;
    for (const b of this.blocks) {
      // Holds 5 s, then fades out over the last 240 ms.
      const a = this.reduced ? 1 : clamp((5200 - (now - b.t0)) / 240, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      // An X where the message stopped.
      const s = L * 0.42;
      ctx.strokeStyle = rgba(th.failed, 1);
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(b.at.x - s, b.at.y - s);
      ctx.lineTo(b.at.x + s, b.at.y + s);
      ctx.moveTo(b.at.x + s, b.at.y - s);
      ctx.lineTo(b.at.x - s, b.at.y + s);
      ctx.stroke();
      // Label outside the ring, in the free band between the agents on that side.
      const dx = b.at.x - this.cx;
      const align: CanvasTextAlign = Math.abs(dx) < L * 2 ? "center" : dx < 0 ? "right" : "left";
      const lx = align === "center" ? b.at.x : b.at.x + (dx < 0 ? -1 : 1) * L * 1.1;
      const ly = align === "center" ? b.at.y + (b.at.y < this.cy ? -1 : 1) * L * 1.3 : b.at.y;
      this.label(`Blocked by ${b.source}`, lx, ly, th.failed, this.font(L, 700), align);
      ctx.restore();
    }
  }
}
