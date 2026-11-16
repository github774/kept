---
name: modular-type-systems
description: "Use when making typographic hierarchy decisions: scale ratio selection, line-height calculation, measure control, letter-spacing rules, font pairing, and optical alignment."
---

# Modular Type Systems

## When to use this
- You need to pick a scale ratio and number of hierarchy levels for a specific content type.
- You are tuning line-height relative to measure and font size.
- You need letter-spacing rules that change by size and weight.
- You are pairing fonts and need structural logic, not a list of trendy combos.
- You need real font stack recommendations with system-font fallbacks.
- Do NOT use this when you need the `clamp()` math for fluid scaling; use `fluid-type-scale` instead.

## Mental model
A modular type system starts with two decisions: a base size and a ratio. Every other size is derived by multiplying or dividing the base by the ratio. `base * ratio^n` gives you step n. This produces a mathematically coherent set of sizes where the visual distance between any two adjacent steps is consistent.

Line-height is not a fixed number. It is a function of three things: the font size, the measure (line length), and the typeface's x-height. Larger text needs tighter line-height (headings at 1.1-1.2). Longer lines need looser line-height (1.6-1.7 for 75ch body text). Short lines (30-40ch) can go tighter (1.4). The sweet spot for body text at 60ch measure is 1.5.

Letter-spacing follows the opposite curve from line-height: it opens up as size shrinks and tightens as size grows. Large display type (48px+) almost always needs negative tracking (-0.02em to -0.04em). Body text at 16px generally needs 0. Small text (12px) benefits from +0.01em to +0.02em. Weight also affects spacing: bold text at any size looks tighter than regular because the strokes fill more of the sidebearing, so bold often needs +0.01em more than regular at the same size.

Measure (line length) has been studied since the 1920s. 45-75 characters per line is the readable range, with 66 characters being the ideal cited by Bringhurst. In practice, 55-70ch is the working range for body text. Below 45ch (mobile single column), line-height can tighten. Above 75ch, reading comprehension drops measurably.

## Setup
No dependencies for the system itself. Font loading:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
```

For self-hosted (recommended for performance):
```bash
npm install @fontsource-variable/inter @fontsource-variable/source-serif-4
```
```js
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
```

## Core API
| Concept | Formula / Value | Notes |
|---|---|---|
| Scale step | `base * ratio^n` | n=0 is body, positive is up (headings), negative is down (captions). |
| Line-height (body) | `1.4 + (measure_ch - 45) * 0.008` | Approximate: 1.4 at 45ch, 1.5 at 58ch, 1.64 at 75ch. |
| Line-height (heading) | `1.1 + 0.1 * (1 / (size_px / 16))` | Tightens as size grows. ~1.1 at 48px, ~1.2 at 24px. |
| Measure | `max-width: 65ch` | Use `ch` unit, which is the width of the "0" glyph. |
| Letter-spacing | See size/weight table below | Negative above 24px, zero at 16px, positive below 14px. |
| Optical margin | `text-indent: -0.05em` on large left-aligned type | Compensates for whitespace inside the glyph bounding box. |

## Recipes

### 1. Complete hierarchy with Major Third (1.25)
A full set of type styles for a content-heavy site.
```css
:root {
  --font-body: 'Inter', 'Helvetica Neue', Arial, sans-serif;
  --font-heading: 'Inter', 'Helvetica Neue', Arial, sans-serif;
  --base: 1rem;
  --ratio: 1.25;
}

/* Scale steps */
.text-xs     { font-size: calc(var(--base) / var(--ratio) / var(--ratio)); } /* 10.24px */
.text-sm     { font-size: calc(var(--base) / var(--ratio)); }                /* 12.8px */
.text-base   { font-size: var(--base); }                                      /* 16px */
.text-md     { font-size: calc(var(--base) * var(--ratio)); }                /* 20px */
.text-lg     { font-size: calc(var(--base) * var(--ratio) * var(--ratio)); } /* 25px */
.text-xl     { font-size: calc(var(--base) * 1.953); }                       /* 31.25px */
.text-2xl    { font-size: calc(var(--base) * 2.441); }                       /* 39.06px */
.text-3xl    { font-size: calc(var(--base) * 3.052); }                       /* 48.83px */

/* Line-height by role */
.text-xs, .text-sm   { line-height: 1.6; }
.text-base           { line-height: 1.5; }
.text-md             { line-height: 1.4; letter-spacing: -0.01em; }
.text-lg             { line-height: 1.3; letter-spacing: -0.015em; }
.text-xl             { line-height: 1.25; letter-spacing: -0.02em; }
.text-2xl            { line-height: 1.2; letter-spacing: -0.025em; }
.text-3xl            { line-height: 1.1; letter-spacing: -0.03em; }
```

### 2. Line-height calculator
Compute line-height from font size and measure.
```js
function lineHeight(fontSizePx, measureCh = 65) {
  if (fontSizePx >= 32) {
    return Math.max(1.05, 1.1 + 0.1 * (16 / fontSizePx));
  }
  const base = 1.4;
  const measureAdjust = (Math.min(measureCh, 75) - 45) * 0.008;
  const sizeAdjust = fontSizePx < 14 ? 0.1 : 0;
  return +(base + measureAdjust + sizeAdjust).toFixed(3);
}

console.log(lineHeight(16, 65));  // 1.56 (body at standard measure)
console.log(lineHeight(48, 20));  // 1.133 (large heading)
console.log(lineHeight(12, 40)); // 1.46 (caption, short measure)
console.log(lineHeight(16, 75)); // 1.64 (body at maximum measure)
```

### 3. Letter-spacing by size and weight
Concrete values for the tracking curve.
```css
/* Size-based tracking */
.display-xl  { font-size: 4rem;    letter-spacing: -0.04em; }
.display     { font-size: 3rem;    letter-spacing: -0.03em; }
.heading-1   { font-size: 2.5rem;  letter-spacing: -0.025em; }
.heading-2   { font-size: 2rem;    letter-spacing: -0.02em; }
.heading-3   { font-size: 1.5rem;  letter-spacing: -0.015em; }
.heading-4   { font-size: 1.25rem; letter-spacing: -0.01em; }
.body        { font-size: 1rem;    letter-spacing: 0; }
.caption     { font-size: 0.875rem; letter-spacing: 0.01em; }
.overline    { font-size: 0.75rem; letter-spacing: 0.05em; text-transform: uppercase; }

/* Weight adjustment: add +0.01em for semibold/bold at any size */
.heading-2.font-bold { letter-spacing: -0.01em; } /* -0.02 + 0.01 = -0.01 */
```

### 4. Measure-controlled prose container
Constrains line length with proper centering and padding.
```css
.prose {
  font-family: 'Source Serif 4', Georgia, 'Times New Roman', serif;
  font-size: 1.125rem;
  line-height: 1.6;
  max-width: 65ch;
  margin-inline: auto;
  padding-inline: clamp(1rem, 5vw, 3rem);
  word-break: break-word;
  overflow-wrap: break-word;
  hyphens: auto;
  hanging-punctuation: first allow-end last;
}

.prose > * + * {
  margin-block-start: 1em;
}

.prose h2,
.prose h3 {
  margin-block-start: 2em;
  margin-block-end: 0.5em;
}
```

### 5. Font pairing: structural contrast
Pair by contrast on exactly one axis (serif vs sans, geometric vs humanist), not two.
```css
/* Pairing 1: Sans heading + Serif body (contrast on classification) */
:root {
  --font-heading: 'Inter', system-ui, sans-serif;
  --font-body: 'Source Serif 4', 'Georgia', serif;
}

/* Pairing 2: Geometric sans heading + Humanist sans body (contrast on construction) */
:root {
  --font-heading: 'DM Sans', 'Futura', sans-serif;
  --font-body: 'Source Sans 3', 'Gill Sans', sans-serif;
}

/* Pairing 3: Mono heading + Sans body (contrast on spacing model) */
:root {
  --font-heading: 'JetBrains Mono', 'Courier New', monospace;
  --font-body: 'Inter', system-ui, sans-serif;
}

h1, h2, h3, h4 {
  font-family: var(--font-heading);
  font-weight: 700;
}

body, p, li {
  font-family: var(--font-body);
  font-weight: 400;
}
```

### 6. Optical margin alignment on large type
Visually aligns the leftmost stroke of large text rather than the bounding box.
```css
.hero-heading {
  font-size: 3.5rem;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
  text-indent: -0.04em;
  margin-left: -0.02em;
}

/* For quotes, the punctuation hangs outside the text block */
blockquote {
  hanging-punctuation: first last;
  text-indent: -0.45em; /* fallback for browsers without hanging-punctuation */
}

@supports (hanging-punctuation: first) {
  blockquote { text-indent: 0; }
}
```

### 7. System font stack (no web fonts needed)
A carefully ordered fallback stack that looks good on every OS.
```css
:root {
  /* Sans-serif: prefers the OS native UI font */
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;

  /* Serif: best available on each OS */
  --font-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;

  /* Monospace: prefers modern coding fonts */
  --font-mono: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
}
```

## Tuning the feel
The scale ratio sets the personality. Tight ratios (1.125) feel dense and professional; wide ratios (1.5) feel bold and editorial. Most projects need 5-7 steps. If you need more than 7, the ratio is too tight or the hierarchy is too deep. Flatten it.

Font weight distribution: use at most 3 weights. Regular (400) for body, medium or semibold (500-600) for emphasis, and bold (700) for headings. Using all of 300/400/500/600/700/800 creates visual noise.

x-height matching: when pairing fonts, match their x-height at the same pixel size. If the body font has a tall x-height (Inter, Roboto) and the heading font has a short one (Playfair Display), set the heading 5-10% larger to compensate.

## Performance
Every web font adds 15-40KB (WOFF2 per weight). Load only the weights and styles you use. Variable fonts are one file for all weights, typically 40-80KB total. Always use `font-display: swap` to prevent invisible text during load.

```css
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter-var.woff2') format('woff2');
  font-weight: 100 900;
  font-display: swap;
}
```

Preconnect to font origins. Self-host for best performance (avoids the cross-origin handshake).

## Accessibility
- Minimum body text: 16px. Never go below 14px for any readable content.
- Minimum contrast: 4.5:1 for body text, 3:1 for large text (24px regular / 18.66px bold).
- Line spacing: WCAG 1.4.12 requires support for at least 1.5x line-height on body text. Do not clip or hide overflow when users override line-height via browser extensions.
- Dyslexia-friendly: avoid fully justified text (ragged right is easier to track). Keep measure under 75ch. Avoid all-caps for more than 2-3 words.

## Anti-slop rules
- Never use more than 2 typefaces on a page. 3 is the absolute maximum and requires a clear structural reason (e.g. mono for code, serif for body, sans for UI).
- Never set body text wider than 75ch. 80ch+ is unreadable regardless of line-height.
- Never use the same line-height for headings and body. Headings need tighter leading (1.1-1.25). Body needs looser (1.5+).
- Never set letter-spacing on body text unless the typeface specifically needs it. Most well-designed fonts have correct default spacing at body sizes.
- Never pair two fonts from the same classification (two geometric sans, two transitional serifs). Contrast on zero axes means they just look like a mistake.
- Never use thin weights (100-300) for body text. They disappear on low-DPI screens and in bright ambient light.
- Never increase letter-spacing on large display type. Tracking should decrease as size increases; positive tracking on a 48px heading looks amateurish.
- Never ignore optical margin alignment on hero text larger than 32px. The leftmost glyph's whitespace creates a visible misalignment with the content below it.

## Checklist
- [ ] Scale ratio chosen for the content type (see tuning section).
- [ ] No more than 7 active scale steps.
- [ ] Line-height varies by role: tighter for headings, looser for body.
- [ ] Measure constrained to 45-75ch on all prose containers.
- [ ] Letter-spacing decreases with size (negative above 24px, zero at 16px, positive below 14px).
- [ ] At most 2 typefaces, paired on exactly one axis of contrast.
- [ ] Font files loaded with `font-display: swap` and preconnected.
- [ ] System font fallback stack ordered by OS coverage.
- [ ] Optical margin applied to hero/display type above 32px.
