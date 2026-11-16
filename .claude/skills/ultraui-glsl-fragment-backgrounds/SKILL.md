---
name: glsl-fragment-backgrounds
description: Use when building a full-screen animated fragment shader background (gradient noise, plasma, domain-warped color fields), covering the vertex passthrough, UV coordinate space, time and mouse uniforms, simplex noise and fractal Brownian motion, domain warping, and palette mixing, with complete runnable shader sources.
---

# GLSL Fragment Shader Backgrounds

## When to use this
- You want an animated, organic-feeling full-screen background (gradient blobs, plasma, flowing noise fields) that would be expensive or impossible to achieve with CSS gradients/animations alone.
- You need a background that reacts continuously to time and optionally mouse position, rendered at native resolution with GPU-parallel cost instead of CPU-bound canvas 2D drawing.
- You are comfortable setting up a minimal WebGL/Three.js/regl harness to run a single full-screen triangle with a fragment shader, or already have one via `three-js-fundamentals`.
- Do NOT use this for a full 3D scene with real geometry, lighting, and camera movement; that's `three-js-fundamentals`/`react-three-fiber-drei`. Do NOT use this if a CSS gradient with `background-position` animation or an SVG filter achieves the same visual at a fraction of the complexity; reach for a shader specifically when the effect needs continuous procedural noise/domain-warping that CSS cannot express.

## Mental model
A full-screen fragment shader background is conceptually the simplest possible use of the GPU's rasterization pipeline: you draw one triangle (or a plain quad) that exactly covers the viewport, and every visible pixel gets computed independently and in parallel by your fragment shader, with zero real geometry to speak of. The vertex shader's only job is a "passthrough": take a hardcoded set of clip-space positions for a full-screen triangle, output them unchanged, and pass UV coordinates to the fragment shader for interpolation.

UV space is the coordinate system your fragment shader actually works in: `vUv` typically ranges from `(0,0)` at one corner to `(1,1)` at the opposite corner, but you almost always want to correct for aspect ratio before using UV coordinates for anything shape-based (circles, noise scale), or your effect will look stretched on non-square viewports. The standard fix is `vec2 uv = (gl_FragCoord.xy - 0.5 * resolution.xy) / resolution.y;` which centers the coordinate system at the middle of the screen and normalizes by height, so a distance of `1.0` in `uv` space means the same physical distance in both x and y regardless of aspect ratio.

The `time` uniform (seconds elapsed, updated from JS every frame) is what turns a static procedural pattern into an animated one: almost every interesting effect is "take a noise function, offset one of its inputs by `time * speed`." Simplex noise (or its close relative, Perlin noise) is the actual procedural randomness source; raw `random()` (hash-based pseudo-randomness) produces uncorrelated static, while simplex noise produces smoothly-varying continuous randomness, which is what "organic" motion actually requires. Fractal Brownian Motion (fBm) layers multiple octaves of simplex noise at increasing frequency and decreasing amplitude to produce more natural, detailed-but-coherent texture, the same technique used for procedural terrain and clouds.

Domain warping is the technique that elevates flat noise into the flowing, marbled, plasma-like look associated with premium generative backgrounds: instead of sampling noise directly at a UV coordinate, you first sample noise to get an offset vector, add that offset to your UV coordinates, and *then* sample noise again at the warped position. This can be nested multiple times (warp the warp) for increasingly complex, non-repeating flow patterns, and is the single biggest lever for making a noise field look intentional rather than like generic Perlin static.

## Setup
Minimal harness options; any full-screen-triangle setup works, pick based on existing stack.
```bash
npm install three@0.169.0
```
```js
import * as THREE from 'three'
```
No install needed for raw WebGL2, shown in recipes below as the most portable/dependency-free option.

## Core API
| Concept | GLSL | Note |
|---|---|---|
| Vertex passthrough | `gl_Position = vec4(position, 0.0, 1.0);` | for a hardcoded full-screen triangle, no matrices needed |
| UV/fragCoord | `gl_FragCoord.xy` or a varying `vUv` | pixel coordinate; normalize by resolution before use |
| `uniform float u_time` | JS-driven | seconds elapsed, drives all animation |
| `uniform vec2 u_resolution` | JS-driven | canvas pixel size, for aspect-correct UV |
| `uniform vec2 u_mouse` | JS-driven | normalized pointer position, optional interactivity |
| `snoise(vec2/vec3)` | function (Ashima simplex noise) | smooth continuous pseudo-random field |
| fBm loop | function, layered `snoise` calls | adds detail via octaves |
| domain warp | `snoise(uv + snoise(uv) * strength)` | flowing, organic distortion |
| `mix(colorA, colorB, t)` | built-in GLSL | palette interpolation driven by noise/time value |
| `smoothstep(edge0, edge1, x)` | built-in GLSL | soft thresholding, avoids hard banding in gradients |

## Recipes

### Full harness: raw WebGL2 full-screen triangle (framework-free)
The minimal complete setup any of the shaders below can be dropped into.
```js
const canvas = document.querySelector('#shader-canvas')
const gl = canvas.getContext('webgl2')

const vertexSrc = `#version 300 es
void main() {
  vec2 pos = vec2(
    (gl_VertexID == 0) ? -1.0 : (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 0) ? -1.0 : (gl_VertexID == 1) ? -1.0 : 3.0
  );
  gl_Position = vec4(pos, 0.0, 1.0);
}`

function compile(type, src) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
  }
  return shader
}

function createProgram(fragmentSrc) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program))
  }
  return program
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio, 2)
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  gl.viewport(0, 0, canvas.width, canvas.height)
}
window.addEventListener('resize', resize)
resize()

function startRenderLoop(program) {
  const uTime = gl.getUniformLocation(program, 'u_time')
  const uResolution = gl.getUniformLocation(program, 'u_resolution')
  const uMouse = gl.getUniformLocation(program, 'u_mouse')
  let mouse = [0.5, 0.5]

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect()
    mouse = [(e.clientX - rect.left) / rect.width, 1.0 - (e.clientY - rect.top) / rect.height]
  })

  const start = performance.now()
  function frame() {
    gl.useProgram(program)
    gl.uniform1f(uTime, (performance.now() - start) / 1000)
    gl.uniform2f(uResolution, canvas.width, canvas.height)
    gl.uniform2f(uMouse, mouse[0], mouse[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
```

### Shader 1: Layered fBm gradient flow (soft, premium "moving gradient" look)
Complete fragment source producing a slowly flowing multi-color gradient field, the safest/most broadly useful of the three.
```glsl
#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
out vec4 fragColor;

vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float snoise(vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  vec2 o = (a.x > a.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hash(i + 0.0)), dot(b, hash(i + o)), dot(c, hash(i + 1.0)));
  return dot(n, vec3(70.0));
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * snoise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

vec3 palette(float t) {
  vec3 a = vec3(0.5, 0.45, 0.55);
  vec3 b = vec3(0.5, 0.45, 0.45);
  vec3 c = vec3(1.0, 0.9, 0.7);
  vec3 d = vec3(0.1, 0.3, 0.55);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
  float t = u_time * 0.08;
  float n = fbm(uv * 1.6 + vec2(t, -t * 0.6));
  n = fbm(uv * 1.6 + n * 0.8 + vec2(0.0, t));
  vec3 color = palette(n * 0.5 + 0.5 + t * 0.05);
  fragColor = vec4(color, 1.0);
}
```

### Shader 2: Domain-warped plasma (nested warp, higher visual complexity)
Complete fragment source using two-stage domain warping for a marbled, flowing plasma effect.
```glsl
#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
out vec4 fragColor;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float snoise(vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  vec2 o = (a.x > a.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hash2(i + 0.0)), dot(b, hash2(i + o)), dot(c, hash2(i + 1.0)));
  return dot(n, vec3(70.0));
}

vec2 warp(vec2 p, float t) {
  vec2 q = vec2(snoise(p + vec2(0.0, 0.0) + t * 0.15), snoise(p + vec2(5.2, 1.3) - t * 0.1));
  return q;
}

float pattern(vec2 p, float t, out vec2 q, out vec2 r) {
  q = warp(p, t);
  r = warp(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.05, t);
  return snoise(p + 4.0 * r);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
  vec2 mouseInfluence = (u_mouse - 0.5) * 0.6;
  vec2 p = uv * 1.4 + mouseInfluence;
  float t = u_time * 0.12;

  vec2 q, r;
  float f = pattern(p, t, q, r);

  vec3 colorA = vec3(0.02, 0.03, 0.08);
  vec3 colorB = vec3(0.35, 0.15, 0.55);
  vec3 colorC = vec3(0.95, 0.55, 0.25);

  vec3 color = mix(colorA, colorB, clamp(length(q), 0.0, 1.0));
  color = mix(color, colorC, clamp(f * 0.5 + 0.5, 0.0, 1.0) * clamp(length(r), 0.0, 1.0));
  fragColor = vec4(color, 1.0);
}
```

### Shader 3: Mouse-reactive radial glow with vignette (interactive spotlight background)
Complete fragment source producing a soft glow that follows the pointer, layered over a subtle animated noise floor, with vignette falloff.
```glsl
#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 aspectUv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
  vec2 mouseAspect = (u_mouse * u_resolution.xy - 0.5 * u_resolution.xy) / u_resolution.y;

  float dist = length(aspectUv - mouseAspect);
  float glow = smoothstep(0.9, 0.0, dist);

  float floorNoise = noise(aspectUv * 3.0 + u_time * 0.05) * 0.06;

  vec3 base = vec3(0.04, 0.045, 0.06) + floorNoise;
  vec3 glowColor = vec3(0.4, 0.6, 1.0);
  vec3 color = base + glowColor * glow * 0.8;

  float vignette = smoothstep(1.0, 0.3, length(uv - 0.5) * 1.3);
  color *= vignette;

  fragColor = vec4(color, 1.0);
}
```

### Three.js ShaderMaterial wrapper (drop any of the above into a React/Three.js app)
Wraps a fragment source in a full-screen quad using Three.js instead of raw WebGL2.
```js
import * as THREE from 'three'

function createShaderBackground(canvas, fragmentShaderSource) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const uniforms = {
    u_time: { value: 0 },
    u_resolution: { value: new THREE.Vector2() },
    u_mouse: { value: new THREE.Vector2(0.5, 0.5) },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      void main() { gl_Position = vec4(position, 1.0); }
    `,
    fragmentShader: fragmentShaderSource, // GLSL ES 1.0 syntax needed here (no #version 300 es / out var), see reference.md for conversion
  })

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  scene.add(quad)

  function resize() {
    const dpr = Math.min(window.devicePixelRatio, 2)
    renderer.setPixelRatio(dpr)
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
    uniforms.u_resolution.value.set(canvas.clientWidth * dpr, canvas.clientHeight * dpr)
  }
  window.addEventListener('resize', resize)
  resize()

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect()
    uniforms.u_mouse.value.set(
      (e.clientX - rect.left) / rect.width,
      1.0 - (e.clientY - rect.top) / rect.height
    )
  })

  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    uniforms.u_time.value = clock.getElapsedTime()
    renderer.render(scene, camera)
  })
}
```

## Tuning the feel
- `u_time` multiplier (animation speed) of 0.05-0.15 for calm, ambient backgrounds (the fBm and plasma shaders above); above 0.3 the motion reads as agitated/anxious rather than atmospheric, which is rarely the intent for a background element.
- fBm octave count of 4-6 balances detail against cost; below 3 looks flat/blobby, above 7 adds GPU cost with diminishing visual return at typical viewing sizes.
- Domain warp strength (the multiplier on the warp offset, `4.0` in shader 2): 2-3 for subtle organic distortion, 4-6 for pronounced marbling, above 8 tends to collapse into visual noise with no recognizable flow structure.
- Palette contrast: keep background shader palettes to 2-3 dominant hues with a shared value/lightness range close to your page's actual background luminance, or the shader visually fights with foreground text/content contrast.

## Performance
- Fragment shader cost scales with pixel count, meaning a full-viewport shader on a 4K/high-DPR display can be 4x+ more expensive than the same shader at 1080p; always cap `devicePixelRatio` at 2, and for expensive shaders (nested domain warp, high fBm octaves) consider rendering at reduced internal resolution (e.g. render to a smaller off-screen framebuffer, then upscale via CSS) on lower-end devices.
- Every additional `snoise` call inside a loop is a real per-pixel cost; profile with the browser's GPU frame timing (`chrome://tracing` or the Performance panel's GPU track) if targeting 60fps consistently on mid-range mobile GPUs, and reduce octave count or warp stages before touching resolution as the first lever.
- Avoid dynamic branching (`if`/`for` with non-constant bounds) inside fragment shaders where possible; GPUs execute both branches for whole warps/wavefronts in many cases, so constant-bound loops (as shown, `for (int i = 0; i < 5; i++)`) are safer than data-dependent loop counts.
- Pause the render loop (`renderer.setAnimationLoop(null)` or stop the rAF loop) when the canvas scrolls out of view via IntersectionObserver, since an off-screen animated background shader still costs full GPU time if left running.

## Accessibility
```js
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
if (prefersReduced) {
  // freeze u_time at a fixed value instead of advancing it continuously
  uniforms.u_time.value = 4.0 // pick a visually pleasant static moment
} else {
  // normal animation loop advancing u_time
}
```
- Mark the canvas `aria-hidden="true"` and `role="presentation"` for purely decorative backgrounds; they carry no informational content for assistive tech.
- Ensure any real foreground text/content placed over a shader background maintains WCAG-sufficient contrast against the shader's brightest and darkest possible output, not just its average appearance; test against the palette's extremes, not a single screenshot.
- Continuously animated, large-area, high-contrast moving patterns are a documented vestibular trigger; keep motion subtle (see tuning notes) and always provide the reduced-motion freeze-frame fallback, this is not optional for a background that covers a large portion of the viewport.

## Anti-slop rules
- Never use raw uncorrelated `random()`/hash noise for organic-looking motion; it produces visual static, not flow, always use simplex/Perlin noise (or fBm layers of it) for anything meant to look organic.
- Never skip aspect-ratio correction on UV coordinates; failing to normalize by `u_resolution.y` (or equivalent) produces visibly stretched/squashed patterns on non-square viewports, one of the most common shader background bugs.
- Never leave a shader's render loop running when its canvas has scrolled far off-screen; gate with IntersectionObserver.
- Never use color palettes with harsh, fully-saturated primary colors for backgrounds behind readable text; desaturate and darken/lighten toward your actual content contrast requirements.
- Never hardcode `u_resolution` once at shader creation without a resize listener; a shader background that doesn't respond to window/container resize will show stretched or misaligned patterns after any viewport change.
- Never nest domain warps more than 2-3 levels deep without checking the result still reads as coherent flow rather than noise; more warping is not always better past a certain point.
- Never ship a shader background without the `prefers-reduced-motion` freeze-frame fallback; this is treated as a hard accessibility requirement, not optional polish, given the vestibular-trigger risk of full-viewport continuous motion.

## Checklist
- [ ] UV coordinates aspect-corrected before any shape/noise sampling
- [ ] Simplex/Perlin noise used for organic motion, not raw random hash
- [ ] `devicePixelRatio` capped at 2 for the render target
- [ ] Resize listener updates `u_resolution` and canvas backing store size
- [ ] Render loop paused when canvas is off-screen (IntersectionObserver-gated)
- [ ] `prefers-reduced-motion` freezes `u_time` at a fixed value rather than disabling render entirely
- [ ] `aria-hidden`/`role="presentation"` set on purely decorative shader canvases
- [ ] Foreground text contrast verified against the shader's full color range, not just a sample screenshot
- [ ] Animation speed and warp strength tuned to read as calm/atmospheric, not agitated
- [ ] Verified frame rate on a mid-tier mobile GPU, not only a development desktop
