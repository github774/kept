# Sources

## Corpus files consulted

| File | Contribution |
|---|---|
| `_raw/skinnye_3d-web-pack/skills/add-postprocessing/SKILL.md` | R3F `@react-three/postprocessing` setup pattern, effect component props, performance notes on `disableNormalPass` and `multisampling` |
| `_raw/AThevon_genjutsu/skills/_jutsu/threejs-r3f/SKILL.md` | EffectComposer + Bloom code pattern, luminanceThreshold guidance, performance patterns table (Instances, LOD, demand frameloop) |
| `_raw/MustBeSimo_cinematic-scroll-skill/references/3d-stack.md` | Tier decision tree (A/B/C/D), DPR clamping rationale, draw-call budgets, renderer caps table, context loss handling pattern, reduced-motion discipline |
| `_raw/MustBeSimo_cinematic-scroll-skill/references/performance-budget.md` | Frame budget breakdown (16.67ms total, JS/compositor split), will-change strategy, mobile degradation matrix, layer count budgets |
| `_raw/freshtechbro_claudedesignskills/.factory/droids/blender-web-pipeline.md` | GLB optimization context (Draco compression, texture sizing) informing why postprocessing budgets must account for asset weight |

## Existing skills cross-referenced

| Skill | Relationship |
|---|---|
| `primitives/shader-postprocessing` | Covers per-effect theory, individual recipes, and the `postprocessing` vs Three.js EffectComposer distinction. This toolkit builds the managed pipeline layer on top. |
| `primitives/three-js-fundamentals` | Scene/renderer/camera boilerplate this stack plugs into. Disposal pattern and resize handling foundation. |
| `primitives/react-three-fiber-drei` | R3F Canvas/useFrame/Suspense setup for the declarative variant. |
| `primitives/glsl-fragment-backgrounds` | Alternative for full-screen shader effects that do not need a scene render (not postprocessing). |

## External documentation

- `postprocessing` npm package docs (vanruesc/postprocessing GitHub): EffectPass merging behavior, Effect API for custom effects, BlendFunction reference
- Three.js r169 docs: WebGLRenderer properties, tone mapping modes, SRGBColorSpace
- `@react-three/postprocessing` docs: declarative component API mapping to underlying `postprocessing` classes
