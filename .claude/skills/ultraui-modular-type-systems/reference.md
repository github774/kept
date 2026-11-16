# Modular Type Systems -- Reference

## Letter-spacing lookup table

| Size (px) | Weight 400 | Weight 600 | Weight 700 |
|---|---|---|---|
| 64+ | -0.04em | -0.03em | -0.025em |
| 48 | -0.03em | -0.02em | -0.015em |
| 32 | -0.02em | -0.015em | -0.01em |
| 24 | -0.015em | -0.01em | -0.005em |
| 20 | -0.01em | -0.005em | 0 |
| 16 | 0 | 0 | +0.005em |
| 14 | +0.005em | +0.01em | +0.01em |
| 12 | +0.01em | +0.015em | +0.02em |
| 10 | +0.02em | +0.025em | +0.03em |
| ALL CAPS (any) | +0.05em | +0.06em | +0.06em |

## Gotchas

1. **`ch` is not the average character width.** It is the width of the "0" glyph specifically. In proportional fonts, 65ch of body text is roughly 65-70 actual characters. This is close enough for measure control.
2. **Variable fonts can have different default optical sizes.** Some variable fonts include an `opsz` axis that adjusts stroke contrast by size. If present, set it: `font-variation-settings: 'opsz' 48;` for headings.
3. **`hanging-punctuation` is Safari-only as of 2024.** Use the `text-indent: -0.45em` fallback with `@supports`.
4. **Google Fonts injects render-blocking CSS if not loaded with `display=swap`.** Always append `&display=swap` to the URL, or self-host.
5. **`system-ui` maps to different fonts per OS.** macOS: SF Pro. Windows: Segoe UI. Linux: varies (often Cantarell or DejaVu Sans). Android: Roboto. This is usually fine but can cause layout shifts if metrics differ significantly. For pixel-exact cross-platform work, use a web font.
6. **Font-size inheritance means `rem` and `em` behave differently in nested elements.** Use `rem` for type scale sizes (relative to root), `em` for letter-spacing and line-height (relative to the element's own font-size).

## Font pairing recommendations (structural logic)

### Sans heading + Serif body
| Heading | Body | Contrast axis |
|---|---|---|
| Inter | Source Serif 4 | Classification (sans vs serif) |
| DM Sans | Lora | Classification + construction (geometric vs calligraphic) |
| Space Grotesk | Literata | Classification + historical period |

### Geometric heading + Humanist body
| Heading | Body | Contrast axis |
|---|---|---|
| DM Sans | Source Sans 3 | Construction (geometric vs humanist) |
| Outfit | Nunito Sans | Construction (hard geometry vs soft humanist) |
| Space Grotesk | Inter | Construction (quirky geometric vs neutral humanist) |

### Display + Text (same family, different optical size)
| Display | Text | Notes |
|---|---|---|
| Source Serif 4 Display | Source Serif 4 Text | Same family, different opsz. Zero risk of clash. |
| Fraunces Display | Fraunces Text | Dramatic display weight with a readable text cut. |

## Additional recipes

### Scale generator (interactive)
Outputs CSS custom properties for any ratio.
```js
function generateScale(basePx, ratio, upSteps, downSteps) {
  const names = [];
  const values = [];
  for (let i = -downSteps; i <= upSteps; i++) {
    const size = basePx * Math.pow(ratio, i);
    const name = i === 0 ? 'base' : i > 0 ? `h${upSteps - i + 1}` : `sm-${Math.abs(i)}`;
    names.push(name);
    values.push({ name, px: Math.round(size * 100) / 100, rem: (size / 16).toFixed(3) });
  }
  const css = values.map(v => `  --type-${v.name}: ${v.rem}rem; /* ${v.px}px */`).join('\n');
  return `:root {\n${css}\n}`;
}

console.log(generateScale(16, 1.25, 5, 2));
```

### Prose defaults with all the details
Every typographic property for a long-form reading experience.
```css
.prose {
  font-family: 'Source Serif 4', Georgia, serif;
  font-size: clamp(1.0625rem, 0.97rem + 0.47vw, 1.25rem);
  line-height: 1.6;
  max-width: 65ch;
  margin-inline: auto;
  padding-inline: clamp(1rem, 5vw, 3rem);
  color: oklch(0.25 0.005 250);
  word-break: break-word;
  overflow-wrap: break-word;
  hyphens: auto;
  hanging-punctuation: first allow-end last;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-variant-numeric: oldstyle-nums proportional-nums;
  font-feature-settings: 'kern' 1, 'liga' 1;
}

.prose p + p {
  text-indent: 1.5em;
  margin-block-start: 0;
}

.prose > p:first-of-type {
  text-indent: 0;
}

.prose > p:first-of-type::first-line {
  font-variant-caps: small-caps;
  font-weight: 500;
}
```

### Weight distribution audit
Check that a design uses at most 3 weights.
```js
function auditWeights(cssText) {
  const weights = new Set();
  const matches = cssText.matchAll(/font-weight:\s*(\d+)/g);
  for (const m of matches) weights.add(parseInt(m[1]));
  const sorted = [...weights].sort((a, b) => a - b);
  const ok = sorted.length <= 3;
  return { weights: sorted, count: sorted.length, pass: ok };
}

console.log(auditWeights(`
  font-weight: 400;
  font-weight: 600;
  font-weight: 700;
  font-weight: 400;
`));
// { weights: [400, 600, 700], count: 3, pass: true }
```
