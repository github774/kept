---
name: three-mobile-fallback-strategy-eval
description: Use when verifying that three-mobile-fallback-strategy was actually implemented correctly. Adversarial audit of capability detection, tier assignment, runtime demotion, disposal, and static fallback.
pairs_with: three-mobile-fallback-strategy
---

# Eval: Three.js Mobile Fallback Strategy

## What this audits
The most common shipped failure is a tier system that classifies correctly at init but never actually changes the scene. The tier is assigned, the config object exists, but renderer pixel ratio, shadow maps, and materials remain at their default values because the scene code never reads the config. Second most common: the FPS monitor exists but fires on transient GC spikes, demoting to minimal on desktop hardware within 30 seconds of load.

## Evidence required
- Source files: `capability-probe.ts` (or equivalent), `tier-manager.ts`, `fps-monitor.ts`, `scene-scaler.ts`, and the main scene entry point.
- DevTools Console: no errors on load, no leaked WebGL contexts.
- DevTools Performance panel: a 10-second recording at each tier (full, reduced, minimal) showing frame times.
- DevTools Application > Canvas: verify WebGL context count does not exceed 1 after benchmark completes.
- Real device test results: at minimum one low-end Android (Samsung A-series or equivalent) and one mid-range device.
- A screenshot of the static fallback rendering (test by forcing `webglVersion = 0` in the probe).

## Automated checks

```javascript
// Static analysis: grep source for required patterns
const src = document.querySelector('script[src*="tier"]')?.src;
// Or read the bundled source

// 1. Probe disposes its test context
// PASS: source contains WEBGL_lose_context or loseContext
// FAIL: benchmark canvas creates a WebGL context that is never destroyed

// 2. DPR is capped, not set raw
// PASS: setPixelRatio(Math.min(devicePixelRatio, <number>))
// FAIL: setPixelRatio(devicePixelRatio) with no cap

// 3. Shadow toggling triggers material.needsUpdate
// PASS: after changing shadowMap.enabled, all materials get needsUpdate = true
// FAIL: shadows toggled but materials not updated (shadows silently stop working)

// 4. Visibility handler exists
// PASS: document.addEventListener('visibilitychange', ...) in source
// FAIL: no visibility handler (render loop runs in hidden tabs)

// Runtime checks (paste in DevTools console):

// 5. Verify benchmark context was cleaned up
console.assert(
  document.querySelectorAll('canvas').length <= 2,
  'FAIL: more than 2 canvas elements present (benchmark canvas leaked)'
);

// 6. Verify pixel ratio is capped
const r = document.querySelector('canvas').__r3f?.gl || window.__THREE_RENDERER__;
if (r) {
  const actualDPR = r.getPixelRatio();
  console.assert(actualDPR <= 2, `FAIL: pixel ratio ${actualDPR} exceeds cap of 2`);
}

// 7. Check that reduced-motion preference is respected
// Set in Chrome: chrome://flags/#force-prefers-reduced-motion
// Or: window.matchMedia('(prefers-reduced-motion: reduce)').matches
// PASS: tier is 'minimal' or 'static'
// FAIL: tier is 'full' or 'reduced' despite reduced-motion preference

// 8. Force a tab hide and verify render loop pauses
document.dispatchEvent(new Event('visibilitychange'));
// Monitor requestAnimationFrame calls; they should stop within 1 frame
```

## Manual inspection protocol

1. Open the page on a desktop with a discrete GPU. Open DevTools Performance tab. Record 10 seconds of normal interaction. FAIL if any single frame exceeds 20ms (the system should have assigned 'full' tier on this hardware).

2. Open DevTools, go to Console, type: `window.__TIER_MANAGER__.forceTier('minimal')` (or equivalent exposed API). Observe: shadows should disappear, materials should visibly simplify (less specular), resolution should drop. FAIL if no visible change occurs (tier config is not applied to the scene).

3. Throttle CPU 6x in DevTools Performance tab. Interact with the scene for 5+ seconds. FAIL if the FPS monitor never triggers a tier demotion (it should fire after ~2 seconds of sustained low FPS).

4. Open the page on an actual low-end Android phone (Samsung A14, Pixel 4a, or equivalent). FAIL if: the page crashes, WebGL context is lost and not recovered, or the scene renders at full tier.

5. In the source, search for `dispose`. FAIL if the static fallback path does not call `renderer.dispose()` after capturing the fallback image.

6. Simulate no WebGL: before page load, override `HTMLCanvasElement.prototype.getContext` to return null for 'webgl2' and 'webgl'. FAIL if the page shows a broken canvas or JS error instead of the static fallback.

7. Open the page, switch to another tab for 10 seconds, switch back. FAIL if the scene shows a frame rate spike (> 100ms frame) on return (the render loop should have paused cleanly and resumed without a queued-frame burst).

8. Check the network tab for the fallback image. FAIL if it is > 200KB or is a PNG (should be compressed JPEG or WebP).

## Scoring rubric

| # | Criterion | Weight | 0 (Fail) | 1 (Partial) | 2 (Pass) |
|---|---|---|---|---|---|
| 1 | WebGL probe detects all three states (WebGL2, WebGL1, none) | 10 | Only checks WebGL2 | Checks both but no fallback for none | All three paths tested and working |
| 2 | GPU renderer string classification covers weak/mid/high | 10 | No string classification, only hardware signals | String list exists but misses major chipsets (Mali, Adreno) | Covers Mali, Adreno, Apple, Intel, PowerVR families |
| 3 | Benchmark runs and disposes cleanly | 8 | No benchmark or benchmark leaks context | Benchmark runs but does not dispose test renderer | Benchmark runs, disposes context, resolves in < 2.5s |
| 4 | Tier config actually changes renderer state | 15 | Config exists but renderer unchanged | Some properties applied (DPR) but not all (shadows, materials) | DPR, shadows, shadow map size, and materials all change per tier |
| 5 | FPS monitor triggers demotion correctly | 12 | No FPS monitor | Monitor exists but fires on single-frame spikes | Requires 120+ consecutive bad frames, resets counter after demotion |
| 6 | Static fallback renders correctly | 10 | No fallback, broken canvas on no-WebGL | Fallback exists but is a blank div or missing alt text | Image fallback with meaningful alt text, renderer fully disposed |
| 7 | Visibility change pauses render loop | 8 | No visibility handling | Handler exists but does not pause FPS monitor | Loop pauses, monitor stops, both resume cleanly on tab return |
| 8 | Material swap is reversible | 7 | Materials swapped but originals lost | Originals stored but not restored on promotion | forceTier('full') correctly restores original materials |
| 9 | prefers-reduced-motion respected | 10 | Ignored entirely | Checked but only reduces tier, does not stop animation | Assigns minimal, scene code checks and stops loop for truly static output |
| 10 | No leaked WebGL contexts | 10 | Multiple contexts visible in DevTools | Benchmark context created but not destroyed | Exactly 1 context after init (benchmark cleaned up) |

**Total: 100 points. Ship threshold: 75.**

## Common false passes

1. **Tier is assigned but never queried.** The TierManager returns `'reduced'` but the scene code hard-codes `renderer.setPixelRatio(2)` and enables shadows unconditionally. The tier system "works" (classifies correctly) but has zero effect on the rendered output.

2. **Benchmark measures the wrong thing.** The benchmark renders 10 untextured triangles instead of a realistic workload. Every device scores 60fps, so every device gets `full` tier. The benchmark exists and runs, but it has no discriminating power.

3. **FPS monitor demotes on page load.** During initial asset loading (GLTF decode, texture upload), frame times spike to 50ms+. The FPS monitor fires immediately and demotes to minimal before the scene has even finished loading. Should defer monitor start until after first meaningful render.

4. **Material swap leaks memory.** On demotion, a new `MeshLambertMaterial` is created for each mesh, but the old `MeshStandardMaterial` is not disposed. On promotion back to full, the Lambert materials are abandoned without disposal. Memory climbs with each tier toggle.

5. **Static fallback uses `toDataURL()` on a WebGL canvas without `preserveDrawingBuffer`.** The canvas returns a transparent image because the draw buffer was already cleared. The fallback renders as a blank rectangle. Fix: render one frame, call `toDataURL()` immediately in the same synchronous block, or set `preserveDrawingBuffer: true` on the renderer for the snapshot frame only.

6. **Reduced-motion is checked at init but not watched.** The user enables reduced-motion after the page loads. The tier stays at `full` because the media query was only read once. Should use `matchMedia.addEventListener('change', ...)`.

7. **Benchmark canvas is appended to the DOM.** The 256x256 benchmark canvas is visible on the page for 2 seconds during the benchmark, then removed. It should never be appended to the DOM at all.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| Tier assigned but scene unchanged | Scene code does not read tier config | Pass config to scene init; gate every feature behind `config.shadowMapEnabled`, `config.postProcessing`, etc. |
| FPS monitor fires on load | Monitor starts before scene is ready | Defer `monitor.start()` until 60 frames after first `renderer.render()` call |
| Material swap leaks GPU memory | Old materials not disposed, new materials not tracked | Store originals in userData; on swap, dispose the replaced material; on restore, dispose the downgraded material |
| Static fallback is blank | `toDataURL` called after buffer clear | Call `renderer.render()` then `toDataURL()` synchronously, or use `preserveDrawingBuffer: true` for the capture frame |
| Benchmark leaks context | `WEBGL_lose_context` not called | Call `loseContext()` on the benchmark GL context after measurement |
| Tab return causes frame spike | Queued rAF callbacks fire in burst | Check `document.hidden` at the top of the render loop; skip render if hidden |
| Tier toggle does not restore quality | Original materials garbage collected | Hold a strong reference to originals in `mesh.userData.__originalMaterial` |

## Verdict format
```
TIER STRATEGY AUDIT
-------------------
Date: YYYY-MM-DD
Auditor: [name]

Per-criterion scores:
| # | Criterion                          | Score |
|---|------------------------------------|-------|
| 1 | WebGL probe (3 states)             | 0/1/2 |
| 2 | GPU string classification          | 0/1/2 |
| 3 | Benchmark + disposal               | 0/1/2 |
| 4 | Tier config applies to renderer    | 0/1/2 |
| 5 | FPS monitor demotion               | 0/1/2 |
| 6 | Static fallback                    | 0/1/2 |
| 7 | Visibility change handling         | 0/1/2 |
| 8 | Material swap reversibility        | 0/1/2 |
| 9 | prefers-reduced-motion             | 0/1/2 |
|10 | No leaked WebGL contexts           | 0/1/2 |

Weighted total: __/100
Ship threshold: 75

Blocking issues:
- [list any criterion scoring 0]

Verdict: SHIP / NO SHIP
```
