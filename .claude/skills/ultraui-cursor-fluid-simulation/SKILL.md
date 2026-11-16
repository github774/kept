---
name: cursor-fluid-simulation
description: Use when building Navier-Stokes style fluid cursor trails, smoke-like mouse interactions, or ink-in-water effects -- the simplified GPU fluid sim using advect/divergence/pressure ping-pong FBOs, plus cheaper canvas alternatives.
---

# Cursor Fluid Simulation

## When to use this
- You want a fluid dynamics cursor trail where color swirls, dissipates, and interacts with itself like ink in water.
- The brief calls for a smoke-like or paint-like mouse interaction on a background.
- You need the full Navier-Stokes look: viscosity, vorticity, pressure waves.
- You want to understand the GPU ping-pong FBO technique for 2D fluid simulation.
- Do NOT use this for simple particle trails or fading cursor tails -- those are dramatically cheaper. See the cheaper alternatives section below.

## Mental model
A 2D fluid simulation solves (a simplified form of) the Navier-Stokes equations on a grid. Each cell of the grid stores a velocity vector (where fluid is flowing) and optionally a density/color (what is visible).

The simulation runs these passes each frame, in order:

1. **Advection**: Move the velocity field by itself. For each cell, trace backward along the velocity to find where the fluid came from, and copy that value forward. This is semi-Lagrangian advection -- stable at any time step.

2. **Diffusion** (optional): Smooth the velocity field to simulate viscosity. For real-time fluid, this is often skipped or folded into a decay multiplier.

3. **External forces**: Add velocity at the cursor position (splat). This is how the mouse interacts with the fluid -- it injects velocity and optionally color.

4. **Pressure projection** (the hard part): The velocity field after advection is generally not divergence-free (fluid is compressing/expanding). Compute the divergence field, solve a Poisson equation for pressure (via Jacobi iteration, 20-40 iterations), and subtract the pressure gradient from velocity. This makes the field divergence-free (incompressible).

5. **Advect dye/color**: Move the visible density field using the corrected velocity. This is what you see.

Each pass is a fragment shader that reads from one FBO and writes to another (ping-pong). The entire simulation runs on the GPU. The CPU only updates the cursor position uniform each frame.

Resolution: the simulation grid does not need to match the screen resolution. A 256x256 or 512x512 grid is typically sufficient -- the fluid is inherently smooth, so low-res simulation upscaled to the screen looks great.

## Setup
Raw WebGL. No library needed.
```js
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
document.body.appendChild(canvas);
```
For WebGL 1, you need the `OES_texture_float` and `OES_texture_float_linear` extensions. WebGL 2 has these built in.

## Core API
| Concept | Role |
|---|---|
| FBO (Framebuffer Object) | Render target. Each simulation field (velocity, pressure, dye) lives in an FBO pair. |
| Ping-pong | Two FBOs per field. Read from A, write to B. Swap every frame. |
| Advection shader | Traces velocity backward, samples source field. |
| Divergence shader | Computes divergence of velocity field. |
| Pressure shader (Jacobi) | Iteratively solves for pressure from divergence. |
| Gradient subtraction shader | Subtracts pressure gradient from velocity. |
| Splat shader | Adds velocity and dye at cursor position (Gaussian blob). |
| Float textures | RGBA32F or RGBA16F for simulation data. |

## Recipes

### 1. Complete minimal fluid simulation (WebGL 2)
A self-contained Navier-Stokes cursor fluid sim. This is the full implementation.
```js
function createFluidSim(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) { console.error('WebGL 2 required'); return; }
  gl.getExtension('EXT_color_buffer_float');

  const SIM_W = 256, SIM_H = 256;

  // --- Shader compilation ---
  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw gl.getShaderInfoLog(s);
    return s;
  }
  function createProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }

  const baseVert = `#version 300 es
    in vec2 aPosition;
    out vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0, 1);
    }
  `;

  // Fullscreen quad
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  // --- FBO helper ---
  function createDoubleFBO(w, h, internalFormat, format, type, filter) {
    function create() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    }
    let a = create(), b = create();
    return {
      get read() { return a; },
      get write() { return b; },
      swap() { [a, b] = [b, a]; },
    };
  }

  const velocity = createDoubleFBO(SIM_W, SIM_H, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.LINEAR);
  const pressure = createDoubleFBO(SIM_W, SIM_H, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
  const dye = createDoubleFBO(SIM_W, SIM_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);

  // --- Shader programs ---
  const advectProg = createProgram(baseVert, `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 uTexelSize;
    uniform float uDt;
    uniform float uDissipation;
    out vec4 fragColor;
    void main() {
      vec2 vel = texture(uVelocity, vUv).xy;
      vec2 coord = vUv - vel * uTexelSize * uDt;
      fragColor = texture(uSource, coord) * uDissipation;
    }
  `);

  const divergenceProg = createProgram(baseVert, `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexelSize;
    out vec4 fragColor;
    void main() {
      float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0)).x;
      float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0)).x;
      float B = texture(uVelocity, vUv - vec2(0, uTexelSize.y)).y;
      float T = texture(uVelocity, vUv + vec2(0, uTexelSize.y)).y;
      float div = 0.5 * (R - L + T - B);
      fragColor = vec4(div, 0, 0, 1);
    }
  `);

  const pressureProg = createProgram(baseVert, `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform vec2 uTexelSize;
    out vec4 fragColor;
    void main() {
      float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0)).x;
      float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0)).x;
      float B = texture(uPressure, vUv - vec2(0, uTexelSize.y)).y;
      float T = texture(uPressure, vUv + vec2(0, uTexelSize.y)).x;
      float div = texture(uDivergence, vUv).x;
      fragColor = vec4((L + R + B + T - div) * 0.25, 0, 0, 1);
    }
  `);

  const gradSubProg = createProgram(baseVert, `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    uniform vec2 uTexelSize;
    out vec4 fragColor;
    void main() {
      float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0)).x;
      float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0)).x;
      float B = texture(uPressure, vUv - vec2(0, uTexelSize.y)).x;
      float T = texture(uPressure, vUv + vec2(0, uTexelSize.y)).x;
      vec2 vel = texture(uVelocity, vUv).xy;
      vel -= 0.5 * vec2(R - L, T - B);
      fragColor = vec4(vel, 0, 1);
    }
  `);

  const splatProg = createProgram(baseVert, `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uTarget;
    uniform vec2 uPoint;
    uniform vec3 uColor;
    uniform float uRadius;
    out vec4 fragColor;
    void main() {
      vec4 base = texture(uTarget, vUv);
      float d = distance(vUv, uPoint);
      float splat = exp(-d * d / uRadius);
      fragColor = base + vec4(uColor * splat, splat);
    }
  `);

  const displayProg = createProgram(baseVert, `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uTexture;
    out vec4 fragColor;
    void main() {
      vec3 c = texture(uTexture, vUv).rgb;
      fragColor = vec4(c, 1.0);
    }
  `);

  // --- Draw helper ---
  function blit(program, uniforms, target) {
    gl.useProgram(program);
    const posLoc = gl.getAttribLocation(program, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    let texUnit = 0;
    for (const [name, val] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, name);
      if (val instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, val);
        gl.uniform1i(loc, texUnit);
        texUnit++;
      } else if (Array.isArray(val)) {
        if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
        else if (val.length === 3) gl.uniform3f(loc, val[0], val[1], val[2]);
      } else {
        gl.uniform1f(loc, val);
      }
    }

    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, SIM_W, SIM_H);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Divergence FBO (single, not double)
  const divTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, divTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, SIM_W, SIM_H, 0, gl.RED, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const divFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, divFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, divTex, 0);

  const texelSize = [1 / SIM_W, 1 / SIM_H];
  let mouseX = 0, mouseY = 0, prevMouseX = 0, prevMouseY = 0, mouseDown = false;

  canvas.addEventListener('mousemove', (e) => {
    mouseX = e.offsetX / canvas.clientWidth;
    mouseY = 1.0 - e.offsetY / canvas.clientHeight;
  });
  canvas.addEventListener('mousedown', () => { mouseDown = true; });
  canvas.addEventListener('mouseup', () => { mouseDown = false; });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    mouseX = t.clientX / canvas.clientWidth;
    mouseY = 1.0 - t.clientY / canvas.clientHeight;
    mouseDown = true;
  }, { passive: false });
  canvas.addEventListener('touchend', () => { mouseDown = false; });

  function step() {
    const dt = 0.016;
    // Splat velocity and dye at cursor
    if (mouseDown || true) { // always splat for cursor trail effect
      const dx = mouseX - prevMouseX;
      const dy = mouseY - prevMouseY;
      if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
        // Velocity splat
        blit(splatProg, {
          uTarget: velocity.read.tex,
          uPoint: [mouseX, mouseY],
          uColor: [dx * 1000, dy * 1000, 0],
          uRadius: 0.0005,
        }, velocity.write);
        velocity.swap();

        // Dye splat (colorful)
        const hue = (performance.now() * 0.001) % 1;
        const r = Math.sin(hue * 6.28) * 0.5 + 0.5;
        const g = Math.sin(hue * 6.28 + 2.09) * 0.5 + 0.5;
        const b = Math.sin(hue * 6.28 + 4.19) * 0.5 + 0.5;
        blit(splatProg, {
          uTarget: dye.read.tex,
          uPoint: [mouseX, mouseY],
          uColor: [r * 0.5, g * 0.5, b * 0.5],
          uRadius: 0.0005,
        }, dye.write);
        dye.swap();
      }
    }
    prevMouseX = mouseX;
    prevMouseY = mouseY;

    // Advect velocity
    blit(advectProg, {
      uVelocity: velocity.read.tex,
      uSource: velocity.read.tex,
      uTexelSize: texelSize,
      uDt: dt,
      uDissipation: 0.99,
    }, velocity.write);
    velocity.swap();

    // Divergence
    gl.bindFramebuffer(gl.FRAMEBUFFER, divFbo);
    gl.viewport(0, 0, SIM_W, SIM_H);
    blit(divergenceProg, {
      uVelocity: velocity.read.tex,
      uTexelSize: texelSize,
    }, { fbo: divFbo });

    // Pressure solve (Jacobi iteration)
    for (let i = 0; i < 30; i++) {
      blit(pressureProg, {
        uPressure: pressure.read.tex,
        uDivergence: divTex,
        uTexelSize: texelSize,
      }, pressure.write);
      pressure.swap();
    }

    // Gradient subtraction
    blit(gradSubProg, {
      uPressure: pressure.read.tex,
      uVelocity: velocity.read.tex,
      uTexelSize: texelSize,
    }, velocity.write);
    velocity.swap();

    // Advect dye
    blit(advectProg, {
      uVelocity: velocity.read.tex,
      uSource: dye.read.tex,
      uTexelSize: texelSize,
      uDt: dt,
      uDissipation: 0.985,
    }, dye.write);
    dye.swap();

    // Display
    blit(displayProg, { uTexture: dye.read.tex }, null);

    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
```

### 2. Canvas fade trail (cheap alternative)
No WebGL. Just draw a semi-transparent overlay each frame to fade old content.
```js
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
document.body.appendChild(canvas);

let mx = 0, my = 0;
canvas.addEventListener('mousemove', (e) => {
  mx = e.clientX; my = e.clientY;
});

function draw() {
  // Fade previous frame
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw at cursor
  const hue = (Date.now() * 0.1) % 360;
  ctx.beginPath();
  ctx.arc(mx, my, 15, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
  ctx.fill();
  requestAnimationFrame(draw);
}
draw();
```

### 3. Particle trail (medium complexity)
Particles spawned at cursor, with velocity and gravity.
```js
const particles = [];

canvas.addEventListener('mousemove', (e) => {
  for (let i = 0; i < 3; i++) {
    particles.push({
      x: e.clientX,
      y: e.clientY,
      vx: (Math.random() - 0.5) * 4,
      vy: (Math.random() - 0.5) * 4 - 2,
      life: 1,
      hue: (Date.now() * 0.1 + i * 30) % 360,
    });
  }
});

function drawParticles() {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.05; // gravity
    p.life -= 0.015;
    if (p.life <= 0) { particles.splice(i, 1); continue; }

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.life * 5, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${p.life})`;
    ctx.fill();
  }
  requestAnimationFrame(drawParticles);
}
drawParticles();
```

### 4. Vorticity confinement (enhance curl detail)
Add a vorticity pass after pressure projection to amplify small curls that would otherwise dissipate.
```glsl
#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uCurl; // pre-computed curl field
uniform vec2 uTexelSize;
uniform float uCurlStrength;
uniform float uDt;
out vec4 fragColor;

void main() {
  float L = texture(uCurl, vUv - vec2(uTexelSize.x, 0)).x;
  float R = texture(uCurl, vUv + vec2(uTexelSize.x, 0)).x;
  float B = texture(uCurl, vUv - vec2(0, uTexelSize.y)).x;
  float T = texture(uCurl, vUv + vec2(0, uTexelSize.y)).x;
  float C = texture(uCurl, vUv).x;

  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  float len = length(force) + 0.0001;
  force = force / len * C * uCurlStrength;

  vec2 vel = texture(uVelocity, vUv).xy;
  fragColor = vec4(vel + force * uDt, 0, 1);
}
```

### 5. Color palette cycling for dye splats
Instead of rainbow HSL, cycle through a curated palette.
```js
const palette = [
  [0.95, 0.2, 0.3],  // red
  [0.2, 0.4, 0.95],  // blue
  [0.1, 0.85, 0.6],  // teal
  [0.95, 0.7, 0.1],  // gold
];
let colorIdx = 0;

function getSplatColor() {
  const c = palette[colorIdx % palette.length];
  colorIdx++;
  return c;
}
```

### 6. Mobile-safe: disable sim, show static gradient
Fluid sim is too expensive for many mobile GPUs. Detect and fallback.
```js
function shouldDisableFluid() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;

  // Check for float texture support
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) return true;

  // Rough GPU power check: max texture size as proxy
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (maxTex < 4096) return true;

  // Mobile user agent heuristic
  if (/Android|iPhone|iPad/.test(navigator.userAgent)) return true;

  return false;
}

if (shouldDisableFluid()) {
  // Static gradient fallback
  canvas.style.background = 'linear-gradient(135deg, #0a0a12, #1a1040)';
} else {
  createFluidSim(canvas);
}
```

## Tuning the feel
- **Simulation resolution**: 128x128 for stylized/low-fi. 256x256 is the sweet spot. 512x512 for high-detail. Above 512 gains diminishing visual returns but quadruples GPU cost.
- **Jacobi iterations**: 20-40 for the pressure solve. Fewer = visible compression artifacts. More = diminishing accuracy gains.
- **Velocity dissipation**: 0.98-0.995. Lower values make the fluid stop quickly. Higher values keep it swirling longer. 0.99 is a good default.
- **Dye dissipation**: 0.97-0.99. Lower = trails fade fast (smoke). Higher = trails persist (ink). Match to the desired aesthetic.
- **Splat radius**: 0.0003-0.001 in UV space. Smaller = thin lines. Larger = wide brush.
- **Splat force multiplier**: 500-2000 for the velocity splat `dx * N`. Lower = gentle push. Higher = explosive burst.
- **Vorticity confinement**: 0.3-0.8 curl strength. Adds the small curls and eddies that make fluid look alive. Without it, the sim looks too laminar.
- **dt (time step)**: Fixed at 0.016 (60fps). Do not tie to real elapsed time unless you handle variable time steps in advection.

## Performance
- The entire simulation is GPU-bound. CPU cost is ~0.1ms per frame (just updating uniforms and issuing draw calls).
- GPU cost: at 256x256 sim resolution, each pass is ~65k fragments. With 5 passes + 30 Jacobi iterations = ~35 full-screen draws. At 256x256 this is trivial even for integrated GPUs.
- At 512x512, cost quadruples. Mobile GPUs struggle. Stick to 128-256 on mobile (if enabling at all).
- The display pass (upscaling sim to screen) is one fullscreen draw with bilinear sampling. Free.
- Memory: each float16 FBO at 256x256 is ~512KB. 6 FBOs (velocity x2, pressure x2, dye x2, divergence x1, curl x1) = ~4MB. Negligible.
- The single most expensive tuning knob is Jacobi iteration count. Each iteration is one full-sim-resolution pass. 30 iterations at 512x512 = 30 * 262k fragments = ~8M fragments per frame just for pressure.

## Accessibility
```js
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
if (reduced.matches) {
  // Show static background, no fluid sim
  showStaticFallback();
}
```
- Fluid simulation is purely decorative. The canvas must have `aria-hidden="true"`.
- Rapid color changes from fast mouse movement could potentially trigger photosensitivity. Cap splat color brightness at 80% and avoid pure white flashes.
- Touch events: use `{ passive: false }` on `touchmove` to prevent scroll while interacting with the fluid, but provide a clear way to scroll past the fluid section.

## Anti-slop rules
1. Never run a fluid sim on mobile without explicit testing. Most mobile GPUs cannot sustain 60fps with 30 Jacobi iterations.
2. Never skip the pressure projection step. Without it, the velocity field compresses and the "fluid" does not look like fluid -- it looks like smeared paint.
3. Never use `RGBA32F` textures when `RGBA16F` is sufficient. Half-float is 2x cheaper in bandwidth and visually indistinguishable for fluid sim.
4. Never tie the sim time step to real elapsed time without handling large dt spikes (tab switch, debugger). A sudden dt of 0.5 will explode the simulation.
5. Never use more than 50 Jacobi iterations. The pressure convergence is logarithmic -- going from 30 to 50 improves accuracy by ~10%, and from 50 to 100 by ~5%.
6. Never run the sim at screen resolution. A 1920x1080 sim grid means 2M fragments per pass. 256x256 looks identical after bilinear upscaling.
7. Never apply the fluid effect over text or interactive UI elements without ensuring `pointer-events: none` and readability.

## Checklist
- [ ] WebGL 2 (or float texture extensions) checked before starting
- [ ] Simulation resolution 256x256 or lower
- [ ] Jacobi iterations 20-40
- [ ] Mobile detection with fallback to static background
- [ ] `prefers-reduced-motion` disables simulation
- [ ] Canvas has `aria-hidden="true"`
- [ ] Touch events handled with scroll fallback
- [ ] Fixed time step used for advection
- [ ] Color palette is curated, not raw rainbow
- [ ] Float16 textures used (not Float32)
