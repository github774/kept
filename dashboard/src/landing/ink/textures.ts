import { NOTE_FOLD, NOTE_RULE, NOTE_SHEET } from "./composition";

/*
  Two textures, built once on the CPU in a few milliseconds and then only sampled.

  paper (512 x 512, tiles):
    r  fibres: short curved strands, the paths ink wicks along when it feathers
    g  low-frequency value noise: pigment density, the drift of the stain
    b  fine grain: where pigment settles into the tooth of the paper
    a  mid-frequency value noise: the wobble of a wet edge

  note (512 x 512, the mark in a unit box):
    r  the mark, sharp
    g  the mark, softened ~6 px: a distance-like field for wet, feathered edges
    b  the silhouette heavily blurred: a growth field, so the stain floods out from its heart
*/

const N = 512;

function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise with `cells` cells across the texture. */
function valueNoise(out: Float32Array, cells: number, seed: number, weight: number) {
  const step = N / cells;
  for (let y = 0; y < N; y++) {
    const gy = y / step;
    const iy = Math.floor(gy);
    let fy = gy - iy;
    fy = fy * fy * (3 - 2 * fy);
    const y0 = iy % cells;
    const y1 = (iy + 1) % cells;
    for (let x = 0; x < N; x++) {
      const gx = x / step;
      const ix = Math.floor(gx);
      let fx = gx - ix;
      fx = fx * fx * (3 - 2 * fx);
      const x0 = ix % cells;
      const x1 = (ix + 1) % cells;
      const a = hash(x0, y0, seed);
      const b = hash(x1, y0, seed);
      const c = hash(x0, y1, seed);
      const d = hash(x1, y1, seed);
      out[y * N + x] += weight * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
    }
  }
}

function fbm(octaves: [number, number][], seed: number) {
  const f = new Float32Array(N * N);
  let total = 0;
  octaves.forEach(([cells, w], i) => {
    valueNoise(f, cells, seed + i * 17, w);
    total += w;
  });
  for (let i = 0; i < f.length; i++) f[i] /= total;
  return f;
}

function canvas2d(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d", { willReadFrequently: true })!;
}

function fibres(): Uint8ClampedArray {
  const ctx = canvas2d(N, N);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, N, N);
  ctx.lineCap = "round";
  let s = 7;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 2600; i++) {
    const x = r() * N;
    const y = r() * N;
    // Paper fibres lie mostly along the machine direction, with plenty of strays.
    const a = r() < 0.65 ? (r() - 0.5) * 1.2 : r() * Math.PI;
    const len = 6 + r() * r() * 46;
    const bend = (r() - 0.5) * len * 0.5;
    const dx = Math.cos(a) * len;
    const dy = Math.sin(a) * len;
    ctx.strokeStyle = `rgba(255,255,255,${0.18 + r() * 0.5})`;
    ctx.lineWidth = 0.6 + r() * 1.1;
    // Draw each strand at its wrapped positions so the texture tiles without a seam.
    for (const ox of [-N, 0, N])
      for (const oy of [-N, 0, N]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(x + ox + dx / 2 - dy * (bend / len), y + oy + dy / 2 + dx * (bend / len), x + ox + dx, y + oy + dy);
        ctx.stroke();
      }
  }
  return ctx.getImageData(0, 0, N, N).data;
}

/** Give the main thread back between steps, so building the textures never holds a frame for long. */
export const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

export async function buildPaper(): Promise<Uint8Array> {
  const fib = fibres();
  await breathe();
  const low = fbm([[4, 1], [8, 0.5], [16, 0.25]], 1);
  await breathe();
  const grain = fbm([[128, 1], [256, 0.6]], 9);
  await breathe();
  const mid = fbm([[16, 1], [32, 0.55], [64, 0.3]], 21);
  await breathe();
  const out = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = fib[i * 4];
    out[i * 4 + 1] = Math.round(low[i] * 255);
    out[i * 4 + 2] = Math.round(grain[i] * 255);
    out[i * 4 + 3] = Math.round(mid[i] * 255);
  }
  return out;
}

function drawNote(ctx: CanvasRenderingContext2D, cut: boolean) {
  const k = N / 100;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = "#fff";
  ctx.fill(new Path2D(NOTE_SHEET));
  if (cut) {
    // The folded corner and the one written line are paper showing through.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill(new Path2D(NOTE_FOLD));
    ctx.fill(new Path2D(NOTE_RULE));
  }
  ctx.restore();
}

/** Three box-blur passes in each direction, a close stand-in for a gaussian, without relying on ctx.filter. */
function blur(src: Float32Array, r: number) {
  const a = Float32Array.from(src);
  const b = new Float32Array(N * N);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const w = 2 * r + 1;
    for (let line = 0; line < N; line++) {
      let acc = 0;
      const at = (i: number) => {
        const j = Math.min(Math.max(i, 0), N - 1);
        return horizontal ? from[line * N + j] : from[j * N + line];
      };
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < N; i++) {
        if (horizontal) to[line * N + i] = acc / w;
        else to[i * N + line] = acc / w;
        acc += at(i + r + 1) - at(i - r);
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

function channel(radius: number, cut: boolean) {
  const ctx = canvas2d(N, N);
  drawNote(ctx, cut);
  const data = ctx.getImageData(0, 0, N, N).data;
  const f = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = data[i * 4 + 3] / 255;
  return radius > 0 ? blur(f, radius) : f;
}

export async function buildNote(): Promise<Uint8Array> {
  const sharp = channel(0, true);
  const soft = channel(3, true);
  await breathe();
  const grow = channel(22, false);
  const out = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = Math.round(sharp[i] * 255);
    out[i * 4 + 1] = Math.round(soft[i] * 255);
    out[i * 4 + 2] = Math.round(grow[i] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export const TEX_SIZE = N;
