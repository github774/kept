# Dark Mode Theming -- Reference

## Surface elevation scale (Material Design 3 model)

| Elevation | Light mode | Dark mode | Use case |
|---|---|---|---|
| 0 (base) | oklch(0.99 0.002 H) | oklch(0.14 0.005 H) | Page background |
| 1 (raised) | oklch(0.97 0.002 H) | oklch(0.18 0.005 H) | Cards, list items |
| 2 (overlay) | oklch(0.99 0.002 H) + shadow | oklch(0.22 0.005 H) | Dropdowns, popovers |
| 3 (sticky) | oklch(0.99 0.002 H) + shadow | oklch(0.24 0.005 H) | Sticky headers, FABs |
| 4 (dialog) | oklch(0.99 0.002 H) + shadow | oklch(0.27 0.005 H) | Modals, dialogs |

H = your neutral hue angle (typically 250 for cool, 50 for warm, 0 for true neutral).

## Gotchas

1. **`prefers-color-scheme` changes do not trigger on Safari if the user toggles system appearance while the tab is backgrounded.** The media query fires only when the tab becomes active again. Your JS listener handles this, but CSS-only dark mode may show the wrong theme momentarily.
2. **`color-scheme: dark` affects `<canvas>` default background.** A canvas with no explicit background will become dark. Set `canvas { background: white; }` if you need a white drawing surface regardless of theme.
3. **`light-dark()` requires `color-scheme` to be set.** Without `color-scheme: light dark` on the element or an ancestor, `light-dark()` always returns the first (light) value.
4. **localStorage is synchronous and blocking.** The anti-FOUC script relies on this. Do not replace it with an async API (IndexedDB, etc.) or the flash returns.
5. **CSS transitions on `color-scheme` are not supported.** The property snaps instantly. The class-based transition approach (recipe 7) works around this by transitioning the custom properties that `color-scheme` does not cover.
6. **Dark mode on Windows with High Contrast enabled overrides `color-scheme` entirely.** Test with both Windows High Contrast themes (black and white). Your custom dark mode tokens are ignored. This is correct behavior; do not fight it.

## Additional recipes

### Scoped dark section within a light page
Force a section to render dark regardless of page theme.
```css
.dark-section {
  color-scheme: dark;
  background: oklch(0.14 0.005 250);
  color: oklch(0.93 0.005 250);
}

.dark-section .card {
  background: oklch(0.18 0.005 250);
  border: 1px solid oklch(0.28 0.005 250);
}

.dark-section a {
  color: oklch(0.70 0.15 250);
}
```

### Dynamic meta theme-color
Update the browser chrome to match the theme (mobile Safari, Chrome Android).
```js
function updateMetaThemeColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const isDark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  meta.setAttribute('content', isDark ? '#1a1a1a' : '#fafafa');
}
```

### Picture element with dark-mode image source
Serve a different image asset per color scheme.
```html
<picture>
  <source srcset="/img/hero-dark.webp" media="(prefers-color-scheme: dark)">
  <img src="/img/hero-light.webp" alt="Hero illustration" width="800" height="400">
</picture>
```

### SVG favicon with dark mode support
An SVG favicon that adapts to system theme.
```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
```
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    rect { fill: #111; }
    @media (prefers-color-scheme: dark) {
      rect { fill: #eee; }
    }
  </style>
  <rect width="32" height="32" rx="4"/>
</svg>
```
