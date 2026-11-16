---
name: dark-mode-theming
description: "Use when implementing dark mode: surface elevation, brand color adaptation, image handling, system preference detection with manual override, and avoiding FOUC."
---

# Dark Mode Theming

## When to use this
- You are implementing a light/dark theme toggle with system preference detection.
- You need to adapt brand colors, images, and illustrations for dark surfaces.
- You want elevation conveyed through lightness rather than shadows.
- You need to prevent the flash of wrong theme on page load (FOUC).
- Do NOT use this when you need to generate the color palette itself; use `color-oklch-palettes` instead.

## Mental model
Dark mode is not inverting your stylesheet. It is a separate design surface with its own rules. Three principles govern it.

First: elevation is lightness, not shadow. In light mode, higher surfaces are lighter and cast shadows. In dark mode, higher surfaces are lighter too, but shadows are invisible (dark on dark). Instead, each elevation level gets a slightly lighter background. Material Design 3 uses 5 levels: 0% tint for the base, then +5%, +8%, +11%, +14% tint applied to the surface color. This means your dark surface colors form a stack from near-black upward.

Second: brand colors must be desaturated. A brand blue at `oklch(0.55 0.2 250)` that pops on a white background will vibrate painfully on a near-black background. Reduce chroma by 20-30% and push lightness up by 0.1-0.15 for dark mode. Never use the same accent color in both modes.

Third: pure black (#000) is almost never correct. It creates too much contrast with text and makes OLED screens look like the content is floating in a void. Near-black (`oklch(0.14 0.005 250)`, roughly #1a1a1a to #1c1c1c) is the standard for a reason. The one exception is OLED-specific themes where battery savings justify true black; even then, use #000 only for the base surface.

## Setup
No dependencies. CSS custom properties and `prefers-color-scheme` media query.
```css
/* color-scheme tells the browser to style form controls, scrollbars, etc. */
:root { color-scheme: light dark; }
```

For the anti-FOUC blocking script (see recipe below):
```html
<!-- Must be in <head>, inline, blocking -->
<script>/* see recipe 5 */</script>
```

## Core API
| Concept | CSS | Notes |
|---|---|---|
| System preference | `@media (prefers-color-scheme: dark)` | Matches OS-level setting. |
| Color scheme hint | `color-scheme: light dark` | Tells browser to adapt UA styles (scrollbars, form controls, selection). |
| Data attribute toggle | `[data-theme="dark"]` | Manual override set by JS. |
| CSS custom property | `--color-surface: #fff` | Swapped per theme via selector. |
| Forced colors | `@media (forced-colors: active)` | Windows High Contrast. Do not override system colors. |
| Light-dark() | `color: light-dark(#111, #eee)` | CSS Color 5 shorthand. Chrome 123+, Firefox 120+, Safari 17.5+. |
| Transition | `transition: background-color 200ms, color 200ms` | Smooth theme switch. Apply to body or a wrapper. |

## Recipes

### 1. Full token set: light and dark
Complete surface, text, and border tokens for both modes.
```css
:root,
[data-theme="light"] {
  color-scheme: light;

  --surface-base: oklch(0.99 0.002 250);
  --surface-raised: oklch(0.97 0.002 250);
  --surface-overlay: oklch(0.99 0.002 250);
  --surface-sunken: oklch(0.95 0.002 250);

  --text-primary: oklch(0.20 0.005 250);
  --text-secondary: oklch(0.40 0.005 250);
  --text-tertiary: oklch(0.55 0.005 250);

  --border-default: oklch(0.88 0.005 250);
  --border-strong: oklch(0.75 0.005 250);

  --accent: oklch(0.55 0.20 250);
  --accent-text: oklch(0.99 0.00 0);
  --accent-subtle: oklch(0.93 0.05 250);
}

[data-theme="dark"] {
  color-scheme: dark;

  --surface-base: oklch(0.14 0.005 250);
  --surface-raised: oklch(0.18 0.005 250);
  --surface-overlay: oklch(0.22 0.005 250);
  --surface-sunken: oklch(0.11 0.005 250);

  --text-primary: oklch(0.93 0.005 250);
  --text-secondary: oklch(0.70 0.005 250);
  --text-tertiary: oklch(0.55 0.005 250);

  --border-default: oklch(0.28 0.005 250);
  --border-strong: oklch(0.40 0.005 250);

  --accent: oklch(0.70 0.15 250);
  --accent-text: oklch(0.15 0.00 0);
  --accent-subtle: oklch(0.25 0.06 250);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;

    --surface-base: oklch(0.14 0.005 250);
    --surface-raised: oklch(0.18 0.005 250);
    --surface-overlay: oklch(0.22 0.005 250);
    --surface-sunken: oklch(0.11 0.005 250);

    --text-primary: oklch(0.93 0.005 250);
    --text-secondary: oklch(0.70 0.005 250);
    --text-tertiary: oklch(0.55 0.005 250);

    --border-default: oklch(0.28 0.005 250);
    --border-strong: oklch(0.40 0.005 250);

    --accent: oklch(0.70 0.15 250);
    --accent-text: oklch(0.15 0.00 0);
    --accent-subtle: oklch(0.25 0.06 250);
  }
}
```

### 2. Elevation via surface tint (not shadow)
Dark mode card stack where each level is visibly higher.
```css
.card {
  background: var(--surface-raised);
  border: 1px solid var(--border-default);
}

.card .card-inner {
  background: var(--surface-overlay);
}

/* In dark mode, shadows are decorative at best, invisible at worst */
[data-theme="dark"] .card {
  box-shadow: none;
}

/* Light mode can keep shadows */
:root:not([data-theme="dark"]) .card {
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.06);
}
```

### 3. Image and illustration handling
Reduce brightness and contrast on images in dark mode. SVG illustrations get inverted fills.
```css
[data-theme="dark"] img:not([data-no-dim]) {
  filter: brightness(0.85) contrast(1.05);
}

[data-theme="dark"] img:not([data-no-dim]):hover {
  filter: brightness(1) contrast(1);
  transition: filter 200ms ease-out;
}

/* For decorative SVG illustrations with light fills */
[data-theme="dark"] .illustration-light {
  filter: invert(1) hue-rotate(180deg) brightness(0.9);
}

/* For screenshots: add a subtle border so they do not bleed into the background */
[data-theme="dark"] .screenshot {
  border: 1px solid var(--border-default);
  border-radius: 4px;
}

/* Transparent PNGs with dark content: give them a light backdrop */
[data-theme="dark"] .logo-on-transparent {
  background: oklch(0.95 0 0);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}
```

### 4. Theme toggle (React)
Full toggle logic with system preference detection and localStorage persistence.
```tsx
import { useEffect, useState, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system';
    return (localStorage.getItem('theme') as Theme) || 'system';
  });

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
    const root = document.documentElement;
    if (newTheme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', newTheme);
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (theme === 'system') {
        document.documentElement.removeAttribute('data-theme');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return { theme, setTheme };
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const options: Theme[] = ['light', 'dark', 'system'];
  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
```

### 5. Anti-FOUC blocking script
Inline in `<head>` to apply theme before first paint.
```html
<script>
(function() {
  var stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.setAttribute('data-theme', stored);
  }
})();
</script>
```

### 6. CSS light-dark() shorthand (modern browsers)
Uses the CSS Color 5 `light-dark()` function for simpler declarations.
```css
:root {
  color-scheme: light dark;
}

body {
  background: light-dark(oklch(0.99 0.002 250), oklch(0.14 0.005 250));
  color: light-dark(oklch(0.20 0.005 250), oklch(0.93 0.005 250));
}

.card {
  background: light-dark(oklch(0.97 0.002 250), oklch(0.18 0.005 250));
  border-color: light-dark(oklch(0.88 0.005 250), oklch(0.28 0.005 250));
}

.accent-text {
  color: light-dark(oklch(0.55 0.20 250), oklch(0.70 0.15 250));
}
```

### 7. Smooth theme transition
Animate the switch without transitioning every element individually.
```css
html.theme-transitioning,
html.theme-transitioning *,
html.theme-transitioning *::before,
html.theme-transitioning *::after {
  transition: background-color 300ms ease, color 300ms ease, border-color 300ms ease, fill 300ms ease, stroke 300ms ease !important;
  transition-delay: 0s !important;
}
```
```js
function switchTheme(newTheme) {
  document.documentElement.classList.add('theme-transitioning');
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  window.setTimeout(() => {
    document.documentElement.classList.remove('theme-transitioning');
  }, 350);
}
```

## Tuning the feel
Surface base lightness: `oklch(0.14-0.16)` for standard dark. `oklch(0.10-0.12)` for deep dark. `oklch(0.00)` for OLED. Each elevation step adds `+0.04` to lightness.

Accent color adaptation: take the light-mode accent, increase L by +0.10 to +0.15, decrease C by 20-30%. Test at both extremes: is the accent readable on the darkest surface? Is it too washed out on the lightest dark surface?

Transition duration: 200-300ms for the theme switch animation. Faster feels glitchy; slower feels laggy. The blocking script (recipe 5) prevents FOUC, so the transition is only for user-initiated switches, not initial load.

## Performance
CSS custom properties are resolved at computed-value time. Changing a property on `:root` triggers a full recalculation of styles on every element that references it. On a page with 1000+ elements, this can take 5-10ms. This is fine for a user-initiated theme switch (it happens once). Do not animate custom properties with `@property` registered types for theme switches; the recalculation cost would apply every frame.

The blocking script in `<head>` adds ~0.1ms to parse time. This is negligible. Do not defer it; the entire point is that it runs before first paint.

## Accessibility
- WCAG contrast requirements apply independently per theme. Test every text/surface pair in both modes.
- `color-scheme: dark` tells the browser to use dark-appropriate colors for system UI: scrollbars, form inputs, selection highlight. Without it, you get bright white scrollbars on a dark page.
- `@media (forced-colors: active)` overrides all custom colors with system colors. Never `!important` over system colors in forced-colors mode.
- Users who prefer dark mode often have light sensitivity. Avoid bright white flashes on interaction (button hover going to white, modals with white backgrounds).

```css
@media (forced-colors: active) {
  .card {
    border: 1px solid CanvasText;
    forced-color-adjust: none; /* only if you must, and test thoroughly */
  }
}
```

## Anti-slop rules
- Never invert your entire light theme and call it dark mode. Inversion flips semantic meaning (primary becomes tertiary, error becomes success-ish).
- Never use pure `#000000` as a dark surface unless explicitly targeting OLED power savings. Use `oklch(0.14 0.005 hue)` instead.
- Never keep the same shadow values in dark mode. Shadows on dark surfaces are invisible; replace them with lighter surface tints or subtle 1px borders.
- Never use the same brand accent color in both themes without testing. High-chroma colors that work on white often vibrate or become unreadable on dark surfaces.
- Never implement dark mode with a CSS `filter: invert(1)` on the whole page. It breaks images, videos, and any element with its own background.
- Never store theme preference in a cookie that requires server-side rendering to read. The blocking `<script>` approach with localStorage works universally and has no server dependency.
- Never transition every element on theme switch with `* { transition: all }`. Use the class-based approach (recipe 7) and limit to color-related properties.
- Never forget `color-scheme`. Without it, form controls, scrollbars, and selection highlights stay light-themed even on a dark page.

## Checklist
- [ ] `color-scheme: light dark` set on `:root`.
- [ ] Anti-FOUC blocking script in `<head>` (inline, not deferred).
- [ ] Three-way toggle: light / dark / system.
- [ ] System preference detected with `prefers-color-scheme` media query.
- [ ] Manual override stored in `localStorage` and applied via `data-theme` attribute.
- [ ] All text/surface contrast pairs verified at WCAG AA in both themes.
- [ ] Brand accent color desaturated and lightness-adjusted for dark mode.
- [ ] Images dimmed in dark mode with `brightness(0.85)`.
- [ ] Shadows removed or replaced with surface tint in dark mode.
- [ ] `@media (forced-colors: active)` tested; no system colors overridden.
