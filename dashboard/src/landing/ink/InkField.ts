import { T, TEAMS, phaseAt, type Layout } from "./composition";
import { FRAG, VERT } from "./shader";
import { TEX_SIZE, breathe, buildNote, buildPaper } from "./textures";

/*
  The ink, on raw WebGL2: one full-screen triangle, one fragment shader, two textures built once. No scene graph,
  no render targets, so the chunk stays small (three.js would add ~600 KB for a single quad).

  The clock runs for the five-second story, then the last frame is drawn and the loop stops: the composition is
  a still image from then on (the browser keeps showing the last frame). The loop wakes only while a pointer
  disturbs the rings, and stops again when they have calmed.
*/

/** cubic-bezier(x1, y1, x2, y2) as a function of x, by Newton's method then bisection. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-5) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

// The pen: a strong ease-in-out (on-screen movement), so the nib accelerates off the paper and lands decisively.
const strokeEase = bezier(0.77, 0, 0.175, 1);

export interface InkStats {
  frames: number[];
}

export interface InkFieldOptions {
  /** Draw the finished composition once and never animate (prefers-reduced-motion). */
  still: boolean;
  /** Pin the clock to one moment (review screenshots: ?t=3). */
  pinned: number | null;
  layout: (w: number, h: number) => Layout;
  onSettled?: () => void;
  /** Called when the story moves to a new caption (a handful of times per play, never per frame). */
  onPhase?: (phase: number) => void;
}

export class InkField {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private textures: WebGLTexture[] = [];
  private buffer: WebGLBuffer;
  private raf = 0;
  private start = 0;
  private settled = false;
  private visible = true;
  private size = { w: 1, h: 1, dpr: 1 };
  private layout: Layout = { cx: 0, cy: 0, scale: 100 };
  private pointer = { x: 0, y: 0, z: 0, last: 0 };
  private lastFrame = 0;
  private phase = -1;
  /** Hovered team (index into TEAMS) and the one it is fading from, with their 0..1 amounts. */
  private hover = { team: -1, amt: 0, prev: -1, prevAmt: 0, target: -1, last: 0 };
  readonly stats: InkStats = { frames: [] };

  static async create(canvas: HTMLCanvasElement, opts: InkFieldOptions): Promise<InkField | null> {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) return null;
    try {
      const [paper, note] = [await buildPaper(), await buildNote()];
      await breathe();
      return new InkField(canvas, gl, opts, paper, note);
    } catch {
      return null;
    }
  }

  private canvas: HTMLCanvasElement;
  private opts: InkFieldOptions;

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    opts: InkFieldOptions,
    paper: Uint8Array,
    note: Uint8Array,
  ) {
    this.canvas = canvas;
    this.opts = opts;
    this.gl = gl;
    this.start = performance.now();
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    this.prog = prog;
    gl.useProgram(prog);
    for (const name of [
      "uRes", "uDpr", "uCenter", "uScale", "uTime", "uStrike", "uPointer", "uPhase", "uHover", "uPaper", "uNote", "uTeams", "uBlue",
    ])
      this.loc[name] = gl.getUniformLocation(prog, name);

    // One triangle that covers the viewport.
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.textures.push(this.texture(0, paper, true));
    this.textures.push(this.texture(1, note, false));
    gl.uniform1i(this.loc.uPaper, 0);
    gl.uniform1i(this.loc.uNote, 1);

    const teams = new Float32Array(TEAMS.length * 4);
    const blue = new Float32Array(TEAMS.length);
    TEAMS.forEach((t, i) => {
      teams.set([t.x, t.y, t.kind, t.t0], i * 4);
      blue[i] = t.tBlue;
    });
    gl.uniform4fv(this.loc.uTeams, teams);
    gl.uniform1fv(this.loc.uBlue, blue);

    this.resize();
    canvas.addEventListener("webglcontextlost", this.onLost);
  }

  private texture(unit: number, data: Uint8Array, repeat: boolean) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEX_SIZE, TEX_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  /** Seconds on the story clock. */
  private now() {
    if (this.opts.pinned !== null) return this.opts.pinned;
    if (this.opts.still) return T.end;
    return (performance.now() - this.start) / 1000;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.size = { w, h, dpr };
    this.layout = this.opts.layout(w, h);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // A still canvas must be repainted after a resize clears it.
    if (!this.raf) this.draw(Math.min(this.now(), T.end));
  }

  private draw(t: number) {
    const gl = this.gl;
    const { w, h, dpr } = this.size;
    const L = this.layout;
    // The context is shared per canvas (React's dev double-mount can build two fields on it), so bind our own state
    // every frame instead of trusting whatever is current. Four calls; nothing measurable.
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.textures.forEach((tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    });
    gl.uniform2f(this.loc.uRes, w * dpr, h * dpr);
    gl.uniform1f(this.loc.uDpr, dpr);
    gl.uniform2f(this.loc.uCenter, L.cx, L.cy);
    gl.uniform1f(this.loc.uScale, L.scale);
    gl.uniform1f(this.loc.uTime, t);
    gl.uniform1f(this.loc.uStrike, strokeEase((t - T.strike) / T.strikeDur));
    gl.uniform3f(this.loc.uPointer, this.pointer.x, this.pointer.y, this.pointer.z);
    gl.uniform1f(this.loc.uPhase, (performance.now() / 1000) % 1000);
    const hv = this.hover;
    gl.uniform4f(this.loc.uHover, hv.team, hv.amt, hv.prev, hv.prevAmt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const phase = phaseAt(t);
    if (phase !== this.phase) {
      this.phase = phase;
      this.opts.onPhase?.(phase);
    }
  }

  play() {
    // Warm the pipeline with a blank frame (t = 0 draws nothing) so the first frame of the story is not the one
    // that pays for driver-side shader compilation.
    this.draw(0);
    this.settled = false;
    this.start = performance.now();
    if (this.opts.still || this.opts.pinned !== null) {
      this.draw(this.now());
      this.settled = true;
      this.opts.onSettled?.();
      return;
    }
    requestAnimationFrame(() => {
      this.start = performance.now();
      this.loop();
    });
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    const tick = (now: number) => {
      this.raf = 0;
      if (this.lastFrame) this.stats.frames.push(now - this.lastFrame);
      if (this.stats.frames.length > 2000) this.stats.frames.shift();
      this.lastFrame = now;
      const t = this.now();
      // The pointer's ripple calms over about half a second.
      if (this.pointer.z > 0) {
        this.pointer.z *= Math.exp(-(now - this.pointer.last) / 450);
        this.pointer.last = now;
        if (this.pointer.z < 0.01) this.pointer.z = 0;
      }
      const hovering = this.stepHover(now);
      const done = t >= T.end;
      this.draw(Math.min(t, T.end));
      if (done && !this.settled) {
        this.settled = true;
        this.opts.onSettled?.();
      }
      if ((!done || this.pointer.z > 0 || hovering) && this.visible) this.raf = requestAnimationFrame(tick);
      else this.lastFrame = 0;
    };
    this.raf = requestAnimationFrame(tick);
  };

  setVisible(v: boolean) {
    if (v === this.visible) return;
    this.visible = v;
    if (v && !this.raf && (!this.settled || this.pointer.z > 0) && !this.opts.still && this.opts.pinned === null) {
      this.loop();
    }
  }

  /** Ease the hovered team's shade toward its target (~160 ms). Returns true while still moving. */
  private stepHover(now: number) {
    const h = this.hover;
    const dt = h.last ? Math.min(64, now - h.last) : 16;
    h.last = now;
    const k = 1 - Math.exp(-dt / 55);
    h.amt += ((h.team === h.target && h.team >= 0 ? 1 : 0) - h.amt) * k;
    h.prevAmt += (0 - h.prevAmt) * k;
    if (h.prevAmt < 0.01) {
      h.prevAmt = 0;
      h.prev = -1;
    }
    const settled = Math.abs((h.team >= 0 ? 1 : 0) - h.amt) < 0.01 && h.prev === -1;
    if (settled) h.amt = h.team >= 0 ? 1 : 0;
    if (!settled) return true;
    h.last = 0;
    return false;
  }

  /** Which team (if any) sits under a point in CSS px; a team is hovered within ~1.6 dot spacings of its centre. */
  private teamAt(x: number, y: number) {
    const L = this.layout;
    const ux = (x - L.cx) / L.scale;
    const uy = (y - L.cy) / L.scale;
    let best = -1;
    let bestD = 0.34;
    const replaced = this.now() >= T.replace;
    TEAMS.forEach((t, i) => {
      // The possessed team is gone once it lifts; the replacement only exists once printed.
      if (t.kind === 2 && this.now() >= T.possess) return;
      if (i === TEAMS.length - 1 && !replaced) return;
      const d = Math.hypot(ux - t.x, uy - t.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** The pointer over the hero, in CSS px relative to the canvas; null when it leaves. */
  hoverAt(p: { x: number; y: number } | null) {
    const team = p ? this.teamAt(p.x, p.y) : -1;
    const h = this.hover;
    if (team === h.target) return;
    h.target = team;
    if (h.team >= 0 && h.team !== team) {
      h.prev = h.team;
      h.prevAmt = h.amt;
    }
    h.team = team;
    h.amt = team >= 0 && team === h.prev ? h.prevAmt : 0;
    if (team === h.prev) {
      h.prev = -1;
      h.prevAmt = 0;
    }
    if (this.opts.still || this.opts.pinned !== null) {
      // Reduced motion: the shade changes, with no transition.
      h.amt = team >= 0 ? 1 : 0;
      h.prev = -1;
      h.prevAmt = 0;
      this.draw(this.now());
      return;
    }
    if (!this.raf && this.visible) this.loop();
  }

  /** A pointer over the hero, in CSS px relative to the canvas. Only the water (the rings) answers it. */
  disturb(x: number, y: number) {
    if (this.opts.still || this.opts.pinned !== null) return;
    if (this.now() < T.rings + 0.8) return;
    const L = this.layout;
    this.pointer.x = (x - L.cx) / L.scale;
    this.pointer.y = (y - L.cy) / L.scale;
    this.pointer.z = Math.min(1, this.pointer.z + 0.35);
    this.pointer.last = performance.now();
    if (!this.raf && this.visible) this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    const gl = this.gl;
    this.textures.forEach((t) => gl.deleteTexture(t));
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.prog);
  }
}
