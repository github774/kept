import { DOT_GAP, DOT_R, NOTE_HALF, RINGS, STRIKE_R, STRIKE_W, T, TEAMS } from "./composition";

/*
  One fragment shader paints every drop. Nothing here is a flat circle: each dot is a signed distance whose edge is
  wobbled by mid-frequency noise, pulled outward along paper fibres (feathering), softened while wet, ringed by a
  faint wicked halo, darkened at its rim as it dries (the coffee-ring tide line), granulated by the paper's tooth,
  and lit by a wet dome highlight that fades as the ink dries to a faint sheen.

  Colour is subtractive. Each ink is an absorbance (Beer-Lambert): transmittance = exp(-sum(k * density)), and the
  canvas is composited with mix-blend-mode: multiply, so the page's own paper and grain show through every stain
  and overlapping inks mix the way real inks do. The k values are -ln(target / paper) for each ink on #EFEBE3.
*/

const f = (n: number) => n.toFixed(4);

export const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;        // device px
uniform float uDpr;
uniform vec2 uCenter;     // CSS px from the canvas top-left
uniform float uScale;     // CSS px per unit
uniform float uTime;
uniform float uStrike;    // 0..1, eased in JS
uniform vec3 uPointer;    // xy units, z strength 0..1
uniform float uPhase;
uniform vec4 uHover;      // (team, amount, previous team, its amount): the team under the pointer inks a shade darker     // wall-clock seconds, for the pointer's ripple after the story clock stops
uniform sampler2D uPaper;
uniform sampler2D uNote;
uniform vec4 uTeams[${TEAMS.length}];   // x, y, kind, t0
uniform float uBlue[${TEAMS.length}];

out vec4 outColor;

const vec3 K_INK = vec3(2.14, 2.20, 2.29);     // #1C1A17
const vec3 K_BLUE = vec3(1.62, 0.95, 0.075);   // #2F5BD3
const vec3 K_NOTE = vec3(0.065, 0.73, 1.99); // #E0711F
const vec3 K_STROKE = vec3(0.16, 1.02, 2.55);   // a deeper orange for the pen line

float sat(float x) { return clamp(x, 0.0, 1.0); }
float expOut(float x) { x = sat(x); return x >= 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * x); }
float cubicOut(float x) { x = sat(x); float a = 1.0 - x; return 1.0 - a * a * a; }
float quartOut(float x) { x = sat(x); float a = 1.0 - x; return 1.0 - a * a * a * a; }

vec4 paper(vec2 px, float s) { return texture(uPaper, px / s); }

// Distance from p to segment ab.
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = sat(dot(pa, ba) / max(dot(ba, ba), 1e-6));
  return length(pa - ba * h);
}

// Wet dome highlight for a drop of radius rpx at offset dv (CSS px): a soft window reflection, upper left.
float dome(vec2 dv, float rpx) {
  vec2 q = dv / max(rpx, 1.0);
  float r2 = dot(q, q);
  if (r2 >= 1.0) return 0.0;
  vec3 n = normalize(vec3(q * 1.15, sqrt(1.0 - r2) + 0.15));
  vec3 h = normalize(vec3(-0.42, -0.58, 0.70) + vec3(0.0, 0.0, 1.0));
  return pow(max(dot(n, h), 0.0), 70.0);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr; // CSS px, y down
  vec2 q = px - uCenter;                                         // CSS px from the catch
  vec2 p = q / uScale;                                           // units

  // Shared samples of the paper: one set per pixel, reused by every drop.
  vec4 n0 = paper(px, 512.0);
  float fib = max(n0.r, texture(uPaper, mat2(0.54, -0.84, 0.84, 0.54) * px / 431.0 + 0.37).r * 0.85);
  float grain = n0.b;
  float low = paper(px, 1500.0).g;
  float sheenN = paper(px + 91.0, 700.0).g;
  vec2 warp = vec2(paper(px, 140.0).a, paper(px + 57.0, 170.0).a) - 0.5;
  float hairMask = smoothstep(0.30, 0.92, fib);
  float mottle = paper(px + 13.0, 260.0).g;   // pigment unevenness inside a dried drop

  vec3 A = vec3(0.0);   // total absorbance
  float spec = 0.0;     // wet gloss
  float body = 0.0;     // dried ink coverage (for the sheen)

  // ----- Teams of four -----
  float R = ${f(DOT_R)} * uScale;
  float gap = ${f(DOT_GAP)} * uScale;
  float reach = gap * 1.42 + R * 2.6 + 8.0;
  for (int i = 0; i < ${TEAMS.length}; i++) {
    vec4 tm = uTeams[i];
    vec2 c = tm.xy * uScale;
    if (length(q - c) > reach) continue;
    int kind = int(tm.z + 0.5);
    float hov = (float(i) == uHover.x ? uHover.y : 0.0) + (float(i) == uHover.z ? uHover.w : 0.0);
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(k == 0 || k == 2 ? -1.0 : 1.0, k < 2 ? -1.0 : 1.0);
      float seed = fract(sin(float(i * 4 + k) * 91.7) * 4375.85);
      vec2 cd = c + o * gap + (vec2(seed, fract(seed * 7.3)) - 0.5) * 0.9;
      float age = uTime - tm.w - seed * 0.07;
      if (age <= 0.0) continue;
      vec2 dv = q - cd;
      float r = length(dv);

      float grow = expOut(age / 0.55);          // the drop spreads fast, then stops
      float wick = cubicOut(age / 2.0);          // the paper keeps drinking a little longer
      float wet = 1.0 - smoothstep(0.35, 2.6, age);
      float lift = 0.0;                          // the possessed team's black lifts away
      if (kind == 2) lift = cubicOut((uTime - ${f(T.possess)}) / 0.7);
      float toBlue = 0.0;
      if (kind == 1) toBlue = cubicOut((uTime - uBlue[i]) / 0.38);

      float rpx = R * (0.32 + 0.68 * grow) * (1.0 + 0.06 * (seed - 0.5)) * (1.0 + 0.35 * lift);
      float wob = (warp.x * 1.1 + (n0.a - 0.5) * 1.3) * (0.55 + 0.05 * rpx) + (grain - 0.5) * 1.3;
      float d = r - rpx + wob;
      float soft = mix(0.5, 1.5, wet);
      // The body of the drop, and the capillaries it sends along the fibres (paler than the body).
      float core = 1.0 - smoothstep(-soft, soft, d);
      float hair = hairMask * (0.7 + 0.20 * rpx) * (0.3 + 0.7 * wick);
      float feather = 1.0 - smoothstep(-0.7, 0.7 + 0.6 * wet, d - hair);
      float haloW = (2.2 + 0.30 * rpx) * (0.3 + 0.7 * wick);
      float halo = pow(sat(1.0 - max(d, 0.0) / haloW), 1.5) * (0.085 + 0.08 * wet) * (0.45 + 1.1 * n0.g);
      // Drying pulls pigment to the rim (the coffee-ring tide line) and leaves the middle a shade paler and mottled.
      float tide = exp(-pow((d + 1.1) / 1.2, 2.0)) * (0.10 + 0.32 * (1.0 - wet));
      float bodyD = 0.70 + 0.30 * mottle + 0.16 * (grain - 0.5) + tide
                    + 0.07 * dot(dv / max(r, 1.0), vec2(-0.6, 0.8));
      float dens = core * bodyD + max(feather - core, 0.0) * (0.20 + 0.16 * fib) + halo * (1.0 - feather);
      dens *= (0.92 + 0.16 * grain);
      float cov = max(core, feather * 0.5);

      dens *= 1.0 + 0.22 * hov;
      A += K_INK * dens * (1.0 - lift) * (1.0 - toBlue);
      body += cov * (1.0 - lift) * (1.0 - wet);
      spec += dome(dv, rpx) * wet * cov * (1.0 - lift) * (1.0 - toBlue);

      if (kind == 1) {
        // Blue floods the dot from inside, a touch wider than the black it replaces.
        float bAge = uTime - uBlue[i] - seed * 0.05;
        if (bAge > 0.0) {
          float bg = expOut(bAge / 0.5);
          float bwet = 1.0 - smoothstep(0.2, 1.8, bAge);
          float brpx = R * (0.25 + 0.80 * bg);
          float bd = r - brpx + wob;
          float bcore = 1.0 - smoothstep(-mix(0.5, 1.6, bwet), mix(0.5, 1.6, bwet), bd);
          float bfeather = 1.0 - smoothstep(-0.7, 0.7 + 0.6 * bwet, bd - hair);
          float bhalo = pow(sat(1.0 - max(bd, 0.0) / (3.0 + 0.5 * brpx)), 1.7) * (0.07 + 0.10 * bwet) * (0.5 + n0.g);
          float btide = exp(-pow((bd + 1.1) / 1.2, 2.0)) * (0.12 + 0.40 * (1.0 - bwet));
          float bdens = bcore * (0.80 + 0.32 * mottle + 0.2 * (grain - 0.5) + btide)
                        + max(bfeather - bcore, 0.0) * 0.3 + bhalo * (1.0 - bfeather);
          float bcov = bcore;
          A += K_BLUE * bdens * (1.0 + 0.22 * hov);
          spec += dome(dv, brpx) * bwet * bcov;
        }
      }
    }
  }

  float rc = length(q);
  float ru = rc / uScale;

  // Retired: the struck mark fades back into the paper (lifted, not erased) before the replacement prints.
  float retired = 1.0 - 0.58 * cubicOut((uTime - ${f(T.retire)}) / 0.45);

  // ----- The bad note: orange ink floods out of the centre team and stains -----
  float tp = uTime - ${f(T.possess)};
  if (tp > 0.0 && ru < 1.6) {
    vec2 uv = p / (2.0 * ${f(NOTE_HALF)}) + 0.5;
    vec4 pk = texture(uNote, uv);
    float front = 1.0 - expOut(tp / 0.8) * 0.97;      // growth threshold falls; the heart floods first
    float grown = smoothstep(front - 0.05, front + 0.05, pk.b + (warp.y) * 0.16);
    float edge = pk.g + warp.x * 0.22 + (n0.a - 0.5) * 0.10;
    float pcov = smoothstep(0.40, 0.56, edge) * grown;
    float pfeather = smoothstep(0.40, 0.50, edge + hairMask * 0.22) * grown;
    float pwet = 1.0 - smoothstep(0.4, 2.6, tp);
    float rim = 1.0 - smoothstep(0.55, 0.95, pk.g);   // watercolour edge: pigment piles at the rim
    float pdens = pcov * (0.80 + 0.42 * mottle + 0.55 * rim * (1.0 - 0.4 * pwet) + 0.30 * (grain - 0.5))
                 + max(pfeather - pcov, 0.0) * 0.45;
    A += K_NOTE * pdens * retired;
    spec += pow(sat(1.0 - length(p - vec2(-0.12, -0.10)) / 0.22), 3.0) * pwet * pcov * 0.5 * retired;

    // The stain: a pale wash that wicks out past the mark, with a tide line where it stopped.
    float sr = 0.86 * cubicOut((tp - 0.1) / 1.7);
    float sEdge = ru + (warp.x + (n0.g - 0.5)) * 0.10 - hairMask * 0.025;
    float wash = (1.0 - smoothstep(sr - 0.35, sr, sEdge)) * 0.04 * (0.4 + 1.2 * mottle);
    float tideS = exp(-pow((sEdge - sr) / 0.02, 2.0)) * 0.028 * smoothstep(0.0, 0.3, sr);
    A += K_NOTE * (wash + tideS) * retired;
  }

  // ----- The strike: one pen stroke, a circle and then the slash -----
  if (uStrike > 0.0 && ru < ${f(STRIKE_R + 0.3)}) {
    const float RS = ${f(STRIKE_R)};
    const float TAU = 6.2831853;
    float circLen = TAU * RS;
    float total = circLen + 2.0 * RS;
    float s = uStrike * total;
    float th0 = -0.7853982; // starts upper right, runs anticlockwise over the top
    vec2 P0 = RS * vec2(cos(th0), sin(th0));
    float a = atan(p.y, p.x);
    float u = mod(th0 - a, TAU);
    float sc = min(s, circLen);
    float dC;
    if (u * RS <= sc) dC = abs(ru - RS);
    else {
      float te = th0 - sc / RS;
      dC = min(length(p - RS * vec2(cos(te), sin(te))), length(p - P0));
    }
    float fS = sat((s - circLen) / (2.0 * RS));
    float dS = fS > 0.0 ? seg(p, P0, mix(P0, -P0, fS)) : 1e3;
    float dd = min(dC, dS);
    float w = ${f(STRIKE_W)} * 0.5 * (1.0 + 0.18 * exp(-length(p - P0) / 0.05));  // the nib lands, pools
    float dpx = (dd - w) * uScale + (warp.y * 1.6 + (n0.a - 0.5) * 1.2);
    float swet = 1.0 - smoothstep(0.2, 2.2, uTime - ${f(T.strike)});
    float scov = 1.0 - smoothstep(-0.7, 0.7 + 0.6 * swet, dpx - hairMask * 1.6);
    float sdens = scov * (0.82 + 0.22 * low + 0.25 * exp(-length(p - P0) / 0.06) + 0.12 * (grain - 0.5));
    A += K_STROKE * sdens * retired;
  }

  // ----- Immunity: rings of print-blue spreading like ink through water -----
  if (uTime > ${f(T.rings)}) {
    vec2 dir = q / max(rc, 1.0);
    // A pointer drifting over the water nudges the rings, nothing else (the dry ink does not move).
    float push = 0.0;
    if (uPointer.z > 0.001) {
      float dm = length(p - uPointer.xy);
      push = uPointer.z * exp(-dm * dm / 0.22) * sin(dm * 15.0 - uPhase * 7.0) * 3.0;
    }
    for (int i = 0; i < ${RINGS.length}; i++) {
      float fi = float(i);
      float te = uTime - ${f(T.rings)} - fi * ${f(T.ringGap)};
      if (te <= 0.0) continue;
      float prog = sat(te / ${f(T.ringDur)});
      float Rf = i == 0 ? ${f(RINGS[0])} : i == 1 ? ${f(RINGS[1])} : i == 2 ? ${f(RINGS[2])} : ${f(RINGS[3])};
      float rad = Rf * quartOut(prog) * uScale;
      float settle = smoothstep(0.35, 1.0, prog);
      // Skip pixels nowhere near this ring or the cloud it trails (most of the canvas, most of the time).
      float d0 = rc - rad;
      float margin = mix(0.42 * uScale, 6.0, settle) + abs(push);
      if (d0 > margin || d0 < -margin - (1.0 - settle) * 1.4 * uScale) continue;
      float ang = texture(uPaper, dir * (0.45 + 0.07 * fi) + vec2(0.31 * fi, 0.17)).g - 0.5;
      float wisp = paper(q * 0.9 + vec2(uTime * 22.0, -uTime * 15.0) + fi * 61.0, 180.0).g - 0.5;
      float d = rc - rad + ang * mix(26.0, 1.4, settle) + wisp * mix(16.0, 0.6, settle) + push;
      float w = mix(0.05 * uScale, 0.62, settle);
      float band = exp(-d * d / (w * w));
      // Hairline breaks and pooling along the settled ring, like a fine nib that skipped.
      float along = mix(1.0, 0.55 + 0.7 * texture(uPaper, dir * 2.3 + fi).a + 0.3 * (grain - 0.5), settle)
                    * mix(1.0, smoothstep(0.30, 0.62, texture(uPaper, dir * 1.6 + fi * 0.3).a), 0.6 * settle);
      float strength = (i == 3 ? 0.55 : 0.78) * mix(0.42, 0.62, settle);
      float dens = band * strength * along * smoothstep(0.0, 0.08, prog);
      // The cloud it leaves behind while moving, thinning as it settles.
      float trail = d < 0.0 ? exp(d / (0.30 * uScale)) * (1.0 - settle) * 0.13
                    * smoothstep(0.25, 0.85, paper(q * 1.3 + fi * 37.0 - uTime * 9.0, 260.0).g) : 0.0;
      A += K_BLUE * (dens + trail);
    }
  }

  vec3 Tr = exp(-A);
  // Dried ink keeps a faint, uneven sheen; wet ink a bright one.
  Tr += vec3(0.030, 0.032, 0.042) * smoothstep(0.35, 0.95, sheenN) * sat(body);
  Tr = mix(Tr, vec3(1.0), sat(spec) * 0.62);
  outColor = vec4(min(Tr, vec3(1.0)), 1.0);
}
`;
