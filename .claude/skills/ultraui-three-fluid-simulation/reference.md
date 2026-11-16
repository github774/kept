# Fluid Simulation Reference

## Navier-Stokes equations (incompressible, 2D)
The simulation solves these two equations every frame:

**Momentum equation** (how velocity changes):
```
dv/dt = -(v . nabla)v - (1/rho) nabla(p) + nu * laplacian(v) + f
```
- `(v . nabla)v` = advection (fluid carries itself)
- `nabla(p)` = pressure gradient (enforces incompressibility)
- `nu * laplacian(v)` = diffusion (viscosity, often implicit via dissipation)
- `f` = external forces (mouse, gravity)

**Continuity equation** (mass conservation):
```
nabla . v = 0
```
The velocity field must be divergence-free: fluid cannot compress or expand.

## Solver steps mapped to shaders
| Step | Shader | Input | Output | Notes |
|---|---|---|---|---|
| 1. External forces | splat | velocity + user input | velocity | Inject velocity at pointer position |
| 2. Advection (velocity) | advection | velocity (self) | velocity | Semi-Lagrangian: trace backward, sample |
| 3. Curl computation | curl | velocity | curl scalar | For vorticity confinement |
| 4. Vorticity confinement | vorticity | velocity + curl | velocity | Amplifies vortices to counteract diffusion |
| 5. Divergence | divergence | velocity | divergence scalar | Right-hand side of pressure Poisson equation |
| 6. Pressure solve | pressure (x30) | pressure + divergence | pressure | Jacobi iteration solves laplacian(p) = div(v) |
| 7. Gradient subtraction | gradSub | velocity + pressure | velocity | v = v - nabla(p), makes v divergence-free |
| 8. Advection (dye) | advection | dye + velocity | dye | Move dye through corrected velocity field |
| 9. Display | display | dye | screen | Final render |

## Jacobi iteration explained
The pressure Poisson equation `laplacian(p) = divergence(v)` is solved iteratively. Each iteration updates each cell's pressure based on its four neighbors:

```
p_new(i,j) = (p(i-1,j) + p(i+1,j) + p(i,j-1) + p(i,j+1) - divergence(i,j)) / 4
```

More iterations = more accurate convergence. Convergence rate depends on grid size. Practical range: 20-40 iterations.

## Semi-Lagrangian advection explained
Instead of pushing values forward (unstable, values can overshoot), trace backward along the velocity from each cell, then sample the source at the traced-back position:

```glsl
// CORRECT (semi-Lagrangian, stable)
vec2 backtracked = vUv - dt * velocity * texelSize;
color = texture(source, backtracked);

// WRONG (forward Euler, unstable)
vec2 pushed = vUv + dt * velocity * texelSize;
color = texture(source, pushed);
```

The backward trace is unconditionally stable because it always samples within the existing field. The forward push can overshoot and cause values to grow unboundedly.

## Render target format guide
| Quantity | Format | Channels | Filter | Why |
|---|---|---|---|---|
| Velocity | RG16F | 2 (vx, vy) | LINEAR | Bilinear needed for advection interpolation |
| Pressure | R16F | 1 | NEAREST | Pressure is computed per-cell, no interpolation |
| Divergence | R16F | 1 | NEAREST | Computed per-cell |
| Curl | R16F | 1 | NEAREST | Computed per-cell |
| Dye | RGBA16F | 4 (r, g, b, a) | LINEAR | Bilinear for smooth dye advection |

## Performance scaling
| SIM_RES | Cells | Jacobi passes (30) | Total passes/frame | Approx frame time (desktop) |
|---|---|---|---|---|
| 64 | 4,096 | 30 | ~40 | < 1 ms |
| 128 | 16,384 | 30 | ~40 | 1-2 ms |
| 256 | 65,536 | 30 | ~40 | 3-6 ms |
| 512 | 262,144 | 30 | ~40 | 8-15 ms |

Each Jacobi iteration is a full-resolution render pass. Reducing iterations from 30 to 20 saves ~25% of the simulation cost.

## Comparison to alternative fluid approaches
| Approach | Visual quality | Performance | Complexity | When to use |
|---|---|---|---|---|
| Full Navier-Stokes (this toolkit) | Best: incompressible, volume-preserving | 3-8ms per frame | High (~8 shaders) | Hero fluid effects, interactive backgrounds |
| Advection-only (no pressure) | Looks fluid briefly, then degenerates | < 1ms | Low (1-2 shaders) | Very simple effects, not recommended |
| Curl noise particle advection | Smoke-like but not incompressible | Depends on particle count | Medium | See `three-particle-gpgpu` |
| CSS/SVG displacement filter | Very rough approximation | ~0 JS cost | Low | See `cursor-fluid-simulation` for quick cursor effects |

## Key references
- Jos Stam, "Stable Fluids" (SIGGRAPH 1999): the foundational paper for real-time fluid simulation. Introduces semi-Lagrangian advection and the pressure projection step.
- Pavel Dobryakov, WebGL-Fluid-Simulation (GitHub): the most widely used open-source WebGL implementation. MIT licensed. This toolkit follows the same algorithmic structure.
- GPU Gems Chapter 38, "Fast Fluid Dynamics Simulation on the GPU": detailed walkthrough of the GPU implementation.
- Harris, "Fast Fluid Dynamics Simulation on the GPU" (GPU Gems 1): covers the Jacobi iteration approach for pressure solving.

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| Dye expands outward like gas | Missing pressure solve | Implement divergence + Jacobi pressure + gradient subtraction |
| Grid checkerboard artifacts | Too few Jacobi iterations | Increase to 20-30 |
| Flow dies within seconds | Missing vorticity confinement | Add curl + vorticity confinement shaders |
| Simulation explodes after tab switch | dt not capped | Cap dt to 0.016-0.033 |
| Black screen on mobile | Float FBO not supported | Check EXT_color_buffer_float, fall back to HALF_FLOAT |
| Advection values grow unboundedly | Using forward Euler instead of semi-Lagrangian | Change `uv + vel * dt` to `uv - vel * dt` |
| Dye looks blocky | Dye rendered at simulation resolution | Use separate higher-res FBO for dye |
| Pointer interaction not working | Splat only injects dye, not velocity | Splat into both velocity and dye FBOs |
| Dye never fades | Dissipation = 1.0 | Set dissipation to 0.95-0.97 |
| Flow looks uniform, no detail | Vorticity confinement too weak | Increase curl parameter to 20-40 |
