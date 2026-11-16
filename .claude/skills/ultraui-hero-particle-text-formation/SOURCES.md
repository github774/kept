# Sources: hero-particle-text-formation

## Corpus files mined

| File | Contribution |
|---|---|
| `_raw/freshtechbro_claudedesignskills/.factory/droids/pixijs-2d.md` (344 lines) | 2D particle rendering patterns, particle system architecture, sprite-based particles vs point sprites. Confirmed particle count performance thresholds. |
| `_raw/AThevon_genjutsu/skills/_jutsu/canvas-generative/SKILL.md` (325 lines) | Canvas 2D generative patterns, noise-driven particle motion, pixel scanning techniques. Informed the text sampling approach. |
| `_raw/s1gmamale1_apple-design-skills/skills/apple-design-web/references/scrollytelling-techniques.md` (976 lines) | Scroll-driven animation patterns, sticky pinning for scroll-linked effects, scroll progress normalization. |

## Primitive skills cross-referenced

| Primitive | Slug | What it provided |
|---|---|---|
| WebGL particle systems | `webgl-particle-systems` | GPU particle architecture (Points vs InstancedMesh), BufferGeometry attribute patterns, GPGPU FBO ping-pong for high counts, curl noise flow field. This toolkit builds the text-formation use case on top of the primitive's particle system foundation. |
| Three.js fundamentals | `three-js-fundamentals` | Scene/camera/renderer setup, resize/DPR handling, disposal pattern, render loop with Clock. |
| GSAP ScrollTrigger | `gsap-scrolltrigger` | ScrollTrigger.create() with onUpdate for continuous progress, scrub mode. |

## Written from expertise

- Text position sampling from hidden canvas with getImageData pixel scanning
- Aspect ratio correction for sampled positions
- Cube-root radius for uniform sphere volume scatter distribution
- ShaderMaterial vertex/fragment shader for formation interpolation with drift
- GSAP entrance tween / ScrollTrigger coordination (kill entrance before scroll takes over)
- SVG path sampling as a variant approach for logo formation
