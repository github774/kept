---
name: three-fluid-simulation-eval
description: Use when verifying that a real-time fluid simulation was actually implemented correctly. Adversarial audit, not a summary.
pairs_with: three-fluid-simulation
---

# Eval: Real-Time Fluid Simulation

## What this audits
The most commonly shipped failure: a "fluid simulation" that is actually just advection without a pressure solve. Without the pressure projection step, the velocity field is compressible: fluid accumulates in some regions and depletes in others, producing expanding/contracting blobs instead of the volume-preserving swirling flow of a real incompressible fluid. The second most common failure: pressure solve exists but with too few Jacobi iterations (< 10), producing grid-aligned noise artifacts.

## Evidence required
- Source code for all simulation shader programs
- A running instance with DevTools open
- Visual recording of 10+ seconds of fluid behavior
- Frame time measurement via Performance tab
- Tab background/foreground test (5+ seconds away, return)
- Pointer interaction test (drag, release, observe dissipation)

## Automated checks
```js
// 1. Count shader programs (minimum 6 for a complete solver)
// advection, divergence, pressure, gradSub, curl, vorticity, splat, display
// Check via WebGL inspector or source grep

// 2. Check for EXT_color_buffer_float
const gl = document.querySelector('canvas').getContext('webgl2');
console.assert(
  gl.getExtension('EXT_color_buffer_float'),
  'FAIL: EXT_color_buffer_float not available'
);

// 3. Frame time check
let maxFrame = 0;
let lastT = performance.now();
function checkFT() {
  const now = performance.now();
  maxFrame = Math.max(maxFrame, now - lastT);
  lastT = now;
  requestAnimationFrame(checkFT);
}
requestAnimationFrame(checkFT);
setTimeout(() => {
  console.log('Max frame time:', maxFrame.toFixed(1), 'ms');
  console.assert(maxFrame < 33, 'FAIL: Below 30fps');
}, 5000);
```

```bash
# Static source checks

# Check for pressure solve (Jacobi iteration)
grep -n "Jacobi\|jacobi\|pressure.*loop\|for.*pressure\|iterations" src/**/*.{js,ts,glsl} || echo "FAIL: No pressure solve found"

# Check for divergence computation
grep -n "divergence\|div(" src/**/*.{js,ts,glsl} || echo "FAIL: No divergence computation"

# Check for gradient subtraction
grep -n "gradient\|gradSub\|grad.*sub" src/**/*.{js,ts,glsl} || echo "FAIL: No gradient subtraction"

# Check for vorticity confinement
grep -n "vorticity\|curl\|confinement" src/**/*.{js,ts,glsl} || echo "WARNING: No vorticity confinement"

# Check for dt cap
grep -n "Math.min.*dt\|Math.min.*delta\|dt.*0.01[6]" src/**/*.{js,ts} || echo "FAIL: No dt cap"

# Check for dissipation < 1.0
grep -n "dissipation" src/**/*.{js,ts,glsl} || echo "WARNING: No dissipation parameter"

# Check disposal
grep -n "deleteProgram\|deleteFramebuffer\|deleteTexture\|dispose" src/**/*.{js,ts} || echo "FAIL: No cleanup"
```

## Manual inspection protocol
1. Drag the pointer across the canvas. Observe the dye trail. FAIL if dye expands outward from the trail like an explosion (missing pressure solve; velocity field is compressible).
2. Create a circular drag motion. Observe the resulting vortex. FAIL if the vortex dies within 1-2 seconds (missing vorticity confinement) or if it shows grid-aligned square artifacts (insufficient Jacobi iterations).
3. Stop interacting. Wait 10 seconds. FAIL if dye does not fade at all (dissipation = 1.0, will accumulate indefinitely) or if it vanishes completely in < 2 seconds (dissipation too aggressive).
4. Switch to another tab for 10 seconds. Return. FAIL if the simulation has visually "exploded" (large bright regions, artifacts) or if the canvas is blank.
5. Create two opposing drags nearby. Observe where they meet. FAIL if fluid "piles up" at the collision point instead of flowing around it (missing divergence-free projection).
6. Resize the window. FAIL if the simulation breaks, aspect ratio distorts, or dye smears.
7. Check the Performance tab frame time. FAIL if average frame time exceeds 16ms on desktop or 33ms on mobile.

## Scoring rubric
| # | Criterion | 0 | 1 | 2 | Weight |
|---|---|---|---|---|---|
| 1 | Pressure solve (incompressibility) | No pressure solve | Pressure solve exists but < 15 iterations | Full Jacobi solve, 20+ iterations, grid artifacts absent | 4 |
| 2 | Advection | No advection | Advection without velocity self-advection | Semi-Lagrangian advection of both velocity and dye | 3 |
| 3 | Vorticity confinement | Absent | Present but too weak or too strong | Tuned confinement, vortices persist naturally | 2 |
| 4 | Dissipation | None (dye/velocity persist forever) | Present but untuned | Velocity 0.97-0.99, dye 0.95-0.99, both deliberate | 2 |
| 5 | dt handling | No cap | Cap exists but too high | Cap at 16-33ms, simulation stable across tab switches | 2 |
| 6 | Pointer interaction | No interaction | Interaction but only dye (no velocity injection) | Both velocity and dye injected, responsive to drag speed | 2 |
| 7 | Resource disposal | No cleanup | Partial | All FBOs, textures, programs disposed | 1 |
| 8 | Resize handling | No handler | Handler but sim breaks or aspect distorts | Full resize, sim continues correctly | 1 |
| 9 | Dual resolution (sim vs dye) | Same resolution for everything | Dye slightly higher | Sim at 128-256, dye at 512-1024 | 1 |
| 10 | Accessibility | No considerations | Canvas has aria-hidden | prefers-reduced-motion handled, aria-hidden on canvas | 1 |
| 11 | Performance | > 16ms frame time on desktop | Stable but not optimized | < 8ms simulation, room for scene content | 1 |

**Total: 20 points. Ship threshold: 15+. Below 10 is a no-ship.**

## Common false passes
1. **"Fluid simulation" is actually just advection.** Without the pressure solve, you have a vector field that moves things around but does not conserve volume. It looks fluid-ish for the first few seconds but quickly degenerates into expanding blobs or disappearing dye. This is the single most common shortcut.
2. **Pressure solve exists but uses 5 iterations.** At very low iteration counts, the Jacobi solver has not converged, and the velocity field still has significant divergence. Artifacts manifest as grid-aligned checkerboard patterns in the dye.
3. **Vorticity confinement is present but uses the raw curl value as a force instead of the curl gradient direction.** The force must point in the direction of increasing vorticity, not the vorticity itself. Incorrect implementation produces uniform rotation instead of localized vortex amplification.
4. **Advection uses forward Euler instead of semi-Lagrangian.** Forward Euler (move the value at this cell forward by velocity) is unstable. Semi-Lagrangian (trace backward along velocity, sample the source) is unconditionally stable. The difference is whether you write `texture(source, uv + vel * dt)` (wrong) or `texture(source, uv - vel * dt)` (correct).
5. **Dye and velocity rendered at the same low resolution.** Velocity at 256 is fine; dye at 256 looks blocky. Dye should be 2-4x velocity resolution for crisp visuals.
6. **Float textures created but `EXT_color_buffer_float` not checked.** On some mobile GPUs, creating float FBOs without the extension silently fails, producing a black screen.

## Required fixes by failure mode
| Failure | Root cause fix |
|---|---|
| Dye expands/contracts (compressible) | Add full pressure solve: divergence computation, 20-30 Jacobi iterations, gradient subtraction |
| Grid artifacts in dye | Increase Jacobi iterations to 20+ |
| Vortices die immediately | Add vorticity confinement (curl computation + confinement force application) |
| Simulation explodes on tab re-focus | Cap dt to 0.016-0.033 seconds |
| Dye never fades | Set dye dissipation < 1.0 (0.95-0.97) |
| Pointer drags have no effect | Inject velocity (not just dye) via splat on pointermove |
| Blocky dye appearance | Use separate higher-resolution FBO for dye (512-1024) |
| Black screen on mobile | Check `EXT_color_buffer_float`, fall back to `HALF_FLOAT` |
| Advection is unstable (values explode) | Replace forward Euler with semi-Lagrangian (backtrack, then sample) |

## Verdict format
```
Fluid Simulation Audit
Score: X / 20
| Criterion | Score | Note |
|---|---|---|
...
Blocking issues: [list]
SHIP / NO SHIP
```
