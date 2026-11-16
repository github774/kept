# Reference: Oversized Kinetic Typography Hero

## SplitText API quick reference (GSAP 3.13+)

See primitive `gsap-splittext-kinetic-type` for the full SplitText API. Key calls used in this toolkit:

| API | Signature | Note |
|---|---|---|
| `SplitText.create(target, vars)` | returns SplitText instance | Preferred v3.13+ entry point. |
| `vars.type` | `'chars'`, `'words'`, `'lines'`, or comma-separated combo | Which levels to split into. |
| `vars.mask` | `'chars'`, `'words'`, or `'lines'` | Wraps each unit in an overflow:hidden clip. The reveal effect. |
| `vars.autoSplit` | boolean | Re-splits on resize and font load changes. |
| `vars.onSplit(self)` | callback | Fires after each split. Use to set initial animation state on new elements. |
| `vars.aria` | `'auto'` or `'hidden'` | `'auto'`: adds aria-hidden to splits, creates sr-only copy. |
| `split.chars` | Element[] | Array of character wrapper elements. |
| `split.words` | Element[] | Array of word wrapper elements. |
| `split.lines` | Element[] | Array of line wrapper elements. |
| `split.revert()` | void | Restores original DOM. Call on teardown. |

## Easing selection guide for text

| Ease | Character | When to use |
|---|---|---|
| `power3.out` | Strong deceleration, "landing" | Default for masked reveals. Text drops into position. |
| `power4.out` | Very strong deceleration | Heavier headlines. Text arrives fast, settles slowly. |
| `power2.out` | Moderate deceleration | Lighter, faster reveals. Body text or word-level. |
| `sine.inOut` | Symmetric, gentle | Idle oscillation, weight waves. |
| `circ.out` | Sharp start, gradual end | Quick snaps. Character flips. |
| `none` (linear) | Uniform speed | Scroll-scrubbed reveals where easing comes from the scroll itself. |

**Never use:** `bounce`, `elastic`, `back` on text. Typography does not overshoot or oscillate. Physical objects bounce; letters are placed.

## Stagger timing calculator

```js
// Total entrance duration for a line of N characters
// entranceDuration = charDuration + (N - 1) * stagger
// Example: 20 chars, 0.025s stagger, 0.8s duration per char
// Total: 0.8 + 19 * 0.025 = 1.275s

function totalEntranceDuration(charCount, stagger, charDuration) {
  return charDuration + (charCount - 1) * stagger;
}

// To hit a target total duration:
function staggerForDuration(charCount, targetDuration, charDuration) {
  return (targetDuration - charDuration) / (charCount - 1);
}
// 20 chars, want 1.0s total, 0.8s per char:
// stagger = (1.0 - 0.8) / 19 = 0.0105s
```

## Variable font weight animation

Requires a variable font with a `wght` axis. Google Fonts with `wght` axis:
- Inter (100-900)
- Roboto Flex (100-1000, also has GRAD axis)
- Fraunces (100-900, also has SOFT, WONK)
- Recursive (300-1000)
- Plus Jakarta Sans (200-800)

```css
/* Weight animation in CSS (for idle/hover, no JS needed) */
@keyframes weightWave {
  0%, 100% { font-variation-settings: 'wght' 400; }
  50% { font-variation-settings: 'wght' 900; }
}
.char {
  animation: weightWave 1.6s ease-in-out infinite;
  animation-delay: calc(var(--char-index) * 60ms);
}
```

**Gotcha:** `font-variation-settings` overwrites ALL axes in every keyframe. If the font has `wght` and `wdth`, you must include both:
```css
font-variation-settings: 'wght' 900, 'wdth' 100;
```
Missing an axis resets it to the font's default, which can cause unexpected jumps.

**Better approach for `wght` only:** Use `font-weight` instead of `font-variation-settings` when only the weight axis is animated. `font-weight` does not affect other axes.

## Masked line reveal mechanics

SplitText's `mask: 'lines'` creates this DOM structure:
```html
<!-- Original: -->
<h1>HELLO WORLD</h1>

<!-- After SplitText.create(h1, { type: 'chars,lines', mask: 'lines' }): -->
<h1 aria-hidden="true">
  <div class="line-mask" style="overflow:hidden;display:block">
    <div class="line" style="display:block">
      <span class="char">H</span>
      <span class="char">E</span>
      <span class="char">L</span>
      <span class="char">L</span>
      <span class="char">O</span>
      <span class="char">&nbsp;</span>
      <span class="char">W</span>
      <span class="char">O</span>
      <span class="char">R</span>
      <span class="char">L</span>
      <span class="char">D</span>
    </div>
  </div>
</h1>
<!-- (aria: 'auto' also creates a visually-hidden copy outside the h1) -->
```

The mask wrapper clips the line. Animating the inner `.line` div's `yPercent: 110` (or the individual `.char` elements) slides them up from below the clip, creating the reveal.

## Common text layout gotchas after splitting

| Issue | Cause | Fix |
|---|---|---|
| Characters have visible gaps | SplitText sets `display: inline-block` on chars, which adds inter-character spacing | Set `letter-spacing: 0` on the original element, or use negative margin on `.char` |
| Line masks cut descenders | `overflow: hidden` clips content below the line box | Add `padding-bottom: 0.15em` to the mask wrapper |
| Text wraps differently after split | Inline-block chars with borders/padding change the line-breaking points | Avoid adding padding/border to individual chars; animate transform/opacity only |
| Split breaks after resize | `autoSplit: false` (or pre-3.13 version) | Use `autoSplit: true` (3.13+) |
| Links inside split text lose functionality | `aria: 'auto'` replaces content with aria-hidden + sr-only copy | For complex content with links: use `aria: 'hidden'` and manually create sr-only text |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Entrance plays but text jumps on completion | `from` values don't match CSS defaults | Set exact `from` state in `onSplit` callback |
| Characters flash visible before entrance | `onSplit` doesn't run on initial split | Add `gsap.set(self.chars, { opacity: 0 })` in `onSplit` |
| Scroll reveal skips words | `stagger` value on scroll tween too large for the scroll range | Reduce stagger or increase the ScrollTrigger end range |
| Weight wave looks choppy | Too many chars animated at `highp` fontVariationSettings | Reduce to 3 concurrent weight-shifting chars, let others hold base weight |
| Idle and pointer effects fight | Both write to the same property without `overwrite` | Use `overwrite: 'auto'` or `overwrite: true` |
