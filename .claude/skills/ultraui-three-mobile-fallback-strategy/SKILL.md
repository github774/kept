---
name: three-mobile-fallback-strategy
description: Use when a Three.js scene must degrade gracefully across GPU tiers, from high-end desktop to low-end mobile to WebGL-unavailable browsers. Builds the complete capability detection, tier assignment, scene complexity scaling, and fallback rendering pipeline.
category: three
pairs_with: three-mobile-fallback-strategy-eval
---

# Three.js Mobile Fallback Strategy

## What this builds
A complete capability-detection and degradation system that wraps any Three.js scene, probing real GPU capabilities at init time and continuously monitoring runtime performance to dynamically scale scene complexity. The system assigns one of four rendering tiers (full, reduced, minimal, static) and provides a unified API for scene code to query its current tier and react accordingly.

- WebGL2/WebGL1 feature probe with actual draw-call benchmark, not just API presence checks.
- GPU renderer string parsing for known-weak chipsets (Mali-G52, Adreno 610, Intel UHD 620, Apple A11).
- Runtime FPS monitor that triggers tier demotion when frame time exceeds budget for N consecutive frames.
- Texture resolution capping, shadow map disabling, post-processing stripping per tier.
- Static image/CSS fallback for devices with no WebGL at all.
- Transparent to scene code: a single `tier` object gates every visual feature.

## When to use / when not to
- Use this whenever a Three.js scene ships to a general audience (marketing site, product page, editorial experience) and must not break on low-end devices.
- Use this when the brief says "works on mobile" and the scene has shadows, post-processing, or >50k triangles.
- Do NOT use this for a kiosk, internal tool, or any app where you control the hardware. Just target that hardware directly.
- Do NOT use this as a substitute for optimizing the scene itself. A scene that needs 200 draw calls on desktop still needs to be reduced to 50, not just hidden on mobile. See `three-js-fundamentals` for geometry reuse and instancing fundamentals.
- For scroll-specific mobile performance (layer budgets, ScrollTrigger count management, thermal throttle resilience), see `scroll-mobile-performance-strategy`, which covers the 2D/CSS animation side. This toolkit covers the 3D/WebGL side exclusively.

## Stack decision
| Dependency | Version | Why | Cheaper alternative |
|---|---|---|---|
| Three.js | r169+ | The scene renderer this strategy wraps. All tier scaling is Three.js-specific (shadow maps, pixel ratio, material swaps). | None. This toolkit is Three.js-specific by definition. |
| No additional deps | -- | Capability detection, FPS monitoring, and tier assignment are all vanilla JS/WebGL API calls. No library needed. | -- |

**Cheaper alternative for the entire approach**: If the scene is simple enough (< 10k tris, no shadows, no post-processing), skip tiering entirely and just cap DPR at 1.5 on mobile. Tiering is engineering overhead that only pays off when the gap between "what looks good on desktop" and "what runs on mobile" is wide.

## Architecture

```
fallback/
  capability-probe.ts    -- WebGL feature detection + GPU benchmark
  tier-manager.ts        -- Assigns and manages the active tier
  fps-monitor.ts         -- Runtime frame-time tracking + demotion trigger
  scene-scaler.ts        -- Applies tier config to a Three.js renderer/scene
  static-fallback.ts     -- Generates and serves the CSS/image fallback
  types.ts               -- Tier config interfaces
```

```
Lifecycle:

  Page load
    |
    v
  [1] Probe WebGL support (canvas.getContext)
    |
    +-- No WebGL --> [STATIC] render fallback image/CSS
    |
    v
  [2] Probe GPU capabilities
    |   - max texture size, max draw buffers, renderer string
    |   - Run micro-benchmark: 500 instanced cubes for 60 frames
    |   - Measure actual frame time under load
    |
    v
  [3] Assign initial tier (full / reduced / minimal)
    |
    v
  [4] Configure scene via tier config
    |   - DPR cap, shadow map size, post-processing on/off
    |   - Material swaps (Physical -> Standard -> Lambert -> Basic)
    |   - Geometry LOD selection
    |   - Texture resolution cap
    |
    v
  [5] Start render loop + FPS monitor
    |
    +-- FPS drops below threshold for 120 frames
    |   |
    |   v
    |   [DEMOTE] drop one tier, reconfigure scene
    |
    +-- Visibility change (tab hidden)
    |   |
    |   v
    |   [PAUSE] stop render loop entirely
    |
    v
  [6] Route change / unmount
    |
    v
  [7] Dispose: renderer, geometries, materials, textures, monitors
```

## Build it: step by step

### Phase 1: Type definitions

```typescript
// types.ts
export type RenderTier = 'full' | 'reduced' | 'minimal' | 'static';

export interface TierConfig {
  tier: RenderTier;
  maxDPR: number;
  shadowMapEnabled: boolean;
  shadowMapSize: number;
  postProcessing: boolean;
  maxTextureSize: number;
  antialias: boolean;
  materialGrade: 'physical' | 'standard' | 'lambert' | 'basic';
  maxDrawCalls: number;
  particleCap: number;
  envMapResolution: number;
}

export const TIER_CONFIGS: Record<RenderTier, TierConfig> = {
  full: {
    tier: 'full',
    maxDPR: 2,
    shadowMapEnabled: true,
    shadowMapSize: 2048,
    postProcessing: true,
    maxTextureSize: 4096,
    antialias: true,
    materialGrade: 'physical',
    maxDrawCalls: 200,
    particleCap: 100000,
    envMapResolution: 512,
  },
  reduced: {
    tier: 'reduced',
    maxDPR: 1.5,
    shadowMapEnabled: true,
    shadowMapSize: 1024,
    postProcessing: false,
    maxTextureSize: 2048,
    antialias: true,
    materialGrade: 'standard',
    maxDrawCalls: 100,
    particleCap: 20000,
    envMapResolution: 256,
  },
  minimal: {
    tier: 'minimal',
    maxDPR: 1,
    shadowMapEnabled: false,
    shadowMapSize: 0,
    postProcessing: false,
    maxTextureSize: 1024,
    antialias: false,
    materialGrade: 'lambert',
    maxDrawCalls: 50,
    particleCap: 5000,
    envMapResolution: 128,
  },
  static: {
    tier: 'static',
    maxDPR: 1,
    shadowMapEnabled: false,
    shadowMapSize: 0,
    postProcessing: false,
    maxTextureSize: 512,
    antialias: false,
    materialGrade: 'basic',
    maxDrawCalls: 0,
    particleCap: 0,
    envMapResolution: 0,
  },
};
```

### Phase 2: WebGL capability probe

```typescript
// capability-probe.ts
import { RenderTier } from './types';

interface GPUProfile {
  webglVersion: 2 | 1 | 0;
  renderer: string;
  vendor: string;
  maxTextureSize: number;
  maxDrawBuffers: number;
  maxVertexUniforms: number;
  floatTextureSupport: boolean;
  instancedArrays: boolean;
  benchmarkFPS: number;
}

// Known weak GPUs by renderer string substring (UNMASKED_RENDERER_WEBGL)
const WEAK_GPUS = [
  'mali-g51', 'mali-g52', 'mali-g31',
  'adreno (tm) 505', 'adreno (tm) 506', 'adreno (tm) 509',
  'adreno (tm) 610', 'adreno (tm) 612',
  'powervr', 'sgx',
  'intel uhd graphics 6', 'intel hd graphics 5',
  'apple a9', 'apple a10', 'apple a11',
];

const MID_GPUS = [
  'mali-g57', 'mali-g68', 'mali-g72', 'mali-g76',
  'adreno (tm) 618', 'adreno (tm) 619', 'adreno (tm) 620',
  'adreno (tm) 630', 'adreno (tm) 640',
  'apple a12', 'apple a13', 'apple a14',
  'intel iris',
  'intel uhd graphics 7',
];

export function probeGPU(): GPUProfile {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;

  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  let webglVersion: 2 | 1 | 0 = 0;

  gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (gl) {
    webglVersion = 2;
  } else {
    gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    if (gl) webglVersion = 1;
  }

  if (!gl) {
    return {
      webglVersion: 0,
      renderer: 'none',
      vendor: 'none',
      maxTextureSize: 0,
      maxDrawBuffers: 0,
      maxVertexUniforms: 0,
      floatTextureSupport: false,
      instancedArrays: false,
      benchmarkFPS: 0,
    };
  }

  const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbgExt
    ? (gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) as string)
    : 'unknown';
  const vendor = dbgExt
    ? (gl.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL) as string)
    : 'unknown';

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxDrawBuffers = webglVersion === 2
    ? (gl.getParameter((gl as WebGL2RenderingContext).MAX_DRAW_BUFFERS) as number)
    : (gl.getExtension('WEBGL_draw_buffers')
      ? (gl.getParameter(0x8824) as number) // MAX_DRAW_BUFFERS_WEBGL
      : 1);
  const maxVertexUniforms = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) as number;

  const floatTextureSupport = webglVersion === 2
    ? !!(gl as WebGL2RenderingContext).getExtension('EXT_color_buffer_float')
    : !!gl.getExtension('OES_texture_float');

  const instancedArrays = webglVersion === 2
    ? true
    : !!gl.getExtension('ANGLE_instanced_arrays');

  // Cleanup the probe context
  const loseExt = gl.getExtension('WEBGL_lose_context');
  if (loseExt) loseExt.loseContext();

  return {
    webglVersion,
    renderer,
    vendor,
    maxTextureSize,
    maxDrawBuffers,
    maxVertexUniforms,
    floatTextureSupport,
    instancedArrays,
    benchmarkFPS: 0, // filled by runBenchmark()
  };
}

export function classifyGPU(profile: GPUProfile): RenderTier {
  if (profile.webglVersion === 0) return 'static';

  const rendererLower = profile.renderer.toLowerCase();

  // Check for known weak GPUs
  if (WEAK_GPUS.some(gpu => rendererLower.includes(gpu))) return 'minimal';

  // Check for known mid-range GPUs
  if (MID_GPUS.some(gpu => rendererLower.includes(gpu))) return 'reduced';

  // Hardware signals
  let score = 0;

  // WebGL2 support
  if (profile.webglVersion === 2) score += 2;

  // Texture size: 16384 = high-end, 8192 = mid, 4096 = low
  if (profile.maxTextureSize >= 16384) score += 3;
  else if (profile.maxTextureSize >= 8192) score += 2;
  else if (profile.maxTextureSize >= 4096) score += 1;

  // Float textures (needed for GPGPU, advanced post-processing)
  if (profile.floatTextureSupport) score += 1;

  // Draw buffers (MRT for deferred rendering)
  if (profile.maxDrawBuffers >= 8) score += 1;

  // Vertex uniforms: >= 1024 is generous
  if (profile.maxVertexUniforms >= 1024) score += 1;

  // Device signals
  const memory = (navigator as any).deviceMemory;
  if (memory && memory >= 8) score += 2;
  else if (memory && memory < 4) score -= 1;

  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores >= 8) score += 1;
  else if (cores <= 2) score -= 1;

  // Touch device penalty (generally weaker GPU)
  if (window.matchMedia('(pointer: coarse)').matches) score -= 1;

  // Reduced motion preference always gets minimal
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'minimal';

  // Benchmark FPS overrides classification
  if (profile.benchmarkFPS > 0) {
    if (profile.benchmarkFPS < 20) return 'minimal';
    if (profile.benchmarkFPS < 40) return 'reduced';
  }

  if (score >= 8) return 'full';
  if (score >= 4) return 'reduced';
  return 'minimal';
}
```

### Phase 3: GPU micro-benchmark

```typescript
// capability-probe.ts (continued)
import * as THREE from 'three';

export async function runBenchmark(timeoutMs = 2000): Promise<number> {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(256, 256);
  renderer.setPixelRatio(1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 20;

  // 500 instanced cubes: a real draw workload
  const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const mesh = new THREE.InstancedMesh(geometry, material, 500);

  const dummy = new THREE.Object3D();
  for (let i = 0; i < 500; i++) {
    dummy.position.set(
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 20
    );
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  scene.add(mesh);

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(5, 10, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  // Warm up: render 10 frames before measuring
  for (let i = 0; i < 10; i++) {
    mesh.rotation.y += 0.02;
    renderer.render(scene, camera);
  }

  // Measure 60 frames
  const frameTimes: number[] = [];
  let lastTime = performance.now();

  return new Promise<number>((resolve) => {
    let frame = 0;
    const maxFrames = 60;
    const deadline = performance.now() + timeoutMs;

    function measure() {
      if (frame >= maxFrames || performance.now() > deadline) {
        // Cleanup
        geometry.dispose();
        material.dispose();
        renderer.dispose();

        if (frameTimes.length < 10) {
          resolve(0); // not enough data
          return;
        }

        // Median frame time -> FPS
        frameTimes.sort((a, b) => a - b);
        const median = frameTimes[Math.floor(frameTimes.length / 2)];
        resolve(Math.round(1000 / median));
        return;
      }

      mesh.rotation.y += 0.02;
      renderer.render(scene, camera);

      const now = performance.now();
      frameTimes.push(now - lastTime);
      lastTime = now;
      frame++;

      requestAnimationFrame(measure);
    }

    requestAnimationFrame(measure);
  });
}
```

### Phase 4: FPS monitor for runtime demotion

```typescript
// fps-monitor.ts
export type DemotionCallback = () => void;

export class FPSMonitor {
  private frameTimes: number[] = [];
  private lastTime = 0;
  private consecutiveBad = 0;
  private readonly threshold: number;      // ms per frame (e.g., 20 = 50fps)
  private readonly demoteAfter: number;    // consecutive bad frames
  private onDemote: DemotionCallback;
  private running = false;
  private rafId = 0;

  constructor(opts: {
    targetFPS?: number;       // default 50 (not 60, allows headroom)
    demoteAfterFrames?: number; // default 120 (~2 seconds)
    onDemote: DemotionCallback;
  }) {
    this.threshold = 1000 / (opts.targetFPS ?? 50);
    this.demoteAfter = opts.demoteAfterFrames ?? 120;
    this.onDemote = opts.onDemote;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  reset(): void {
    this.consecutiveBad = 0;
    this.frameTimes = [];
  }

  getAverageFPS(): number {
    if (this.frameTimes.length === 0) return 60;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return Math.round(1000 / avg);
  }

  private tick = (): void => {
    if (!this.running) return;

    const now = performance.now();
    const delta = now - this.lastTime;
    this.lastTime = now;

    // Ignore first frame (often a spike)
    if (delta > 0 && delta < 200) {
      this.frameTimes.push(delta);
      // Keep a rolling window of 300 frames
      if (this.frameTimes.length > 300) this.frameTimes.shift();

      if (delta > this.threshold) {
        this.consecutiveBad++;
        if (this.consecutiveBad >= this.demoteAfter) {
          this.consecutiveBad = 0;
          this.onDemote();
        }
      } else {
        this.consecutiveBad = 0;
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}
```

### Phase 5: Scene scaler

```typescript
// scene-scaler.ts
import * as THREE from 'three';
import { TierConfig, TIER_CONFIGS, RenderTier } from './types';

export class SceneScaler {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private currentTier: RenderTier;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, initialTier: RenderTier) {
    this.renderer = renderer;
    this.scene = scene;
    this.currentTier = initialTier;
    this.apply(TIER_CONFIGS[initialTier]);
  }

  get tier(): RenderTier {
    return this.currentTier;
  }

  demote(): RenderTier {
    const order: RenderTier[] = ['full', 'reduced', 'minimal'];
    const idx = order.indexOf(this.currentTier);
    if (idx < order.length - 1) {
      this.currentTier = order[idx + 1];
      this.apply(TIER_CONFIGS[this.currentTier]);
    }
    return this.currentTier;
  }

  setTier(tier: RenderTier): void {
    this.currentTier = tier;
    this.apply(TIER_CONFIGS[tier]);
  }

  private apply(config: TierConfig): void {
    // Pixel ratio
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.maxDPR));

    // Shadows
    if (this.renderer.shadowMap.enabled !== config.shadowMapEnabled) {
      this.renderer.shadowMap.enabled = config.shadowMapEnabled;
      // Must mark all materials as needing update when toggling shadows
      this.scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach(m => { m.needsUpdate = true; });
          } else {
            mesh.material.needsUpdate = true;
          }
        }
      });
    }

    // Shadow map resolution on all shadow-casting lights
    if (config.shadowMapEnabled) {
      this.scene.traverse((obj) => {
        if ((obj as THREE.Light).isLight && (obj as any).shadow) {
          const light = obj as THREE.DirectionalLight | THREE.SpotLight | THREE.PointLight;
          light.shadow.mapSize.setScalar(config.shadowMapSize);
          if (light.shadow.map) {
            light.shadow.map.dispose();
            light.shadow.map = null as any;
          }
        }
      });
    }

    // Material grade swaps
    this.scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || !mat.isMeshStandardMaterial) return;

      // Store original material reference for potential promotion
      if (!(mesh.userData as any).__originalMaterial) {
        (mesh.userData as any).__originalMaterial = mat;
      }

      switch (config.materialGrade) {
        case 'physical':
        case 'standard':
          // Restore original if it was swapped
          if ((mesh.userData as any).__originalMaterial) {
            mesh.material = (mesh.userData as any).__originalMaterial;
          }
          break;
        case 'lambert': {
          const lambert = new THREE.MeshLambertMaterial({
            color: mat.color,
            map: mat.map,
            emissive: mat.emissive,
            emissiveMap: mat.emissiveMap,
            transparent: mat.transparent,
            opacity: mat.opacity,
          });
          mesh.material = lambert;
          break;
        }
        case 'basic': {
          const basic = new THREE.MeshBasicMaterial({
            color: mat.color,
            map: mat.map,
            transparent: mat.transparent,
            opacity: mat.opacity,
          });
          mesh.material = basic;
          break;
        }
      }
    });

    console.log(`[SceneScaler] Applied tier: ${config.tier} (DPR: ${config.maxDPR}, shadows: ${config.shadowMapEnabled})`);
  }
}
```

### Phase 6: Static fallback

```typescript
// static-fallback.ts
import * as THREE from 'three';

export interface FallbackOptions {
  container: HTMLElement;
  /** Pre-rendered image URL. If not provided, renders one frame from the scene. */
  imageUrl?: string;
  /** Alt text for the fallback image */
  alt?: string;
  /** CSS background as final fallback if image fails */
  backgroundColor?: string;
}

/**
 * Renders a single frame of the scene to a data URL, then replaces
 * the canvas with an <img> tag. Zero ongoing GPU cost.
 */
export function renderStaticFallback(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: FallbackOptions
): void {
  let imageUrl = opts.imageUrl;

  if (!imageUrl) {
    // Render one frame and extract as JPEG (smaller than PNG for photos)
    renderer.render(scene, camera);
    imageUrl = renderer.domElement.toDataURL('image/jpeg', 0.85);
  }

  // Dispose the renderer entirely
  renderer.dispose();
  renderer.domElement.remove();

  // Insert a plain image
  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = opts.alt ?? '3D scene';
  img.style.cssText = `
    width: 100%;
    height: 100%;
    object-fit: cover;
    position: absolute;
    inset: 0;
  `;
  img.onerror = () => {
    // Final fallback: CSS background
    opts.container.style.background = opts.backgroundColor ?? '#0a0a0f';
  };
  opts.container.appendChild(img);
}

/**
 * For devices with no WebGL at all. No renderer ever created.
 */
export function renderNoWebGLFallback(opts: FallbackOptions): void {
  if (opts.imageUrl) {
    const img = document.createElement('img');
    img.src = opts.imageUrl;
    img.alt = opts.alt ?? '3D scene';
    img.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
      position: absolute;
      inset: 0;
    `;
    opts.container.appendChild(img);
  } else {
    opts.container.style.background = opts.backgroundColor ?? '#0a0a0f';
  }
}
```

### Phase 7: Tier manager (the orchestrator)

```typescript
// tier-manager.ts
import * as THREE from 'three';
import { probeGPU, classifyGPU, runBenchmark } from './capability-probe';
import { FPSMonitor } from './fps-monitor';
import { SceneScaler } from './scene-scaler';
import { renderStaticFallback, renderNoWebGLFallback } from './static-fallback';
import { RenderTier, TIER_CONFIGS } from './types';

export interface TierManagerOptions {
  container: HTMLElement;
  fallbackImageUrl?: string;
  /** Skip benchmark for faster init (uses GPU string classification only) */
  skipBenchmark?: boolean;
  /** Called when tier changes at runtime */
  onTierChange?: (newTier: RenderTier, oldTier: RenderTier) => void;
}

export class TierManager {
  private scaler: SceneScaler | null = null;
  private monitor: FPSMonitor | null = null;
  private _tier: RenderTier = 'full';
  private visibilityHandler: (() => void) | null = null;
  private renderLoopPaused = false;

  get tier(): RenderTier {
    return this._tier;
  }

  get config() {
    return TIER_CONFIGS[this._tier];
  }

  async init(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: TierManagerOptions
  ): Promise<RenderTier> {
    const profile = probeGPU();

    // No WebGL at all
    if (profile.webglVersion === 0) {
      this._tier = 'static';
      renderNoWebGLFallback({
        container: opts.container,
        imageUrl: opts.fallbackImageUrl,
        alt: '3D scene (WebGL unavailable)',
      });
      return this._tier;
    }

    // Run benchmark unless skipped
    if (!opts.skipBenchmark) {
      profile.benchmarkFPS = await runBenchmark();
    }

    // Classify
    this._tier = classifyGPU(profile);

    // If classified as static even with WebGL (extremely weak GPU),
    // render one frame then replace with image
    if (this._tier === 'static') {
      renderStaticFallback(renderer, scene, camera, {
        container: opts.container,
        imageUrl: opts.fallbackImageUrl,
        alt: '3D scene',
      });
      return this._tier;
    }

    // Apply tier to scene
    this.scaler = new SceneScaler(renderer, scene, this._tier);

    // Start FPS monitor for runtime demotion
    this.monitor = new FPSMonitor({
      targetFPS: 45, // generous threshold; demote only on real trouble
      demoteAfterFrames: 120,
      onDemote: () => {
        const oldTier = this._tier;
        this._tier = this.scaler!.demote();
        if (oldTier !== this._tier) {
          opts.onTierChange?.(this._tier, oldTier);
          // Reset monitor counters after demotion
          this.monitor!.reset();
        }
      },
    });
    this.monitor.start();

    // Pause render loop when tab is hidden
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.renderLoopPaused = true;
        this.monitor?.stop();
      } else {
        this.renderLoopPaused = false;
        this.monitor?.start();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    return this._tier;
  }

  /** Check before each render call */
  get shouldRender(): boolean {
    return !this.renderLoopPaused && this._tier !== 'static';
  }

  /** Force a specific tier (for dev tools / user preference) */
  forceTier(tier: RenderTier): void {
    const old = this._tier;
    this._tier = tier;
    this.scaler?.setTier(tier);
  }

  dispose(): void {
    this.monitor?.stop();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }
}
```

### Phase 8: Wiring it into a scene

```typescript
// main.ts -- example integration
import * as THREE from 'three';
import { TierManager } from './fallback/tier-manager';

const container = document.getElementById('scene-container')!;
const canvas = document.createElement('canvas');
container.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  50,
  container.clientWidth / container.clientHeight,
  0.1,
  100
);
camera.position.set(0, 2, 5);

// -- Build scene content here --
// (lights, meshes, etc.)

const tierManager = new TierManager();

tierManager.init(renderer, scene, camera, {
  container,
  fallbackImageUrl: '/images/scene-fallback.jpg',
  onTierChange: (newTier, oldTier) => {
    console.log(`Tier changed: ${oldTier} -> ${newTier}`);
    // Optionally update UI to inform user
  },
}).then((tier) => {
  console.log(`Initial tier: ${tier}`);

  if (tier === 'static') return; // no render loop needed

  // Scene code queries tier for conditional features
  const config = tierManager.config;

  if (config.postProcessing) {
    // Set up EffectComposer, bloom, etc.
  }

  // Resize handler
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.maxDPR));
  };
  window.addEventListener('resize', onResize);

  // Render loop
  function animate() {
    if (!tierManager.shouldRender) {
      requestAnimationFrame(animate);
      return;
    }
    // -- Update scene objects here --
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
});
```

## The full reference implementation

```typescript
// A complete, self-contained TierManager with inline dependencies.
// Copy this single file for projects that do not need module separation.

import * as THREE from 'three';

// ---- Types ----
type RenderTier = 'full' | 'reduced' | 'minimal' | 'static';

interface TierConfig {
  tier: RenderTier;
  maxDPR: number;
  shadowMapEnabled: boolean;
  shadowMapSize: number;
  postProcessing: boolean;
  maxTextureSize: number;
  antialias: boolean;
  materialGrade: 'physical' | 'standard' | 'lambert' | 'basic';
  maxDrawCalls: number;
  particleCap: number;
}

const TIERS: Record<RenderTier, TierConfig> = {
  full:    { tier:'full',    maxDPR:2,   shadowMapEnabled:true,  shadowMapSize:2048, postProcessing:true,  maxTextureSize:4096, antialias:true,  materialGrade:'physical', maxDrawCalls:200, particleCap:100000 },
  reduced: { tier:'reduced', maxDPR:1.5, shadowMapEnabled:true,  shadowMapSize:1024, postProcessing:false, maxTextureSize:2048, antialias:true,  materialGrade:'standard', maxDrawCalls:100, particleCap:20000  },
  minimal: { tier:'minimal', maxDPR:1,   shadowMapEnabled:false, shadowMapSize:0,    postProcessing:false, maxTextureSize:1024, antialias:false, materialGrade:'lambert',  maxDrawCalls:50,  particleCap:5000   },
  static:  { tier:'static',  maxDPR:1,   shadowMapEnabled:false, shadowMapSize:0,    postProcessing:false, maxTextureSize:512,  antialias:false, materialGrade:'basic',    maxDrawCalls:0,   particleCap:0      },
};

// ---- Weak GPU database ----
const WEAK_GPUS = ['mali-g51','mali-g52','mali-g31','adreno (tm) 505','adreno (tm) 506','adreno (tm) 610','powervr','sgx','apple a9','apple a10','apple a11','intel uhd graphics 6','intel hd graphics 5'];
const MID_GPUS  = ['mali-g57','mali-g68','mali-g72','mali-g76','adreno (tm) 618','adreno (tm) 619','adreno (tm) 630','adreno (tm) 640','apple a12','apple a13','apple a14','intel iris','intel uhd graphics 7'];

// ---- Probe ----
function probeWebGL(): { version: 2|1|0; renderer: string; maxTexSize: number; floatTex: boolean } {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  let gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
  let v: 2|1|0 = gl ? 2 : 0;
  if (!gl) { const g1 = c.getContext('webgl'); if (g1) { gl = g1 as any; v = 1; } }
  if (!gl) return { version: 0, renderer: 'none', maxTexSize: 0, floatTex: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const r = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : 'unknown';
  const mts = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const ft = v === 2 ? !!gl.getExtension('EXT_color_buffer_float') : !!gl.getExtension('OES_texture_float');
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  return { version: v, renderer: r, maxTexSize: mts, floatTex: ft };
}

function classify(renderer: string, maxTexSize: number, benchFPS: number): RenderTier {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'minimal';
  const rl = renderer.toLowerCase();
  if (WEAK_GPUS.some(g => rl.includes(g))) return 'minimal';
  if (MID_GPUS.some(g => rl.includes(g))) return 'reduced';
  if (benchFPS > 0 && benchFPS < 20) return 'minimal';
  if (benchFPS > 0 && benchFPS < 40) return 'reduced';
  let s = 0;
  if (maxTexSize >= 16384) s += 3; else if (maxTexSize >= 8192) s += 2; else s += 1;
  const mem = (navigator as any).deviceMemory;
  if (mem && mem >= 8) s += 2; else if (mem && mem < 4) s -= 1;
  if ((navigator.hardwareConcurrency ?? 4) >= 8) s += 1;
  if (window.matchMedia('(pointer: coarse)').matches) s -= 1;
  return s >= 5 ? 'full' : s >= 2 ? 'reduced' : 'minimal';
}

// ---- FPS Monitor ----
class FPSMon {
  private bad = 0;
  private last = 0;
  private rid = 0;
  private running = false;
  constructor(private threshold: number, private limit: number, private cb: () => void) {}
  start() { this.running = true; this.last = performance.now(); this.tick(); }
  stop() { this.running = false; cancelAnimationFrame(this.rid); }
  reset() { this.bad = 0; }
  private tick = () => {
    if (!this.running) return;
    const n = performance.now(), d = n - this.last; this.last = n;
    if (d > 0 && d < 200) { if (d > this.threshold) { this.bad++; if (this.bad >= this.limit) { this.bad = 0; this.cb(); } } else this.bad = 0; }
    this.rid = requestAnimationFrame(this.tick);
  };
}

// ---- Scene Scaler ----
function applyTier(r: THREE.WebGLRenderer, s: THREE.Scene, c: TierConfig) {
  r.setPixelRatio(Math.min(window.devicePixelRatio, c.maxDPR));
  if (r.shadowMap.enabled !== c.shadowMapEnabled) {
    r.shadowMap.enabled = c.shadowMapEnabled;
    s.traverse(o => { if ((o as THREE.Mesh).isMesh) { const m = (o as THREE.Mesh).material; if (Array.isArray(m)) m.forEach(x => x.needsUpdate = true); else if (m) (m as THREE.Material).needsUpdate = true; } });
  }
  if (c.shadowMapEnabled) s.traverse(o => { if ((o as any).isLight && (o as any).shadow) { (o as any).shadow.mapSize.setScalar(c.shadowMapSize); if ((o as any).shadow.map) { (o as any).shadow.map.dispose(); (o as any).shadow.map = null; } } });
}

// ---- Public API ----
export async function initTierManager(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  container: HTMLElement,
  opts?: { fallbackImage?: string; skipBenchmark?: boolean; onTierChange?: (t: RenderTier) => void }
): Promise<{ tier: RenderTier; config: TierConfig; shouldRender: () => boolean; dispose: () => void; forceTier: (t: RenderTier) => void }> {
  const probe = probeWebGL();
  if (probe.version === 0) {
    if (opts?.fallbackImage) { const img = new Image(); img.src = opts.fallbackImage; img.alt = '3D scene'; img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0'; container.appendChild(img); }
    else container.style.background = '#0a0a0f';
    const cfg = TIERS.static;
    return { tier: 'static', config: cfg, shouldRender: () => false, dispose: () => {}, forceTier: () => {} };
  }
  let benchFPS = 0;
  if (!opts?.skipBenchmark) {
    // inline benchmark: 500 instanced cubes, 60 frames
    const bc = document.createElement('canvas'); bc.width = bc.height = 256;
    const br = new THREE.WebGLRenderer({ canvas: bc, antialias: false }); br.setSize(256,256); br.setPixelRatio(1);
    const bs = new THREE.Scene(); const bca = new THREE.PerspectiveCamera(50,1,0.1,100); bca.position.z = 20;
    const bg = new THREE.BoxGeometry(0.5,0.5,0.5); const bm = new THREE.MeshStandardMaterial({color:0x888888}); const bi = new THREE.InstancedMesh(bg,bm,500);
    const bd = new THREE.Object3D(); for (let i=0;i<500;i++) { bd.position.set((Math.random()-.5)*20,(Math.random()-.5)*20,(Math.random()-.5)*20); bd.updateMatrix(); bi.setMatrixAt(i,bd.matrix); } bs.add(bi);
    bs.add(new THREE.DirectionalLight(0xffffff,2)); bs.add(new THREE.AmbientLight(0xffffff,0.5));
    for (let i=0;i<10;i++) { bi.rotation.y+=.02; br.render(bs,bca); }
    const fts: number[] = []; let lt = performance.now();
    await new Promise<void>(res => { let f=0; (function m() { if (f>=60) { bg.dispose(); bm.dispose(); br.dispose(); fts.sort((a,b)=>a-b); benchFPS = fts.length>10 ? Math.round(1000/fts[fts.length>>1]) : 0; res(); return; } bi.rotation.y+=.02; br.render(bs,bca); const n=performance.now(); fts.push(n-lt); lt=n; f++; requestAnimationFrame(m); })(); });
  }
  let tier = classify(probe.renderer, probe.maxTexSize, benchFPS);
  applyTier(renderer, scene, TIERS[tier]);
  let paused = false;
  const mon = new FPSMon(1000/45, 120, () => {
    const order: RenderTier[] = ['full','reduced','minimal'];
    const i = order.indexOf(tier);
    if (i < order.length-1) { tier = order[i+1]; applyTier(renderer, scene, TIERS[tier]); mon.reset(); opts?.onTierChange?.(tier); }
  });
  mon.start();
  const onVis = () => { if (document.hidden) { paused = true; mon.stop(); } else { paused = false; mon.start(); } };
  document.addEventListener('visibilitychange', onVis);
  return {
    tier, config: TIERS[tier],
    shouldRender: () => !paused && tier !== 'static',
    dispose: () => { mon.stop(); document.removeEventListener('visibilitychange', onVis); },
    forceTier: (t: RenderTier) => { tier = t; applyTier(renderer, scene, TIERS[t]); },
  };
}
```

## Tuning the feel

| Parameter | Value | Why |
|---|---|---|
| Benchmark frame count | 60 | One second of data at 60fps. Enough to stabilize without delaying page load. |
| Benchmark resolution | 256x256 | Small enough that the benchmark does not itself cause visible jank on the page. |
| Benchmark instance count | 500 | Stresses instanced draw path without being absurdly heavy. A GPU that cannot handle 500 instanced cubes at 256x256 will not handle any real scene. |
| FPS demotion threshold | 45fps (22ms) | Not 60. Allows 25% headroom for GC pauses, background tabs, and measurement noise. Demoting at 60fps would be too aggressive. |
| Consecutive bad frames before demotion | 120 | About 2 seconds at 60fps. A brief spike (GC, tab switch, network) should not trigger demotion. Sustained poor performance should. |
| DPR cap (full) | 2 | 3x devices (Samsung S-series) render 9x the pixels of 1x for negligible visual improvement at normal viewing distance. Cap at 2. |
| DPR cap (reduced) | 1.5 | Sweet spot for retina-ish sharpness without the fill-rate cost of 2x on a mid-range GPU. |
| DPR cap (minimal) | 1 | Every pixel counts on a weak GPU. 1x is noticeably softer on retina but avoids the 4x fill-rate tax. |
| Shadow map (full) | 2048 | Sharp shadows without the 8MB VRAM cost of 4096. |
| Shadow map (reduced) | 1024 | Acceptable softness, 1/4 the VRAM of 2048. |

## Variants

### 1. Benchmark-free fast init
Skip the benchmark for instant tier assignment. Set `skipBenchmark: true`. Classification uses GPU string + hardware signals only. Less accurate but zero init delay. Best for sites where perceived load speed matters more than optimal tier placement.

### 2. User-controlled quality toggle
Expose a UI control that calls `forceTier()`. Let users override the automatic classification. Common in games, rare on marketing sites, but good practice for complex configurators where the user knows their hardware better than your heuristics.

### 3. Server-side hint via User-Agent Client Hints
Request `Sec-CH-UA-Model` and `Sec-CH-Device-Memory` via the `Accept-CH` response header. Use the model string to pre-classify before any JS runs, embedding the initial tier as a data attribute on the container. Client-side probe then confirms or overrides.

### 4. Progressive enhancement (start minimal, promote)
Invert the default: start at minimal tier, render the scene, then run the benchmark in the background. If the benchmark passes, promote to reduced or full. Guarantees fast first paint at the cost of a visible quality pop-in.

### 5. WebGPU upgrade path
Check for `navigator.gpu` before falling back to WebGL. If WebGPU is available, skip the WebGL benchmark entirely and assign `full` tier. WebGPU devices are universally modern enough for any scene complexity this system gates.

## Performance budget
| Metric | Target |
|---|---|
| Capability probe time | < 50ms (no benchmark) / < 2500ms (with benchmark) |
| Tier assignment accuracy | Correct for 90%+ of real devices (validated against BrowserStack device farm) |
| FPS monitor overhead | < 0.1ms per frame (one performance.now() call + comparison) |
| Memory overhead | < 50KB for the tier management system itself |
| Static fallback LCP | < 1.5s (pre-rendered image, no WebGL init at all) |

## Accessibility
- `prefers-reduced-motion: reduce` always assigns `minimal` tier. This is not a performance decision; it is a user preference. Minimal tier disables shadows and post-processing but still renders the scene. If the user's preference is truly "no motion," scene code must additionally stop the render loop and show a static frame (call `renderStaticFallback()`).
- The static fallback image must have meaningful `alt` text describing what the 3D scene shows, not "3D scene" or "WebGL content."
- Focus management: if interactive 3D elements exist (hotspots, controls), they must have ARIA labels and be keyboard-reachable. Tier demotion must not remove interactive affordances, only visual quality.
- Screen reader users get the same content via DOM overlays regardless of tier. The 3D scene is decorative from an a11y perspective unless it carries unique interactive content.

## Anti-slop rules
1. DO NOT check `navigator.userAgent` for GPU classification. User-agent strings tell you nothing about GPU capability. Use `WEBGL_debug_renderer_info` or actual benchmark results.
2. DO NOT use `window.innerWidth < 768` as a proxy for "mobile." A 768px-wide desktop browser is not a phone. Use `(pointer: coarse)`, `deviceMemory`, `hardwareConcurrency`, and the actual GPU probe.
3. DO NOT create the benchmark renderer at full page resolution. A 256x256 offscreen canvas is sufficient and does not cause visible jank.
4. DO NOT demote tier on a single bad frame. GC pauses, compositor jank, and tab-switch artifacts cause individual frame spikes on every device. Require 120+ consecutive bad frames.
5. DO NOT forget to dispose the benchmark renderer. A leaked WebGL context counts against the browser's context limit (typically 8-16 per page).
6. DO NOT swap materials without storing the original. Material demotion must be reversible for the user-controlled quality toggle to work.
7. DO NOT assume `WEBGL_debug_renderer_info` is available. Safari hides it by default. Classify as `reduced` when the renderer string is unknown, not `full`.
8. DO NOT skip the visibility change handler. A hidden tab running a render loop at full tilt drains battery and heats the device, causing thermal throttle that poisons the FPS monitor.
9. DO NOT run the benchmark during page load if there is any other heavy JS running (font loading, hydration, analytics). Defer it with `requestIdleCallback` or a 1-second setTimeout.
10. DO NOT treat `deviceMemory` as authoritative. It is Chrome-only, rounded, and can be spoofed. Use it as one signal among many, never the sole classifier.
11. DO NOT log tier changes to the console in production. The console call itself can cause frame drops on some mobile browsers.

## Integration notes
- **`three-js-fundamentals`**: This toolkit wraps any scene built with the fundamentals primitive. The scene code does not need to know about tiering; it queries `config.shadowMapEnabled`, `config.postProcessing`, etc., at init time.
- **`scroll-mobile-performance-strategy`**: That toolkit handles CSS/DOM animation tiering (ScrollTrigger count, layer budget, image strategy). This toolkit handles the WebGL/3D side. They compose well: use `scroll-mobile-performance-strategy` for the page shell and this toolkit for the embedded 3D scene.
- **`shader-postprocessing`**: Post-processing is the first thing this system strips on tier demotion. Scene code should check `config.postProcessing` before creating an EffectComposer.
- **`three-scroll-sync-camera`**: Camera sync precision matters more on reduced/minimal tiers because lower frame rates amplify scroll-sync drift. Pass the tier to the scroll sync system so it can adjust its interpolation strategy.
- **`three-configurator-product`**: Product configurators should use this system's `materialGrade` to select the appropriate PBR fidelity for the current device.
- **Known conflict**: If using React Three Fiber, R3F manages its own render loop and pixel ratio. You must integrate the tier config through R3F's `dpr` prop and `frameloop` prop rather than calling `renderer.setPixelRatio()` directly.

## Ship checklist
- [ ] WebGL2, WebGL1, and no-WebGL paths all tested in real browsers (not just Chrome DevTools device emulation).
- [ ] Benchmark runs in < 2.5 seconds on the slowest target device.
- [ ] Static fallback image is pre-rendered, compressed, and served from CDN, not generated at runtime in production.
- [ ] FPS monitor does not trigger demotion during initial scene load (defer monitor start until first 60 frames complete).
- [ ] Tier demotion is logged to analytics (which tier, when, what device) for future tuning.
- [ ] `prefers-reduced-motion` tested: scene stops animating, fallback is static, no render loop running.
- [ ] Material swap does not leak GPU memory (original materials stored, downgraded materials disposed on promotion).
- [ ] Visibility change handler tested: tab hide pauses loop, tab show resumes without FPS spike.
- [ ] No console.log calls in production build.
- [ ] Tested on at least: iPhone 12 (A14, minimal/reduced boundary), Samsung A54 (Mali-G68, reduced), Pixel 7a (Mali-G710, reduced/full boundary), MacBook Air M1 (full), and a 2019 Windows laptop with Intel UHD 620 (minimal).
- [ ] Fallback image alt text reviewed for accuracy.
- [ ] User quality toggle (if present) persists preference in localStorage.
