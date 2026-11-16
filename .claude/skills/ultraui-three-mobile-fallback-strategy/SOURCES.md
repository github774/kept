# Sources: three-mobile-fallback-strategy

## Corpus files consulted

| File | What it contributed |
|---|---|
| `_raw/freshtechbro_claudedesignskills/.factory/droids/threejs-webgl.md` (559 lines) | Core Three.js setup patterns, material table, shadow configuration, dispose pattern, InstancedMesh usage, LOD pattern. Confirmed current API surface for r169+. |
| `_raw/MustBeSimo_cinematic-scroll-skill/SKILL.md` (1117 lines) | Performance budget concepts, mobile tier gating approach, the idea of a multi-phase pipeline with verification. Informed the probe-classify-apply architecture. |
| `_raw/freshtechbro_claudedesignskills/plugins/bundles/core-3d-animation/skills/gsap-scrolltrigger/SKILL.md` (765 lines) | ScrollTrigger matchMedia pattern for responsive breakpoints. Informed the device-tier scoring approach. |

## Existing skills cross-referenced

| Skill | Relationship |
|---|---|
| `scroll-mobile-performance-strategy` (scroll/) | Covers CSS/DOM mobile performance (layer budgets, ScrollTrigger counts, thermal guard). This toolkit handles the WebGL/3D side exclusively. The tier-detection scoring approach was informed by that skill's `detectDeviceTier()` function but diverges significantly: this toolkit adds GPU renderer string classification, a real WebGL benchmark, and runtime FPS demotion, none of which apply to 2D scroll performance. |
| `three-js-fundamentals` (primitives/) | Referenced for core setup patterns (resize, DPR, color space, dispose). Not duplicated here; this toolkit assumes the scene is already built per fundamentals. |
| `ogl-lightweight-webgl` (primitives/) | Referenced as the lighter-weight alternative for scenes that do not need Three.js's full feature set. Mentioned in "When to use / when not to" but not integrated. |

## External knowledge applied
- WebGL context limits per browser (Chrome/Firefox: 16, Safari: 8) from WebGL specification and browser implementation notes.
- GPU chipset naming conventions from ARM (Mali), Qualcomm (Adreno), Apple (A-series/M-series), and Intel (UHD/Iris) public documentation.
- `navigator.deviceMemory` API behavior (power-of-2 rounding, Chrome-only) from W3C Device Memory specification.
- Thermal throttle detection via frame-time regression, a common pattern in mobile game development.
