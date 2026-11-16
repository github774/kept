---
name: three-fluid-simulation
description: Use when building a real-time fluid simulation (ink, smoke, dye) rendered in a Three.js or WebGL scene. Builds a complete Navier-Stokes solver on the GPU with advection, pressure projection, vorticity confinement, and interactive dye injection.
category: three
pairs_with: three-fluid-simulation-eval
---

# Real-Time Fluid Simulation in a Web 3D Scene

## What this builds
A GPU-accelerated 2D fluid simulation based on Jos Stam's "Stable Fluids" method, running entirely in fragment shaders via render-to-texture. The simulation solves the incompressible Navier-Stokes equations in real time: advection moves the fluid, pressure projection enforces incompressibility (mass conservation), and vorticity confinement restores small-scale curls lost to numerical diffusion. Interactive dye and force injection from mouse/touch creates the classic "ink in water" effect.

- Full Navier-Stokes solver: advection, diffusion, pressure solve (Jacobi iteration), divergence correction
- Vorticity confinement to preserve swirling details the solver would otherwise smooth away
- Mouse/touch-driven force and dye injection (splat)
- Multi-resolution simulation: low-res velocity field, high-res dye rendering
- Bloom/glow postprocessing on the fluid output for visual polish
- WebGL2 render targets with float textures for accurate pressure solving
- Compositing the fluid simulation as a background, overlay, or texture in a Three.js scene
- Proper disposal of all render targets and shader programs

## When to use / when not to
- Use for interactive backgrounds with ink/smoke/dye that responds to pointer interaction.
- Use for hero sections, loading screens, or transition effects with organic fluid motion.
- Use for creative/art-directed pages where the fluid is the primary visual.
- Do NOT use for physically accurate CFD simulation. This is a visual effect, not engineering-grade fluid dynamics.
- Do NOT use when a simpler noise-based distortion achieves the same visual. See `liquid-displacement-effects` or `cursor-fluid-simulation` for lighter alternatives.
- Do NOT use when the fluid must be 3D volumetric (smoke filling a room). That requires 3D texture advection, which is significantly more expensive. This toolkit is 2D fluid projected into a 3D scene.
- For GPGPU particle simulation (not fluid fields), see `three-particle-gpgpu`.
- For base Three.js setup, see `three-js-fundamentals`.

## Stack decision
| Dependency | Version | Why | Cheaper alternative |
|---|---|---|---|
| Raw WebGL2 | - | Fluid simulation requires direct control over render targets, framebuffers, and fragment shader passes. Three.js abstractions add overhead for this use case. | Three.js WebGLRenderTarget works but adds unnecessary scene/camera overhead. |
| Three.js (optional) | 0.169+ | Only needed if compositing the fluid output into a 3D scene (as a texture on geometry or a fullscreen quad). | Standalone WebGL2 canvas for fluid-only pages. |

The simulation itself runs on raw WebGL2 for maximum control over the render pipeline. Three.js is used only for compositing the fluid output into a larger 3D scene.

Cheaper alternative: Use Pavel Dobryakov's WebGL-fluid-simulation (MIT, ~1000 lines) as a standalone canvas. It is the most battle-tested open-source implementation and the basis for most web fluid effects. This toolkit teaches you to build the same system from understanding.

## Architecture
```
WebGL2 Context
  |
  +--- Render Targets (ping-pong pairs):
  |      velocity      (RG16F, sim resolution)
  |      pressure      (R16F, sim resolution)
  |      divergence    (R16F, sim resolution)
  |      dye/color     (RGBA16F, dye resolution, can be higher)
  |      curl          (R16F, sim resolution)
  |
  +--- Shader Programs:
  |      advection     (semi-Lagrangian backtracking)
  |      divergence    (compute div(velocity))
  |      pressure      (Jacobi iteration to solve Poisson)
  |      gradientSub   (subtract pressure gradient from velocity)
  |      curl          (compute curl for vorticity confinement)
  |      vorticity     (apply confinement force)
  |      splat         (inject force/dye at pointer position)
  |      display       (render dye to screen)
  |
  +--- Simulation Loop (per frame):
         1. Apply external forces (mouse splat into velocity)
         2. Inject dye (mouse splat into dye texture)
         3. Compute curl (for vorticity confinement)
         4. Apply vorticity confinement force
         5. Advect velocity field (self-advection)
         6. Compute divergence of velocity
         7. Solve pressure via Jacobi iteration (20-40 iterations)
         8. Subtract pressure gradient from velocity (projection)
         9. Advect dye field through corrected velocity
        10. Render dye to display (with optional bloom)

Compositing into Three.js:
  WebGL2 fluid canvas --> readPixels or shared context
  OR: render fluid to a texture, use as map on a Three.js fullscreen quad
  OR: use Three.js WebGLRenderTarget directly for all fluid targets
```

## Build it: step by step

### Phase 1: WebGL2 setup and utility functions
```js
const canvas = document.getElementById('fluid');
const gl = canvas.getContext('webgl2', {
  alpha: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
});

// Enable float texture rendering
const ext = gl.getExtension('EXT_color_buffer_float');
if (!ext) console.error('EXT_color_buffer_float required for fluid sim');

// Resize canvas
function resize() {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
}
resize();
window.addEventListener('resize', resize);

// Compile shader helper
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(vertSrc, fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
  }
  return prog;
}

// Fullscreen triangle vertex shader (shared by all passes)
const baseVertexShader = `#version 300 es
  precision highp float;
  out vec2 vUv;
  void main() {
    float x = float((gl_VertexID & 1) << 2);
    float y = float((gl_VertexID & 2) << 1);
    vUv = vec2(x, y) * 0.5;
    gl_Position = vec4(x - 1.0, y - 1.0, 0, 1);
  }
`;
```

### Phase 2: Double-buffered render targets
```js
class DoubleFBO {
  constructor(w, h, internalFormat, format, type, filter) {
    this.width = w;
    this.height = h;
    this.read = createFBO(w, h, internalFormat, format, type, filter);
    this.write = createFBO(w, h, internalFormat, format, type, filter);
  }
  swap() {
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }
  dispose() {
    gl.deleteFramebuffer(this.read.fbo);
    gl.deleteTexture(this.read.texture);
    gl.deleteFramebuffer(this.write.fbo);
    gl.deleteTexture(this.write.texture);
  }
}

function createFBO(w, h, internalFormat, format, type, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  return { texture, fbo, width: w, height: h };
}

// Simulation resolution (lower for performance)
const SIM_RES = 256;
const DYE_RES = 1024; // higher resolution for crisp dye rendering

const simW = SIM_RES;
const simH = Math.round(SIM_RES * canvas.height / canvas.width);
const dyeW = DYE_RES;
const dyeH = Math.round(DYE_RES * canvas.height / canvas.width);

const velocity = new DoubleFBO(simW, simH, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.LINEAR);
const pressure = new DoubleFBO(simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
const divergenceFBO = createFBO(simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
const curlFBO = createFBO(simW, simH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
const dye = new DoubleFBO(dyeW, dyeH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
```

### Phase 3: Simulation shader programs
```js
// Advection: move a quantity through the velocity field
const advectionShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  out vec4 fragColor;
  void main() {
    vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
    fragColor = dissipation * texture(uSource, coord);
  }
`);

// Divergence: compute div(velocity)
const divergenceShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uVelocity;
  uniform vec2 texelSize;
  out vec4 fragColor;
  void main() {
    float L = texture(uVelocity, vUv - vec2(texelSize.x, 0)).x;
    float R = texture(uVelocity, vUv + vec2(texelSize.x, 0)).x;
    float B = texture(uVelocity, vUv - vec2(0, texelSize.y)).y;
    float T = texture(uVelocity, vUv + vec2(0, texelSize.y)).y;
    float div = 0.5 * (R - L + T - B);
    fragColor = vec4(div, 0, 0, 1);
  }
`);

// Pressure solve: Jacobi iteration for Poisson equation
const pressureShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  uniform vec2 texelSize;
  out vec4 fragColor;
  void main() {
    float L = texture(uPressure, vUv - vec2(texelSize.x, 0)).x;
    float R = texture(uPressure, vUv + vec2(texelSize.x, 0)).x;
    float B = texture(uPressure, vUv - vec2(0, texelSize.y)).x;
    float T = texture(uPressure, vUv + vec2(0, texelSize.y)).x;
    float div = texture(uDivergence, vUv).x;
    fragColor = vec4((L + R + B + T - div) * 0.25, 0, 0, 1);
  }
`);

// Gradient subtraction: enforce incompressibility
const gradSubShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  uniform vec2 texelSize;
  out vec4 fragColor;
  void main() {
    float L = texture(uPressure, vUv - vec2(texelSize.x, 0)).x;
    float R = texture(uPressure, vUv + vec2(texelSize.x, 0)).x;
    float B = texture(uPressure, vUv - vec2(0, texelSize.y)).x;
    float T = texture(uPressure, vUv + vec2(0, texelSize.y)).x;
    vec2 vel = texture(uVelocity, vUv).xy;
    vel -= vec2(R - L, T - B) * 0.5;
    fragColor = vec4(vel, 0, 1);
  }
`);

// Curl: compute vorticity magnitude
const curlShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uVelocity;
  uniform vec2 texelSize;
  out vec4 fragColor;
  void main() {
    float L = texture(uVelocity, vUv - vec2(texelSize.x, 0)).y;
    float R = texture(uVelocity, vUv + vec2(texelSize.x, 0)).y;
    float B = texture(uVelocity, vUv - vec2(0, texelSize.y)).x;
    float T = texture(uVelocity, vUv + vec2(0, texelSize.y)).x;
    fragColor = vec4(0.5 * (R - L - T + B), 0, 0, 1);
  }
`);

// Vorticity confinement: amplify curls
const vorticityShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform vec2 texelSize;
  uniform float curl;
  uniform float dt;
  out vec4 fragColor;
  void main() {
    float L = texture(uCurl, vUv - vec2(texelSize.x, 0)).x;
    float R = texture(uCurl, vUv + vec2(texelSize.x, 0)).x;
    float B = texture(uCurl, vUv - vec2(0, texelSize.y)).x;
    float T = texture(uCurl, vUv + vec2(0, texelSize.y)).x;
    float C = texture(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    float len = max(length(force), 1e-5);
    force = force / len * curl * C;
    vec2 vel = texture(uVelocity, vUv).xy + force * dt;
    fragColor = vec4(vel, 0, 1);
  }
`);

// Splat: inject dye or force at a point
const splatShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uTarget;
  uniform vec2 point;
  uniform float radius;
  uniform vec3 color;
  uniform float aspectRatio;
  out vec4 fragColor;
  void main() {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    float d = dot(p, p);
    vec3 splat = exp(-d / radius) * color;
    vec3 base = texture(uTarget, vUv).xyz;
    fragColor = vec4(base + splat, 1);
  }
`);

// Display: render dye to screen
const displayShader = createProgram(baseVertexShader, `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uTexture;
  out vec4 fragColor;
  void main() {
    vec3 color = texture(uTexture, vUv).rgb;
    fragColor = vec4(color, 1);
  }
`);
```

### Phase 4: Simulation step functions
```js
function blit(target) {
  if (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function setUniforms(program, uniforms) {
  gl.useProgram(program);
  for (const [name, value] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(program, name);
    if (loc === null) continue;
    if (typeof value === 'number') {
      gl.uniform1f(loc, value);
    } else if (value.length === 2) {
      gl.uniform2f(loc, value[0], value[1]);
    } else if (value.length === 3) {
      gl.uniform3f(loc, value[0], value[1], value[2]);
    } else if (value instanceof WebGLTexture || typeof value === 'object') {
      // Texture binding handled separately
    }
  }
}

function bindTexture(program, name, texture, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, name), unit);
}

const simTexel = [1 / simW, 1 / simH];
const dyeTexel = [1 / dyeW, 1 / dyeH];
const aspectRatio = canvas.width / canvas.height;

function step(dt) {
  // 1. Curl (for vorticity confinement)
  gl.useProgram(curlShader);
  gl.uniform2f(gl.getUniformLocation(curlShader, 'texelSize'), ...simTexel);
  bindTexture(curlShader, 'uVelocity', velocity.read.texture, 0);
  blit(curlFBO);

  // 2. Vorticity confinement
  gl.useProgram(vorticityShader);
  gl.uniform2f(gl.getUniformLocation(vorticityShader, 'texelSize'), ...simTexel);
  gl.uniform1f(gl.getUniformLocation(vorticityShader, 'curl'), 30);
  gl.uniform1f(gl.getUniformLocation(vorticityShader, 'dt'), dt);
  bindTexture(vorticityShader, 'uVelocity', velocity.read.texture, 0);
  bindTexture(vorticityShader, 'uCurl', curlFBO.texture, 1);
  blit(velocity.write);
  velocity.swap();

  // 3. Advect velocity (self-advection)
  gl.useProgram(advectionShader);
  gl.uniform2f(gl.getUniformLocation(advectionShader, 'texelSize'), ...simTexel);
  gl.uniform1f(gl.getUniformLocation(advectionShader, 'dt'), dt);
  gl.uniform1f(gl.getUniformLocation(advectionShader, 'dissipation'), 0.99);
  bindTexture(advectionShader, 'uVelocity', velocity.read.texture, 0);
  bindTexture(advectionShader, 'uSource', velocity.read.texture, 1);
  blit(velocity.write);
  velocity.swap();

  // 4. Compute divergence
  gl.useProgram(divergenceShader);
  gl.uniform2f(gl.getUniformLocation(divergenceShader, 'texelSize'), ...simTexel);
  bindTexture(divergenceShader, 'uVelocity', velocity.read.texture, 0);
  blit(divergenceFBO);

  // 5. Clear pressure (start each solve from zero for stability)
  gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.read.fbo);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // 6. Jacobi pressure solve (20-40 iterations)
  gl.useProgram(pressureShader);
  gl.uniform2f(gl.getUniformLocation(pressureShader, 'texelSize'), ...simTexel);
  bindTexture(pressureShader, 'uDivergence', divergenceFBO.texture, 1);
  for (let i = 0; i < 30; i++) {
    bindTexture(pressureShader, 'uPressure', pressure.read.texture, 0);
    blit(pressure.write);
    pressure.swap();
  }

  // 7. Gradient subtraction (project velocity to divergence-free field)
  gl.useProgram(gradSubShader);
  gl.uniform2f(gl.getUniformLocation(gradSubShader, 'texelSize'), ...simTexel);
  bindTexture(gradSubShader, 'uPressure', pressure.read.texture, 0);
  bindTexture(gradSubShader, 'uVelocity', velocity.read.texture, 1);
  blit(velocity.write);
  velocity.swap();

  // 8. Advect dye through corrected velocity
  gl.useProgram(advectionShader);
  gl.uniform2f(gl.getUniformLocation(advectionShader, 'texelSize'), ...dyeTexel);
  gl.uniform1f(gl.getUniformLocation(advectionShader, 'dt'), dt);
  gl.uniform1f(gl.getUniformLocation(advectionShader, 'dissipation'), 0.97);
  bindTexture(advectionShader, 'uVelocity', velocity.read.texture, 0);
  bindTexture(advectionShader, 'uSource', dye.read.texture, 1);
  blit(dye.write);
  dye.swap();
}
```

### Phase 5: Input handling (splat)
```js
let pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false, moved: false };

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = 1 - (e.clientY - rect.top) / rect.height;
  pointer.dx = (x - pointer.x) * 10;
  pointer.dy = (y - pointer.y) * 10;
  pointer.x = x;
  pointer.y = y;
  pointer.moved = true;
});

canvas.addEventListener('pointerdown', () => { pointer.down = true; });
canvas.addEventListener('pointerup', () => { pointer.down = false; });

function splat(x, y, dx, dy, color) {
  // Inject velocity
  gl.useProgram(splatShader);
  gl.uniform2f(gl.getUniformLocation(splatShader, 'point'), x, y);
  gl.uniform1f(gl.getUniformLocation(splatShader, 'radius'), 0.0005);
  gl.uniform3f(gl.getUniformLocation(splatShader, 'color'), dx, dy, 0);
  gl.uniform1f(gl.getUniformLocation(splatShader, 'aspectRatio'), aspectRatio);
  bindTexture(splatShader, 'uTarget', velocity.read.texture, 0);
  blit(velocity.write);
  velocity.swap();

  // Inject dye
  gl.uniform3f(gl.getUniformLocation(splatShader, 'color'), ...color);
  bindTexture(splatShader, 'uTarget', dye.read.texture, 0);
  blit(dye.write);
  dye.swap();
}

function generateColor() {
  const h = Math.random();
  const s = 0.7 + Math.random() * 0.3;
  const l = 0.5 + Math.random() * 0.2;
  // HSL to RGB conversion
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 1/6) { r = c; g = x; b = 0; }
  else if (h < 2/6) { r = x; g = c; b = 0; }
  else if (h < 3/6) { r = 0; g = c; b = x; }
  else if (h < 4/6) { r = 0; g = x; b = c; }
  else if (h < 5/6) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}
```

### Phase 6: Render loop
```js
let lastTime = performance.now();

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  dt = Math.min(dt, 0.016); // cap at ~60fps step
  lastTime = now;

  // Handle input
  if (pointer.moved) {
    pointer.moved = false;
    splat(pointer.x, pointer.y, pointer.dx, pointer.dy, generateColor());
  }

  // Run simulation
  step(dt);

  // Display result
  gl.useProgram(displayShader);
  bindTexture(displayShader, 'uTexture', dye.read.texture, 0);
  blit(null); // render to screen
}
frame();

// Auto-splat for ambient motion when no interaction
setInterval(() => {
  if (!pointer.down) {
    const x = 0.3 + Math.random() * 0.4;
    const y = 0.3 + Math.random() * 0.4;
    const dx = (Math.random() - 0.5) * 5;
    const dy = (Math.random() - 0.5) * 5;
    splat(x, y, dx, dy, generateColor());
  }
}, 800);
```

### Phase 7: Compositing into a Three.js scene
```js
import * as THREE from 'three';

// Option A: Use the fluid canvas as a texture source
const fluidTexture = new THREE.CanvasTexture(canvas);
fluidTexture.minFilter = THREE.LinearFilter;
fluidTexture.magFilter = THREE.LinearFilter;

// Apply to a fullscreen quad in the Three.js scene
const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadMat = new THREE.MeshBasicMaterial({
  map: fluidTexture,
  toneMapped: false,
});
const quad = new THREE.Mesh(quadGeo, quadMat);
quad.frustumCulled = false;
threeScene.add(quad);

// Update texture in render loop
function threeAnimate() {
  fluidTexture.needsUpdate = true;
  threeRenderer.render(threeScene, threeCamera);
  requestAnimationFrame(threeAnimate);
}

// Option B: Render fluid directly to a Three.js WebGLRenderTarget
// (shares the same WebGL context, more efficient)
// This requires using Three.js's renderer for the fluid passes,
// which adds complexity. Option A is simpler for most cases.
```

### Phase 8: Disposal
```js
function dispose() {
  velocity.dispose();
  pressure.dispose();
  dye.dispose();
  gl.deleteFramebuffer(divergenceFBO.fbo);
  gl.deleteTexture(divergenceFBO.texture);
  gl.deleteFramebuffer(curlFBO.fbo);
  gl.deleteTexture(curlFBO.texture);

  gl.deleteProgram(advectionShader);
  gl.deleteProgram(divergenceShader);
  gl.deleteProgram(pressureShader);
  gl.deleteProgram(gradSubShader);
  gl.deleteProgram(curlShader);
  gl.deleteProgram(vorticityShader);
  gl.deleteProgram(splatShader);
  gl.deleteProgram(displayShader);

  canvas.remove();
}
```

## The full reference implementation
The full implementation is the concatenation of Phases 1-6. The simulation is self-contained in a single file. For compositing, add Phase 7. The core loop is:
1. Handle pointer input (splat force + dye)
2. `step(dt)` runs the Navier-Stokes solver
3. Display dye to screen
4. Auto-splat for ambient motion

## Tuning the feel
| Parameter | Value | Rationale |
|---|---|---|
| SIM_RES | 128-256 | Simulation grid resolution. 128 for mobile, 256 for desktop. Higher = sharper vortices but more Jacobi work. |
| DYE_RES | 512-1024 | Dye (color) can be rendered at higher resolution than the velocity field. 1024 for crisp dye on desktop. |
| Jacobi iterations | 20-40 | More = more accurate pressure solve = more incompressible flow. 30 is a good default. Below 20, visible artifacts. Above 40, diminishing returns. |
| Vorticity confinement (curl) | 20-50 | Higher = more aggressive vortex amplification. 30 is natural. Above 50, unnatural spinning. 0 = no confinement, flow dies quickly. |
| Velocity dissipation | 0.97-0.999 | How fast velocity decays. 0.99 is standard. Lower = flow dies faster. Higher = flow persists longer. |
| Dye dissipation | 0.95-0.99 | How fast dye fades. 0.97 gives visible trails. 0.99 keeps dye almost permanently. |
| Splat radius | 0.0002-0.001 | In UV space. Smaller = precise cursor trail. Larger = broad brush. |
| Splat force multiplier | 5-20 | How much force a pointer drag injects. 10 is responsive. Above 20, flow becomes turbulent immediately. |
| Auto-splat interval | 500-2000ms | How often ambient splats fire when no interaction. 800ms is active. 2000ms is calm. |
| dt cap | 0.016 (60fps) | Prevents large time steps that blow up the simulation. |

## Variants

### 1. Ink-in-water (dark background, saturated dye)
Black background. Vivid, saturated dye colors. Low dissipation (0.99) so ink persists. Vorticity confinement at 40+ for swirling details.

### 2. Smoke/fog (light dye, high dissipation)
Light gray or white dye on dark background. High dissipation (0.95) so smoke fades quickly. Lower vorticity confinement (10-20) for softer flow.

### 3. Interactive cursor trail
Fluid triggered only by pointer movement (no auto-splat). Splat radius tied to pointer velocity. Dye color follows a brand palette. Great for hero sections.

### 4. Audio-reactive fluid
Bass hits trigger large splats at random positions. High-frequency energy increases vorticity confinement. Volume maps to splat force. Requires audio analysis (FFT).

### 5. 3D scene background
Fluid rendered to a texture, applied as a background quad in a Three.js scene. 3D objects in front with the fluid as a living backdrop. Use `toneMapped: false` on the quad material.

## Performance budget
| Metric | Target | Notes |
|---|---|---|
| Sim resolution | 128-256 per axis | VRAM scales quadratically. 256^2 with 5 textures = ~2.5 MB. |
| Dye resolution | 512-1024 per axis | 1024^2 RGBA16F = ~8 MB. |
| Jacobi iterations | 20-40 | Each is a full-resolution render pass. The biggest per-frame cost. |
| Total passes per frame | ~40-60 | Curl + vorticity + advect vel + divergence + 30 Jacobi + grad sub + advect dye + display. |
| Frame time | < 8ms | Leaves room for other rendering. Profile on target GPU. |
| Mobile | SIM_RES 64-128, DYE_RES 256-512 | Reduce Jacobi to 15-20. |

Cut first: reduce Jacobi iterations (20 is usually fine). Reduce SIM_RES. Reduce DYE_RES. Remove vorticity confinement (saves 2 passes, flow becomes smoother but less detailed).

## Accessibility
- Fluid simulation is decorative. Add `aria-hidden="true"` to the canvas.
- For `prefers-reduced-motion`, stop the simulation loop and display the last frame as a static image. Or stop auto-splats and only respond to deliberate pointer interaction.
- Never convey information through fluid behavior.
- Fluid motion can trigger vestibular sensitivity. High vorticity confinement and fast flow are worse. Reduce speed and confinement for accessible variants.

```js
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
if (motionQuery.matches) {
  // Freeze: render one last frame and stop the loop
  cancelAnimationFrame(rafId);
}
```

## Anti-slop rules
1. Do NOT skip the pressure solve. Without it, the velocity field is not divergence-free and fluid "compresses," creating unphysical expanding/contracting blobs.
2. Do NOT use fewer than 15 Jacobi iterations. The pressure field will not converge and artifacts appear as grid-aligned noise.
3. Do NOT use `gl.FLOAT` textures when `gl.HALF_FLOAT` is sufficient. Half-float is 2x less VRAM and faster on most GPUs for this use case.
4. Do NOT forget to cap dt. A single large time step (tab re-focus) will blow up the semi-Lagrangian advection.
5. Do NOT set velocity dissipation to exactly 1.0. Numerical errors accumulate and the flow becomes unstable over time.
6. Do NOT render the dye at simulation resolution. Dye should be at least 2x the velocity grid resolution for crisp visuals.
7. Do NOT skip vorticity confinement. Without it, the numerical diffusion of the solver kills all small-scale vortices and the flow looks dead within seconds.
8. Do NOT use `NEAREST` filter on the velocity texture. Advection needs bilinear interpolation (`LINEAR`) to work correctly. Use `NEAREST` only for pressure and divergence.
9. Do NOT run the simulation on a `<canvas>` without `preserveDrawingBuffer: false`. Preserving the buffer wastes memory and prevents the compositor from reusing it.
10. Do NOT forget to clear the pressure field at the start of each solve. Reusing the previous frame's pressure as an initial guess can cause drift over long sessions.

## Integration notes
- Composes with `three-js-fundamentals` for the Three.js compositing path (Phase 7).
- Composes with `shader-postprocessing` for bloom applied over the fluid output (additive bloom on bright dye creates a glowing ink effect).
- Related to `cursor-fluid-simulation` in primitives, which covers a simpler CSS/canvas cursor trail. This toolkit is the real Navier-Stokes solver.
- Related to `three-particle-gpgpu` for the FBO ping-pong pattern. That toolkit applies FBO ping-pong to particle positions; this one applies it to velocity/pressure fields. The underlying GPU technique is the same.
- Conflict: if compositing into a Three.js scene, the fluid's WebGL context and Three.js's renderer must share the same `<canvas>` or use `CanvasTexture` to bridge separate canvases. Sharing a context requires careful `gl.bindFramebuffer` management.

## Ship checklist
- [ ] `EXT_color_buffer_float` extension verified before creating float render targets
- [ ] Simulation resolution appropriate for target device (128-256)
- [ ] Dye resolution higher than sim resolution (at least 2x)
- [ ] Jacobi iterations >= 20
- [ ] Vorticity confinement enabled (curl > 0)
- [ ] dt capped at 0.016-0.033 to prevent blowup
- [ ] Velocity and dye dissipation < 1.0
- [ ] All FBOs and programs disposed on teardown
- [ ] `prefers-reduced-motion` freezes or simplifies the simulation
- [ ] Canvas has `aria-hidden="true"`
- [ ] Resize handler updates canvas size and aspect ratio
- [ ] Auto-splat provides ambient motion when no pointer input
- [ ] Tested on mobile (reduced resolution + fewer Jacobi iterations)
- [ ] Pointer interaction works with both mouse and touch
