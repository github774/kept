# Easing curves and timing design reference

## Full named curve table (extended)
| Name | cubic-bezier | Notes |
|---|---|---|
| linear | `cubic-bezier(0, 0, 1, 1)` | Constant rate; correct for scroll-scrubbed and rotation loops only. |
| ease | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Browser/CSS default; rarely the best deliberate choice. |
| ease-in | `cubic-bezier(0.42, 0, 1, 1)` | CSS spec value for exits. |
| ease-out | `cubic-bezier(0, 0, 0.58, 1)` | CSS spec value for entrances. |
| ease-in-out | `cubic-bezier(0.42, 0, 0.58, 1)` | CSS spec value for in-scene moves. |
| Material standard | `cubic-bezier(0.2, 0, 0, 1)` | General-purpose Material Design 3 default. |
| Material standard decelerate | `cubic-bezier(0, 0, 0, 1)` | Entrances. |
| Material standard accelerate | `cubic-bezier(0.3, 0, 1, 1)` | Exits. |
| Material emphasized | `cubic-bezier(0.2, 0, 0, 1)` (with longer duration) | High-emphasis general moves. |
| Material emphasized decelerate | `cubic-bezier(0.05, 0.7, 0.1, 1)` | High-emphasis entrances. |
| Material emphasized accelerate | `cubic-bezier(0.3, 0, 0.8, 0.15)` | High-emphasis exits. |
| Fluent standard | `cubic-bezier(0.8, 0, 0.2, 1)` | Microsoft Fluent Design in-scene moves. |
| Penner easeOutQuad | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | Gentle deceleration. |
| Penner easeOutCubic | `cubic-bezier(0.33, 1, 0.68, 1)` | Standard entrance choice. |
| Penner easeOutQuart | `cubic-bezier(0.25, 1, 0.5, 1)` | Stronger deceleration than cubic. |
| Penner easeOutExpo | `cubic-bezier(0.16, 1, 0.3, 1)` | Sharp initial burst, long soft tail. |
| Penner easeInCubic | `cubic-bezier(0.32, 0, 0.67, 0)` | Standard exit choice. |
| Penner easeInOutCubic | `cubic-bezier(0.65, 0, 0.35, 1)` | Standard in-scene move choice. |
| Back out (overshoot) | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful settle with overshoot. |
| Anticipate | `cubic-bezier(0.36, 0, 0.66, -0.56)` | Small negative dip before forward motion. |

## Spring parameter quick reference (generic stiffness/damping model)
| Feel | Stiffness | Damping | Mass | Character |
|---|---|---|---|---|
| Tight/snappy UI feedback | 300-500 | 25-35 | 1 | Fast settle, near zero overshoot. |
| Standard content entrance | 170-220 | 20-26 | 1 | Natural, slight cushion, minimal overshoot. |
| Playful/celebratory | 250-350 | 8-15 | 1 | Visible bounce, 1-2 oscillations. |
| Floaty cursor-follower/parallax | 100-180 | 14-22 | 1 | Visible lag, smooth trailing follow. |
| Heavy/large element | 150-220 | 24-30 | 1.5-2.5 | Slower to start and stop, reads as more massive. |

## Duration reference by interaction category
| Category | Range | Typical curve family |
|---|---|---|
| Instant feedback (hover, focus ring) | 80-150ms | ease-out or none |
| Press/tap feedback | 100-180ms | ease-in (press), ease-out (release) |
| Tooltip/popover | 100-150ms | ease-out (in), ease-in (out) |
| Small UI entrance (dropdown, chip) | 150-250ms | ease-out |
| Standard content entrance (card, panel) | 250-400ms | ease-out |
| Modal/dialog entrance | 250-350ms | expo-out or Material emphasized decelerate |
| Layout reflow/reorder | 200-350ms | ease-in-out or spring |
| Large-distance/route transition | 350-500ms | expo-out (softer variant) |
| Celebratory burst | 400-700ms | back-out or under-damped spring |
| Ambient/looping | 800-1500ms per cycle | linear or ease-in-out |

## Additional worked examples

### Diagnosing an entrance that feels "sluggish" despite a short duration
Symptom: 300ms duration, feels slow. Likely cause: `ease-in-out` used instead of `ease-out` for an entrance, meaning the first ~40% of the animation is spent slowly ramping up before any perceptible motion, effectively wasting the early part of the duration. Fix: switch to `cubic-bezier(0, 0, 0.2, 1)` or `cubic-bezier(0.16, 1, 0.3, 1)` so motion is visible from frame one.

### Diagnosing a drag interaction that feels "sticky"
Symptom: a draggable element visually lags noticeably behind the pointer during drag itself (not just on release). Likely cause: the element's position is being driven by a spring or eased tween DURING the active drag, rather than 1:1 with pointer position, with easing/spring smoothing reserved for the release/settle phase only. Fix: bind position directly (no easing) while the pointer is down, and only apply spring/eased motion for the release-to-rest phase (momentum, snap-back, or elastic bounce-back).

### Building a distance-aware duration function
```js
function durationForDistance(distancePx, { min = 150, max = 500, pxPerMs = 0.6, base = 100 } = {}) {
  return Math.min(max, Math.max(min, base + distancePx * pxPerMs));
}

// durationForDistance(40)  -> 150 (clamped to min)
// durationForDistance(300) -> 280
// durationForDistance(700) -> 500 (clamped to max)
```

### Deriving a damped-oscillator spring config from a target duration and bounce amount
```js
function springFromDurationAndBounce(durationMs, bounciness) {
  // bounciness: 0 (no overshoot) to 1 (very bouncy), rough approximation
  const dampingRatio = 1 - bounciness * 0.8;
  const angularFreq = (2 * Math.PI) / (durationMs / 1000);
  const mass = 1;
  const stiffness = mass * angularFreq * angularFreq;
  const damping = 2 * mass * dampingRatio * angularFreq;
  return { stiffness, damping, mass };
}

// springFromDurationAndBounce(400, 0)   -> critically damped, no overshoot
// springFromDurationAndBounce(400, 0.6) -> visible bounce
```

## Gotchas
- A bezier curve with `y1` or `y2` outside 0-1 (overshoot curves) is valid CSS/WAAPI syntax but some older tooling or design-tool exports clamp these values on round-trip; verify an overshoot curve survives being copy-pasted through your specific toolchain rather than assuming it does.
- "Ease" as a colloquial term is ambiguous between the CSS keyword `ease` (a specific bezier) and the general concept of easing; when communicating with designers or in documentation, prefer explicit bezier values or named references from the table above over the bare word "ease" to avoid this specific keyword collision.
- Two curves can have very similar visual appearance over a short duration but diverge significantly at longer durations (or vice versa); always preview a curve at the ACTUAL duration it will ship with, not a convenient round number used only for comparison during the design phase.
- Spring "duration" is not directly settable in the classic stiffness/damping/mass model; some libraries (SwiftUI, some react-spring/Motion configurations) offer a duration-plus-bounce parameterization as a convenience layer specifically because raw stiffness/damping is unintuitive to tune by feel; prefer that parameterization when available and only drop to raw physical parameters when you need precision the convenience layer does not expose.
- A curve that looks correct in an isolated demo/sandbox can look wrong in the actual product context because the surrounding motion (or lack of it) changes the perceptual baseline; always do final feel-tuning in the actual application context, not an isolated component sandbox.
