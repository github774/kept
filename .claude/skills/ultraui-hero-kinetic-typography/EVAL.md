---
name: hero-kinetic-typography-eval
description: Use when verifying that hero-kinetic-typography was actually implemented correctly. Adversarial audit, not a summary.
pairs_with: hero-kinetic-typography
---

# Eval: Oversized Kinetic Typography Hero

## What this audits
The most common shipped failure is a "kinetic type" hero where all characters appear simultaneously because the stagger value is too small to perceive, or where SplitText was called before fonts loaded, producing wrong line breaks that persist after the real font renders. The second failure is pointer effects running on touch devices, causing the hero text to jitter on every scroll gesture.

## Evidence required
- The built HTML file, opened at 1440x900 and 375x812
- Video recording (3-5 seconds) of the entrance animation at 0.5x speed to verify per-character stagger is visible
- Screenshot of the hero with DevTools Elements panel showing the split DOM structure (chars wrapped in line-mask divs)
- Chrome DevTools Performance recording of entrance + 3 seconds of pointer movement
- Console log on load confirming no errors
- Test with reduced motion enabled
- Test on a touch device (or DevTools touch simulation) confirming no pointer effects activate

## Automated checks

```bash
# PASS: SplitText used
grep -qE "SplitText" index.html && echo "PASS: SplitText" || echo "FAIL: no SplitText"

# PASS: fonts.ready gate
grep -qE "fonts\.ready" index.html && echo "PASS: font gate" || echo "FAIL: SplitText not gated behind fonts.ready"

# PASS: autoSplit enabled
grep -qE "autoSplit.*true\|autoSplit:\s*true" index.html && echo "PASS: autoSplit" || echo "FAIL: no autoSplit for resize"

# PASS: mask option used
grep -qE "mask.*['\"]lines['\"]" index.html && echo "PASS: line masks" || echo "FAIL: no mask option (no overflow clip)"

# PASS: stagger used
grep -qE "stagger" index.html && echo "PASS: stagger" || echo "FAIL: no stagger in animation"

# PASS: hover media query gate
grep -qE "hover.*hover\|pointer.*fine" index.html && echo "PASS: hover gate" || echo "FAIL: pointer effects not hover-gated"

# PASS: overwrite on pointer tweens
grep -qE "overwrite.*true\|overwrite:\s*true" index.html && echo "PASS: overwrite" || echo "FAIL: no overwrite on pointer tweens"

# PASS: reduced motion
grep -qE "prefers-reduced-motion" index.html && echo "PASS: reduced motion" || echo "FAIL: no reduced motion"

# PASS: split.revert() in teardown
grep -qE "\.revert\(\)" index.html && echo "PASS: revert" || echo "FAIL: no split.revert() for cleanup"

# FAIL: bounce/elastic easing on text
grep -qE "bounce\|elastic" index.html && echo "FAIL: bounce/elastic easing on text" || echo "PASS: no bounce/elastic"
```

### Runtime checks
```js
// Check split DOM structure exists
const splitChars = document.querySelectorAll('[class*="char"]');
console.assert(splitChars.length > 5, `FAIL: only ${splitChars.length} split chars found`);

// Check line masks have overflow:hidden
const masks = document.querySelectorAll('.line-mask, [class*="line"]');
masks.forEach((m, i) => {
  const ov = getComputedStyle(m).overflow;
  console.assert(ov === 'hidden' || ov === 'clip', `FAIL: line mask ${i} overflow is ${ov}`);
});

// Check font is loaded
const loaded = document.fonts.check('800 48px Inter');
console.assert(loaded, 'WARN: target font may not be loaded');

// Frame rate during pointer movement
let f=0;const s=performance.now();
function ct(){f++;if(performance.now()-s<2000)requestAnimationFrame(ct);else console.log(`${f} frames/2s = ${(f/2)|0}fps`);}
ct();
```

## Manual inspection protocol

1. Load page at 1440x900. Watch the entrance animation. FAIL if all characters appear at the same time (no visible stagger between characters).
2. Slow down the recording to 0.25x. FAIL if individual character entrance is not visible (each char should visibly slide up from behind its line mask).
3. Check descenders: look at any "g", "y", "p" in the headline. FAIL if the bottom of the letter is clipped by the line mask.
4. Resize the window from 1440px to 768px. FAIL if the text re-splits with a visible flash or layout jump (autoSplit should handle seamlessly).
5. Scroll down. FAIL if the subline words do not progressively reveal (opacity 0.15 to 1.0) as you scroll.
6. Move pointer across the headline. FAIL if characters do not react (weight shift, displacement, or no effect if hover-gated and testing on desktop).
7. Stop moving the pointer for 4 seconds. FAIL if no idle animation begins (weight wave, subtle Y drift).
8. Open DevTools Performance, record 5 seconds of pointer movement over the headline. FAIL if frame time exceeds 16ms for more than 3 consecutive frames.
9. Enable reduced motion. Reload. FAIL if any animation plays (all text should be immediately visible in final state).
10. Simulate touch device in DevTools. Reload. FAIL if pointer effects are active (weight animation on touch move).

## Scoring rubric

| # | Criterion | Weight | 0 (Fail) | 1 (Partial) | 2 (Pass) |
|---|---|---|---|---|---|
| 1 | Visible per-char/per-line stagger | 3 | All text appears at once | Stagger exists but too fast to perceive (<0.01s) | Clear wave visible at normal speed (0.02-0.04s) |
| 2 | Font-gated splitting | 3 | Split before fonts.ready; wrong line breaks | fonts.ready used but no autoSplit for resize | fonts.ready + autoSplit + onSplit callback |
| 3 | Masked line reveals | 2 | No overflow clip; text visible during approach | Overflow clip on some lines but not all | All lines have overflow:hidden masks |
| 4 | Scroll-scrubbed word reveal | 2 | No scroll interaction on subline | Scroll triggers but not smooth (binary) | Smooth scrub with per-word stagger |
| 5 | Pointer-reactive characters | 1 | No pointer effect | Effect exists but runs on touch devices | Hover-gated, overwrite:true, smooth interpolation |
| 6 | Entrance easing | 2 | Linear or bounce/elastic | Generic ease | power3.out or similar deceleration curve |
| 7 | Idle animation | 1 | No idle state | Idle runs but never pauses on interaction | Idle starts after timeout, pauses on pointer |
| 8 | prefers-reduced-motion | 2 | Not handled | Animation stops but text not in final state | Timeline jumped to end, all text visible |
| 9 | Descender preservation | 2 | g/y/p clipped by line mask | Some descenders visible, some clipped | All descenders fully visible |
| 10 | SPA teardown | 1 | No cleanup | Partial (timeline killed but splits not reverted) | split.revert() + timeline.kill() + listener removal |
| 11 | Performance (frame time) | 2 | Below 30fps during pointer reactivity | 30-55fps | 55fps+ |

**Total: 42 points. Ship threshold: 34+ with no criterion at 0.**

## Common false passes

1. **"Stagger" that is too fast to see.** A stagger of `0.005s` on 20 characters means the entire reveal spans 100ms. At 60fps that is 6 frames. The human eye cannot distinguish individual character entrances at this speed; it reads as a single simultaneous appearance.
2. **Line masks without descender accommodation.** `overflow: hidden` on a container with `line-height: 0.95` clips the bottom of "g" and "y". The entrance animation looks correct because the characters slide up into view from below the clip, but at rest the descenders are cut off.
3. **SplitText called before font load.** The text splits against the fallback font's character widths. Once the real font loads, the text re-renders but the split spans are sized for the wrong font. Line breaks shift but the split structure is stale, causing characters to overflow their masks or stack incorrectly.
4. **Pointer effects on mobile.** Without a `(hover: hover)` gate, `pointermove` events fire on scroll on mobile, causing every character to react to the user's thumb position as they scroll. The headline visually jitters on every swipe.
5. **`overwrite` not set on pointer tweens.** Each `pointermove` event creates a new tween per character. At 60fps, that is 60 * 20 = 1200 tweens per second. GSAP's default `overwrite: false` queues all of them, creating a cascade of fighting animations and eventually consuming all available memory.
6. **autoSplit without onSplit callback.** When the browser re-splits on resize, the old GSAP animation targets become stale (they reference DOM nodes that SplitText just replaced). The new split chars start in their natural position (visible), so the entrance animation never applies to them, and resizing the window during the entrance reveals a partially-animated state.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| No visible stagger | Stagger value too low | Increase to 0.02-0.03s per character |
| Wrong line breaks | Split before font load | Gate behind `document.fonts.ready.then(...)` |
| Descenders clipped | line-height too tight with overflow:hidden | Add `padding-bottom: 0.15em` to mask wrapper |
| Pointer jitter on mobile | No hover media query | Gate behind `matchMedia('(hover: hover) and (pointer: fine)')` |
| Memory explosion | No overwrite on pointer tweens | Add `overwrite: true` to every per-char pointer tween |
| Stale targets after resize | autoSplit replaces DOM, old tweens reference dead nodes | Re-create tweens in `onSplit` callback |
| Bounce easing on text | Wrong easing choice | Replace with `power3.out` or `power4.out` |

## Verdict format
```
## Kinetic Type Hero Audit

| # | Criterion | Score |
|---|---|---|
| 1 | Visible per-char stagger | X/2 |
| ... | ... | ... |

**Total: XX / 42**
**Blocking issues:** [list or "none"]
**SHIP / NO SHIP**
```
