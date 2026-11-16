# Sources

## Corpus files examined
- `skills/primitives/webgl-particle-systems/SKILL.md` -- mined for the GPGPU pattern (FBO ping-pong, GPUComputationRenderer). The fluid simulation uses the same underlying ping-pong technique but applied to velocity/pressure fields instead of particle positions.
- `skills/primitives/three-js-fundamentals/SKILL.md` -- base renderer setup for the Three.js compositing path.
- `skills/primitives/glsl-fragment-backgrounds/SKILL.md` -- fullscreen triangle technique, UV coordinate space, shader program compilation. The fluid simulation uses the same fullscreen-triangle pattern for each simulation pass.
- `skills/primitives/cursor-fluid-simulation/SKILL.md` -- checked for overlap. That primitive covers a simpler CSS/canvas cursor trail effect, not a full Navier-Stokes solver. This toolkit is the real solver.
- `skills/primitives/shader-postprocessing/SKILL.md` -- integration notes for bloom applied over fluid output.

## Corpus index searches
- Searched for: `fluid`, `navier`, `stokes`, `sph`, `eulerian`, `smoke`, `simulation`, `advect`, `pressure.?solve`, `divergen`, `webgl.*fluid`, `jos.?stam`. Corpus hits were FluidSim (scientific CFD, not web 3D), Barba.js (page transitions labeled "fluid," not actual fluid dynamics), molecular dynamics (unrelated), and fluid layouts (CSS, unrelated). One relevant hit: `_raw/K-Dense-AI_scientific-agent-skills/skills/fluidsim/SKILL.md` (scientific FluidSim, Python/HPC, not web WebGL). No corpus files specifically about WebGL Navier-Stokes fluid simulation were found.

## External knowledge applied
- Jos Stam, "Stable Fluids" (SIGGRAPH 1999): the foundational algorithm for this toolkit.
- Pavel Dobryakov, WebGL-Fluid-Simulation (GitHub, MIT): the most widely used open-source reference implementation. The shader structure in this toolkit follows the same algorithmic decomposition.
- GPU Gems Chapter 38, "Fast Fluid Dynamics Simulation on the GPU": detailed GPU implementation guide.
- WebGL2 specification for EXT_color_buffer_float, RG16F/R16F/RGBA16F internal formats.
