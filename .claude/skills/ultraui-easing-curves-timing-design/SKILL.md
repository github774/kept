---
name: easing-curves-timing-design
description: Use when deciding WHICH duration, easing curve, or spring feel to actually use for a given UI motion (not how to code it), including cubic-bezier anatomy, entrance/exit/move ease conventions, distance/size-based duration scaling, overshoot, anticipation, and named curve reference values (Material, iOS, Apple, custom expressive).
---

# Easing curves and timing design

## When to use this
- You already know which animation library/API you're using (see the other skills in this folder for syntax) and need to decide the actual numbers: duration in ms, which curve, how much overshoot.
- A reviewer or your own eye says an animation "feels off" or "feels AI-generated" and you need a principled way to diagnose why, rather than randomly nudging numbers.
- You're building or auditing a design system's motion tokens (a shared set of durations/curves reused across components) and need defensible defaults with rationale.
- You need to translate a motion reference (a competitor's app, a design file annotation, a named platform curve like "Material standard" or "iOS spring") into concrete cubic-bezier or spring values.
- Do NOT use this for how to implement a given curve in a specific library's API syntax; that is covered in each library-specific skill (`gsap-core-timelines`, `motion-one-waapi`, `framer-motion-*`, etc). This skill is about the craft decision, not the code.

This skill is deliberately library-agnostic and is meant to be read alongside whichever execution-focused skill you are actually implementing in; the numbers and reasoning here transfer directly regardless of which library ends up running the animation.

## Mental model

The rest of this document works through the actual mechanics (bezier anatomy, spring physics), the standard conventions (entrance/exit/move), and a concrete numeric/curve reference table, in that order, so you can either read it straight through once or jump to the reference table when you already know which category of motion you are tuning.
A cubic-bezier easing curve for animation timing is a 1-dimensional function mapping elapsed time (x-axis, 0 to 1) to progress (y-axis, 0 to 1), defined by two control points, `cubic-bezier(x1, y1, x2, y2)`. The first control point shapes the beginning of the motion, the second shapes the end; critically, `x1` and `x2` are usually constrained close to their "natural" role (the curve must be a valid function of time, so x-values are typically kept between 0 and 1) while `y1` and `y2` can exceed 0-1, which is exactly how overshoot curves work (a `y` value greater than 1 momentarily means "further than the destination" before settling back). Reading a bezier's shape: a small `x1` with large `y1` means the curve rockets away from 0 immediately (fast start), a `x2` close to 1 with `y2` close to 1 means it approaches the end slowly (a soft landing). This is the literal mechanism behind why "ease-out" curves (fast start, slow finish) suit entrances and "ease-in" curves (slow start, fast finish) suit exits.

The entrance/exit/move convention is not arbitrary tradition, it maps to what the eye expects from real-world motion combined with what each transition communicates. An entering element is arriving to get the user's attention, so a fast initial movement (drawing the eye) that decelerates into its resting place (ease-out, e.g. `cubic-bezier(0, 0, 0.2, 1)`) both grabs attention immediately and settles predictably, letting the user's eye land on the final position without overshoot-induced uncertainty about where it will actually stop. An exiting element is leaving the user's attention already, so an ease-in curve (slow start, accelerating away, e.g. `cubic-bezier(0.4, 0, 1, 1)`) matches how the eye naturally disengages, and starting slowly avoids a jarring instant-snap departure while still getting off-screen quickly rather than dawdling. An element MOVING from one place to another (not entering or leaving the screen, just relocating) typically wants ease-in-out (slow-fast-slow, e.g. `cubic-bezier(0.4, 0, 0.2, 1)`) because both endpoints are already "in the scene" and deserve a soft launch and a soft landing.

Springs are a physically different model from bezier curves: instead of a pre-authored fixed-shape curve over a fixed duration, a spring is a damped harmonic oscillator continuously simulated (mass, stiffness/tension, damping/friction), which naturally produces a duration that emerges from the physics rather than being set directly, and which naturally handles interrupted/re-targeted motion (a spring chasing a new target from its current velocity looks continuous; a bezier tween restarted mid-flight visually snaps or requires manual current-value capture). Springs suit anything that responds to continuous or interruptible input (drag, hover, live data); bezier curves suit anything with a fixed, known start and end that should look identical every time it plays (a scripted entrance sequence, a design-system-consistent modal open).

Duration should scale with the distance and/or size of what is moving, because real-world objects with more distance to cover or more mass to accelerate take measurably longer, and matching that expectation is what makes digital motion read as physically believable rather than arbitrary. A small icon moving 20px should take meaningfully less time than a full-screen panel translating 400px, even with the same easing curve shape; a common approach is a duration formula like `baseDuration + distance * pixelsPerMs`, clamped to a sensible min/max so very long distances do not produce absurdly long animations and very short ones do not disappear below perceptible thresholds (below ~100ms).

Overshoot (a curve or spring that goes slightly past the target before settling back) and anticipation (a small motion in the OPPOSITE direction before the main motion begins, borrowed directly from classical animation's 12 principles) both exist to make motion read as having real momentum/weight rather than being a mechanically precise value change. They should be used sparingly and only on elements arriving into a resting, non-critical-precision position; overshoot on a draggable element mid-gesture, or on anything where the exact final value is functionally important to communicate precisely and immediately (a progress bar reaching 100%, a form validation state), works against the UI's actual communicative job.

## Anatomy of anticipation and overshoot, worked
Classical animation's anticipation principle (a small backward or downward motion before the main motion, like a jumper crouching before leaping) translates to a bezier curve with a negative or out-of-range control point value early in the curve, e.g. `cubic-bezier(0.36, 0, 0.66, -0.56)`, where the negative `y1`-adjacent value briefly drives progress below 0 before rocketing past 1 and settling. In practice this is easier to author as two chained keyframes than as a single bezier: an explicit keyframe at 10-15% of the duration holding a small negative offset (e.g. `translateY(4px)` before a `translateY(-20px)` entrance), then the main motion. Reserve anticipation for genuinely playful, low-frequency moments (a mascot animation, a rare celebratory action); using it on routine UI motion (every button, every card) reads as exhausting rather than delightful, since the viewer relearns to expect a wind-up before every routine interaction, which slows down perceived responsiveness across the whole product.

Human perceptual thresholds anchor most of the numeric guidance in this skill and are worth internalizing directly rather than treating as arbitrary ranges. Below roughly 100ms, a state change registers as instantaneous and any easing curve becomes visually indistinguishable from another, since there are too few rendered frames to perceive a shape; below ~16ms (one frame at 60fps) a change is not perceptible as animation at all, just an instant cut. Between 100-300ms is the zone where a curve's shape is clearly perceptible and does the most work distinguishing entrance/exit/move intent. Above roughly 500ms for anything that blocks further interaction (a modal must finish opening before its contents are usable), users begin perceiving the delay itself as a cost, which is why even large-distance transitions are capped well below what "distance-based scaling" alone might suggest.

## Setup
No install; this is a decision framework, not a library. Values below are directly usable as `cubic-bezier()` CSS values, GSAP `ease` strings via `CustomEase`, Motion `easing` arrays, or spring `config` objects depending on which execution skill you pair this with.

## Core API
This skill has no API surface of its own; it supplies the numbers other skills' APIs consume. Common formats you will need to produce a value in: raw `cubic-bezier(x1, y1, x2, y2)` strings, four-number arrays for JS-based APIs, named keyword strings for quick defaults, and spring parameter objects with stiffness/damping/mass keys. Cross-reference:
| Concept | Where it plugs in |
|---|---|
| `cubic-bezier(x1,y1,x2,y2)` | CSS `transition-timing-function`, WAAPI `easing`, Motion `easing` array `[x1,y1,x2,y2]`. |
| Named GSAP ease (`power2.out`) | `gsap-core-timelines` `ease` vars. |
| Spring `{stiffness, damping, mass}` | `framer-motion-gestures-drag`/`framer-motion-layout` `transition` prop, `react-spring-physics` `config`. |
| `steps(n)` | WAAPI/CSS `easing` for mechanical/frame-based motion. |
| Duration in ms | Every duration-based API across all sibling skills. |
| Anticipation keyframe pair | GSAP `keyframes` array, WAAPI multi-keyframe array, Motion multi-value arrays. |
| Named platform curve lookup | Any library accepting a raw `cubic-bezier()`-equivalent array/string. |

The broader context worth knowing: this entrance/exit/move convention and the anticipation/overshoot vocabulary both trace back to the "12 basic principles of animation" documented by Disney animators Frank Thomas and Ollie Johnston (slow in/slow out, anticipation, follow-through, arcs), originally developed for hand-drawn character animation and re-derived independently by the UI motion design community because the same perceptual and physical-plausibility reasoning applies regardless of medium. Recognizing this lineage is useful mainly as a sanity check: if a proposed piece of UI motion cannot be justified by one of these established principles (weight, timing, anticipation, follow-through, arcs, exaggeration used sparingly), it is worth asking whether it is solving a real perceptual/communicative problem or just adding motion for its own sake.

## Recipes
(These are worked timing decisions, not code snippets, since this skill is about the number/curve choice itself. Pair each decision below with the matching execution skill for actual implementation syntax.)

Each recipe states a duration, a curve or spring choice, and the reasoning, in the same format so they are easy to scan and compare against each other when auditing a screen with multiple simultaneous animation types.

### Modal/dialog entrance
Fast-out settle so the dialog draws attention immediately then lands predictably.
Duration: 250-350ms. Curve: `cubic-bezier(0.16, 1, 0.3, 1)` (a strong ease-out, sometimes called "expo-out"). Distance-scale: modal panels typically travel a fixed small distance (8-24px) regardless of viewport, so distance scaling matters less here than on cross-screen transitions; keep duration in the stated range regardless of viewport size.

### Modal/dialog exit
Quicker and simpler than the entrance, no overshoot.
Duration: 150-200ms. Curve: `cubic-bezier(0.4, 0, 1, 1)` (ease-in). The asymmetry (exit faster than entrance) is deliberate: the user has already decided to leave, so the UI should get out of the way quickly rather than re-earning attention on the way out.

### Element relocating within the same view (drag-and-drop settle, reorder)
Soft launch and soft landing since both endpoints are already on-screen and "known."
Duration: 200-350ms depending on distance (use the 0.3-0.6 px/ms scaling guidance below). Curve: `cubic-bezier(0.4, 0, 0.2, 1)` (Material's "standard" ease-in-out) for deterministic UI moves, or a spring (`stiffness: 300-400, damping: 28-32`) if the move is a direct continuation of a drag gesture's release.

### Button press micro-feedback
Near-instant but still perceptible, communicates "the tap registered" without becoming the focal event.
Duration: 100-150ms down, 150-200ms back up (asymmetric, the release settle can be marginally slower than the press). Curve: `cubic-bezier(0.4, 0, 1, 1)` for the press-down (fast), `cubic-bezier(0, 0, 0.2, 1)` for the release (soft landing). Scale: independent of element size for buttons within normal UI size ranges (this is a state change, not a spatial move, so the distance-scaling rule does not apply).

### Celebratory/expressive burst (like button, success confetti, achievement unlock)
Deliberate overshoot signals delight rather than precision.
Duration: 400-700ms including settle. Curve/spring: spring with `stiffness: 300-400, damping: 10-16` (visibly under-damped, produces 1-2 visible oscillations) or a bezier overshoot curve like `cubic-bezier(0.34, 1.56, 0.64, 1)` (a common "back ease" shape, note `y1 > 1`). Reserve for genuinely positive/low-stakes moments; never apply this class of curve to error states, destructive-action confirmations, or anything where the user needs to trust the exact resulting value immediately.

### Full-screen or large-distance transition (route change, panel takeover)
Longer duration justified by both distance and the scale of context change, still capped to avoid feeling slow.
Duration: 350-500ms. Curve: `cubic-bezier(0.22, 1, 0.36, 1)` (a slightly softer expo-out than the modal entrance curve, since the traveling distance is much larger and a very sharp deceleration over a long distance can feel like slamming into a wall). Distance-scale: at the higher end of typical UI transition duration precisely because there is genuinely more visual "ground" being covered; do not extend past ~600ms even for very large moves, since beyond that the transition itself starts to feel like the bottleneck to using the product.

### Loading/progress indicator (indeterminate spinner or bar)
Continuous, non-terminating motion that should never call attention to itself with acceleration changes.
Duration: 800-1500ms per cycle. Curve: `linear`, or `cubic-bezier(0.4, 0, 0.6, 1)` for a very subtle breathing quality on a pulsing (not rotating) indicator. Never use ease-out or ease-in on a seamless loop; the deceleration-then-instant-restart reads as a visible stutter once per cycle.

### Tooltip/popover appearance
Should feel instant and unobtrusive since it is secondary, contextual information, not a focal event.
Duration: 100-150ms. Curve: `cubic-bezier(0, 0, 0.2, 1)` (ease-out) for appearance, 80-120ms `cubic-bezier(0.4, 0, 1, 1)` (ease-in) for dismissal. Distance-scale: tooltips travel very short distances (0-8px), so keep duration at the low end of any general entrance guidance; a tooltip animating with modal-entrance-length duration feels like it is interrupting rather than assisting.

### Form validation error appearance
Must communicate precisely and immediately, so restraint matters more than expressiveness.
Duration: 150-200ms. Curve: `cubic-bezier(0.4, 0, 0.2, 1)` (ease-in-out), no overshoot, no spring. A shake gesture (if used at all) should be brief (250-350ms total) and use a linear or ease-in-out curve, since a bouncy or overshooting error indicator undercuts the seriousness of the message being communicated.

## Named curve reference table
Concrete cubic-bezier values worth keeping on hand, translated from their platform's actual motion documentation/specs rather than approximated by eye.

| Name | cubic-bezier | Typical use | Source/lineage |
|---|---|---|---|
| Material standard | `cubic-bezier(0.2, 0, 0, 1)` | Default in-scene move, general purpose | Material Design 3 motion spec ("emphasized" family baseline) |
| Material standard decelerate | `cubic-bezier(0, 0, 0, 1)` | Entrances | Material Design motion spec |
| Material standard accelerate | `cubic-bezier(0.3, 0, 1, 1)` | Exits | Material Design motion spec |
| Material emphasized decelerate | `cubic-bezier(0.05, 0.7, 0.1, 1)` | High-emphasis entrances (hero elements, large surfaces) | Material Design 3 motion spec |
| Material emphasized accelerate | `cubic-bezier(0.3, 0, 0.8, 0.15)` | High-emphasis exits | Material Design 3 motion spec |
| iOS/UIKit default | `cubic-bezier(0.25, 0.1, 0.25, 1)` | System default, roughly CSS `ease` | Apple UIKit `UIView.AnimationCurve.easeInEaseOut` approximation |
| iOS spring (typical sheet presentation) | spring, not bezier: `damping: 0.86, response: 0.5` (SwiftUI terms) | Sheet/modal presentation | Apple Human Interface Guidelines, SwiftUI spring API |
| CSS `ease` (browser default) | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Generic fallback, rarely the best choice deliberately | CSS Easing Functions spec |
| CSS `ease-in` | `cubic-bezier(0.42, 0, 1, 1)` | Exits | CSS Easing Functions spec |
| CSS `ease-out` | `cubic-bezier(0, 0, 0.58, 1)` | Entrances | CSS Easing Functions spec |
| CSS `ease-in-out` | `cubic-bezier(0.42, 0, 0.58, 1)` | In-scene moves | CSS Easing Functions spec |
| "Expo out" (common expressive entrance) | `cubic-bezier(0.16, 1, 0.3, 1)` | Modal/panel entrances wanting a confident snap-settle | Widely used custom convention (e.g. popularized via easings.net as `easeOutExpo`) |
| "Back out" (overshoot) | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Celebratory/playful settle with overshoot | Common custom "back ease" derived from Robert Penner's easing equations |
| Penner `easeOutCubic` | `cubic-bezier(0.33, 1, 0.68, 1)` | General entrance, softer than expo | Robert Penner's easing equations, ubiquitous in GSAP/animation libraries |
| Penner `easeInCubic` | `cubic-bezier(0.32, 0, 0.67, 0)` | General exit | Robert Penner's easing equations |
| Fluent (Microsoft) standard | `cubic-bezier(0.8, 0, 0.2, 1)` | In-scene moves in Fluent Design apps | Microsoft Fluent Design motion guidelines |
| Custom expressive "anticipate" | `cubic-bezier(0.36, 0, 0.66, -0.56)` | Small backward dip before forward motion (note negative `y1`) | Custom convention adapting classical animation's anticipation principle to bezier form |

## Spring vs bezier decision table
| Situation | Choice | Why |
|---|---|---|
| Drag-following element (cursor follower, draggable card) | Spring | Must remain continuous under a constantly-changing target. |
| Scripted modal/panel entrance played identically every time | Bezier | Reproducible, exact duration a design system can document. |
| Gesture-release momentum (swipe, flick) | Spring | Needs to incorporate release velocity naturally. |
| Scroll-scrubbed animation (progress tied to scroll position) | Neither, use `linear`/`none` | Scroll position itself supplies the perceptual easing. |
| List item entrance with a stagger | Bezier | Reproducible per-item timing, easy to reason about total sequence length. |
| Icon toggle (menu/close, play/pause) | Bezier (fast ease-in-out) | Fixed, discrete states, exact timing matters more than physical realism. |
| Live data-driven value change (a chart value updating in real time) | Spring | New target arrives before the previous transition finishes, springs handle re-targeting gracefully. |
| Celebratory burst (like, achievement) | Either, spring is more common | Both can produce overshoot; spring's continuous decay often looks more organic for a one-off burst. |

## Diagnosing a curve that "feels wrong"
A short troubleshooting loop for when timing feels off but the specific problem is not obvious:
1. Check role mismatch first: is an entrance using an ease-in curve, or an exit using ease-out? This single swap is the most common invisible-but-wrong cause.
2. Check duration against distance: pull up the element's actual pixel travel distance and compare against the clamp formula below; a fixed duration reused across very different distances is the second most common cause.
3. Check for uniform timing across unrelated elements: if every animated thing on the screen shares one duration and curve, the choreography will feel flat even if each individual value is defensible in isolation.
4. Check whether a spring is fighting a bezier-driven parent (e.g. a spring-based drag inside a bezier-tweened container); mismatched motion models on nested elements can look subtly uncoordinated even when neither is wrong on its own.
5. Only after the above, consider adjusting the raw bezier control points or spring stiffness/damping numbers; most "feels wrong" reports are role or context mismatches, not badly-tuned numbers.
6. If the animation involves multiple simultaneously-moving properties (e.g. position and opacity and scale together), check whether they share one easing curve or each has its own; a single shared curve across dissimilar properties is often fine, but a scale animation that should settle later than an opacity fade (common in overshoot entrances) needs its own curve or slightly offset timing, not a single blanket curve applied to both.

## Tuning the feel
- Duration-by-distance starting formula: `duration_ms = clamp(150, 500, 150 + distance_px * 0.6)`. A 40px move lands around 174ms, a 300px move around 330ms, a 600px move clamps at 500ms. Treat this as a starting heuristic to tune from, not a law; different curve shapes perceptually compress or stretch the same numeric duration.
- Duration-by-size: larger/heavier-feeling elements (a full card vs a small icon) read as more believable with slightly longer durations and less aggressive initial acceleration even over the same distance, mimicking the real-world intuition that more visual "mass" implies more inertia.
- The "under 100ms reads as instant, over 300ms reads as laggy" rule of thumb applies specifically to discrete UI feedback (hover, press, toggle); it does NOT apply to spatial transitions (modals, page changes, panel expansions), which regularly and correctly run 250-500ms+ without feeling slow, because the user is tracking a continuous, information-bearing motion rather than waiting for an acknowledgment.
- Stagger delay between repeated elements in a list should shrink, not stay fixed, as list length grows, so total sequence duration does not scale linearly forever; a useful cap is keeping total stagger spread under ~400-500ms regardless of item count by lowering per-item delay for longer lists.
- When uncertain between a bezier curve and a spring for a given element, ask: "can this motion be interrupted or re-targeted mid-flight by further user input?" If yes (drag, live-updating value, gesture-driven), default to a spring. If no (a scripted, always-identical sequence), a bezier curve gives more precise, reproducible control.
- When a design system needs a small, memorable set of motion tokens rather than ad hoc per-component choices, three duration tiers (fast ~150ms for feedback, base ~250-300ms for standard entrances/moves, slow ~400-500ms for large-distance/high-emphasis transitions) crossed with three curve roles (enter, exit, move) covers the large majority of real UI needs without needing a much larger token set; resist the urge to add a fourth or fifth duration tier unless a genuinely distinct use case demands it, since token proliferation defeats the consistency goal tokens exist for.
- A quick sanity check for a newly-authored curve: does it look intentional played at 0.25x speed (most animation tools and browser DevTools support slow-motion playback)? Slowing playback exaggerates any awkward mid-curve inflection or timing mismatch that is too fast to consciously notice at normal speed but still contributes to a vague "something feels off" impression.

## Performance
- Easing curve choice itself has no direct performance cost difference (a `cubic-bezier` and `linear` cost the same to evaluate); performance costs come from WHICH properties are animated (compositor-safe vs layout-triggering), covered in each execution-focused sibling skill, not from timing/easing decisions themselves.
- Spring-based motion, because duration emerges from physics rather than being fixed, can occasionally run longer than intended if `damping` is too low relative to `stiffness` (many small oscillations before settling below the rest threshold); if a spring animation is unexpectedly still consuming frames/CPU well after it should feel "done," check the damping ratio rather than assuming a rendering performance bug.
- Extremely small duration values (under ~16ms, less than one frame at 60fps) are effectively invisible and wasted; do not author sub-frame durations expecting a visible effect, and be aware that at very high refresh rates (120Hz+) a duration tuned to "feel right" at 60fps can look slightly different due to more sampled frames within the same wall-clock time, though this is usually imperceptible for durations above ~100ms.
- A curve's shape only matters visually if the animation runs long enough for multiple frames to render along its distinct sections; a 250ms+ animation clearly shows an ease-out's deceleration tail, while the same curve compressed to 80ms barely differs visually from linear. Do not invest tuning effort into precise bezier control points for very short (under ~120ms) animations; broad named categories (`ease-out`, `ease-in`) are sufficient at that duration, save precision tuning for animations at 250ms and above where the shape is actually visible.
- Testing on a throttled/low-end device matters specifically for perceived timing, not just raw frame rate: a curve authored and tuned only on a high-end development machine at 120Hz can feel subtly different (often slightly slower-reading, since fewer intermediate frames render) on a throttled or lower-refresh-rate device; spot check timing-sensitive animations (anything under 200ms) on a representative lower-end device or with CPU throttling enabled.

## Performance-adjacent authoring note
When a curve or spring needs to be re-tuned after initial ship (a common outcome once real usage/feedback comes in), keep the change scoped to the single motion token/config value rather than hand-editing the number at every call site; the token approach (referenced above) is what makes a system-wide timing adjustment a one-line change instead of a multi-file hunt, and this authoring discipline pays for itself the first time a stakeholder asks to make "everything feel snappier."

## Accessibility
Easing/duration decisions interact with `prefers-reduced-motion` primarily through DURATION, not curve shape: the standard mitigation is reducing duration toward zero (or removing translation/scale entirely, keeping only opacity) rather than trying to find a "reduced motion" curve shape, since the goal is minimizing vestibular-trigger motion (parallax, large translation, spin) entirely, not making it subtler. A useful pattern for teams: define motion tokens as pairs, e.g. `duration.entrance = 300ms` / `duration.entrance.reducedMotion = 0ms`, rather than leaving each component to invent its own reduced-motion branch. Overshoot and spring-bounce effects specifically should be fully disabled (not just shortened) under reduced motion, since the oscillation itself, not just its duration, is the part that can trigger discomfort for vestibular-sensitive users.

## Converting between curve representations
Design tools and platform documentation express easing in different native units; converting correctly matters more than it seems, since a naive "looks about right" eyeball conversion is a common source of a curve that reads slightly wrong compared to its source reference.

| Source format | Target format | Conversion approach |
|---|---|---|
| After Effects keyframe velocity graph | CSS `cubic-bezier()` | Read the incoming/outgoing tangent handle percentages directly off the graph; AE's influence/speed values map roughly to bezier control point positions, but always verify visually rather than assuming a 1:1 numeric match. |
| iOS `UISpringTimingParameters` (damping ratio + response) | Web spring (`stiffness`/`damping`/`mass`) | Convert via the standard damped-harmonic-oscillator relationship: `stiffness = mass * (2 * pi / response)^2`, `damping = 4 * pi * mass * dampingRatio / response`. Treat this as a starting point, then tune by eye since perceptual thresholds differ by platform's overall motion pacing. |
| Named CSS keyword (`ease`, `ease-in-out`) | Explicit `cubic-bezier()` | Use the CSS spec's defined control points directly (see the named curve table above) rather than re-deriving; they are standardized values, not approximations. |
| Lottie/After Effects easing preset | GSAP/Motion easing | Export the raw bezier handle values from the animation tool rather than picking the nearest-sounding named ease in the target library; "nearest sounding" (e.g. assuming AE's "Easy Ease" equals `power2.inOut`) is frequently wrong by a meaningful visual margin. |

Separately from `prefers-reduced-motion`, be aware that vestibular-sensitive users can be affected even by motion within the "reduced" allowance if it involves large-scale parallax, simulated depth (z-axis scale changes on a big element), or spinning; when in doubt about a specific effect's safety under reduced motion, the conservative choice is a plain opacity crossfade with zero translation/scale/rotation, which conveys the same state change with the lowest vestibular risk profile available.

## Anti-slop rules

Every rule below is specifically about the timing/curve craft decision, not about implementation code quality, which is covered in each library-specific skill's own anti-slop section.
- Do not use the exact same duration and curve for every single animated element on a page/app regardless of role (entrance vs exit vs move vs feedback); uniform timing across every kind of motion is the single most common tell of unreviewed, ungrounded animation work.
- Do not default to `ease-in-out` for everything because it "seems safe." Ease-in-out is specifically for in-scene moves; using it for entrances (which want ease-out) or exits (which want ease-in) produces a subtly wrong, slightly floaty feel that is hard to name but easy to feel.
- Do not apply overshoot/spring-bounce to more than a small minority of elements in a given view; if everything bounces, nothing reads as intentionally celebratory, and it starts to look like a a template default rather than a considered choice.
- Do not pick a duration independent of the actual pixel distance being traveled; a 4px hover shift and a 400px panel slide sharing one fixed duration constant is a common, visible mismatch.
- Do not use a spring for a fixed, always-identical, one-shot scripted sequence where an exact, reproducible duration matters (e.g. a design system's documented "300ms modal entrance"); use a bezier tween, since spring duration is an emergent property, not a guaranteed one, and can vary slightly with re-tuned physics values later.
- Do not use a bezier tween for anything that must respond continuously to live, interruptible input (drag, real-time value tracking); the visual snap/discontinuity when a bezier tween is retargeted mid-flight is a well-known, avoidable defect.
- Do not treat named platform curves (Material, iOS) as universally correct for a non-native web product without checking they match the actual visual weight/density of your UI; a curve tuned for a native OS's motion language does not automatically feel native inside a web app with different visual density and interaction patterns.
- Do not eyeball-convert a curve from a design tool's velocity graph or a competitor product's motion into a named library ease by "vibes"; pull the actual control point or spring parameter values using the conversion guidance above, since small numeric differences in the deceleration tail are exactly the kind of thing an attentive reviewer notices even if they cannot immediately name what is wrong.
- Do not tune precise bezier control points on animations under ~120ms; that level of precision is invisible at that duration and the effort is better spent on the animations long enough to actually show a curve's shape (250ms+).
- Do not skip the slow-motion playback check on a newly-authored curve intended for a high-visibility, frequently-seen interaction (primary navigation, a core recurring action); awkward mid-curve inflections are cheap to catch this way and expensive to diagnose later from vague qualitative feedback.

## Checklist

Run this against any screen or component with more than one type of animated motion before calling it design-reviewed.
- [ ] Curve/spring numeric values were pulled from an actual source (spec, design tool export, conversion formula) rather than eyeballed, for any animation longer than ~120ms.
- [ ] Every animation category on a given screen (entrance, exit, in-scene move, feedback, loop) is distinguishable from the others by duration and/or curve shape, not identical.
- [ ] Entrances use ease-out family curves, exits use ease-in family curves, in-scene moves use ease-in-out or a spring.
- [ ] Duration scales with actual travel distance/element size rather than being one fixed global constant.
- [ ] Overshoot/spring-bounce reserved for a deliberate minority of celebratory or playful elements.
- [ ] Spring used specifically where motion must respond to continuous/interruptible input; bezier used for fixed scripted sequences.
- [ ] `prefers-reduced-motion` reduces duration toward zero and disables oscillation/overshoot entirely, not just "makes it faster."
- [ ] Stagger spread capped so long lists do not scale total animation time linearly forever.
- [ ] Named platform curves (Material/iOS/Apple) checked against your own product's visual density before adopting wholesale.
- [ ] No two functionally different motion categories (entrance/exit/move/feedback) sharing identical duration+curve by default.
- [ ] Motion tokens (duration/curve constants) are centralized and reusable rather than hardcoded at each call site, so a future system-wide tuning pass is a small change.
- [ ] Any curve intended for a high-frequency, high-visibility interaction has been checked at slow-motion playback for awkward inflections.
- [ ] Duration for any spatial move was checked against actual pixel distance, not assumed from a fixed global constant.
