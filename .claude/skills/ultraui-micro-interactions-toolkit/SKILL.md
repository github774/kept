---
name: micro-interactions-toolkit
description: Use when building or auditing any small interactive element - buttons, hovers, cursors, toggles, inputs, counters, tooltips, icons, links. Covers the full micro-interaction surface of a product with timings, states and failure modes.
category: micro
pairs_with: micro-interactions-toolkit-eval
---

# Micro-Interactions Toolkit

## Scope

Covers every interaction small enough that a user does not consciously notice it working, and
immediately notices it failing:

- Button systems: states, sizes, loading, press physics, disabled semantics
- Hover reveal catalogue: underline wipes, mask reveals, character shuffles, border draws, tilt,
  spotlight follow, image peek
- Custom cursor systems and the state machine behind them
- Magnetic elements and pull falloff
- 3D tilt cards with correct perspective and glare
- Text scramble and decode
- Number counters and value formatting
- Toggles and switches with spring physics
- Checkbox and radio motion
- Input focus, floating labels, validation states
- Link and underline treatment systems
- Icon transitions and morphs
- Scroll hints and affordances
- Drag affordances and drop targets
- Copy to clipboard confirmation
- Reaction and like bursts
- Progress feedback, determinate and indeterminate
- Tooltips and popovers with delay and collision logic
- UI sound design

Deliberately excluded: page-level and section-level motion (see `scroll-reveal-choreography-system`
and `nav-and-page-transitions-toolkit`), and layout animation of lists (see `flip-sortable-lists`).

## Decision matrix

| Situation | Use | Avoid | Why |
|---|---|---|---|
| Element responds to pointer proximity | Magnetic pull, 40-80px radius | Magnetic on anything below 44px tap target | Small targets already move under the finger; magnetism makes them harder to hit |
| State change the user caused | 120-200ms, ease-out | Anything over 300ms | The user already knows what they did; motion confirms, it does not narrate |
| State change the system caused | 200-320ms, ease-in-out | Instant swap | Unannounced changes get missed; give the eye a path to follow |
| Value counting up | 800-1600ms, ease-out, tabular figures | Linear easing, proportional figures | Linear reads mechanical; proportional figures make the box jitter |
| Hover on a text link | Underline wipe 180ms | Color-only change | Color alone fails for colorblind users and reads as unstyled |
| Hover on a card | Lift 2-4px + shadow, 160ms | Scale above 1.03 | Scale blurs text on non-integer scales and pushes neighbours visually |
| Destructive action | No playful motion, require confirm | Bounce, spring overshoot | Delight on delete is a tonal error |
| Async under 400ms | Nothing, or optimistic update | Spinner | A spinner that flashes is worse than no spinner |
| Async 400ms to 4s | Determinate progress or skeleton | Indeterminate spinner if progress is knowable | Indeterminate says "I have no idea", which is rarely true |
| Async over 4s | Progress plus what is happening in words | Bare spinner | Users abandon silent waits |
| Cursor replacement | Only if the site is a portfolio or showcase | Custom cursor on a checkout or dashboard | Cursor replacement costs precision; only spend it where the payoff is atmosphere |
| Tooltip on hover | 400-600ms open delay, 0ms close on leave, shared 150ms group delay | Instant open | Instant tooltips fire constantly while the pointer crosses the UI |

## Shared foundations

Four rules apply to everything in this document. The sub-topic sections assume them and do not
repeat them.

**1. Compositor-only properties.** Animate `transform` and `opacity`. Everything else risks layout
or paint on every frame. `box-shadow` is the common exception people reach for; animate a pseudo
element's `opacity` with two pre-rendered shadows instead of animating the shadow itself.

**2. Duration scales with distance and size, not with importance.** A 16px icon rotating needs
~150ms. A full-width panel sliding needs ~350ms. Same easing family, different durations. If
everything in a product uses one duration, everything feels wrong at one end of the size range.

**3. Entrances ease out, exits ease in, moves ease in-out.** Entrances decelerate into place
(the object arrives). Exits accelerate away (the object leaves). Something moving from A to B does
both. This single rule fixes most amateur motion.

**4. Every state must be reachable by keyboard and visible when focused.** If a hover treatment
carries meaning, `:focus-visible` gets the same treatment. A hover-only affordance is a bug.

```css
/* The motion token set every section below draws from */
:root {
  --dur-instant: 100ms;
  --dur-fast:    160ms;   /* hover, press, small state flips */
  --dur-base:    240ms;   /* most state changes */
  --dur-slow:    360ms;   /* panels, drawers, larger travel */
  --dur-count:  1200ms;   /* number count-ups */

  --ease-out:   cubic-bezier(0.16, 1, 0.3, 1);      /* entrances, arrivals */
  --ease-in:    cubic-bezier(0.7, 0, 0.84, 0);      /* exits */
  --ease-inout: cubic-bezier(0.65, 0, 0.35, 1);     /* moves */
  --ease-spring: linear(0, 0.28 8%, 0.72 18%, 1.02 30%, 1.008 45%, 1);
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-instant: 1ms; --dur-fast: 1ms; --dur-base: 1ms;
    --dur-slow: 1ms; --dur-count: 1ms;
  }
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

Note the reduced-motion block sets 1ms rather than 0. A 0-duration transition does not fire
`transitionend`, and code that waits on that event will hang. 1ms fires and is imperceptible.

## Button systems

A button is the highest-traffic interactive element in most products. It needs five visually
distinct states and one physical behaviour.

```css
.btn {
  --btn-bg: #111;
  --btn-fg: #fff;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5em;
  padding: 0.75em 1.25em;
  min-height: 44px;               /* tap target floor */
  font: inherit;
  font-weight: 500;
  line-height: 1;
  color: var(--btn-fg);
  background: var(--btn-bg);
  border: 1px solid transparent;
  cursor: pointer;
  isolation: isolate;
  transition:
    transform var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

/* hover: a real luminance shift, not an opacity fade */
.btn:hover { background: color-mix(in oklch, var(--btn-bg), white 12%); }

/* press: the physical beat. 1px down beats scale for text crispness */
.btn:active { transform: translateY(1px); transition-duration: var(--dur-instant); }

/* focus: always visible, never only on hover */
.btn:focus-visible {
  outline: 2px solid var(--btn-bg);
  outline-offset: 2px;
}

/* disabled: reduced contrast AND no pointer affordance */
.btn:disabled,
.btn[aria-disabled="true"] {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}

/* loading: fixed width so the button does not resize mid-action */
.btn[data-loading="true"] {
  color: transparent;
  pointer-events: none;
}
.btn[data-loading="true"]::after {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 1em;
  height: 1em;
  border: 2px solid color-mix(in oklch, var(--btn-fg), transparent 60%);
  border-top-color: var(--btn-fg);
  border-radius: 50%;
  animation: btn-spin 640ms linear infinite;
}
@keyframes btn-spin { to { transform: rotate(360deg); } }
```

```js
// Loading state without layout shift: lock the rendered width before swapping content.
export function setLoading(btn, loading) {
  if (loading) {
    btn.style.minWidth = btn.getBoundingClientRect().width + "px";
    btn.dataset.loading = "true";
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.style.minWidth = "";
    delete btn.dataset.loading;
    btn.removeAttribute("aria-busy");
  }
}
```

Numbers that matter: press travel 1px (2px starts to feel mushy), hover luminance shift 10-14%
(below 8% is invisible on a bright screen), spinner rotation 600-700ms per turn (faster reads
frantic, slower reads stalled), minimum tap target 44px.

Failure mode that marks amateur work: `transition: all`. It animates properties you did not intend,
including `width` when content changes, producing a visible stretch on every state flip.

## Hover reveal catalogue

Nine treatments that are actually distinct. Rotate them by role, never mix more than two families
on one page.

```css
/* 1. Underline wipe. The default for text links. */
.hv-underline {
  background-image: linear-gradient(currentColor, currentColor);
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 0% 1px;
  transition: background-size var(--dur-fast) var(--ease-out);
}
.hv-underline:hover, .hv-underline:focus-visible { background-size: 100% 1px; }

/* 2. Underline wipe out-and-in. Directional, reads more deliberate. */
.hv-underline-swap {
  background-image: linear-gradient(currentColor, currentColor);
  background-repeat: no-repeat;
  background-position: 100% 100%;
  background-size: 100% 1px;
  transition: background-size var(--dur-fast) var(--ease-in);
}
.hv-underline-swap:hover {
  background-position: 0 100%;
  background-size: 100% 1px;
  animation: swap-wipe 320ms var(--ease-inout);
}
@keyframes swap-wipe {
  0%   { background-size: 100% 1px; background-position: 100% 100%; }
  49%  { background-size: 0% 1px;   background-position: 100% 100%; }
  51%  { background-size: 0% 1px;   background-position: 0 100%; }
  100% { background-size: 100% 1px; background-position: 0 100%; }
}

/* 3. Mask reveal. Two stacked copies, one clipped. */
.hv-mask { position: relative; display: inline-block; overflow: hidden; }
.hv-mask span { display: block; transition: transform var(--dur-base) var(--ease-out); }
.hv-mask span:last-child { position: absolute; inset: 0; transform: translateY(100%); }
.hv-mask:hover span:first-child { transform: translateY(-100%); }
.hv-mask:hover span:last-child  { transform: translateY(0); }

/* 4. Border draw. Two pseudo elements, each drawing two sides. */
.hv-border { position: relative; }
.hv-border::before, .hv-border::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  border: 1px solid currentColor;
  transition: clip-path var(--dur-base) var(--ease-inout);
}
.hv-border::before { clip-path: inset(0 100% 100% 0); }
.hv-border::after  { clip-path: inset(100% 0 0 100%); }
.hv-border:hover::before { clip-path: inset(0 0 50% 0); }
.hv-border:hover::after  { clip-path: inset(50% 0 0 0); }

/* 5. Card lift. Shadow pre-rendered on a pseudo element, opacity animated. */
.hv-lift { position: relative; transition: transform var(--dur-fast) var(--ease-out); }
.hv-lift::after {
  content: ""; position: absolute; inset: 0; z-index: -1; opacity: 0;
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.18);
  transition: opacity var(--dur-fast) var(--ease-out);
}
.hv-lift:hover { transform: translateY(-3px); }
.hv-lift:hover::after { opacity: 1; }

/* 6. Spotlight follow. Pointer position drives a radial gradient. */
.hv-spot {
  position: relative;
  background:
    radial-gradient(
      220px circle at var(--mx, 50%) var(--my, 50%),
      color-mix(in oklch, currentColor, transparent 88%),
      transparent 60%
    );
}
```

```js
// Spotlight follow: write pointer position as CSS custom properties.
// One listener on the container, not one per card.
export function initSpotlight(container) {
  container.addEventListener("pointermove", (e) => {
    const card = e.target.closest(".hv-spot");
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
}
```

```css
/* 7. Image peek. Image scales inside a fixed frame, frame never moves. */
.hv-peek { overflow: hidden; }
.hv-peek img {
  display: block;
  transition: transform var(--dur-slow) var(--ease-out);
  will-change: transform;
}
.hv-peek:hover img { transform: scale(1.06); }

/* 8. Arrow slide with a mask so the arrow enters rather than appearing. */
.hv-arrow { display: inline-flex; align-items: center; gap: 0.4em; overflow: hidden; }
.hv-arrow svg {
  transition: transform var(--dur-fast) var(--ease-out);
  transform: translateX(-4px);
  opacity: 0;
}
.hv-arrow:hover svg { transform: translateX(0); opacity: 1; }

/* 9. Character shuffle. Per-character stagger driven by an index variable. */
.hv-chars span {
  display: inline-block;
  transition: transform var(--dur-fast) var(--ease-out);
  transition-delay: calc(var(--i) * 18ms);
}
.hv-chars:hover span { transform: translateY(-0.15em); }
```

Numbers: image peek scale 1.04-1.08 (1.1 and above shows compression artifacts on photos),
per-character stagger 15-25ms (above 30ms the word visibly ripples rather than lifts), underline
weight 1px at body size, 2px at 24px and above.

Failure mode: applying the same hover treatment to every interactive element on a page. Hover
treatment is a signal of element type. If a card, a link and a button all lift the same way, the
treatment stops carrying information.

## Custom cursor systems

Only worth it on portfolios, showcases and brand sites. On any interface where precision matters,
the native cursor wins. If you build one, it needs a state machine, not a single follower div.

```js
// Cursor with lerped follow and an explicit state machine.
// States: default | link | drag | text | view | hidden
export function initCursor({
  root = document.body,
  lerp = 0.18,        // 0.12 sluggish, 0.25 twitchy, 0.18 is the usable middle
  size = 12,
} = {}) {
  if (window.matchMedia("(pointer: coarse)").matches) return null;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) lerp = 1;

  const el = document.createElement("div");
  el.className = "cursor";
  el.setAttribute("aria-hidden", "true");
  el.dataset.state = "default";
  root.appendChild(el);

  let tx = innerWidth / 2, ty = innerHeight / 2;
  let cx = tx, cy = ty;
  let raf = null, visible = false;

  const onMove = (e) => {
    tx = e.clientX; ty = e.clientY;
    if (!visible) { visible = true; cx = tx; cy = ty; el.dataset.visible = "true"; }
  };

  const tick = () => {
    cx += (tx - cx) * lerp;
    cy += (ty - cy) * lerp;
    el.style.transform = `translate3d(${cx - size / 2}px, ${cy - size / 2}px, 0)`;
    raf = requestAnimationFrame(tick);
  };

  const setState = (s) => { el.dataset.state = s; };

  // Delegate state from data attributes so markup declares its own cursor.
  const onOver = (e) => {
    const t = e.target.closest("[data-cursor]");
    setState(t ? t.dataset.cursor : "default");
  };

  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerover", onOver, { passive: true });
  document.addEventListener("pointerleave", () => { el.dataset.visible = "false"; });
  raf = requestAnimationFrame(tick);

  return {
    setState,
    destroy() {
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerover", onOver);
      el.remove();
    },
  };
}
```

```css
.cursor {
  position: fixed; top: 0; left: 0; z-index: 9999;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff;
  pointer-events: none;
  opacity: 0;
  mix-blend-mode: difference;   /* stays visible on any background */
  transition: width var(--dur-fast) var(--ease-out),
              height var(--dur-fast) var(--ease-out),
              opacity var(--dur-fast) linear,
              background-color var(--dur-fast) var(--ease-out);
}
.cursor[data-visible="true"] { opacity: 1; }
.cursor[data-state="link"]   { width: 44px; height: 44px; background: #fff; }
.cursor[data-state="view"]   { width: 72px; height: 72px; }
.cursor[data-state="text"]   { width: 2px;  height: 24px; border-radius: 1px; }
.cursor[data-state="drag"]   { width: 56px; height: 56px; }

/* Never hide the native cursor without a working replacement on screen. */
@media (pointer: fine) and (prefers-reduced-motion: no-preference) {
  body:has(.cursor[data-visible="true"]) { cursor: none; }
  body:has(.cursor[data-visible="true"]) a,
  body:has(.cursor[data-visible="true"]) button { cursor: none; }
}
```

`mix-blend-mode: difference` is what keeps a custom cursor legible across light and dark sections
without any per-section logic. It is the single highest-value line in this section.

Failure modes: hiding the native cursor before the custom one is visible (the pointer disappears on
first paint); leaving `cursor: none` active on touch devices; forgetting that text inputs need a
real caret cursor, not a decorative dot.

## Magnetic elements

```js
// Magnetic pull with distance falloff. One rAF loop for all elements.
export function initMagnetic(selector = "[data-magnetic]", {
  radius = 80,     // px beyond the element bounds where pull begins
  strength = 0.35, // 0.25 subtle, 0.5 aggressive
  lerp = 0.2,
} = {}) {
  if (window.matchMedia("(pointer: coarse)").matches) return () => {};
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  const items = [...document.querySelectorAll(selector)].map((el) => ({
    el, x: 0, y: 0, tx: 0, ty: 0, rect: el.getBoundingClientRect(),
  }));

  const measure = () => items.forEach((i) => { i.rect = i.el.getBoundingClientRect(); });
  let mx = -9999, my = -9999;

  const onMove = (e) => { mx = e.clientX; my = e.clientY; };

  const tick = () => {
    for (const i of items) {
      const cx = i.rect.left + i.rect.width / 2;
      const cy = i.rect.top + i.rect.height / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy);
      const reach = Math.max(i.rect.width, i.rect.height) / 2 + radius;

      if (dist < reach) {
        // Falloff: 1 at the centre, 0 at the edge of reach. Squared for a softer edge.
        const f = (1 - dist / reach) ** 2;
        i.tx = dx * strength * f;
        i.ty = dy * strength * f;
      } else {
        i.tx = 0; i.ty = 0;
      }
      i.x += (i.tx - i.x) * lerp;
      i.y += (i.ty - i.y) * lerp;
      i.el.style.transform = `translate3d(${i.x.toFixed(2)}px, ${i.y.toFixed(2)}px, 0)`;
    }
    raf = requestAnimationFrame(tick);
  };

  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("resize", measure);
  addEventListener("scroll", measure, { passive: true });
  let raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", onMove);
    removeEventListener("resize", measure);
    removeEventListener("scroll", measure);
  };
}
```

Numbers: radius 60-100px, strength 0.25-0.4, lerp 0.15-0.25. Squared falloff, not linear: linear
falloff makes the element snap noticeably at the boundary of the reach circle.

Hard rule: the element's clickable area moves with it, so the visual and the hit area stay aligned.
If you instead move only an inner label, the click target no longer matches what the user sees.

Never nest magnetic elements. A magnetic button inside a magnetic card produces compounding
translation and the inner element drifts out of its parent.

## 3D tilt cards

```js
// Perspective tilt with glare. Perspective on the parent, transform on the child.
export function initTilt(el, { max = 8, scale = 1.02, glare = true } = {}) {
  if (window.matchMedia("(pointer: coarse)").matches) return;
  const parent = el.parentElement;
  parent.style.perspective = "1000px";
  el.style.transformStyle = "preserve-3d";
  el.style.transition = "transform 400ms cubic-bezier(0.16,1,0.3,1)";

  let g;
  if (glare) {
    g = document.createElement("div");
    g.className = "tilt-glare";
    el.appendChild(g);
  }

  const onEnter = () => { el.style.transition = "transform 100ms linear"; };

  const onMove = (e) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;   // 0..1
    const py = (e.clientY - r.top) / r.height;   // 0..1
    const rx = (0.5 - py) * max * 2;             // rotateX: up is positive
    const ry = (px - 0.5) * max * 2;             // rotateY: right is positive
    el.style.transform =
      `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${scale})`;
    if (g) {
      g.style.opacity = "1";
      g.style.background =
        `radial-gradient(circle at ${px * 100}% ${py * 100}%,` +
        ` rgb(255 255 255 / 0.28), transparent 55%)`;
    }
  };

  const onLeave = () => {
    el.style.transition = "transform 400ms cubic-bezier(0.16,1,0.3,1)";
    el.style.transform = "rotateX(0deg) rotateY(0deg) scale(1)";
    if (g) g.style.opacity = "0";
  };

  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", onLeave);
}
```

```css
.tilt-glare {
  position: absolute; inset: 0; pointer-events: none;
  opacity: 0; transition: opacity var(--dur-base) var(--ease-out);
  mix-blend-mode: overlay;
}
```

Numbers: max rotation 6-10deg. Above 12deg the card reads as a novelty and text on it becomes hard
to read at the far edge. Scale 1.01-1.03. Return transition 350-450ms with a strong ease-out so the
card settles rather than snapping.

The two failures that give tilt away as amateur: perspective set on the tilting element itself
(which produces a flat skew rather than depth), and no transition change between move and leave, so
the card either lags the pointer or snaps back instantly.

## Text scramble and decode

```js
// Scramble-to-resolve. Locks width first so surrounding layout never reflows.
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@$*<>/\\";

export function scramble(el, text, { duration = 900, stagger = 28 } = {}) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = text;
    return Promise.resolve();
  }
  // Reserve final width so neighbours do not shift while characters churn.
  const probe = el.cloneNode(false);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  probe.textContent = text;
  el.parentElement.appendChild(probe);
  el.style.minWidth = probe.getBoundingClientRect().width + "px";
  probe.remove();

  const chars = [...text];
  const start = performance.now();
  const resolveAt = chars.map((_, i) => i * stagger + Math.random() * 120);

  return new Promise((done) => {
    const tick = (now) => {
      const t = now - start;
      let output = "";
      let settled = 0;
      chars.forEach((c, i) => {
        if (c === " ") { output += " "; settled++; return; }
        if (t >= resolveAt[i] + duration * 0.25) { output += c; settled++; }
        else if (t >= resolveAt[i] - 120) {
          output += GLYPHS[(Math.random() * GLYPHS.length) | 0];
        } else output += " ";
      });
      el.textContent = output;
      if (settled === chars.length) { el.style.minWidth = ""; done(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
```

Use a monospace font, or lock the width as above. Proportional fonts change width per glyph and the
line visibly breathes during the scramble, which reads as a rendering bug.

Numbers: total resolve under 1.2s. Per-character stagger 20-35ms. Scramble only once per element
per page view; a headline that re-scrambles on every scroll into view is an irritation, not a
flourish.

## Number counters

```js
// Count-up with easing, correct formatting, and no layout jitter.
export function countUp(el, to, {
  from = 0,
  duration = 1200,
  decimals = 0,
  locale = undefined,
  prefix = "",
  suffix = "",
} = {}) {
  const fmt = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Accessibility: expose the final value immediately, animate a visual-only span.
  el.setAttribute("aria-label", `${prefix}${fmt.format(to)}${suffix}`);

  if (reduce) { el.textContent = `${prefix}${fmt.format(to)}${suffix}`; return; }

  const start = performance.now();
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  const tick = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const v = from + (to - from) * easeOut(t);
    el.textContent = `${prefix}${fmt.format(v)}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = `${prefix}${fmt.format(to)}${suffix}`;  // exact final value
  };
  requestAnimationFrame(tick);
}
```

```css
/* Mandatory. Without this the number box jitters as digit widths change. */
.counter { font-variant-numeric: tabular-nums; }
```

Two non-negotiables: `tabular-nums`, and setting the exact target value on the final frame rather
than trusting the interpolation to land. Floating point will otherwise leave you at 99.97%.

Trigger on `IntersectionObserver` at `threshold: 0.5`, once. A counter that restarts every time it
scrolls into view undermines the number it is presenting.

## Toggles and switches

```css
.switch {
  --w: 44px; --h: 24px; --pad: 3px;
  position: relative;
  width: var(--w); height: var(--h);
  flex: none;
  background: #c9c9cf;
  border-radius: calc(var(--h) / 2);
  border: none;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.switch::after {
  content: "";
  position: absolute;
  top: var(--pad); left: var(--pad);
  width: calc(var(--h) - var(--pad) * 2);
  height: calc(var(--h) - var(--pad) * 2);
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
  transition: transform var(--dur-base) var(--ease-spring);
}
.switch[aria-checked="true"] { background: #16a34a; }
.switch[aria-checked="true"]::after {
  transform: translateX(calc(var(--w) - var(--h)));
}
.switch:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
```

```js
// Switch: role and state must be real, not visual only.
export function initSwitch(btn, onChange) {
  btn.setAttribute("role", "switch");
  if (!btn.hasAttribute("aria-checked")) btn.setAttribute("aria-checked", "false");
  btn.addEventListener("click", () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    btn.setAttribute("aria-checked", String(next));
    onChange?.(next);
  });
}
```

The spring easing on the knob is the whole point. A linear or ease-out knob reads as a settings
row; a knob that overshoots ~2% and settles reads as a physical switch. The
`--ease-spring` linear() curve above does exactly that with no JS.

The colour change must be simultaneous with the knob travel, not delayed. Delaying it by even 60ms
makes the control feel unresponsive.

## Input focus and validation

```css
.field { position: relative; }
.field input {
  width: 100%;
  padding: 1.25rem 0.875rem 0.5rem;
  border: 1px solid #d4d4d8;
  background: transparent;
  transition: border-color var(--dur-fast) var(--ease-out),
              box-shadow var(--dur-fast) var(--ease-out);
}
.field label {
  position: absolute;
  left: 0.875rem;
  top: 50%;
  transform: translateY(-50%);
  transform-origin: left center;
  color: #71717a;
  pointer-events: none;
  transition: transform var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
/* Float the label when focused or when the field has content. */
.field input:focus + label,
.field input:not(:placeholder-shown) + label {
  transform: translateY(-140%) scale(0.78);
  color: #18181b;
}
.field input:focus {
  outline: none;
  border-color: #18181b;
  box-shadow: 0 0 0 3px rgb(24 24 27 / 0.12);
}
/* Only show invalid styling after the user has left the field. */
.field input[aria-invalid="true"]:not(:focus) {
  border-color: #dc2626;
  box-shadow: 0 0 0 3px rgb(220 38 38 / 0.12);
}
.field .msg {
  display: block;
  min-height: 1.25em;     /* reserve space so the form never jumps */
  font-size: 0.8125rem;
  color: #dc2626;
}
```

The `:not(:placeholder-shown)` trick requires `placeholder=" "` (a single space) on the input.
Without it the label never floats for pre-filled values.

Two rules that separate professional forms: validate on blur, not on keystroke (validating while
someone types tells them they are wrong before they have finished being right), and reserve the
error message height so the layout does not jump when a message appears.

## Tooltips and popovers

```js
// Tooltip with group delay: the first tooltip waits, subsequent ones open instantly
// while the pointer stays within the group. This is how native OS tooltips behave.
export function initTooltips({
  openDelay = 500,
  groupWindow = 400,   // after closing, this long of "warm" instant-open
} = {}) {
  let timer = null, warmUntil = 0, current = null;

  const show = (trigger) => {
    const id = trigger.getAttribute("aria-describedby");
    const tip = id && document.getElementById(id);
    if (!tip) return;
    tip.dataset.open = "true";
    position(trigger, tip);
    current = tip;
  };

  const hide = () => {
    if (current) { current.dataset.open = "false"; current = null; }
    warmUntil = performance.now() + groupWindow;
  };

  const position = (trigger, tip) => {
    const r = trigger.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = r.top - t.height - 8;
    let left = r.left + r.width / 2 - t.width / 2;
    // Flip below if it would clip the viewport top.
    if (top < 8) top = r.bottom + 8;
    // Clamp horizontally with an 8px gutter.
    left = Math.max(8, Math.min(left, innerWidth - t.width - 8));
    tip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  };

  document.addEventListener("pointerover", (e) => {
    const trigger = e.target.closest("[data-tooltip]");
    if (!trigger) return;
    clearTimeout(timer);
    const warm = performance.now() < warmUntil;
    timer = setTimeout(() => show(trigger), warm ? 0 : openDelay);
  });

  document.addEventListener("pointerout", (e) => {
    if (!e.target.closest("[data-tooltip]")) return;
    clearTimeout(timer);
    hide();
  });

  // Keyboard parity: focus opens immediately, Escape closes.
  document.addEventListener("focusin", (e) => {
    const t = e.target.closest("[data-tooltip]");
    if (t) show(t);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}
```

```css
[role="tooltip"] {
  position: fixed; top: 0; left: 0; z-index: 1000;
  padding: 0.375rem 0.5rem;
  font-size: 0.8125rem;
  background: #18181b; color: #fff;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
[role="tooltip"][data-open="true"] { opacity: 1; }
```

The group-delay behaviour is what makes a tooltip system feel native. Without it, moving across a
toolbar either spams tooltips (no delay) or feels unresponsive (delay every time).

Tooltips must never contain interactive content. If it needs a link or a button, it is a popover
and needs focus management, not a tooltip.

## Copy to clipboard

```js
export async function copyWithFeedback(btn, text) {
  const label = btn.querySelector("[data-label]") ?? btn;
  const original = label.textContent;
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = "Copied";
    btn.dataset.state = "success";
  } catch {
    label.textContent = "Press Ctrl+C";
    btn.dataset.state = "error";
  }
  // Announce to screen readers without moving focus.
  const live = document.getElementById("sr-live");
  if (live) live.textContent = label.textContent;
  setTimeout(() => {
    label.textContent = original;
    delete btn.dataset.state;
  }, 1600);
}
```

Confirmation must persist 1.4-2s. Under 1s the user misses it if they blinked; over 3s the button
appears stuck. Never move focus on copy, and never replace the button with a different-width label
unless the width is locked.

## Progress feedback

```css
/* Indeterminate: use only when progress is genuinely unknowable. */
.progress-indeterminate {
  position: relative; height: 2px; overflow: hidden; background: #e4e4e7;
}
.progress-indeterminate::after {
  content: ""; position: absolute; inset: 0;
  background: currentColor;
  transform-origin: left;
  animation: indet 1.4s var(--ease-inout) infinite;
}
@keyframes indet {
  0%   { transform: translateX(-100%) scaleX(0.4); }
  50%  { transform: translateX(20%)   scaleX(0.7); }
  100% { transform: translateX(100%)  scaleX(0.4); }
}

/* Determinate: width driven by a custom property, transitioned. */
.progress-bar {
  height: 2px; background: #e4e4e7;
}
.progress-bar > i {
  display: block; height: 100%;
  width: calc(var(--p, 0) * 1%);
  background: currentColor;
  transition: width var(--dur-base) var(--ease-out);
}
```

Rules by duration: under 400ms show nothing (a spinner that flashes is visual noise); 400ms to 4s
show a skeleton or determinate bar; over 4s show progress plus a sentence saying what is happening.
Never let a determinate bar sit at 100% without the operation completing, and never let it move
backwards.

## Icon transitions

```css
/* Two-icon crossfade with rotation. Both icons stacked, one visible. */
.icon-swap { position: relative; display: inline-grid; place-items: center; }
.icon-swap svg {
  grid-area: 1 / 1;
  transition: transform var(--dur-base) var(--ease-out),
              opacity var(--dur-fast) var(--ease-out);
}
.icon-swap svg:last-child { opacity: 0; transform: rotate(-90deg) scale(0.6); }
.icon-swap[data-on="true"] svg:first-child { opacity: 0; transform: rotate(90deg) scale(0.6); }
.icon-swap[data-on="true"] svg:last-child  { opacity: 1; transform: rotate(0) scale(1); }
```

```css
/* Hamburger to close, using the same three bars rather than swapping glyphs. */
.burger { width: 24px; height: 16px; position: relative; }
.burger i {
  position: absolute; left: 0; height: 2px; width: 100%; background: currentColor;
  transition: transform var(--dur-base) var(--ease-inout),
              opacity var(--dur-instant) linear var(--dur-instant);
}
.burger i:nth-child(1) { top: 0; }
.burger i:nth-child(2) { top: 7px; }
.burger i:nth-child(3) { top: 14px; }
.burger[aria-expanded="true"] i:nth-child(1) { transform: translateY(7px) rotate(45deg); }
.burger[aria-expanded="true"] i:nth-child(2) { opacity: 0; }
.burger[aria-expanded="true"] i:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
```

Morphing the existing shape beats crossfading two glyphs. The hamburger-to-close above transforms
the same three elements, which reads as one object changing state rather than two icons swapping.

## UI sound design

Sound is the most commonly botched micro-interaction. Rules:

- Default to off. Provide a visible toggle. Persist the choice.
- Never play audio before a user gesture; browsers block it and you get a console error rather than
  a sound.
- Frequency range 200-2000Hz. Below 200Hz sounds like an error on laptop speakers, above 4kHz is
  piercing on headphones.
- Duration 40-120ms for confirmations, up to 300ms for completions.
- Peak amplitude around -18dBFS. UI sound should sit under speech and music, not over it.
- One sound per event class, not per element. A distinct sound per button is chaos.

```js
// Tiny synth so you ship no audio files and no library.
const ctx = () => (window.__uiCtx ??= new (window.AudioContext || webkitAudioContext)());

export function blip({ freq = 880, dur = 0.06, gain = 0.08, type = "sine" } = {}) {
  if (localStorage.getItem("ui-sound") !== "on") return;
  const a = ctx();
  if (a.state === "suspended") a.resume();
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + 0.005);   // 5ms attack, no click
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  osc.connect(g).connect(a.destination);
  osc.start();
  osc.stop(a.currentTime + dur + 0.02);
}

export const sounds = {
  tap:     () => blip({ freq: 660, dur: 0.045, gain: 0.05 }),
  success: () => { blip({ freq: 880, dur: 0.06 }); setTimeout(() => blip({ freq: 1320, dur: 0.09 }), 70); },
  error:   () => blip({ freq: 220, dur: 0.14, type: "square", gain: 0.06 }),
};
```

The 5ms attack ramp matters. Starting a gain at full value produces an audible click on every
sound, which is the tell of a first attempt.

## Composition

Micro-interactions fail collectively, not individually. Each one is defensible; twelve of them on
one screen is a carnival. Budget them.

**Per-screen budget.** At most one "signature" interaction per viewport (a magnetic CTA, a tilt
card grid, a custom cursor state). Everything else on that screen uses the plain treatments: hover
lift, underline wipe, press travel.

**Ordering when several fire at once.** If a click triggers a press, a sound, a toast and a
counter, they must not all start at t=0. Press at 0ms, sound at 0ms, toast at 80ms, counter at
120ms. Simultaneous events read as one indistinct flash.

**Conflicts to watch for:**

- Custom cursor plus magnetic elements: the cursor lerp and the magnet lerp fight, and the cursor
  appears to lag behind the element it is pulling. Use a faster lerp (0.25) on the cursor when its
  state is `link`.
- Tilt cards inside a scroll-driven parallax section: both write `transform` on overlapping
  elements. Put the tilt on a child, the parallax on the parent.
- Tooltips inside modals: the tooltip's `position: fixed` escapes the modal stacking context only
  if the modal uses a transform. Render tooltips to a portal at document root.
- Spring toggles inside virtualized lists: recycled rows carry their spring mid-flight into the new
  row. Reset transforms on recycle.

```js
// One rAF loop for every pointer-driven micro-interaction on the page.
// Multiple independent loops is the most common cause of micro-interaction jank.
const subscribers = new Set();
let running = false;

export function onFrame(fn) {
  subscribers.add(fn);
  if (!running) { running = true; requestAnimationFrame(loop); }
  return () => subscribers.delete(fn);
}

function loop(now) {
  for (const fn of subscribers) fn(now);
  if (subscribers.size) requestAnimationFrame(loop);
  else running = false;
}
```

## Performance budget

| Target | Value |
|---|---|
| Frame time during any hover or pointer interaction | under 8ms (leaves headroom under the 16.7ms budget) |
| rAF loops running simultaneously | 1 |
| `will-change` declarations live at once | under 10 |
| Elements with an active pointer listener | delegate; 1 listener per interaction type, not per element |
| INP contribution from any micro-interaction | under 40ms |
| Added JS for the full toolkit | under 8KB gzipped |

Levers, in the order to pull them:

1. Delegate listeners to a container rather than binding per element.
2. Cache `getBoundingClientRect()` and re-measure on resize and scroll, never per pointer move.
3. Consolidate to one rAF loop (see `onFrame` above).
4. Remove `will-change` after the interaction settles; a permanent `will-change: transform` on
   many elements exhausts GPU memory and makes everything slower.
5. Drop the effect entirely on coarse pointers rather than trying to make it touch-friendly.

Profile with the Performance panel: record while moving the pointer across the interactive area.
Look for `Recalculate Style` and `Layout` entries inside the pointer-move flame chart. Any layout
work during a pointer move means something is animating a non-compositor property or reading
geometry per frame.

## Accessibility

```css
/* Baseline: honour reduced motion but keep state changes legible. */
@media (prefers-reduced-motion: reduce) {
  .hv-lift:hover { transform: none; }
  .hv-lift:hover::after { opacity: 1; }   /* keep the shadow, drop the travel */
  .cursor { display: none; }
  body { cursor: auto !important; }
}
```

Requirements, all mandatory:

- Every hover treatment that carries meaning has an identical `:focus-visible` treatment.
- Focus indicators are never removed. `outline: none` without a replacement is a defect.
- Toggles use `role="switch"` and `aria-checked`, not a styled div.
- Counters expose the final value via `aria-label` immediately, so a screen reader never reads a
  mid-animation number.
- Copy confirmations and other transient feedback go to a visually hidden `aria-live="polite"`
  region. Do not move focus.
- Custom cursors are `aria-hidden` and never the only indication of interactivity.
- Tooltips are referenced by `aria-describedby`, open on focus as well as hover, and close on
  Escape.
- Tap targets are at least 44x44px including any magnetic displacement.
- Motion never conveys information alone. If an item is "new" because it pulsed, it is not new to
  anyone who did not see the pulse.

```html
<!-- Put this once in the document. Everything transient announces through it. -->
<div id="sr-live" aria-live="polite" class="sr-only"></div>
```

```css
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

## Anti-slop rules

1. Never use `transition: all`. Name the properties. `all` animates things you did not intend and
   costs paint you did not budget.
2. Never animate `width`, `height`, `top`, `left`, `margin` or `padding` for effect. Use
   `transform`.
3. No scale above 1.03 on anything containing text. Non-integer scale blurs glyph rendering.
4. No hover effect longer than 300ms. The pointer will have moved on.
5. No bounce or elastic easing on destructive or financial actions.
6. Do not put a spinner on anything that resolves in under 400ms. Show nothing.
7. Do not stagger more than 8 items. Past 8 it reads as a loading failure, not choreography.
8. Never hide the native cursor without a visible working replacement already on screen.
9. Never nest magnetic elements, and never apply magnetism to targets under 44px.
10. Counters without `font-variant-numeric: tabular-nums` are a defect, not a preference.
11. Never validate a form field on keystroke. Validate on blur.
12. No tooltip on a touch device. There is no hover; you are building a tap-to-dismiss overlay
    that blocks the thing under it.
13. Do not apply the same hover treatment to cards, links and buttons. Treatment signals type.
14. No sound without an off switch, and never on by default.
15. Do not re-trigger an entrance animation every time an element scrolls into view.
16. Never rely on `:hover` alone to expose a control. Keyboard and touch users cannot reach it.
17. Do not run more than one rAF loop. Consolidate.
18. Do not leave `will-change` on permanently. Add before, remove after.
19. Avoid pure white or pure black for glare, shadow and overlay effects; use a colour mixed from
    the surface so effects sit in the palette rather than on top of it.
20. Do not ship a micro-interaction you have not tested with the CPU throttled 4x. Most of them
    feel fine on the machine that built them and terrible on a mid-range phone.

## Ship checklist

- [ ] Every interactive element has hover, focus-visible, active, disabled and loading states
- [ ] `:focus-visible` treatment matches or exceeds the hover treatment in visibility
- [ ] No `transition: all` anywhere in the stylesheet
- [ ] All animated properties are `transform` or `opacity`, verified in DevTools paint flashing
- [ ] Buttons lock width before entering loading state
- [ ] Tap targets measure at least 44x44px, including at maximum magnetic displacement
- [ ] Counters use tabular figures and land on the exact target value
- [ ] Counters expose the final value to assistive tech immediately
- [ ] Form validation fires on blur, and error message space is reserved
- [ ] Tooltips open on focus, close on Escape, and are disabled on coarse pointers
- [ ] Custom cursor, if present, is `aria-hidden` and disabled on touch and reduced motion
- [ ] Native cursor is never hidden before the replacement is visible
- [ ] Magnetic and tilt effects are disabled on `(pointer: coarse)`
- [ ] One rAF loop total, verified by searching the bundle for `requestAnimationFrame`
- [ ] `getBoundingClientRect` is not called inside any pointer-move handler
- [ ] `will-change` is added on interaction start and removed on settle
- [ ] `prefers-reduced-motion` path tested; durations are 1ms, not 0
- [ ] Transient feedback announces through a single `aria-live` region
- [ ] Sound is off by default with a persisted, visible toggle
- [ ] At most one signature interaction per viewport
- [ ] Simultaneous feedback events are offset by 60-120ms, not fired together
- [ ] Whole page re-tested with CPU throttled 4x and no interaction drops frames
