---
name: three-particle-gpgpu
description: Use when building GPU-driven particle simulations with FBO ping-pong in Three.js. Builds a complete GPGPU particle system with simulation shaders, curl noise fields, attractor forces, mouse interaction, and proper resource management for 100k-1M particles.
category: three
pairs_with: three-particle-gpgpu-eval
---

# GPGPU Particle Simulation with FBO Ping-Pong

## What this builds
A production-grade GPU-computed particle simulation using Three.js's GPUComputationRenderer. All particle state (position, velocity, life, color) lives in floating-point textures on the GPU. Simulation shaders run as full-screen fragment passes that read the previous frame's texture and write the next frame's state (ping-pong). The CPU never touches per-particle data, allowing 100k-1M+ particles at 60fps.

- FBO ping-pong architecture: simulation runs entirely on the GPU via render-to-texture
- GPUComputationRenderer manages texture variables, dependencies, and double-buffering
- Position and velocity stored as RGBA float textures (x, y, z, w per texel = per particle)
- Curl noise flow field for organic, divergence-free particle motion
- Attractor/repulsor forces (point, line, mesh surface) with configurable strength and falloff
- Mouse/pointer interaction injected as a uniform-driven force emitter
- Particle rendering via Points with a vertex shader that samples the position texture
- Configurable particle lifecycle (birth, death, respawn) via the life/age channel
- Proper disposal of all GPU resources (render targets, textures, materials)

## When to use / when not to
- Use when you need more than 50k particles with per-particle physics (forces, noise, attractors).
- Use when the CPU-driven approach (mutating typed arrays, `needsUpdate = true`) cannot keep up (typically above 50-100k particles).
- Use for flow fields, swarms, galaxy simulations, smoke-like effects, data-driven particle clouds.
- Do NOT use for fewer than 10k particles. CPU-driven particle systems are simpler and sufficient. See `webgl-particle-systems` for the CPU approach.
- Do NOT use for 2D canvas particle effects (rain, confetti, sparkles). See `canvas-2d-performance`.
- Do NOT use when WebGL2 is not available. GPGPU requires float texture support (standard in WebGL2, extension-dependent in WebGL1).
- For the CPU-driven particle baseline, see `webgl-particle-systems`. This toolkit extends that baseline to full GPU simulation.

## Stack decision
| Dependency | Version | Why | Cheaper alternative |
|---|---|---|---|
| Three.js | 0.169+ | GPUComputationRenderer ships in addons. Manages FBO ping-pong, variable dependencies, shader compilation. | Raw WebGL2 FBO management (write your own ping-pong swaps, uniform binding, texture attachment). Possible but ~300 lines of boilerplate. |
| GPUComputationRenderer | Three.js addons | Abstracts the double-buffer render target swap, variable dependency graph, and uniform injection. | Custom implementation with two WebGLRenderTargets and a fullscreen quad. |
| No compute shaders | - | WebGPU compute shaders are the future but browser support is incomplete (2025). Fragment-shader GPGPU via FBO is the portable solution today. | WebGPU compute shaders via Three.js WebGPURenderer (experimental, not production-ready). |

## Architecture
```
GPUComputationRenderer (manages FBO ping-pong)
  |
  +--- Variable: texturePosition (RGBA32F, WxH)
  |      Read: previous position + velocity
  |      Write: new position
  |      Shader: positionSimulation.glsl
  |
  +--- Variable: textureVelocity (RGBA32F, WxH)
  |      Read: previous position + velocity + forces
  |      Write: new velocity
  |      Shader: velocitySimulation.glsl
  |
  +--- (Optional) Variable: textureLife (RGBA32F, WxH)
  |      Read: age, lifetime, state
  |      Write: aged/respawned state
  |
  Dependency graph:
    position depends on [position, velocity]
    velocity depends on [position, velocity]
    life depends on [life, position]
  |
  v
gpuCompute.compute()  -- runs all simulation passes once
  |
  v
Render pass:
  Points(geometry, shaderMaterial)
    geometry: BufferGeometry with 'reference' attribute (UV into texture)
    vertex shader: samples texturePosition to get world position
    fragment shader: draws point sprites
  |
  v
renderer.render(scene, camera)

Texture layout:
  Each texel = one particle
  Width x Height = total particle count
  e.g. 512 x 512 = 262,144 particles
  RGBA channels: x=R, y=G, z=B, w=A (life/age/extra data)

Lifecycle:
  1. Create GPUComputationRenderer(width, height, renderer)
  2. Create initial state textures (fill with starting positions/velocities)
  3. Add variables with simulation shaders
  4. Set dependencies between variables
  5. Init (compiles shaders, creates render targets)
  6. Render loop: gpuCompute.compute(), then render scene
  7. Teardown: dispose render targets, materials, geometry
```

## Build it: step by step

### Phase 1: GPUComputationRenderer setup
```js
import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

// Texture dimensions determine particle count
// WIDTH * HEIGHT = particle count
const WIDTH = 512;  // 512 * 512 = 262,144 particles
const COUNT = WIDTH * WIDTH;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 500
);
camera.position.set(0, 0, 15);

// Create GPGPU compute renderer
const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);

// Check float texture support
if (!renderer.capabilities.isWebGL2) {
  const ext = renderer.getContext().getExtension('OES_texture_float');
  if (!ext) {
    console.error('Float textures not supported');
  }
}
```

### Phase 2: Initialize state textures
```js
// Create initial position texture
const positionTexture = gpuCompute.createTexture();
const posData = positionTexture.image.data; // Float32Array, 4 values per texel

for (let i = 0; i < COUNT; i++) {
  const i4 = i * 4;
  // Distribute particles in a sphere
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const r = Math.random() * 5;
  posData[i4]     = r * Math.sin(phi) * Math.cos(theta); // x
  posData[i4 + 1] = r * Math.sin(phi) * Math.sin(theta); // y
  posData[i4 + 2] = r * Math.cos(phi);                    // z
  posData[i4 + 3] = Math.random();                         // w: life/age seed
}

// Create initial velocity texture
const velocityTexture = gpuCompute.createTexture();
const velData = velocityTexture.image.data;

for (let i = 0; i < COUNT; i++) {
  const i4 = i * 4;
  velData[i4]     = (Math.random() - 0.5) * 0.1;
  velData[i4 + 1] = (Math.random() - 0.5) * 0.1;
  velData[i4 + 2] = (Math.random() - 0.5) * 0.1;
  velData[i4 + 3] = 1.0;
}
```

### Phase 3: Simulation shaders
```js
const positionShader = /* glsl */ `
  uniform float uTime;
  uniform float uDelta;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);

    // Integrate position
    pos.xyz += vel.xyz * uDelta * 60.0;

    // Respawn particles that drift too far
    float dist = length(pos.xyz);
    if (dist > 20.0) {
      // Reset to a random position near center
      float seed = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453 + uTime);
      float theta = seed * 6.283185;
      float phi = acos(2.0 * fract(seed * 7.31) - 1.0);
      float r = fract(seed * 13.17) * 2.0;
      pos.xyz = vec3(
        r * sin(phi) * cos(theta),
        r * sin(phi) * sin(theta),
        r * cos(phi)
      );
    }

    gl_FragColor = pos;
  }
`;

const velocityShader = /* glsl */ `
  uniform float uTime;
  uniform float uDelta;
  uniform vec3 uMouse3D;
  uniform float uMouseStrength;

  //
  // Simplex 3D noise for curl field
  //
  vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }

  // Curl noise: divergence-free vector field from noise gradients
  vec3 curlNoise(vec3 p) {
    float e = 0.1;
    vec3 dx = vec3(e, 0.0, 0.0);
    vec3 dy = vec3(0.0, e, 0.0);
    vec3 dz = vec3(0.0, 0.0, e);

    float x = snoise(p + dy) - snoise(p - dy)
            - snoise(p + dz) + snoise(p - dz);
    float y = snoise(p + dz) - snoise(p - dz)
            - snoise(p + dx) + snoise(p - dx);
    float z = snoise(p + dx) - snoise(p - dx)
            - snoise(p + dy) + snoise(p - dy);

    return normalize(vec3(x, y, z)) / (2.0 * e);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);

    // Curl noise force
    float noiseFreq = 0.15;
    float noiseSpeed = 0.2;
    vec3 curlForce = curlNoise(pos.xyz * noiseFreq + uTime * noiseSpeed) * 0.5;

    // Center attractor (gentle pull toward origin)
    vec3 toCenter = -pos.xyz * 0.002;

    // Mouse interaction (repulsor)
    vec3 toMouse = pos.xyz - uMouse3D;
    float mouseDist = length(toMouse);
    vec3 mouseForce = vec3(0.0);
    if (mouseDist < 3.0 && uMouseStrength > 0.0) {
      mouseForce = normalize(toMouse) * uMouseStrength / (mouseDist * mouseDist + 0.5);
    }

    // Apply forces
    vel.xyz += curlForce * uDelta;
    vel.xyz += toCenter;
    vel.xyz += mouseForce * uDelta;

    // Damping
    vel.xyz *= 0.98;

    // Clamp velocity to prevent explosions
    float speed = length(vel.xyz);
    if (speed > 2.0) vel.xyz = normalize(vel.xyz) * 2.0;

    gl_FragColor = vel;
  }
`;
```

### Phase 4: Wire up GPUComputationRenderer
```js
// Add variables (links shader to texture)
const positionVariable = gpuCompute.addVariable(
  'texturePosition', positionShader, positionTexture
);
const velocityVariable = gpuCompute.addVariable(
  'textureVelocity', velocityShader, velocityTexture
);

// Set dependencies (which variables each shader can read)
gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable]);
gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable]);

// Add uniforms to simulation shaders
positionVariable.material.uniforms.uTime = { value: 0 };
positionVariable.material.uniforms.uDelta = { value: 0 };

velocityVariable.material.uniforms.uTime = { value: 0 };
velocityVariable.material.uniforms.uDelta = { value: 0 };
velocityVariable.material.uniforms.uMouse3D = { value: new THREE.Vector3(0, 0, 0) };
velocityVariable.material.uniforms.uMouseStrength = { value: 0.0 };

// Set texture wrapping (ClampToEdge prevents edge bleeding)
positionVariable.wrapS = THREE.ClampToEdgeWrapping;
positionVariable.wrapT = THREE.ClampToEdgeWrapping;
velocityVariable.wrapS = THREE.ClampToEdgeWrapping;
velocityVariable.wrapT = THREE.ClampToEdgeWrapping;

// Initialize (compiles shaders, creates render targets)
const error = gpuCompute.init();
if (error !== null) {
  console.error('GPUComputationRenderer init error:', error);
}
```

### Phase 5: Render particles from the position texture
```js
// Create geometry with UV references into the position texture
const geometry = new THREE.BufferGeometry();
const references = new Float32Array(COUNT * 2);

for (let i = 0; i < COUNT; i++) {
  const x = (i % WIDTH) / WIDTH;
  const y = Math.floor(i / WIDTH) / WIDTH;
  references[i * 2] = x;
  references[i * 2 + 1] = y;
}

geometry.setAttribute('reference', new THREE.Float32BufferAttribute(references, 2));

// Particle render material
const particleMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPositionTexture: { value: null },
    uPointSize: { value: 1.5 },
    uColor: { value: new THREE.Color(0x4488ff) },
    uOpacity: { value: 0.6 },
  },
  vertexShader: /* glsl */ `
    attribute vec2 reference;
    uniform sampler2D uPositionTexture;
    uniform float uPointSize;

    varying float vLife;

    void main() {
      vec4 posData = texture2D(uPositionTexture, reference);
      vec3 pos = posData.xyz;
      vLife = posData.w;

      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;

      // Size attenuation (closer = larger)
      gl_PointSize = uPointSize * (200.0 / -mvPosition.z);
      gl_PointSize = max(gl_PointSize, 0.5);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;

    varying float vLife;

    void main() {
      // Soft circle via distance from center of point sprite
      float d = length(gl_PointCoord - vec2(0.5));
      if (d > 0.5) discard;
      float alpha = smoothstep(0.5, 0.2, d) * uOpacity;

      gl_FragColor = vec4(uColor, alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const particles = new THREE.Points(geometry, particleMaterial);
scene.add(particles);
```

### Phase 6: Mouse interaction
```js
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
const mouse3D = new THREE.Vector3();

// Invisible plane for raycasting mouse to 3D position
const interactionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

window.addEventListener('pointermove', (e) => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouseNDC, camera);
  raycaster.ray.intersectPlane(interactionPlane, mouse3D);

  velocityVariable.material.uniforms.uMouse3D.value.copy(mouse3D);
  velocityVariable.material.uniforms.uMouseStrength.value = 2.0;
});

window.addEventListener('pointerleave', () => {
  velocityVariable.material.uniforms.uMouseStrength.value = 0.0;
});
```

### Phase 7: Render loop
```js
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.05); // cap delta to prevent spiral
  const elapsed = clock.getElapsedTime();

  // Update simulation uniforms
  positionVariable.material.uniforms.uTime.value = elapsed;
  positionVariable.material.uniforms.uDelta.value = delta;
  velocityVariable.material.uniforms.uTime.value = elapsed;
  velocityVariable.material.uniforms.uDelta.value = delta;

  // Run simulation
  gpuCompute.compute();

  // Feed current position texture to render material
  particleMaterial.uniforms.uPositionTexture.value =
    gpuCompute.getCurrentRenderTarget(positionVariable).texture;

  renderer.render(scene, camera);
}
animate();
```

### Phase 8: Resize and disposal
```js
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

function dispose() {
  window.removeEventListener('resize', onResize);
  cancelAnimationFrame(/* raf id */);

  // Dispose GPU compute resources
  // GPUComputationRenderer creates 2 render targets per variable (ping-pong)
  gpuCompute.dispose();

  // Dispose render geometry and material
  geometry.dispose();
  particleMaterial.dispose();

  // Dispose renderer
  renderer.dispose();
  document.body.removeChild(renderer.domElement);
}
```

## The full reference implementation
```js
import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createGPGPUParticles(container, config = {}) {
  const {
    width = 256,
    pointSize = 1.5,
    color = 0x4488ff,
    noiseFreq = 0.15,
    noiseSpeed = 0.2,
    damping = 0.98,
  } = config;

  const count = width * width;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    60, container.clientWidth / container.clientHeight, 0.1, 500
  );
  camera.position.set(0, 0, 15);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // GPGPU setup
  const gpuCompute = new GPUComputationRenderer(width, width, renderer);
  const posTex = gpuCompute.createTexture();
  const velTex = gpuCompute.createTexture();

  // Fill initial state
  const pd = posTex.image.data;
  const vd = velTex.image.data;
  for (let i = 0; i < count; i++) {
    const i4 = i * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = Math.random() * 5;
    pd[i4] = r * Math.sin(phi) * Math.cos(theta);
    pd[i4+1] = r * Math.sin(phi) * Math.sin(theta);
    pd[i4+2] = r * Math.cos(phi);
    pd[i4+3] = Math.random();
    vd[i4] = vd[i4+1] = vd[i4+2] = 0;
    vd[i4+3] = 1;
  }

  // Shaders (same as Phase 3 above, with configurable uniforms)
  const posShader = `
    uniform float uTime; uniform float uDelta;
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(texturePosition, uv);
      vec4 vel = texture2D(textureVelocity, uv);
      pos.xyz += vel.xyz * uDelta * 60.0;
      if (length(pos.xyz) > 20.0) {
        float s = fract(sin(dot(uv, vec2(12.9898,78.233)))*43758.5453 + uTime);
        pos.xyz = vec3(sin(s*6.28), cos(s*3.14), sin(s*9.42)) * fract(s*7.0) * 2.0;
      }
      gl_FragColor = pos;
    }`;

  // (Full velocity shader with curl noise as in Phase 3)
  const velShader = `/* ... velocity shader from Phase 3 ... */`;

  const posVar = gpuCompute.addVariable('texturePosition', posShader, posTex);
  const velVar = gpuCompute.addVariable('textureVelocity', velShader, velTex);
  gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
  gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);

  posVar.material.uniforms.uTime = { value: 0 };
  posVar.material.uniforms.uDelta = { value: 0 };
  velVar.material.uniforms.uTime = { value: 0 };
  velVar.material.uniforms.uDelta = { value: 0 };
  velVar.material.uniforms.uMouse3D = { value: new THREE.Vector3() };
  velVar.material.uniforms.uMouseStrength = { value: 0 };

  gpuCompute.init();

  // Render geometry
  const refs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    refs[i*2] = (i % width) / width;
    refs[i*2+1] = Math.floor(i / width) / width;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('reference', new THREE.Float32BufferAttribute(refs, 2));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPositionTexture: { value: null },
      uPointSize: { value: pointSize },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: `
      attribute vec2 reference;
      uniform sampler2D uPositionTexture;
      uniform float uPointSize;
      void main() {
        vec3 pos = texture2D(uPositionTexture, reference).xyz;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uPointSize * (200.0 / -mv.z);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(uColor, smoothstep(0.5, 0.2, d) * 0.6);
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Points(geo, mat));

  // Resize
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  // Animate
  const clock = new THREE.Clock();
  let raf;
  function animate() {
    raf = requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsedTime();
    posVar.material.uniforms.uTime.value = t;
    posVar.material.uniforms.uDelta.value = delta;
    velVar.material.uniforms.uTime.value = t;
    velVar.material.uniforms.uDelta.value = delta;
    gpuCompute.compute();
    mat.uniforms.uPositionTexture.value =
      gpuCompute.getCurrentRenderTarget(posVar).texture;
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return function dispose() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    gpuCompute.dispose();
    geo.dispose();
    mat.dispose();
    renderer.dispose();
    container.removeChild(renderer.domElement);
  };
}
```

## Tuning the feel
| Parameter | Value | Rationale |
|---|---|---|
| Texture width (particle count) | 128 (16k), 256 (65k), 512 (262k), 1024 (1M) | 256 is the sweet spot for most web use. 512 for desktop hero. 1024 only on discrete GPUs. |
| noiseFreq | 0.05-0.3 | Low = broad sweeping flow. High = turbulent, chaotic. 0.15 is a good default. |
| noiseSpeed | 0.1-0.5 | How fast the flow field evolves over time. 0.2 is calm. 0.5 is energetic. |
| Damping | 0.95-0.995 | 0.98 is standard fluid feel. Below 0.95 kills motion too fast. Above 0.995, particles never settle. |
| Point size | 0.5-3.0 | Smaller = fog/gas. Larger = distinct particles. Above 3.0, overdraw becomes expensive. |
| Attractor strength | 0.001-0.01 | Gentle pull to keep particles from escaping. Stronger = tighter cluster. |
| Mouse repulsor radius | 2-5 world units | Smaller = precise interaction. Larger = sweeping influence. |
| Mouse repulsor strength | 1-5 | Below 1 is subtle. Above 5 is aggressive scattering. |
| Delta cap | 0.05 (50ms) | Prevents simulation explosion when tab regains focus after long background. |
| Velocity clamp | 1-3 world units/frame | Prevents runaway particles. Set based on scene scale. |

## Variants

### 1. Attractor constellations
Multiple point attractors placed in a pattern (logo outline, letter positions). Particles orbit between them. Switch attractor weights over time for morphing.

### 2. Mesh surface emission
Sample positions from a mesh surface (via MeshSurfaceSampler). Use those positions as the initial state or as attractor targets. Particles born on the mesh surface, flow outward.

### 3. Audio-reactive flow
Map audio frequency bands to curl noise parameters (low freq = broad flow, high freq = turbulence). Bass hits increase attractor strength momentarily.

### 4. Trail rendering
Instead of Points, render as connected line segments. Store N previous positions per particle in additional texture channels. Use LineSegments with a vertex shader sampling position history.

### 5. Color field
Store color data in the velocity texture's alpha channel or a third GPGPU texture. Particles pick up color based on their position in the flow field. Creates ink-in-water effects.

## Performance budget
| Metric | Target | Notes |
|---|---|---|
| Particle count | 65k-262k for web, up to 1M on desktop | Each particle = one texel. VRAM = width^2 * 16 bytes * 2 variables * 2 (ping-pong) |
| VRAM for 256x256 | ~8 MB | 256^2 * 16B * 4 render targets = ~8 MB |
| VRAM for 512x512 | ~32 MB | Quadruples with each width doubling |
| Frame time budget | < 4ms for simulation + render | Leaves room for other scene content |
| Draw calls | 1 (Points) | Single draw call regardless of particle count |
| Simulation passes per frame | 2 (position + velocity) | More variables = more passes. Keep to 2-3. |

Cut first: reduce texture width (halve = quarter the particles). Reduce point size (less overdraw). Remove unused variables. Skip mouse interaction uniform updates when pointer is idle.

## Accessibility
```js
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
if (motionQuery.matches) {
  // Freeze simulation: stop calling gpuCompute.compute()
  // Particles stay at their current positions as a static cloud
  simulationRunning = false;
}
```
- GPGPU particles are decorative. Add `aria-hidden="true"` to the canvas container.
- Never convey information solely through particle behavior.
- On low-power devices (mobile, integrated GPU), reduce texture width or disable entirely.

## Anti-slop rules
1. Do NOT use GPUComputationRenderer for fewer than 10k particles. The setup overhead is not worth it. Use CPU-driven `needsUpdate` instead. See `webgl-particle-systems`.
2. Do NOT forget to cap delta time. A tab returning from background can produce a delta of 10+ seconds, causing the simulation to explode in one frame.
3. Do NOT skip the damping term. Undamped particles accelerate indefinitely and leave the visible scene.
4. Do NOT use `NearestFilter` on GPGPU textures. The default `LinearFilter` interpolates between texels, which is wrong for per-particle data. Set `minFilter` and `magFilter` to `NearestFilter` on the render targets if you access neighboring texels.
5. Do NOT run GPGPU on mobile without testing. Many mobile GPUs have limited float texture precision (mediump) or slow fill rates that make the simulation stutter.
6. Do NOT create new textures or materials per frame. All GPGPU resources are created once at init and reused.
7. Do NOT use `Math.random()` in GLSL. Use a deterministic hash function seeded from `gl_FragCoord` and `uTime`.
8. Do NOT forget to call `gpuCompute.dispose()` on teardown. Each variable holds two render targets (ping-pong pair) that will leak if not disposed.
9. Do NOT exceed 3 GPGPU variables unless necessary. Each adds a full-resolution render pass per frame.
10. Do NOT add a velocity clamp without also adding a delta clamp. They solve different failure modes (runaway forces vs. time gap).

## Integration notes
- Builds on `webgl-particle-systems` which covers CPU-driven particles and introduces GPUComputationRenderer at a basic level. This toolkit goes deep on the GPGPU architecture.
- Composes with `three-js-fundamentals` for scene/camera/renderer/resize setup.
- Composes with `glsl-fragment-backgrounds` for simplex noise implementations reusable in the simulation shaders.
- Composes with `shader-postprocessing` for bloom on additive-blended particles (bloom + additive blending on dark backgrounds produces the classic "energy particle" look).
- Composes with `three-environment-hdri-reflections` if particles are rendered as instanced meshes (not Points) that need environment reflections.
- Conflict: GPUComputationRenderer uses internal render targets and calls `renderer.setRenderTarget()` during `compute()`. If you also use `EffectComposer`, ensure `compute()` is called before `composer.render()`, not between passes.

## Ship checklist
- [ ] Float texture support verified (`isWebGL2` or `OES_texture_float`)
- [ ] GPUComputationRenderer initialized without errors
- [ ] Delta time capped (max 50ms) to prevent explosion on tab re-focus
- [ ] Velocity damping applied (0.95-0.995 range)
- [ ] Velocity magnitude clamped
- [ ] Particles respawn when drifting out of bounds
- [ ] `gpuCompute.dispose()` called on teardown
- [ ] Geometry and render material disposed on teardown
- [ ] Resize handler updates renderer and camera
- [ ] `prefers-reduced-motion` freezes simulation
- [ ] Canvas has `aria-hidden="true"`
- [ ] Tested on target low-end device (mobile GPU if applicable)
- [ ] Draw calls verified: 1 for Points, 2 simulation passes
- [ ] Mouse interaction disabled when pointer leaves the canvas
