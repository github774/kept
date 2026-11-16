---
name: three-postprocessing-stack
description: Use when building a managed postprocessing pipeline for a Three.js scene with a frame budget, effect ordering, tier-based quality scaling, and real disposal. Builds a complete EffectComposer stack, not a one-off bloom demo.
category: three
pairs_with: three-postprocessing-stack-eval
---

# Three.js Postprocessing Stack

## What this builds
A production postprocessing pipeline that manages effect ordering, per-frame cost accounting, device-tier quality scaling, and full disposal on teardown. The finished system lets you declare a set of effects, assign them a frame-time budget in milliseconds, and have the stack automatically downgrade or disable effects when the budget is exceeded.

- Ordered, merged EffectComposer driven by the `postprocessing` library (Vanruesc), not Three's own example passes
- Per-effect cost measurement via GPU timer queries or fallback JS timing
- Tiered quality presets (high / medium / low / off) with automatic demotion when frame time exceeds threshold
- Full resize handling that propagates to every render target
- Complete disposal of render targets, effects, and the composer itself on unmount or route change
- R3F declarative variant alongside vanilla Three.js

## When to use / when not to
- Use when your scene needs two or more full-screen effects chained together with a real performance contract.
- Use when you need dynamic quality scaling: the stack should degrade gracefully on weaker GPUs without manual intervention.
- Do NOT use for a single bloom on one emissive element. That is a one-liner covered by `shader-postprocessing`.
- Do NOT use for stylized full-screen shaders that have nothing to do with the scene render (color grading overlays, film burns). Those are fragment-shader overlays; see `glsl-fragment-backgrounds`.
- If you are working in R3F and just need a quick Bloom + Vignette with no budget management, `shader-postprocessing` covers it faster.

## Stack decision
| Dependency | Version | Why |
|---|---|---|
| `three` | 0.169.0 | Scene renderer |
| `postprocessing` | 6.36.4 | Merges compatible effects into single-shader passes via EffectPass, cutting full-screen draws vs Three's own per-pass EffectComposer. Actively maintained, correct tone-mapping integration. |
| `@react-three/postprocessing` | 2.16.3 | R3F declarative wrapper (R3F path only) |

**Cheaper alternative:** Three's own `examples/jsm/postprocessing/EffectComposer` + individual `*Pass` classes. Simpler to import, but every pass is a separate full-screen draw (no merging), so a 4-effect chain costs 4x the fragment work instead of 1-2x.

## Architecture

```
PostStack
  |- EffectComposer (owns render targets, drives the pass chain)
  |    |- RenderPass (scene + camera, always first)
  |    |- EffectPass (merged: bloom + vignette + grain)
  |    |- EffectPass (DOF, cannot merge: needs depth input)
  |    |- EffectPass (CA + custom grade, merged)
  |
  |- BudgetMonitor
  |    |- reads GPU timer or JS frame-time delta
  |    |- compares against budget threshold (default 4ms for postprocessing share)
  |    |- downgrades tier after N consecutive over-budget frames
  |    |- upgrades tier after M consecutive under-budget frames
  |
  |- TierManager
  |    |- HIGH:   all effects, full resolution
  |    |- MEDIUM: bloom + vignette only, 0.75x resolution
  |    |- LOW:    vignette only, 0.5x resolution
  |    |- OFF:    bypass composer, render direct
  |
  |- ResizeHandler
  |    |- listens to ResizeObserver on canvas container
  |    |- calls composer.setSize + renderer.setSize + camera update
  |
  |- Disposer
       |- disposes every Effect, every Pass, render targets
       |- nulls references to prevent leaks
```

Lifecycle: construct -> configure effects -> start render loop (composer.render replaces renderer.render) -> resize events propagate -> budget monitor adjusts tier -> teardown calls dispose.

## Build it: step by step

### Phase 1: Install and import

```bash
npm install three@0.169.0 postprocessing@6.36.4
```

```js
import * as THREE from 'three'
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  VignetteEffect,
  NoiseEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  ToneMappingEffect,
  SMAAEffect,
  BlendFunction,
  ToneMappingMode,
  KernelSize,
  SMAAPreset,
} from 'postprocessing'
```

### Phase 2: Build the core PostStack class

```js
const TIER = { HIGH: 0, MEDIUM: 1, LOW: 2, OFF: 3 }

class PostStack {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.budget = opts.budgetMs ?? 4       // ms allocated to postprocessing
    this.overFrames = opts.overFrames ?? 8  // consecutive over-budget frames before demotion
    this.underFrames = opts.underFrames ?? 60
    this.tier = opts.initialTier ?? TIER.HIGH
    this.overCount = 0
    this.underCount = 0
    this.composer = null
    this.effects = {}
    this.disposed = false
  }
}
```

### Phase 3: Create and order effects

Effects are created once and stored by name. Order matters: bloom must come before vignette so bloom operates on the un-vignetted image. DOF must be in its own EffectPass because it needs the depth buffer as an additional input and cannot merge with effects that do not.

```js
PostStack.prototype.init = function () {
  const composer = new EffectComposer(this.renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  })

  // Pass 1: render the scene
  composer.addPass(new RenderPass(this.scene, this.camera))

  // Create effects
  this.effects.bloom = new BloomEffect({
    intensity: 0.9,
    luminanceThreshold: 0.75,
    luminanceSmoothing: 0.25,
    mipmapBlur: true,
    kernelSize: KernelSize.MEDIUM,
  })

  this.effects.vignette = new VignetteEffect({
    darkness: 0.55,
    offset: 0.3,
  })

  this.effects.grain = new NoiseEffect({
    premultiply: true,
    blendFunction: BlendFunction.SOFT_LIGHT,
  })
  this.effects.grain.blendMode.opacity.value = 0.05

  this.effects.ca = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(0.0006, 0.0006),
    radialModulation: true,
    modulationOffset: 0.4,
  })

  this.effects.dof = new DepthOfFieldEffect(this.camera, {
    focusDistance: 0.02,
    focalLength: 0.05,
    bokehScale: 3.0,
  })

  this.effects.toneMapping = new ToneMappingEffect({
    mode: ToneMappingMode.ACES_FILMIC,
  })

  this.effects.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM })

  // Pass 2: merged bloom + vignette + grain + tone mapping + SMAA
  this.mergedPass = new EffectPass(
    this.camera,
    this.effects.bloom,
    this.effects.vignette,
    this.effects.grain,
    this.effects.toneMapping,
    this.effects.smaa,
  )
  composer.addPass(this.mergedPass)

  // Pass 3: DOF (separate, needs depth)
  this.dofPass = new EffectPass(this.camera, this.effects.dof)
  this.dofPass.enabled = this.tier === TIER.HIGH
  composer.addPass(this.dofPass)

  // Pass 4: CA (can merge with custom effects if you add any)
  this.caPass = new EffectPass(this.camera, this.effects.ca)
  this.caPass.enabled = this.tier <= TIER.MEDIUM
  composer.addPass(this.caPass)

  this.composer = composer
  this.applyTier(this.tier)
}
```

### Phase 4: Tier management

Each tier enables/disables passes and adjusts the composer's render scale. Never reconstruct the composer; just toggle `.enabled` on passes and adjust the output render target resolution.

```js
PostStack.prototype.applyTier = function (tier) {
  this.tier = tier

  if (tier === TIER.OFF) {
    // bypass composer entirely; caller should use renderer.render directly
    return
  }

  // Resolution scale per tier
  const scaleMap = { [TIER.HIGH]: 1, [TIER.MEDIUM]: 0.75, [TIER.LOW]: 0.5 }
  const scale = scaleMap[tier] ?? 1
  const w = Math.floor(this.renderer.domElement.clientWidth * scale)
  const h = Math.floor(this.renderer.domElement.clientHeight * scale)
  const dpr = Math.min(window.devicePixelRatio, 2)
  this.composer.setSize(w * dpr, h * dpr, false)

  // HIGH: all passes
  // MEDIUM: bloom + vignette + grain + tone + smaa + CA, no DOF
  // LOW: vignette + tone + smaa only
  this.dofPass.enabled = tier === TIER.HIGH
  this.caPass.enabled = tier <= TIER.MEDIUM

  if (tier === TIER.LOW) {
    this.effects.bloom.blendMode.opacity.value = 0
    this.effects.grain.blendMode.opacity.value = 0
  } else {
    this.effects.bloom.blendMode.opacity.value = 1
    this.effects.grain.blendMode.opacity.value = 0.05
  }
}
```

### Phase 5: Budget monitor

Measure the cost of `composer.render()` each frame. GPU timer queries (EXT_disjoint_timer_query_webgl2) are preferred but not universally available; fall back to `performance.now()` around the render call.

```js
PostStack.prototype.createBudgetMonitor = function () {
  const gl = this.renderer.getContext()
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  this.gpuTimerAvailable = !!ext
  this.pendingQuery = null
  this.ext = ext
}

PostStack.prototype.beginMeasure = function () {
  if (this.gpuTimerAvailable && !this.pendingQuery) {
    const query = this.renderer.getContext().createQuery()
    this.renderer.getContext().beginQuery(this.ext.TIME_ELAPSED_EXT, query)
    this.pendingQuery = query
    return
  }
  this._jsStart = performance.now()
}

PostStack.prototype.endMeasure = function () {
  const gl = this.renderer.getContext()
  if (this.gpuTimerAvailable && this.pendingQuery) {
    gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    // Results are available next frame at earliest
    const q = this.pendingQuery
    this.pendingQuery = null
    // Check previous query result
    if (this._lastQuery) {
      const available = gl.getQueryParameter(this._lastQuery, gl.QUERY_RESULT_AVAILABLE)
      if (available) {
        const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT)
        if (!disjoint) {
          const ns = gl.getQueryParameter(this._lastQuery, gl.QUERY_RESULT)
          this.updateBudget(ns / 1e6) // nanoseconds to ms
        }
        gl.deleteQuery(this._lastQuery)
      }
    }
    this._lastQuery = q
    return
  }
  this.updateBudget(performance.now() - this._jsStart)
}

PostStack.prototype.updateBudget = function (ms) {
  if (ms > this.budget) {
    this.underCount = 0
    this.overCount++
    if (this.overCount >= this.overFrames && this.tier < TIER.OFF) {
      this.applyTier(this.tier + 1)
      this.overCount = 0
    }
  } else {
    this.overCount = 0
    this.underCount++
    if (this.underCount >= this.underFrames && this.tier > TIER.HIGH) {
      this.applyTier(this.tier - 1)
      this.underCount = 0
    }
  }
}
```

### Phase 6: Render integration

Replace `renderer.render(scene, camera)` with `postStack.render(delta)`.

```js
PostStack.prototype.render = function (delta) {
  if (this.disposed) return
  if (this.tier === TIER.OFF) {
    this.renderer.render(this.scene, this.camera)
    return
  }
  this.beginMeasure()
  this.composer.render(delta)
  this.endMeasure()
}
```

### Phase 7: Resize handling

Listen to a ResizeObserver on the canvas container. Propagate to renderer, composer, and camera.

```js
PostStack.prototype.attachResize = function (container) {
  this._resizeObserver = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    if (width === 0 || height === 0) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    this.renderer.setSize(width, height, false)
    this.renderer.setPixelRatio(dpr)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    // Re-apply tier to recompute scaled size
    this.applyTier(this.tier)
  })
  this._resizeObserver.observe(container)
}
```

### Phase 8: Disposal

Every render target, effect, and pass must be disposed. The `postprocessing` library's EffectComposer and EffectPass implement `.dispose()` that recursively clean up render targets.

```js
PostStack.prototype.dispose = function () {
  if (this.disposed) return
  this.disposed = true

  this._resizeObserver?.disconnect()
  this._resizeObserver = null

  // Delete any pending GPU query
  if (this._lastQuery) {
    this.renderer.getContext().deleteQuery(this._lastQuery)
    this._lastQuery = null
  }
  if (this.pendingQuery) {
    this.renderer.getContext().deleteQuery(this.pendingQuery)
    this.pendingQuery = null
  }

  // Dispose all effects
  Object.values(this.effects).forEach((effect) => effect.dispose())
  this.effects = {}

  // Dispose composer (disposes all passes and their render targets)
  this.composer?.dispose()
  this.composer = null
}
```

### Phase 9: Complete wiring example

```js
// Scene setup (abbreviated; see three-js-fundamentals for full boilerplate)
const canvas = document.querySelector('#canvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
renderer.outputColorSpace = THREE.SRGBColorSpace
// Do NOT set toneMapping on the renderer when using postprocessing's ToneMappingEffect;
// it would double-apply. Let the effect handle it.
renderer.toneMapping = THREE.NoToneMapping

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
camera.position.set(0, 1.5, 5)

// ... add meshes, lights, etc.

const stack = new PostStack(renderer, scene, camera, {
  budgetMs: 4,
  initialTier: TIER.HIGH,
})
stack.init()
stack.createBudgetMonitor()
stack.attachResize(canvas.parentElement)

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta()
  // Update scene animations here
  stack.render(delta)
})

// On teardown (route change, unmount):
// stack.dispose()
// renderer.dispose()
```

### Phase 10: R3F declarative variant

For React Three Fiber, wrap the same logic in a component that uses `useFrame` and manages disposal via `useEffect` cleanup.

```jsx
import { useRef, useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  EffectComposer,
  Bloom,
  Vignette,
  Noise,
  ChromaticAberration,
  DepthOfField,
  ToneMapping,
} from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'

function AdaptivePostStack({ budgetMs = 4 }) {
  const { gl } = useThree()
  const tier = useRef('high')
  const overCount = useRef(0)

  useFrame(() => {
    // Simplified JS-side budget check
    // @react-three/postprocessing handles compose internally;
    // measure total frame time and compare
    const info = gl.info.render
    // In practice, wrap the parent Canvas's onCreated to grab the composer ref
    // and measure render time. See reference.md for the full pattern.
  })

  // Tier-based conditional rendering
  const isHigh = tier.current === 'high'
  const isMedium = tier.current === 'medium' || isHigh

  return (
    <EffectComposer multisampling={0}>
      {isMedium && (
        <Bloom
          intensity={0.9}
          luminanceThreshold={0.75}
          luminanceSmoothing={0.25}
          mipmapBlur
        />
      )}
      <Vignette darkness={0.55} offset={0.3} />
      {isMedium && (
        <Noise
          premultiply
          blendFunction={BlendFunction.SOFT_LIGHT}
          opacity={0.05}
        />
      )}
      {isHigh && (
        <DepthOfField
          focusDistance={0.02}
          focalLength={0.05}
          bokehScale={3}
        />
      )}
      {isMedium && (
        <ChromaticAberration
          offset={[0.0006, 0.0006]}
          radialModulation
          modulationOffset={0.4}
        />
      )}
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  )
}
```

## The full reference implementation

```js
import * as THREE from 'three'
import {
  EffectComposer, RenderPass, EffectPass,
  BloomEffect, VignetteEffect, NoiseEffect,
  ChromaticAberrationEffect, DepthOfFieldEffect,
  ToneMappingEffect, SMAAEffect,
  BlendFunction, ToneMappingMode, KernelSize, SMAAPreset,
} from 'postprocessing'

const TIER = { HIGH: 0, MEDIUM: 1, LOW: 2, OFF: 3 }

class PostStack {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.budget = opts.budgetMs ?? 4
    this.overFrames = opts.overFrames ?? 8
    this.underFrames = opts.underFrames ?? 60
    this.tier = opts.initialTier ?? TIER.HIGH
    this.overCount = 0
    this.underCount = 0
    this.composer = null
    this.effects = {}
    this.disposed = false
    this._jsStart = 0
    this._lastQuery = null
    this.pendingQuery = null
    this.gpuTimerAvailable = false
    this.ext = null
    this._resizeObserver = null
  }

  init() {
    this.renderer.toneMapping = THREE.NoToneMapping
    const composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    })
    composer.addPass(new RenderPass(this.scene, this.camera))

    const e = this.effects
    e.bloom = new BloomEffect({
      intensity: 0.9, luminanceThreshold: 0.75,
      luminanceSmoothing: 0.25, mipmapBlur: true,
      kernelSize: KernelSize.MEDIUM,
    })
    e.vignette = new VignetteEffect({ darkness: 0.55, offset: 0.3 })
    e.grain = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SOFT_LIGHT })
    e.grain.blendMode.opacity.value = 0.05
    e.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0006, 0.0006),
      radialModulation: true, modulationOffset: 0.4,
    })
    e.dof = new DepthOfFieldEffect(this.camera, {
      focusDistance: 0.02, focalLength: 0.05, bokehScale: 3.0,
    })
    e.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    e.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM })

    this.mergedPass = new EffectPass(this.camera, e.bloom, e.vignette, e.grain, e.toneMapping, e.smaa)
    this.dofPass = new EffectPass(this.camera, e.dof)
    this.caPass = new EffectPass(this.camera, e.ca)

    composer.addPass(this.mergedPass)
    composer.addPass(this.dofPass)
    composer.addPass(this.caPass)

    this.composer = composer
    this.applyTier(this.tier)
  }

  applyTier(tier) {
    this.tier = tier
    if (tier === TIER.OFF) return
    const scale = [1, 0.75, 0.5][tier] ?? 1
    const el = this.renderer.domElement
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = Math.floor(el.clientWidth * scale * dpr)
    const h = Math.floor(el.clientHeight * scale * dpr)
    if (w > 0 && h > 0) this.composer.setSize(w, h, false)
    this.dofPass.enabled = tier === TIER.HIGH
    this.caPass.enabled = tier <= TIER.MEDIUM
    this.effects.bloom.blendMode.opacity.value = tier <= TIER.MEDIUM ? 1 : 0
    this.effects.grain.blendMode.opacity.value = tier <= TIER.MEDIUM ? 0.05 : 0
  }

  createBudgetMonitor() {
    const gl = this.renderer.getContext()
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.gpuTimerAvailable = !!this.ext
  }

  beginMeasure() {
    if (this.gpuTimerAvailable && !this.pendingQuery) {
      const gl = this.renderer.getContext()
      const q = gl.createQuery()
      gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
      this.pendingQuery = q
      return
    }
    this._jsStart = performance.now()
  }

  endMeasure() {
    const gl = this.renderer.getContext()
    if (this.gpuTimerAvailable && this.pendingQuery) {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      const q = this.pendingQuery
      this.pendingQuery = null
      if (this._lastQuery) {
        if (gl.getQueryParameter(this._lastQuery, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
            this._budgetUpdate(gl.getQueryParameter(this._lastQuery, gl.QUERY_RESULT) / 1e6)
          }
          gl.deleteQuery(this._lastQuery)
        }
      }
      this._lastQuery = q
      return
    }
    this._budgetUpdate(performance.now() - this._jsStart)
  }

  _budgetUpdate(ms) {
    if (ms > this.budget) {
      this.underCount = 0
      if (++this.overCount >= this.overFrames && this.tier < TIER.OFF) {
        this.applyTier(this.tier + 1)
        this.overCount = 0
      }
    } else {
      this.overCount = 0
      if (++this.underCount >= this.underFrames && this.tier > TIER.HIGH) {
        this.applyTier(this.tier - 1)
        this.underCount = 0
      }
    }
  }

  render(delta) {
    if (this.disposed) return
    if (this.tier === TIER.OFF) {
      this.renderer.render(this.scene, this.camera)
      return
    }
    this.beginMeasure()
    this.composer.render(delta)
    this.endMeasure()
  }

  attachResize(container) {
    this._resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width === 0 || height === 0) return
      const dpr = Math.min(window.devicePixelRatio, 2)
      this.renderer.setSize(width, height, false)
      this.renderer.setPixelRatio(dpr)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
      this.applyTier(this.tier)
    })
    this._resizeObserver.observe(container)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this._resizeObserver?.disconnect()
    this._resizeObserver = null
    const gl = this.renderer.getContext()
    if (this._lastQuery) { gl.deleteQuery(this._lastQuery); this._lastQuery = null }
    if (this.pendingQuery) { gl.deleteQuery(this.pendingQuery); this.pendingQuery = null }
    Object.values(this.effects).forEach((e) => e.dispose())
    this.effects = {}
    this.composer?.dispose()
    this.composer = null
  }
}
```

## Tuning the feel

| Parameter | Value | Why |
|---|---|---|
| Bloom intensity | 0.9 | Visible but not blown out. Above 1.2 reads as a game engine default. |
| Bloom luminance threshold | 0.75 | Only genuinely bright surfaces glow. 0.5 makes the whole scene hazy. |
| Bloom kernel size | MEDIUM (KernelSize.MEDIUM = 2) | Balances glow radius vs mip blur cost. LARGE adds one more mip level. |
| Vignette darkness | 0.55 | Draws the eye to center without obviously darkening corners. 0.8+ is film noir territory. |
| Grain opacity | 0.05 | Barely perceptible texture. 0.1+ creates a visible film effect that distracts from content. |
| CA offset | 0.0006 | Fringing visible at edges, invisible at center. 0.002+ is a glitch effect, not a lens. |
| DOF bokeh scale | 3.0 | Noticeable out-of-focus blur without smearing geometry. 6+ looks like a tilt-shift miniature. |
| Budget threshold | 4ms | Postprocessing gets ~25% of the 16.67ms frame. Scene rendering and JS get the rest. |
| Over-budget demotion count | 8 frames | Avoids single-frame spikes causing unnecessary tier drops. |
| Under-budget promotion count | 60 frames | Requires a full second of headroom before upgrading back. |
| Resolution scale (MEDIUM) | 0.75x | 44% fewer fragments than full. Mip blur on bloom hides the softness. |
| Resolution scale (LOW) | 0.5x | 75% fewer fragments. Only vignette, which is a gradient, survives clearly. |

## Variants

### 1. Cinematic film grade
Replace NoiseEffect with a custom FilmGrainEffect using a blue-noise texture for non-repeating grain. Add a DepthOfFieldEffect with a narrow focal length (0.02) for a shallow-focus look. Drive CA offset from scroll velocity for a lens-in-motion feel.

### 2. Neon / cyberpunk
Set bloom threshold to 0.5 and intensity to 1.8. Use emissive materials with HDR values (color components > 1.0) on neon elements. Add a custom scanline effect as a merged EffectPass alongside bloom. Skip vignette; the bloom halo is the framing device.

### 3. Clean product studio
Bloom threshold at 0.9 (only specular highlights bloom). No grain, no CA. Vignette very subtle (0.3 darkness). Tone mapping set to LINEAR for accurate product color. Focus on SMAA quality (ULTRA preset) over stylistic effects.

### 4. Horror / glitch
High CA offset (0.003) with animated jitter via `effect.offset.set(x, y)` every few frames. Grain at 0.12 with OVERLAY blend. Add a custom RGBShiftEffect or use ChromaticAberration with random spikes. Vignette darkness at 0.85.

### 5. Underwater / dreamy
DOF with a very short focal length (0.01) and high bokeh scale (6.0). Add a custom color tint pass shifting everything toward blue-green. Bloom at 1.0 with threshold 0.6 for pervasive soft glow. Grain at 0.08 for organic texture.

## Performance budget

| Metric | Target | Lever |
|---|---|---|
| Postprocessing frame time | < 4ms | Drop DOF first (saves 1-2ms), then CA, then bloom |
| Total render targets alive | < 6 | The composer's internal ping-pong + bloom mips. Check via renderer.info.memory.textures |
| Texture memory (postprocessing) | < 32MB at 1080p | Halve resolution scale or drop HalfFloat to UnsignedByte |
| Total frame time | < 16.67ms (60fps) | Scene + postprocessing combined |
| Bundle size (postprocessing lib) | ~45KB gzipped | Tree-shakeable; only imported effects are bundled |

**What to cut first (in order):**
1. DOF (heaviest single effect, large-kernel blur per pixel)
2. CA with radial modulation (fragment cost scales with modulation samples)
3. Bloom kernel size (drop from LARGE to SMALL)
4. Resolution scale (0.75x saves 44% fill, 0.5x saves 75%)
5. SMAA preset (drop from ULTRA to LOW, or remove entirely at DPR >= 2 where it is less needed)

## Accessibility

### prefers-reduced-motion
```js
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
function applyMotionPref() {
  if (motionQuery.matches) {
    // Disable all animated effects (grain flicker, CA jitter)
    // Keep static effects (vignette, tone mapping) that do not change per frame
    stack.effects.grain.blendMode.opacity.value = 0
    stack.effects.ca.offset.set(0, 0)
    // If DOF focus is animated, freeze it at the default distance
  }
}
motionQuery.addEventListener('change', applyMotionPref)
applyMotionPref()
```

### Focus management
Postprocessing is purely visual. It does not affect DOM focus, keyboard navigation, or screen reader output. No additional focus management is required, but the canvas element should have `role="img"` and an `aria-label` describing the scene content when the 3D scene is decorative.

### Honest cost
Postprocessing makes visually impaired users' experience neither better nor worse (it is a pixel-level effect on an already-rendered image). Users with photosensitive conditions may be affected by rapid brightness changes from animated bloom or grain; freeze animated effect parameters under reduced-motion.

## Anti-slop rules
1. DO NOT set `renderer.toneMapping` to anything other than `NoToneMapping` when using the postprocessing library's `ToneMappingEffect`. Double tone mapping washes out highlights and compresses dynamic range.
2. DO NOT use Three.js's own `examples/jsm/postprocessing/EffectComposer` alongside the `postprocessing` npm package. They are separate implementations with incompatible pass interfaces.
3. DO NOT add bloom without setting at least one material's emissive or color to HDR values (components > 1.0). Bloom with a threshold of 0.75 on a scene where nothing exceeds 1.0 produces zero visible effect and wastes the entire pass cost.
4. DO NOT create multiple EffectComposer instances for the same renderer. One composer per renderer; use multiple passes within it.
5. DO NOT forget to call `composer.setSize()` on resize. The render targets will stay at the old resolution, producing a stretched or blurry result.
6. DO NOT put effects that need depth (DOF, SSAO) into the same EffectPass as effects that do not. The depth-requiring effect forces the entire merged pass to sample the depth buffer, and the merging may fail silently.
7. DO NOT use MSAA (multisampling > 0) on the EffectComposer when bloom is active. Bloom operates on downsampled mips; MSAA on the intermediate targets wastes memory and does not improve the bloom quality.
8. DO NOT animate effect parameters at 60fps without clamping. CA offset oscillating without a clamp produces nausea-inducing flicker. Grain opacity above 0.15 is distracting. Keep animated ranges tight.
9. DO NOT skip disposal. Every EffectComposer holds GPU-side render targets that survive garbage collection. A route change without `.dispose()` leaks 10-50MB of VRAM per composer instance.
10. DO NOT default to full-resolution postprocessing on mobile. DPR 3 devices process 9x the fragments of DPR 1. Clamp DPR to 2 at the renderer level AND consider 0.75x or 0.5x render scale for the composer.

## Integration notes

- **`three-js-fundamentals`**: Provides the scene/renderer/camera setup this stack plugs into. This toolkit assumes that boilerplate exists and does not repeat it.
- **`shader-postprocessing`**: Covers the theory and individual-effect recipes. This toolkit builds the managed pipeline layer on top of those same effects. Do not duplicate effect explanations; reference `shader-postprocessing` for per-effect deep dives.
- **`react-three-fiber-drei`**: R3F scene setup. The R3F variant of this stack uses `@react-three/postprocessing` which wraps the same `postprocessing` library.
- **`three-camera-rig-cinematography`**: Camera rigs that animate position/target. DOF focus distance should track the camera rig's focal target, not remain static.
- **Known conflict**: If the scene already uses `renderer.toneMapping = ACESFilmicToneMapping` (common in Three.js tutorials), adding `ToneMappingEffect` double-applies it. Set `renderer.toneMapping = NoToneMapping` before initializing the stack.
- **Known conflict**: SMAA and renderer-level MSAA (`antialias: true` on WebGLRenderer) both attempt anti-aliasing. Using both wastes resources. Choose one: SMAA via postprocessing (preferred, since you are already paying the composer cost) or renderer MSAA (set `antialias: true` and skip SMAAEffect). Set `antialias: false` when using this stack.

## Ship checklist
- [ ] `renderer.toneMapping` set to `NoToneMapping`; tone mapping handled by `ToneMappingEffect`
- [ ] `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` applied
- [ ] `composer.setSize()` called in resize handler
- [ ] At least one emissive/HDR material in scene if bloom is enabled
- [ ] DOF focus distance tuned to the scene's primary focal point
- [ ] Budget monitor active and tier demotion tested (throttle CPU in DevTools, confirm tier drops)
- [ ] Tier OFF path tested: scene renders correctly without composer
- [ ] `dispose()` called on route change / unmount; no VRAM leaks confirmed via `renderer.info.memory`
- [ ] `prefers-reduced-motion` freezes animated effect parameters
- [ ] Canvas has `role="img"` and `aria-label` if the 3D scene is decorative
- [ ] Frame time under 16.67ms on target low-end device with all effects at their assigned tier
- [ ] Grain/CA values tested on a real screen, not just a Retina display (low-DPR screens amplify subtle effects)
- [ ] No visible banding in vignette gradient (increase bit depth via HalfFloatType if banding appears)
