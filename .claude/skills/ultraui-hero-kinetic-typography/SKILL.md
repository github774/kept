---
name: hero-kinetic-typography
description: Use when building an oversized kinetic type hero with per-character choreography. Builds a complete hero section with SplitText-driven masked reveals, stagger sequences, scroll-scrubbed secondary lines, pointer-reactive letter effects, and idle animation.
category: hero
pairs_with: hero-kinetic-typography-eval
---

# Oversized Kinetic Typography Hero

## What this builds
A full-viewport hero dominated by large-scale text that enters with per-character or per-line choreography, reacts to scroll and pointer, and breathes when idle. Not a single fade-in of a text block -- each letter, word, or line is an independently animated element with its own timing offset, rotation, and opacity arc.

- GSAP SplitText splits headline into chars/words/lines with overflow-clip masks
- Multi-line choreographed entrance: each line slides up out of its mask in sequence
- Per-character stagger with slight rotation for the "typeset drop" feel
- Scroll-scrubbed secondary text that reveals word-by-word as the user scrolls
- Pointer-reactive weight or position shift on individual characters (desktop only)
- Idle loop: subtle variable-font weight wave or Y oscillation
- Pure DOM text: no canvas, no WebGL, fully accessible and SEO-visible

## When to use / when not to
- Use when the hero IS the typography -- the text is the visual, not a label on a visual.
- Use for portfolios, editorial sites, agencies, product launches where the headline carries the design.
- Use when the brand has a strong typeface (variable font preferred for weight animation).
- Do NOT use when the hero is primarily visual (3D scene, video, particles). Use `hero-3d-anime-js-render-framework`, `hero-webgl-shader-fullscreen`, or `hero-particle-text-formation`.
- Do NOT use for small body text animation. Splitting body paragraphs into hundreds of character spans is expensive and makes screen readers announce letter-by-letter. Keep kinetic type to headlines.
- Do NOT use for image-sequence scrubbing. Use `hero-video-scrub-apple`.

## Stack decision
| Dependency | Version | Why | Cheaper alternative |
|---|---|---|---|
| GSAP | 3.13+ | Timeline sequencing, ScrollTrigger, easing library. The industry standard for complex choreography. | anime.js v4 can animate per-character, but lacks SplitText equivalent and ScrollTrigger's pin/scrub. |
| SplitText | 3.13+ (free) | Splits text into char/word/line spans with overflow-clip mask wrappers. `autoSplit` handles resize re-splitting. Was paid, now free in GSAP 3.13. | Manual `<span>` wrapping per character. Works but breaks on resize (line breaks change), loses `autoSplit` / `mask` functionality. |
| ScrollTrigger | 3.13+ (free) | Scroll-scrubbed animation for the secondary reveal. Pin support if needed. | IntersectionObserver for trigger-only (no scrub), CSS `animation-timeline: view()` for simple scroll-linked opacity (no stagger control). |
| Variable font (optional) | Any with `wght` axis | Enables weight-wave animation: `font-variation-settings: 'wght'` animated per character. | Static font weights with opacity/transform-only animation. Still looks good, loses the glyph-morphing effect. |

See primitive `gsap-splittext-kinetic-type` for the SplitText API, split mechanics, and resize handling. This toolkit builds the complete hero on top of that foundation.

## Architecture

```
<section class="type-hero">
  <div class="type-hero__primary">
    <h1 class="headline">LINE ONE</h1>         <!-- SplitText: lines + chars, masked -->
    <h1 class="headline">LINE TWO</h1>         <!-- separate element per visual line -->
  </div>
  <div class="type-hero__secondary">
    <p class="subline">A sentence revealed word-by-word on scroll.</p>  <!-- SplitText: words -->
  </div>
  <div class="type-hero__cta">
    <a href="#" class="cta-btn">Get Started</a>
  </div>
</section>
```

**Lifecycle:**
1. **Font gate**: Wait for `document.fonts.ready` before splitting.
2. **Split**: `SplitText.create()` on headlines (chars + lines with mask) and subline (words).
3. **Entrance timeline**: `gsap.timeline()` sequences masked line reveals, per-char stagger, subline, and CTA.
4. **Scroll reveal**: ScrollTrigger scrubs the subline word reveal as the user scrolls.
5. **Pointer reactivity**: `pointermove` drives per-char weight shift or Y displacement (desktop only).
6. **Idle loop**: After entrance completes and no pointer activity, a gentle weight wave or Y oscillation runs.
7. **Teardown**: `split.revert()` restores original DOM. Timeline killed. Listeners removed.

## Build it: step by step

### Phase 1: HTML + CSS for oversized type hero

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinetic Type Hero</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  body{background:#faf9f6;color:#111;font-family:'Inter',system-ui,sans-serif;overflow-x:hidden}
  .type-hero{
    position:relative;min-height:100vh;
    display:flex;flex-direction:column;justify-content:center;
    padding:4rem clamp(1.5rem,5vw,6rem);
  }
  .headline{
    font-size:clamp(3rem,10vw,9rem);font-weight:800;
    line-height:0.95;letter-spacing:-0.04em;
    text-transform:uppercase;
    margin-bottom:0.1em;
  }
  .subline{
    font-size:clamp(1rem,2vw,1.5rem);font-weight:400;
    line-height:1.5;max-width:50ch;margin-top:2rem;
    color:#444;
  }
  .cta-btn{
    display:inline-block;margin-top:2.5rem;
    padding:0.8em 2em;font-size:1rem;font-weight:600;
    color:#faf9f6;background:#111;border:none;
    text-decoration:none;letter-spacing:0.02em;
    opacity:0;
  }
  /* SplitText mask overflow clips */
  .line-mask{overflow:hidden;display:block}
  .spacer{height:150vh}

  @media(prefers-reduced-motion:reduce){
    .headline,.subline,.cta-btn{opacity:1!important;transform:none!important}
  }
</style>
</head>
<body>
<section class="type-hero" id="type-hero">
  <div class="type-hero__primary" aria-label="Hero headline">
    <h1 class="headline" id="line1">MOTION</h1>
    <h1 class="headline" id="line2">DEFINES</h1>
    <h1 class="headline" id="line3">CRAFT</h1>
  </div>
  <div class="type-hero__secondary">
    <p class="subline" id="subline">Every letter has weight. Every transition has intent. This is typography that moves with purpose.</p>
  </div>
  <a href="#" class="cta-btn" id="cta">Explore the work</a>
</section>
<div class="spacer"></div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/SplitText.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrollTrigger.min.js"></script>
<script>
gsap.registerPlugin(SplitText, ScrollTrigger);
</script>
</body>
</html>
```

### Phase 2: Font-gated text splitting

```js
document.fonts.ready.then(() => {
  // Split headlines into chars with line-level masks
  const headlineSplits = [];
  document.querySelectorAll('.headline').forEach(el => {
    const split = SplitText.create(el, {
      type: 'chars,lines',
      mask: 'lines',       // wraps each line in an overflow:hidden clip
      autoSplit: true,      // re-splits on resize/font change
      onSplit(self) {
        // Re-create entrance animation on re-split
        gsap.set(self.chars, { yPercent: 110, rotate: 5, opacity: 0 });
      }
    });
    headlineSplits.push(split);
  });

  // Split subline into words
  const sublineSplit = SplitText.create('#subline', {
    type: 'words',
    autoSplit: true,
    onSplit(self) {
      gsap.set(self.words, { opacity: 0.15 });
    }
  });

  // Phases 3-7 run inside this font.ready callback
});
```

### Phase 3: Choreographed entrance timeline

```js
  const entranceTl = gsap.timeline({
    defaults: { ease: 'power3.out', duration: 0.8 }
  });

  // Line 1: chars slide up from behind mask with rotation
  entranceTl.from(headlineSplits[0].chars, {
    yPercent: 110,
    rotate: 5,
    opacity: 0,
    stagger: 0.025,
    duration: 0.9,
  });

  // Line 2: overlapping start, chars from opposite rotation
  entranceTl.from(headlineSplits[1].chars, {
    yPercent: 110,
    rotate: -3,
    opacity: 0,
    stagger: 0.02,
    duration: 0.85,
  }, '-=0.5');

  // Line 3: fastest stagger, minimal rotation
  entranceTl.from(headlineSplits[2].chars, {
    yPercent: 110,
    rotate: 2,
    opacity: 0,
    stagger: 0.018,
    duration: 0.8,
  }, '-=0.4');

  // CTA button fades in after all text
  entranceTl.to('#cta', {
    opacity: 1,
    duration: 0.6,
    ease: 'power2.out',
  }, '-=0.2');
```

### Phase 4: Scroll-scrubbed word reveal on subline

```js
  gsap.to(sublineSplit.words, {
    opacity: 1,
    stagger: 0.1,
    scrollTrigger: {
      trigger: '#type-hero',
      start: 'top top',
      end: 'bottom center',
      scrub: 1,       // smooth 1-second interpolation
    },
  });
```

### Phase 5: Pointer-reactive character effects (desktop only)

```js
  const isHoverDevice = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (isHoverDevice) {
    const allChars = headlineSplits.flatMap(s => Array.from(s.chars));

    // Pre-compute character center positions
    let charCenters = [];
    function computeCenters() {
      charCenters = allChars.map(el => {
        const rect = el.getBoundingClientRect();
        return { el, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
      });
    }
    computeCenters();
    window.addEventListener('resize', computeCenters);

    const RADIUS = 200; // px influence radius
    const MAX_WEIGHT = 900;
    const MIN_WEIGHT = 400;
    const BASE_WEIGHT = 800;

    document.addEventListener('pointermove', (e) => {
      const mx = e.clientX, my = e.clientY;
      charCenters.forEach(({ el, cx, cy }) => {
        const dist = Math.hypot(mx - cx, my - cy);
        if (dist < RADIUS) {
          const t = 1 - dist / RADIUS; // 1 at cursor, 0 at edge
          const weight = BASE_WEIGHT + (MAX_WEIGHT - BASE_WEIGHT) * t;
          gsap.to(el, { fontVariationSettings: `'wght' ${Math.round(weight)}`, duration: 0.3, overwrite: true });
        } else {
          gsap.to(el, { fontVariationSettings: `'wght' ${BASE_WEIGHT}`, duration: 0.5, overwrite: true });
        }
      });
    }, { passive: true });
  }
```

### Phase 6: Idle weight wave

```js
  let idleTimeout;
  let idleAnim;

  function startIdle() {
    if (!isHoverDevice) return;
    const allChars = headlineSplits.flatMap(s => Array.from(s.chars));
    idleAnim = gsap.timeline({ repeat: -1 });
    idleAnim.to(allChars, {
      fontVariationSettings: `'wght' 900`,
      duration: 1.2,
      ease: 'sine.inOut',
      stagger: { each: 0.06, from: 'start', repeat: 1, yoyo: true },
    });
  }

  function resetIdleTimer() {
    clearTimeout(idleTimeout);
    if (idleAnim) { idleAnim.kill(); idleAnim = null; }
    idleTimeout = setTimeout(startIdle, 3000);
  }

  document.addEventListener('pointermove', resetIdleTimer, { passive: true });
  entranceTl.then(() => resetIdleTimer());
```

### Phase 7: Reduced motion and teardown

```js
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  function handleReduced(e) {
    if (e.matches) {
      entranceTl.progress(1); // jump to end state
      if (idleAnim) idleAnim.kill();
      clearTimeout(idleTimeout);
      gsap.set(sublineSplit.words, { opacity: 1 });
      gsap.set('#cta', { opacity: 1 });
    }
  }
  mq.addEventListener('change', handleReduced);
  handleReduced(mq);

  // Teardown for SPA
  function teardown() {
    entranceTl.kill();
    if (idleAnim) idleAnim.kill();
    clearTimeout(idleTimeout);
    headlineSplits.forEach(s => s.revert());
    sublineSplit.revert();
    ScrollTrigger.getAll().forEach(t => t.kill());
  }
```

### Phase 8: Scramble-decode variant entrance

An alternative entrance where characters cycle through random glyphs before resolving:

```js
// Requires ScrambleText plugin (also free since GSAP 3.13)
// <script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrambleTextPlugin.min.js"></script>
// gsap.registerPlugin(ScrambleTextPlugin);

const scrambleTl = gsap.timeline();
document.querySelectorAll('.headline').forEach((el, i) => {
  scrambleTl.from(el, {
    scrambleText: {
      text: el.textContent,
      chars: 'upperCase',
      revealDelay: 0.3,
      speed: 0.4,
    },
    duration: 1.2,
  }, i * 0.3);
});
```

## The full reference implementation

The complete working hero is Phases 1-7 assembled in order. The Phase 1 HTML shell contains all CSS and script tags. The `document.fonts.ready.then(() => { ... })` callback wraps Phases 2-7 in sequence. The entrance timeline (Phase 3) runs automatically on font load. ScrollTrigger (Phase 4) binds to the scroll. Pointer reactivity (Phase 5) and idle wave (Phase 6) are progressive enhancements gated behind hover capability.

Key integration detail: `SplitText.create()` with `autoSplit: true` and `onSplit` callback means the entrance animation state is re-applied whenever the browser re-splits text (on resize, font change). The `onSplit` callback sets the initial hidden state (`yPercent: 110, opacity: 0`) so the entrance tween always has the correct start values.

## Tuning the feel

| Parameter | Value | Rationale |
|---|---|---|
| Headline font size | `clamp(3rem, 10vw, 9rem)` | Large enough to command the viewport. Below 3rem, kinetic effects are invisible. Above 12rem, single words overflow on mobile. |
| Line height | 0.95 | Tight leading sells the "typeset" look. 1.0+ creates too much air between lines for display type. 0.85 risks descender/ascender clipping. |
| Letter spacing | -0.04em | Tight tracking for display type at large sizes. Loosens perceived weight. Below -0.06em, characters overlap. |
| Char stagger | 0.02-0.03s | Fast enough to read as a wave, slow enough that each character is perceivable. Below 0.01s, all chars appear simultaneously. Above 0.05s, the sequence drags. |
| Line overlap (position parameter) | `-=0.4` to `-=0.6` | Each line starts before the previous finishes. Zero overlap makes the sequence feel like slides. Full overlap (all at once) loses the choreography. |
| Entrance rotation | 2-5 degrees | Just enough to sell the "drop into place" without making text unreadable mid-flight. Above 8 degrees, the text looks like it is falling, not being placed. |
| Entrance duration per line | 0.8-1.0s | Long enough to read as deliberate motion. Below 0.5s, the entrance is a flash. Above 1.5s, it tests patience for the third line. |
| Entrance ease | `power3.out` | Strong deceleration gives weight. `linear` looks robotic. `bounce` or `elastic` is never appropriate for type. |
| Scroll scrub smoothing | `scrub: 1` | 1-second interpolation smooths out scroll jitter. `scrub: true` (0s) is too jittery for word-by-word reveal. `scrub: 3` is too laggy. |
| Pointer radius | 200px | Large enough to affect 3-5 characters at once. Below 80px, only the character directly under the cursor reacts. Above 400px, the whole line shifts uniformly. |
| Idle weight wave stagger | 0.06s per char | Creates a visible ripple through the word. Below 0.03s, the wave is too fast to perceive. Above 0.1s, the ripple takes too long to traverse a long word. |

## Variants

### 1. Blur-in reveal (Emil Kowalski signature)
Replace the masked slide-up with a blur-to-sharp transition per word:
```js
gsap.from(split.words, {
  filter: 'blur(8px)',
  opacity: 0,
  y: 20,
  stagger: 0.04,
  duration: 0.9,
  ease: 'power2.out',
});
```
Keep blur at the word level, not per-character. Per-char blur creates too many composited layers (one per blurred element).

### 2. 3D character flip
Characters rotate into view around their bottom edge:
```js
gsap.set('.headline', { perspective: 600 });
gsap.from(split.chars, {
  rotateX: -90,
  transformOrigin: '50% 100%',
  opacity: 0,
  stagger: 0.025,
  duration: 0.7,
  ease: 'power3.out',
});
```
Requires `perspective` on the parent for the 3D rotation to be visible. `transform-origin: 50% 100%` makes chars hinge from their baseline.

### 3. Color wipe / gradient reveal
Text starts as outline only, fills with color from left to right:
```css
.headline { -webkit-text-stroke: 1px currentColor; color: transparent; }
```
```js
gsap.to(split.chars, {
  color: '#111',
  '-webkit-text-stroke-color': 'transparent',
  stagger: 0.02,
  duration: 0.6,
  scrollTrigger: { trigger: '.headline', scrub: 1 },
});
```

### 4. Scramble-decode entrance
Characters cycle through random glyphs before resolving (see Phase 8). Best for tech/AI/cyberpunk brands. Use monospace font or `font-variant-numeric: tabular-nums` to prevent reflow during scramble.

### 5. Magnetic letter hover
Each character is subtly attracted toward the cursor position:
```js
document.addEventListener('pointermove', (e) => {
  charCenters.forEach(({ el, cx, cy }) => {
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 150) {
      const pull = (1 - dist / 150) * 8; // max 8px displacement
      gsap.to(el, { x: dx / dist * pull, y: dy / dist * pull, duration: 0.3, overwrite: true });
    } else {
      gsap.to(el, { x: 0, y: 0, duration: 0.5, overwrite: true });
    }
  });
});
```

## Performance budget

| Metric | Target | Lever |
|---|---|---|
| DOM elements from split | < 200 spans | Only split headlines (3 lines, ~20 chars). Never split body paragraphs. |
| Composited layers | < 15 | SplitText with mask creates one layer per line. Per-char animation does not promote each char unless `will-change` is applied. |
| JS bundle | ~70KB (GSAP core + SplitText + ScrollTrigger gzipped) | All free since GSAP 3.13. No additional dependencies. |
| Layout triggers | 0 per frame | Animate only `transform`, `opacity`, and `font-variation-settings`. Never `width`, `height`, `top`, `left`. |
| Frame time | < 8ms | Transform-only animations are compositor-driven. Variable font animation triggers paint but not layout; acceptable for < 50 chars. |
| LCP impact | Positive | The headline IS the LCP element. It is real DOM text, so LCP scores the text paint time. |

**What to cut first:** Remove pointer-reactive weight animation (the most expensive effect: per-char `fontVariationSettings` triggers paint per frame per character). Remove idle wave. Remove per-char stagger on the longest line (animate as words instead).

## Accessibility

- SplitText splits DOM text into spans. Screen readers may announce letter-by-letter. Fix: GSAP 3.13 `aria: 'auto'` on `SplitText.create()` adds `aria-hidden="true"` to the split spans and creates a visually-hidden copy with the full text for screen readers.
- For complex content inside split text (links, `<em>`, etc.), use `aria: 'hidden'` and manually add a visually-hidden duplicate paragraph.
- `prefers-reduced-motion` jumps the entrance timeline to its end state (all text visible, no animation). The scroll-scrubbed subline is set to full opacity.
- Focus management: if the CTA button is inside the hero, it must remain keyboard-focusable. SplitText does not affect tab order since it only wraps text nodes, not interactive elements.
- Variable-font weight animation is purely visual. Screen readers do not perceive weight changes. No accessibility impact.
- Respect the user: never split more than 3-4 headlines total. Aggressive splitting of long text blocks makes the page fragile on resize and harms the reading experience for everyone.

```js
// Accessibility: aria:auto in SplitText
SplitText.create('#line1', {
  type: 'chars,lines',
  mask: 'lines',
  aria: 'auto', // GSAP 3.13+ handles sr-only copy
  autoSplit: true,
});
```

## Anti-slop rules

1. DO NOT split text before web fonts load. Splitting against fallback font metrics produces wrong line breaks that persist even after the real font swaps in. Gate behind `document.fonts.ready`.
2. DO NOT apply `will-change: transform` to every split character. 50+ composited layers will tank mobile performance. Let the browser promote only during active animation.
3. DO NOT use `bounce` or `elastic` easing on text entrance. Typography never bounces. It settles. Use `power3.out` or `power4.out` for deceleration.
4. DO NOT animate `font-variation-settings` on more than ~50 characters simultaneously. Each change triggers a paint. 100+ characters with weight animation per frame drops below 30fps on mid-range devices.
5. DO NOT use per-character splitting for body paragraphs. A 200-word paragraph becomes 1000+ spans. Split paragraphs at the word or line level only.
6. DO NOT forget `overwrite: true` on pointer-reactive tweens. Without it, GSAP queues every tween from every `pointermove` event, creating hundreds of competing animations per second.
7. DO NOT run the scramble-decode effect with proportional fonts unless you accept layout shift. Random "W" swapping with "i" causes visible reflow. Use monospace for scramble, or ScrambleTextPlugin's `chars: 'upperCase'` with a font where all uppercase glyphs are similar width.
8. DO NOT forget to call `split.revert()` on SPA teardown. Unreleased SplitText instances leak DOM nodes (the wrapper spans persist after the component unmounts).
9. DO NOT animate the `.headline` element itself while also animating its split children. Parent transforms compound with child transforms, causing double-motion.
10. DO NOT set `line-height: 1` on split text with masked line reveals. The mask clips to the line height, and descenders (g, y, p) get cut off. Use at least `line-height: 0.95` with `padding-bottom: 0.1em` on the mask wrapper.
11. DO NOT stack per-char `filter: blur()` animation. Each blurred element becomes its own composited layer. 30 blurred chars = 30 layers. Blur at the word or line level.

## Integration notes

- **With `hero-3d-anime-js-render-framework`:** The kinetic type can live on the front layer of the 3D scene. Run the GSAP entrance timeline after the anime.js entrance completes. Partition elements: anime.js owns scene transforms, GSAP owns text-level transforms.
- **With `hero-webgl-shader-fullscreen`:** The kinetic type lives in `.hero__content` above the shader canvas. Ensure text contrast against the shader with `text-shadow` or a semi-transparent overlay.
- **With `lenis-smooth-scroll`:** No conflict. ScrollTrigger reads from Lenis's scroll proxy automatically.
- **Known conflict:** GSAP and CSS `transition` on the same element fight. Remove `transition` from any element that GSAP animates.
- **Known conflict:** `SplitText.create()` with `autoSplit: true` re-runs `onSplit` on every resize. If `onSplit` creates new GSAP tweens without killing old ones, they accumulate. Kill old tweens in `onSplit` before creating new ones.
- **With `stagger-orchestration`:** The primitive covers stagger timing theory. This toolkit applies it specifically to text choreography.

## Ship checklist

- [ ] `document.fonts.ready` gate before any `SplitText.create()` call
- [ ] `SplitText.create()` uses `autoSplit: true` for responsive re-splitting
- [ ] `aria: 'auto'` or manual sr-only text copy for accessibility
- [ ] Entrance timeline uses position parameter for overlapping line reveals
- [ ] Per-char stagger values produce visible wave (0.02-0.03s range)
- [ ] No `bounce` or `elastic` easing on text motion
- [ ] ScrollTrigger scrub on subline with `scrub: 1` smoothing
- [ ] Pointer effects gated behind `(hover: hover) and (pointer: fine)`
- [ ] `overwrite: true` on all pointer-reactive per-char tweens
- [ ] `prefers-reduced-motion` jumps all animation to end state
- [ ] `split.revert()` called on SPA teardown
- [ ] Variable-font weight animation limited to < 50 chars
- [ ] No `will-change` on individual characters, only on actively animating containers
- [ ] Line height and mask padding preserve descenders (g, y, p visible)
