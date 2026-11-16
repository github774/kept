---
name: three-particle-gpgpu-eval
description: Use when verifying that a GPGPU particle simulation with FBO ping-pong was actually implemented correctly. Adversarial audit, not a summary.
pairs_with: three-particle-gpgpu
---

# Eval: GPGPU Particle Simulation

## What this audits
The most commonly shipped failure: GPUComputationRenderer is set up and particles appear, but the simulation has no damping (particles accelerate to infinity and disappear), delta time is uncapped (simulation explodes on tab re-focus), render targets are never disposed (VRAM leak), or the particle render shader does not actually sample the GPU-computed position texture (particles sit at origin or follow a static pattern).

## Evidence required
- Source files for GPGPU setup, simulation shaders, and render material
- A running instance with DevTools open
- `renderer.info` output before and after 30 seconds of runtime
- Performance recording showing frame times during continuous simulation
- Tab background/foreground test (switch to another tab for 5+ seconds, return)
- DevTools Memory snapshot to check for render target leaks

## Automated checks
```js
// 1. Check that GPUComputationRenderer exists
console.assert(
  typeof GPUComputationRenderer !== 'undefined' || document.querySelector('canvas'),
  'FAIL: No GPGPU infrastructure found'
);

// 2. Check renderer.info for render target count
const r = window.__renderer || renderer;
console.log('Render targets:', r.info.memory.textures);
// PASS: should be stable over time (ping-pong reuses targets)
// FAIL: count growing = leak

// 3. Check frame time
let lastTime = performance.now();
let maxFrame = 0;
function checkFrames() {
  const now = performance.now();
  maxFrame = Math.max(maxFrame, now - lastTime);
  lastTime = now;
  requestAnimationFrame(checkFrames);
}
requestAnimationFrame(checkFrames);
setTimeout(() => {
  console.log('Max frame time (5s sample):', maxFrame.toFixed(1), 'ms');
  console.assert(maxFrame < 33, 'FAIL: Frame time exceeded 33ms (below 30fps)');
}, 5000);
```

```bash
# Static source checks

# Check for delta cap
grep -n "Math.min.*getDelta\|delta.*0.05\|clamp.*delta" src/**/*.{js,ts} || echo "FAIL: No delta time cap found"

# Check for damping
grep -n "0\.9[5-9]\|damping\|vel.*\*=" src/**/*.{glsl,js,ts} || echo "FAIL: No velocity damping found"

# Check for disposal
grep -n "gpuCompute.*dispose\|dispose()" src/**/*.{js,ts} | head -10 || echo "FAIL: No disposal found"

# Check that position texture feeds render material
grep -n "getCurrentRenderTarget\|uPositionTexture" src/**/*.{js,ts} || echo "FAIL: Position texture not connected to render pass"
```

## Manual inspection protocol
1. Watch particles for 10 seconds. FAIL if particles steadily accelerate and leave the viewport (missing damping or attractor).
2. Switch to another browser tab for 10 seconds. Return. FAIL if particles have teleported to extreme positions or the scene is empty (uncapped delta time).
3. Open DevTools Memory tab. Take a heap snapshot. Wait 30 seconds. Take another. FAIL if "WebGLTexture" count has grown (render target leak).
4. Move the mouse/pointer over the canvas. FAIL if particles show zero response (mouse interaction shader uniform not connected).
5. Move the pointer off the canvas. FAIL if a phantom force continues affecting particles (mouse strength not zeroed on pointerleave).
6. Resize the window. FAIL if canvas does not resize or particles stop rendering.
7. Check `renderer.info.render.calls` in console. FAIL if calls per frame exceed 5 (should be ~3: 2 simulation passes + 1 render pass).

## Scoring rubric
| # | Criterion | 0 | 1 | 2 | Weight |
|---|---|---|---|---|---|
| 1 | Simulation correctness | Particles static or exploding | Particles move but drift away or cluster at origin | Smooth, organic, bounded flow | 3 |
| 2 | Delta time handling | No cap (explodes on re-focus) | Cap exists but too high (>100ms) | Cap at 50ms or lower, simulation stable across tab switches | 3 |
| 3 | Velocity damping | No damping | Damping too aggressive (<0.9) or too weak (>0.999) | Damping 0.95-0.995, tuned to aesthetic | 2 |
| 4 | Position texture to render connection | Render shader does not sample GPGPU output | Samples but with wrong UV or stale reference | Correct sampling, particles visually move with simulation | 3 |
| 5 | Resource disposal | No cleanup | Partial (some dispose calls) | Full: gpuCompute.dispose(), geometry, material, renderer | 2 |
| 6 | Render target stability | VRAM grows over time | Stable but extra targets created | Ping-pong only, stable VRAM | 2 |
| 7 | Mouse/interaction | No interaction | Interaction works but no boundary handling | Full interaction with pointerleave cleanup | 1 |
| 8 | Particle bounds | Particles escape to infinity | Soft boundary but particles accumulate at edge | Respawn or wrap at boundary | 2 |
| 9 | Resize handling | No handler | Handler but simulation breaks | Full resize, simulation unaffected | 1 |
| 10 | Accessibility | No considerations | Canvas hidden from AT | prefers-reduced-motion pauses sim, aria-hidden on canvas | 1 |

**Total: 20 points. Ship threshold: 15+. Below 10 is a no-ship.**

## Common false passes
1. **Particles move, so the simulation "works."** But movement comes from initial velocity alone with no forces applied. The simulation shaders compile and run but produce zero net force, and particles coast on their init velocities until damping halts them.
2. **Curl noise is in the shader but produces identical flow for all particles.** If the noise sampling position does not include the particle's own position (just `uTime`), all particles get the same force vector and move as a rigid mass.
3. **Delta time capped, but simulation uses `clock.getElapsedTime()` for integration instead of delta.** Elapsed time is cumulative and does not produce correct Euler integration. Position must be updated by `velocity * delta`, not `velocity * totalTime`.
4. **`gpuCompute.dispose()` is called, but the render material's `uPositionTexture` still holds a reference to a disposed render target.** The texture reference must be nulled or the material disposed as well.
5. **Mouse interaction uniform is set once on init but never updated in the event handler.** The uniform object exists, but `mousemove` listener is missing or does not write to it.
6. **Texture width is 1024 (1M particles) on a page that will run on mobile.** The developer tested on a desktop GPU and did not check mobile, where it drops to 5fps.

## Required fixes by failure mode
| Failure | Root cause fix |
|---|---|
| Particles explode on tab re-focus | Add `Math.min(clock.getDelta(), 0.05)` delta cap |
| Particles accelerate to infinity | Add `vel.xyz *= 0.98` damping in velocity shader |
| Particles leave viewport and never return | Add boundary check with respawn or wrap in position shader |
| VRAM grows over time | Verify GPUComputationRenderer is not re-initialized per frame; call dispose on teardown |
| Particles at origin / not moving | Verify render vertex shader samples `uPositionTexture` and that uniform is set from `getCurrentRenderTarget` |
| All particles move identically | Sample curl noise at `pos.xyz * freq`, not just `uTime` |
| Simulation doubles speed on 120Hz monitors | Multiply forces by `uDelta`, not a constant |

## Verdict format
```
GPGPU Particle Simulation Audit
Score: X / 20
| Criterion | Score | Note |
|---|---|---|
...
Blocking issues: [list]
SHIP / NO SHIP
```
