# Sources

## Corpus files examined
- `skills/primitives/webgl-particle-systems/SKILL.md` -- mined extensively for the GPGPU section (Phase 5 in that skill). Contains the basic GPUComputationRenderer setup, texture initialization, simulation/render shader structure. This toolkit extends that foundation into a deep, production-grade treatment with curl noise, multi-force systems, interaction, and lifecycle management.
- `skills/primitives/three-js-fundamentals/SKILL.md` -- base renderer, scene, camera, resize, disposal patterns.
- `skills/primitives/glsl-fragment-backgrounds/SKILL.md` -- simplex noise implementation (same Ashima noise used in curl noise shader). Reused the noise function rather than reimplementing.
- `skills/primitives/shader-postprocessing/SKILL.md` -- integration notes for bloom with particle systems, render target interaction with EffectComposer.
- `skills/hero/hero-particle-text-formation/SKILL.md` -- checked for GPGPU text formation approach. That skill uses CPU-driven particles; this toolkit is the GPU-driven upgrade path.

## Corpus index searches
- Searched for: `gpgpu`, `fbo`, `ping.?pong`, `compute.?shader`, `particle`, `gpu.?sim`, `render.?target`, `data.?texture`, `float.?texture`, `framebuffer`. Corpus hits were PixiJS 2D particles (different renderer), OpenPIV (scientific PIV, not web 3D), and GPU optimization references (NVIDIA Warp, unrelated). No corpus files specifically about Three.js FBO ping-pong GPGPU were found beyond the existing primitives.

## External knowledge applied
- Three.js r169 GPUComputationRenderer source code and examples (misc/GPUComputationRenderer.js).
- Curl noise technique (Bridson et al., divergence-free noise for fluid-like particle advection).
- Ashima simplex noise GLSL implementation (standard, widely used in WebGL).
- FBO ping-pong pattern (standard GPU particle simulation technique from GPU Gems and related literature).
