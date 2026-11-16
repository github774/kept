# Cursor Fluid Simulation -- Reference

## Simulation pass order
Each frame runs these GPU passes in this exact sequence:
1. **Splat** - inject velocity + dye at cursor
2. **Advect velocity** - move velocity by itself (self-advection)
3. **Compute curl** (optional) - for vorticity confinement
4. **Apply vorticity** (optional) - amplify small-scale curls
5. **Compute divergence** - how much the velocity field compresses
6. **Pressure solve** (Jacobi x20-40) - find pressure that makes field divergence-free
7. **Gradient subtract** - remove pressure gradient from velocity
8. **Advect dye** - move visible color by corrected velocity
9. **Display** - render dye texture to screen

Skipping step 6-7 gives you a "paint" simulation (no incompressibility). Visually distinct -- the fluid compresses into streaks instead of swirling.

## FBO texture format reference
| Format | GL Enum | Size/texel | Use case |
|---|---|---|---|
| `RGBA16F` | `gl.RGBA16F` / `gl.HALF_FLOAT` | 8 bytes | Dye (need RGBA for color+alpha) |
| `RG16F` | `gl.RG16F` / `gl.HALF_FLOAT` | 4 bytes | Velocity (XY only) |
| `R16F` | `gl.R16F` / `gl.HALF_FLOAT` | 2 bytes | Pressure, divergence, curl (scalar) |
| `RGBA32F` | `gl.RGBA32F` / `gl.FLOAT` | 16 bytes | Overkill. Avoid. |

## Common gotchas

1. **WebGL 1 float textures**: Need `OES_texture_float` + `OES_texture_float_linear` (for bilinear filtering on float textures). Not universally supported -- check extension availability.
2. **EXT_color_buffer_float**: Required on WebGL 2 to render TO float textures (FBO attachment). Without it, `gl.checkFramebufferStatus` returns `INCOMPLETE_ATTACHMENT`.
3. **Ping-pong swap timing**: Swap AFTER writing, BEFORE reading in the next pass. Swapping at the wrong time means a pass reads its own output, which is undefined behavior (though often works on desktop).
4. **Boundary conditions**: The clamp-to-edge texture wrap mode handles boundaries implicitly -- velocity at edges reads the edge value. For proper no-slip boundaries (velocity = 0 at walls), add a boundary shader pass.
5. **Advection stability**: Semi-Lagrangian advection (trace backward, sample) is unconditionally stable for any time step, unlike forward Euler advection. Always use backward tracing.
6. **Dissipation vs diffusion**: Dissipation (multiply by 0.99) is a simple uniform decay. Diffusion (Gaussian smoothing) simulates viscosity. For real-time fluid, dissipation is far cheaper and visually similar.
7. **Screen resize**: When the canvas resizes, the simulation FBOs do NOT resize (they stay at SIM_W x SIM_H). Only the display pass viewport changes. This is correct -- the sim resolution is independent of screen resolution.

## Additional recipes

### Pressure clear between frames
Resetting pressure to zero each frame before Jacobi iteration gives a different feel (less persistent vortices).
```js
// Before the Jacobi loop:
gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.write.fbo);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
pressure.swap();
```
Whether to clear or not is an aesthetic choice. Clearing: faster convergence, cleaner fluid. Not clearing: vortices persist longer, more chaotic.

### Multi-touch splats (mobile)
Handle multiple simultaneous touch points for multi-finger paint.
```js
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (let i = 0; i < e.touches.length; i++) {
    const t = e.touches[i];
    const x = t.clientX / canvas.clientWidth;
    const y = 1.0 - t.clientY / canvas.clientHeight;
    // Splat at each touch point
    splatAtPosition(x, y, getSplatColor());
  }
}, { passive: false });
```

### Bloom post-process on dye
Add a simple bloom pass after the fluid sim for a glowing trail.
```glsl
#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexelSize;
out vec4 fragColor;

void main() {
  vec3 sum = vec3(0.0);
  // 9-tap box blur as cheap bloom
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      sum += texture(uTexture, vUv + vec2(float(x), float(y)) * uTexelSize * 4.0).rgb;
    }
  }
  sum /= 9.0;
  vec3 base = texture(uTexture, vUv).rgb;
  // Add bloom where brightness exceeds threshold
  vec3 bloom = max(sum - 0.3, 0.0) * 1.5;
  fragColor = vec4(base + bloom, 1.0);
}
```

### Cursor interaction without fluid sim (CSS approach)
For when even the canvas trail is too complex. Pure CSS radial gradient that follows the cursor.
```js
document.addEventListener('mousemove', (e) => {
  document.body.style.setProperty('--cx', e.clientX + 'px');
  document.body.style.setProperty('--cy', e.clientY + 'px');
});
```
```css
body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    300px circle at var(--cx) var(--cy),
    rgba(100, 100, 255, 0.15),
    transparent
  );
  z-index: 9999;
}
```
This is zero-cost (GPU-composited gradient) and works everywhere. It is not fluid simulation, but it is often sufficient for a "cursor glow" brief.
