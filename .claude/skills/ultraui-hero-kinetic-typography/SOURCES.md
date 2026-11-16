# Sources: hero-kinetic-typography

## Corpus files mined

| File | Contribution |
|---|---|
| `_raw/luthfierlmbang_Fluke-Motion/skills/fluke-motion/references/kinetic-typography.md` (169 lines) | Comprehensive kinetic typography taxonomy: scramble/decode, typewriter, variable font animation, text on path, 3D text, character physics, text distortion shaders, marquee, reveal variations table, wavy text, highlight/gradient/shimmer, split-flap, outline-to-fill, glitch, magnetic letters. Informed the variant selection and anti-slop rules. Key insight: "animate the largest unit that still reads as crafted" (Emil Kowalski's rule). |
| `_raw/greensock_gsap-skills/skills/gsap-plugins/SKILL.md` (433 lines) | SplitText plugin API (pre-3.13 and post-3.13), ScrambleTextPlugin API, ScrollTrigger integration patterns. Confirmed SplitText is free since GSAP 3.13. |
| `_raw/freshtechbro_claudedesignskills/.factory/skills/gsap-scrolltrigger/references/common_patterns.md` (1228 lines) | GSAP ScrollTrigger common patterns: scrub mode, pin mode, trigger/start/end calculation, markers for debugging. |
| `_raw/freshtechbro_claudedesignskills/.factory/skills/gsap-scrolltrigger/references/easing_guide.md` (748 lines) | GSAP easing function visual guide: power1-4, sine, circ, expo, back, bounce, elastic, custom. Informed the easing selection guide for text. |

## Primitive skills cross-referenced

| Primitive | Slug | What it provided |
|---|---|---|
| GSAP SplitText kinetic type | `gsap-splittext-kinetic-type` | Full SplitText API reference, split mechanics, mask option, autoSplit/onSplit pattern, resize handling, accessibility (aria option), font loading gate. This toolkit builds the complete hero section on top of the primitive's SplitText foundation. |
| GSAP core timelines | `gsap-core-timelines` | Timeline creation, position parameter syntax, defaults, stagger. Used for the entrance choreography. |
| Stagger orchestration | `stagger-orchestration` | Stagger timing patterns, from/center/edges ordering, grid stagger. Applied to character stagger timing. |
| Easing curves timing design | `easing-curves-timing-design` | Easing curve selection rationale, power curves, sine, cubic-bezier. Informed "no bounce on text" rule. |

## Written from expertise

- Complete hero section architecture with multiple text lines choreographed as a composed timeline
- Pointer-reactive per-character weight shift with distance-based influence radius
- Idle weight wave with timeout-based start/stop
- Descender preservation in masked line reveals (padding-bottom fix)
- `overwrite: true` requirement on pointer tweens (memory explosion prevention)
- Scramble-decode variant entrance with monospace constraint
- Magnetic letter hover variant with inner-span hit-target fix
