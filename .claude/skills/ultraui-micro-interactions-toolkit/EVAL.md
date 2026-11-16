---
name: micro-interactions-toolkit-eval
description: Use when verifying that micro-interactions were actually implemented correctly. Adversarial audit of buttons, hovers, cursors, toggles, inputs, counters and tooltips.
pairs_with: micro-interactions-toolkit
---

# Eval: Micro-Interactions Toolkit

## What this audits

The failure this category ships most often is a set of interactions that each look fine in
isolation and are collectively unusable: `transition: all` everywhere, hover-only affordances with
no keyboard equivalent, counters that jitter, spinners on 200ms requests, a custom cursor that
hides the native one before it renders, and four independent rAF loops fighting each other. Almost
none of this is visible on the developer's machine. All of it is visible on a throttled mid-range
phone with a keyboard.

The second failure is uniformity: every element gets the same hover lift, so the treatment stops
distinguishing a card from a button from a link.

## Evidence required

Do not score from a description of the work. Open these:

- The stylesheet(s) as text, for the static grep checks below
- The page in a browser at 1440x900 and at 390x844
- DevTools Performance panel, with a recorded trace while moving the pointer across the interactive
  area for 5 seconds
- DevTools Rendering panel with Paint Flashing enabled
- The page navigated using only the keyboard, Tab through every interactive element
- The page with `prefers-reduced-motion: reduce` forced (Rendering panel > Emulate CSS media)
- The page with CPU throttled 4x
- The bundle or source, searched for `requestAnimationFrame`
- A screen reader (VoiceOver rotor or equivalent) on any counter and any copy-to-clipboard control

## Automated checks

```bash
# Static checks. Run from the project root. Each has an explicit pass condition.
SRC="src"   # adjust

echo "== 1. transition: all =="
grep -rn "transition:\s*all" $SRC --include=*.css --include=*.scss --include=*.tsx
# PASS: no output. FAIL: any occurrence.

echo "== 2. non-compositor animated properties =="
grep -rnE "transition:[^;]*\b(width|height|top|left|right|bottom|margin|padding)\b" $SRC --include=*.css
# PASS: no output, or every hit is justified in a comment. FAIL: silent hits.

echo "== 3. outline removed without replacement =="
grep -rn "outline:\s*none\|outline:\s*0" $SRC --include=*.css -A3 | grep -B1 -A3 "outline" | grep -L "focus-visible"
# PASS: every outline:none is inside a rule that also defines a focus-visible style.

echo "== 4. tabular numerals on counters =="
grep -rn "font-variant-numeric:\s*tabular-nums" $SRC --include=*.css
# PASS: at least one hit, and it applies to every counter element.
# FAIL: zero hits while the page has animated numbers.

echo "== 5. rAF loop count =="
grep -rn "requestAnimationFrame" $SRC | grep -v "node_modules" | wc -l
# PASS: loops are consolidated. Multiple call sites are acceptable ONLY if they all
# feed one shared scheduler. FAIL: 3+ independent self-perpetuating loops.

echo "== 6. reduced motion honoured =="
grep -rn "prefers-reduced-motion" $SRC --include=*.css --include=*.tsx | wc -l
# PASS: at least one CSS media block AND JS matchMedia guards on cursor/magnetic/tilt/scramble.

echo "== 7. reduced motion uses 1ms not 0 =="
grep -rnA4 "prefers-reduced-motion" $SRC --include=*.css | grep -E "duration:\s*0s|duration:\s*0ms"
# PASS: no output. FAIL: 0 duration, which suppresses transitionend and can hang await chains.

echo "== 8. coarse pointer guards =="
grep -rn "pointer: coarse\|pointer:coarse" $SRC | wc -l
# PASS: >=1 if the page has cursor, magnetic, tilt or tooltip features.

echo "== 9. switch semantics =="
grep -rn 'role="switch"' $SRC | wc -l
grep -rn 'aria-checked' $SRC | wc -l
# PASS: both non-zero if the UI has toggles. FAIL: styled divs with only a data attribute.

echo "== 10. live region present =="
grep -rn 'aria-live' $SRC | wc -l
# PASS: >=1 if there is any transient confirmation (copy, save, undo).
```

```js
// Runtime checks. Paste into the DevTools console on the live page.

// R1: no layout-triggering reads during pointer move.
// Move the pointer across the interactive area while this runs.
(() => {
  const orig = Element.prototype.getBoundingClientRect;
  let inMove = false, hits = 0;
  addEventListener("pointermove", () => { inMove = true;
    queueMicrotask(() => { inMove = false; }); }, true);
  Element.prototype.getBoundingClientRect = function () {
    if (inMove) hits++;
    return orig.apply(this, arguments);
  };
  setTimeout(() => {
    console.log("getBoundingClientRect during pointermove:", hits);
    Element.prototype.getBoundingClientRect = orig;
  }, 5000);
})();
// PASS: 0. FAIL: any nonzero count means geometry is read per frame.

// R2: will-change is not left on permanently.
(() => {
  const n = [...document.querySelectorAll("*")]
    .filter(e => getComputedStyle(e).willChange !== "auto").length;
  console.log("elements with will-change at rest:", n);
})();
// PASS: under 10. FAIL: 30+, which exhausts GPU memory.

// R3: tap target sizes including interactive children.
(() => {
  const small = [...document.querySelectorAll('a,button,[role="button"],[role="switch"],input')]
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44));
  console.table(small.map(({ e, r }) => ({
    tag: e.tagName, text: e.textContent.trim().slice(0, 24),
    w: Math.round(r.width), h: Math.round(r.height) })));
})();
// PASS: empty, or every entry is a dense-toolbar control with 44px spacing around it.

// R4: counters land on the exact target.
// Read the rendered text of each counter after animation settles and compare to its aria-label.
(() => {
  document.querySelectorAll("[data-counter], .counter").forEach(el => {
    console.log(el.textContent.trim(), "| aria-label:", el.getAttribute("aria-label"));
  });
})();
// PASS: rendered text equals the aria-label value exactly. FAIL: 99.97 vs 100, or no aria-label.

// R5: focus styles are actually visible.
(() => {
  let bad = [];
  document.querySelectorAll("a,button,input,select,textarea,[tabindex]").forEach(el => {
    el.focus();
    const s = getComputedStyle(el);
    const hasOutline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const hasShadow = s.boxShadow !== "none";
    if (!hasOutline && !hasShadow) bad.push(el);
  });
  console.log("focusable elements with no visible focus indicator:", bad.length, bad);
})();
// PASS: 0. FAIL: any element with no outline and no box-shadow when focused.
```

## Manual inspection protocol

Each step has a binary outcome. Record it.

1. Tab through the entire page without touching the mouse. FAIL if any interactive element is
   unreachable, or if the focus ring is invisible on any of them, or if focus order does not
   follow visual order.
2. Hover a card, a button and a text link in turn. FAIL if all three receive the same treatment.
3. Hover a text link. FAIL if the only change is colour.
4. Click a button that triggers an async action. FAIL if the button changes width, or if a spinner
   appears for an action that completes in under 400ms.
5. Focus a form field, type an invalid value, keep focus. FAIL if an error appears before blur.
6. Trigger a validation error. FAIL if content below the field shifts down when the message
   appears.
7. Scroll a counter into view, then scroll away and back. FAIL if it re-animates.
8. Watch a counter closely during count-up. FAIL if the digits shift horizontally (missing
   tabular-nums) or if the final value is not the exact target.
9. Hover across a row of five tooltip triggers quickly. FAIL if every one opens after a full delay
   (no group warm window), or if they all open instantly on first hover.
10. Open a tooltip with the keyboard (Tab to trigger). FAIL if it does not appear. Press Escape.
    FAIL if it does not close.
11. Reload with a custom cursor present. FAIL if the native cursor disappears before the custom one
    is painted, even for one frame.
12. Resize the window while a magnetic element is present, then hover it. FAIL if the pull centre
    is offset from the element (stale cached rect).
13. Hover a magnetic button and click at the edge of its travel. FAIL if the click misses because
    the hit area did not move with the visual.
14. Enable `prefers-reduced-motion: reduce`. FAIL if any element still travels, if the custom
    cursor still renders, or if a state change becomes invisible because the only indication was
    motion.
15. Switch to a touch device or emulate coarse pointer. FAIL if tooltips, tilt, magnetic or custom
    cursor are still active.
16. Throttle CPU 4x and record a Performance trace while moving the pointer for 5 seconds. FAIL if
    frame time exceeds 16ms for more than 3 consecutive frames, or if `Layout` appears inside the
    pointer-move flame chart at all.
17. Enable Paint Flashing and hover every interactive element. FAIL if large regions repaint on a
    hover that should only composite.
18. Trigger a copy-to-clipboard. FAIL if focus moves, if the confirmation lasts under 1s or over
    3s, or if nothing is announced to assistive tech.
19. Count signature interactions in one viewport. FAIL if more than one (magnetic + tilt + custom
    cursor + scramble on the same screen).
20. Trigger an action that fires several feedback events at once. FAIL if press, sound, toast and
    counter all start on the same frame.

## Scoring rubric

| # | Criterion | Weight | 0 | 1 | 2 |
|---|---|---:|---|---|---|
| 1 | Keyboard parity | 12 | Hover-only affordances exist | Reachable but focus ring weak or inconsistent | Every hover treatment mirrored on `:focus-visible`, focus order correct |
| 2 | Compositor discipline | 10 | Animates width/height/top/left, or `transition: all` present | Transform-only but `will-change` left on permanently | Transform/opacity only, `will-change` added and removed, no layout in pointer traces |
| 3 | Treatment differentiation | 10 | Cards, buttons and links share one hover treatment | Two treatments across three element types | Distinct treatment per element role, consistently applied |
| 4 | Counter correctness | 8 | No tabular figures, value drifts off target | Tabular figures but no aria-label or re-animates on re-entry | Tabular, exact final value, aria-label set immediately, fires once |
| 5 | Loading and progress honesty | 8 | Spinner on sub-400ms actions, or button resizes | Correct thresholds but indeterminate where progress is knowable | Nothing under 400ms, determinate where possible, width locked |
| 6 | Form validation timing | 8 | Validates on keystroke | Validates on blur but layout shifts on error | Blur validation, reserved message height, invalid state suppressed while focused |
| 7 | Tooltip behaviour | 8 | No delay, or no keyboard access | Delay present but no group warm window, or no Escape | Group delay, focus open, Escape close, disabled on coarse pointer |
| 8 | Cursor and magnetic safety | 10 | Native cursor hidden with no replacement painted, or active on touch | Guarded on touch but stale rects on resize/scroll | Guarded on coarse pointer and reduced motion, rects re-measured, hit area moves with visual |
| 9 | Reduced motion | 10 | No handling | CSS block present but JS effects still run | CSS and JS both guarded, 1ms not 0, state changes remain legible |
| 10 | rAF and listener architecture | 8 | 3+ independent loops, per-element listeners | One loop but per-element listeners | Single shared loop, delegated listeners, cached geometry |
| 11 | Restraint | 8 | 3+ signature interactions per viewport | 2 per viewport | At most 1, everything else plain |
| 12 | Throttled performance | 10 | Drops frames at 4x CPU throttle | Occasional drops under 3 consecutive frames | Holds under 16ms throughout |

**Total: 110 points. Ship threshold: 83 (75%). Any 0 in criteria 1, 8, 9 or 12 is an automatic NO SHIP regardless of total.**

## Common false passes

1. **The "it feels smooth" pass.** Everything is fluid on an M-series laptop at 120Hz. The
   implementation reads `getBoundingClientRect()` inside `pointermove` and runs three rAF loops.
   Throttle CPU 4x and it collapses. Always test throttled; a fast machine hides the entire class
   of geometry-per-frame bugs.

2. **The "we support reduced motion" pass.** A `@media (prefers-reduced-motion: reduce)` block
   exists and zeroes CSS durations. But the custom cursor, magnetic pull, tilt and scramble are all
   JS-driven and have no `matchMedia` guard, so they run at full strength. Check the JS, not just
   the CSS. This is the single most common false pass in this category.

3. **The "accessible toggle" pass.** The switch looks perfect and animates beautifully. It is a
   `div` with a click handler and a `data-on` attribute. A screen reader announces nothing. Check
   for `role="switch"` and `aria-checked`, not visual correctness.

4. **The "counter works" pass.** The number counts up smoothly and stops at 1,247. It is missing
   `tabular-nums`, so the container width oscillates during the count and the layout beside it
   twitches. On a screen reader it announces a stream of intermediate values. Watch the edges of
   the box, not the number.

5. **The "focus styles present" pass.** `:focus` is styled, but `outline: none` is set on
   `:focus-visible` or the styling is a 1px outline in a colour 1.2:1 against the background.
   Technically present, practically invisible. Measure the contrast of the focus indicator.

6. **The "custom cursor is fine" pass.** It works perfectly after the first pointer move. On page
   load, `cursor: none` is already applied while the replacement is still at opacity 0, so for the
   first few hundred milliseconds there is no pointer at all. Reload and watch the very first
   frame.

7. **The "magnetic buttons work" pass.** They do, until the page scrolls. The rects were cached at
   init and never re-measured, so after scrolling the pull centre sits where the button used to be.
   Scroll, then hover.

8. **The "no jank" pass with permanent `will-change`.** Frame times are excellent because
   `will-change: transform` sits on 200 elements. GPU memory is exhausted, and on a mid-range
   Android the whole page becomes slower, including scrolling. Count elements with `will-change` at
   rest.

9. **The "tooltips are accessible" pass.** They open on focus and close on Escape. They are also
   still active on touch, where there is no hover, so the first tap opens a tooltip that covers the
   control the user was trying to press. Emulate a coarse pointer.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| Jank on pointer move | Geometry read per frame | Cache rects at init, re-measure on `resize` and `scroll` only |
| Multiple loops fighting | Each feature owns a rAF | Consolidate into one shared scheduler with a subscriber set |
| Reduced motion ignored by JS effects | Guard exists only in CSS | Add `matchMedia("(prefers-reduced-motion: reduce)")` early-return to every JS effect initialiser |
| Layout shift on button loading | Content swap changes width | Lock `minWidth` from the measured rect before swapping |
| Layout shift on validation error | Message inserted into flow | Reserve `min-height` on the message element permanently |
| Counter box twitches | Proportional figures | `font-variant-numeric: tabular-nums` |
| Counter announces intermediate values | Live text node updated per frame | Set `aria-label` to the final value at start; animate visual text only |
| Cursor missing on first paint | `cursor: none` applied before replacement is visible | Gate `cursor: none` behind a `[data-visible="true"]` state on the replacement |
| Magnetic centre drifts | Stale cached rect | Re-measure on scroll and resize |
| Click misses magnetic button | Only an inner label is translated | Translate the interactive element itself |
| Everything looks the same | One hover treatment reused everywhere | Assign treatment by element role; keep a documented mapping |
| GPU memory pressure | Permanent `will-change` | Add on interaction start, remove on settle or transitionend |
| Tooltip blocks control on touch | No pointer guard | Disable the tooltip system entirely under `(pointer: coarse)` |
| Feedback reads as one flash | All events at t=0 | Offset: press 0ms, sound 0ms, toast 80ms, counter 120ms |

## Verdict format

Return exactly this shape:

```
SCORE: <n>/110 (<pct>%)

| # | Criterion | Band | Note |
|---|---|---|---|
| 1 | Keyboard parity | 0/1/2 | <one line of evidence> |
... all 12 rows ...

AUTOMATIC FAILURES: <list any 0 in criteria 1, 8, 9, 12, or "none">

BLOCKING ISSUES
1. <issue> - <file:line or DevTools evidence> - <required fix>
2. ...

NON-BLOCKING
- <issue> - <suggested fix>

EVIDENCE NOT OBTAINED
- <any check you could not run, and why>

SHIP
```
or
```
NO SHIP
```
