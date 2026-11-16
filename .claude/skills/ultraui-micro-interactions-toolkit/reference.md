# Micro-Interactions Reference

## Named easing curves

| Name | cubic-bezier | Use |
|---|---|---|
| Standard out | `0.16, 1, 0.3, 1` | Entrances, hover arrivals, most state changes |
| Standard in | `0.7, 0, 0.84, 0` | Exits, dismissals |
| Standard in-out | `0.65, 0, 0.35, 1` | Moves between two positions |
| Gentle out | `0.25, 0.46, 0.45, 0.94` | Large surfaces where snap feels aggressive |
| Snappy out | `0.22, 1, 0.36, 1` | Small controls, toggles, chips |
| Anticipate | `0.68, -0.55, 0.27, 1.55` | Playful only. Never on destructive actions |
| Material standard | `0.4, 0, 0.2, 1` | When matching Material Design |
| iOS default | `0.25, 0.1, 0.25, 1` | When matching Apple platform feel |

Spring as a CSS `linear()` curve, no JS required:

```css
--ease-spring-soft:  linear(0, 0.22 8%, 0.62 18%, 0.98 32%, 1.01 42%, 1);
--ease-spring-firm:  linear(0, 0.28 8%, 0.72 18%, 1.02 30%, 1.008 45%, 1);
--ease-spring-loose: linear(0, 0.18 6%, 0.55 16%, 1.05 34%, 0.98 52%, 1.004 70%, 1);
```

`linear()` has broad support in current browsers. For older targets, fall back to
`cubic-bezier(0.34, 1.56, 0.64, 1)`, which overshoots once without the secondary settle.

## Duration by travel distance

| Travel | Duration | Example |
|---|---|---|
| 0-4px | 100-140ms | Button press, checkbox tick |
| 4-16px | 140-200ms | Hover lift, icon slide |
| 16-64px | 200-280ms | Dropdown open, tooltip |
| 64-240px | 280-360ms | Drawer, side panel |
| Full viewport | 360-500ms | Fullscreen overlay |

Halve these for exits. An element leaving should be faster than the same element arriving, because
the user has already decided.

## Spring constants (react-spring / Framer Motion)

| Feel | stiffness | damping | mass | Settles in |
|---|---:|---:|---:|---|
| Instant | 700 | 40 | 1 | ~180ms |
| Snappy | 400 | 30 | 1 | ~300ms |
| Default | 260 | 26 | 1 | ~420ms |
| Gentle | 170 | 22 | 1 | ~600ms |
| Wobbly | 180 | 12 | 1 | ~900ms, visible oscillation |
| Molasses | 280 | 60 | 3 | ~1400ms |

Damping below about 15 produces visible oscillation. Use it only for playful, non-critical
feedback. Mass above 1 is almost always wrong for UI; it makes controls feel unresponsive.

## Delay values

| Interaction | Delay |
|---|---|
| Tooltip open (cold) | 400-600ms |
| Tooltip open (warm, within group window) | 0ms |
| Tooltip close | 0ms on pointer leave, 100ms if travelling to the tooltip itself |
| Tooltip group warm window | 300-500ms after last close |
| Hover intent on mega menu | 120-180ms before opening |
| Mega menu close | 200-300ms grace, cancelled if pointer returns |
| Submenu open on hover | 100ms plus a pointer-direction check |
| Toast auto-dismiss | 4000ms informational, 6000ms with an action, never for errors |
| Copy confirmation | 1400-2000ms |
| Skeleton minimum display | 300ms, to avoid a flash if data arrives fast |
| Debounce on search input | 250-350ms |
| Throttle on pointer-driven effects | none, use rAF instead |

## Stagger values

| Context | Per-item delay | Max items |
|---|---:|---:|
| Characters in a word | 15-25ms | 40 |
| Words in a headline | 40-60ms | 12 |
| Lines in a paragraph | 60-90ms | 6 |
| Cards in a grid | 50-80ms | 8 |
| List rows | 30-50ms | 10 |
| Nav items in an overlay | 40-60ms | 8 |

Total stagger duration should not exceed about 500ms. Past that the last item feels forgotten.
For grids, stagger from a corner or from the centre outward rather than in DOM order; DOM order
reads as a loading sequence, spatial order reads as choreography.

## The `:has()` patterns worth knowing

```css
/* Dim sibling cards when one is hovered. */
.grid:has(.card:hover) .card:not(:hover) { opacity: 0.55; }

/* Style a field wrapper based on the input inside it. */
.field:has(input:focus) { border-color: currentColor; }
.field:has(input[aria-invalid="true"]) .msg { opacity: 1; }

/* Hide the native cursor only while a custom cursor is actually visible. */
body:has(.cursor[data-visible="true"]) { cursor: none; }

/* Disable page scroll when any dialog is open, without a JS class toggle. */
body:has(dialog[open]) { overflow: hidden; }
```

## Pointer event notes

- Use `pointerdown`/`pointermove`/`pointerup`, not mouse or touch events. One code path.
- `setPointerCapture` keeps drag working when the pointer leaves the element. Essential for sliders
  and drag handles.
- `touch-action: none` on a drag surface prevents the browser from stealing the gesture for
  scrolling. Scope it tightly; on a whole page it disables scrolling entirely.
- `pointercancel` fires when the browser takes over the gesture. Always reset state there, not just
  on `pointerup`.
- Passive listeners (`{ passive: true }`) on move and scroll listeners are required for scroll
  performance. You cannot call `preventDefault` in them, which is usually fine.

## Contrast requirements

| Element | Minimum ratio |
|---|---|
| Body text | 4.5:1 |
| Large text (18.66px bold or 24px) | 3:1 |
| Icons and meaningful graphics | 3:1 |
| Focus indicator against adjacent colour | 3:1 |
| Disabled controls | exempt, but keep above 2:1 for legibility |
| Placeholder text | 4.5:1 if it carries information, otherwise avoid using it to carry information |

A focus indicator at 3:1 against the adjacent background is a hard requirement, not a preference.
A 1px light-grey ring on white fails.

## Troubleshooting

**Hover state sticks on touch devices.** Mobile browsers emulate hover on tap and leave it applied.
Wrap hover rules in `@media (hover: hover) and (pointer: fine)`.

**Transition does not fire on first render.** The element was inserted with its final state already
applied. Force a reflow between insert and class change: `el.offsetHeight;` then add the class. Or
use the Web Animations API, which does not have this problem.

**`transitionend` fires multiple times.** It fires once per animated property. Filter on
`e.propertyName`, and check `e.target === el` to ignore bubbling from children.

**Animation restarts when a parent re-renders.** In React, an inline style object or a key change
remounts the node. Memoize style objects and keep keys stable.

**Spring overshoot clips inside a container.** The overshoot exceeds the bounds and gets cut by
`overflow: hidden`. Either add padding equal to the overshoot distance, or use a non-overshooting
curve for elements inside clipped containers.

**Custom cursor lags on a heavy page.** The lerp loop is competing with layout work. Confirm the
cursor writes only `transform` and that no other code reads geometry during the frame.

**Blurry text during transform.** A non-integer scale or a fractional translate on a text element.
Round translate values, and prefer scaling a background or a pseudo element rather than a text
container.

**Focus ring appears on mouse click.** Use `:focus-visible` rather than `:focus`. The browser
handles the heuristic for you.

**iOS momentum scroll breaks a sticky element.** Sticky positioning combined with a transformed
ancestor creates a new containing block. Remove the transform from the ancestor.

## Feature detection snippets

```js
export const caps = {
  coarse:   matchMedia("(pointer: coarse)").matches,
  hover:    matchMedia("(hover: hover)").matches,
  reduce:   matchMedia("(prefers-reduced-motion: reduce)").matches,
  hasLinear: CSS.supports("transition-timing-function", "linear(0, 1)"),
  hasHas:    CSS.supports("selector(:has(*))"),
  hasVT:     "startViewTransition" in document,
  lowEnd:    (navigator.hardwareConcurrency ?? 8) <= 4 ||
             (navigator.deviceMemory ?? 8) <= 4,
};

// Composite guard used by every pointer-driven effect in the toolkit.
export const enableRichMotion = !caps.coarse && !caps.reduce && !caps.lowEnd;
```

## Related skills

- `micro-button-system`, `micro-custom-cursor-system` in `skills/primitives` for narrower detail
- `hover-microinteraction-catalog` for the extended hover treatment list
- `stagger-orchestration` for grid and wave stagger maths
- `flip-sortable-lists` for list reorder animation, which is layout animation not micro-interaction
- `nav-and-page-transitions-toolkit` for menu, drawer and route-level motion
- `frontend-qa-audit-toolkit` for the wider audit this eval plugs into
