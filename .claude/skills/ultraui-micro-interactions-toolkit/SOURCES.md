# Sources

Corpus mined from `_meta/CORPUS_INDEX.tsv` and the primitives library, plus original material.

| Source | Contributed |
|---|---|
| `skills/primitives/hover-microinteraction-catalog` | Base hover treatment set; extended here with the border-draw clip-path pair and the spotlight delegation pattern |
| `skills/primitives/custom-cursor-systems` | Cursor state machine shape; the `mix-blend-mode: difference` legibility technique and the first-paint guard are carried forward |
| `skills/primitives/magnetic-cursor-interactions` | Falloff maths; squared falloff chosen over linear, and the nesting prohibition added |
| `skills/primitives/micro-tilt-3d-cards` equivalents in corpus | Perspective-on-parent rule and the move-vs-leave transition swap |
| `skills/primitives/text-scramble-decode` | Width-locking probe technique to prevent reflow during scramble |
| `skills/primitives/easing-curves-timing-design` | Duration-by-distance table and the entrance/exit/move easing rule stated once in Shared foundations |
| `_raw` design-taste and impeccable family repos | Anti-slop rule material: `transition: all`, uniform hover treatment, scale ceilings, spinner thresholds |
| `_raw` accessibility-oriented skill docs | Focus-visible parity requirement, live region pattern, switch semantics |
| `prompts/components/lib-shadcn-ui`, `lib-originui` | Real-world form field, switch and tooltip implementations used to sanity check the API shapes here |
| Original | The `linear()` spring token set, the shared `onFrame` scheduler, the tooltip group-warm-window implementation, the Web Audio blip synth with 5ms attack ramp, the composition/conflict section, and the full eval rubric |

## Conflicts resolved

- **Tooltip delay.** Sources ranged from 0ms to 1000ms. Settled on 400-600ms cold with a group warm
  window, matching native OS behaviour, because a flat delay is either spammy or unresponsive.
- **Magnetic strength.** Corpus examples used 0.5-0.8, which visibly detaches the element from the
  cursor. Reduced to 0.25-0.4 with squared falloff.
- **Tilt max rotation.** Sources suggested up to 20deg. Capped at 6-10deg here; beyond that text on
  the card degrades and the effect reads as a novelty.
- **Reduced motion duration.** Several sources set `0s`. Changed to `1ms` because `0s` suppresses
  `transitionend` and hangs any code awaiting it.
- **Press feedback.** Sources split between `scale(0.97)` and `translateY(1px)`. Chose translate,
  because scale blurs text at non-integer values.
