# Hover Microinteraction Catalog - Reference

## Easing reference for hover effects

| Name | Value | Use for |
|---|---|---|
| Tight in-out | `cubic-bezier(0.65, 0, 0.35, 1)` | Wipes, slides, fills |
| Soft overshoot | `cubic-bezier(0.23, 1, 0.32, 1)` | Scale, tilt return |
| Snap in | `cubic-bezier(0.5, 0, 0, 1)` | Fast entrance, soft land |
| Bounce settle | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful scale pop |

## Gotchas

1. **`:hover` on parent affects children.** If a card has hover styles and contains a button with its own hover, both fire simultaneously. Use `:hover > .child` or scope carefully.
2. **`overflow: hidden` clips pseudo-elements.** Border-draw and slide-out effects need the parent to have `overflow: visible` (or the pseudo must be inside the overflow boundary).
3. **`background-clip: text` has a `-webkit-` prefix requirement.** Without `-webkit-background-clip: text`, the text gradient wipe shows nothing in Safari.
4. **`clip-path` transitions require matching shapes.** You cannot transition from `circle()` to `polygon()`. Both keyframes must use the same function with the same number of points.
5. **`transform-origin` on pseudo-elements.** The origin is relative to the pseudo-element, not the parent. If the pseudo fills the parent, the origins align. If it does not, math is needed.
6. **`text-decoration: underline` fights custom underlines.** Always set `text-decoration: none` before applying custom underline effects.
7. **Sticky hover on iOS Safari.** Even with `@media (hover: hover)`, programmatic `:hover` can sometimes stick after scroll on iOS. Adding an empty `touchstart` listener to the element is the historical workaround (forces Safari to properly handle hover/unhover events).

## Additional recipes

### Split text with per-character stagger on hover
Each character lifts and recolors individually, staggered from left to right.

```html
<span class="split-hover" data-text="HOVER ME">HOVER ME</span>
```

```js
document.querySelectorAll('.split-hover').forEach((el) => {
  const text = el.dataset.text;
  el.innerHTML = text.split('').map((char, i) =>
    char === ' '
      ? '<span style="display:inline-block;width:0.3em">&nbsp;</span>'
      : `<span style="display:inline-block;transition:transform 0.3s ${i * 30}ms cubic-bezier(0.23,1,0.32,1), color 0.3s ${i * 30}ms">${char}</span>`
  ).join('');
});
```

```css
@media (hover: hover) {
  .split-hover:hover span {
    transform: translateY(-3px);
    color: var(--accent, #ff4040);
  }
}
```

### Magnetic underline (underline follows cursor X position)
The underline position tracks the cursor's X within the link.

```js
document.querySelectorAll('.magnetic-underline').forEach((link) => {
  if (!matchMedia('(hover: hover)').matches) return;

  link.addEventListener('mousemove', (e) => {
    const rect = link.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    link.style.setProperty('--underline-x', `${x}%`);
  });
});
```

```css
@media (hover: hover) {
  .magnetic-underline {
    --underline-x: 50%;
    text-decoration: none;
    background-image: radial-gradient(circle at var(--underline-x) 100%, currentColor 0%, currentColor 30%, transparent 30%);
    background-size: 100% 1.5px;
    background-position: bottom;
    background-repeat: no-repeat;
    padding-bottom: 2px;
  }
}
```

### Diagonal wipe fill
Background fills diagonally from bottom-left to top-right using clip-path.

```css
@media (hover: hover) {
  .btn-diagonal {
    position: relative;
    overflow: hidden;
    z-index: 1;
  }
  .btn-diagonal::before {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--accent, #000);
    clip-path: polygon(0 100%, 0 100%, 0 100%);
    transition: clip-path 0.4s cubic-bezier(0.65, 0, 0.35, 1);
    z-index: -1;
  }
  .btn-diagonal:hover::before {
    clip-path: polygon(-10% 110%, 110% -10%, 110% 110%);
  }
}
```

### Outline-to-fill button
Border-only button fills solid on hover with text color inversion.

```css
@media (hover: hover) {
  .btn-outline-fill {
    border: 1.5px solid currentColor;
    background: transparent;
    color: var(--text, #000);
    position: relative;
    overflow: hidden;
    z-index: 1;
    transition: color 0.3s 0.05s;
  }
  .btn-outline-fill::before {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--text, #000);
    transform: scaleY(0);
    transform-origin: bottom;
    transition: transform 0.3s cubic-bezier(0.65, 0, 0.35, 1);
    z-index: -1;
  }
  .btn-outline-fill:hover::before {
    transform: scaleY(1);
  }
  .btn-outline-fill:hover {
    color: var(--bg, #fff);
  }
}
```

### Background fill wipe
Button background fills from left to right on hover.

```css
@media (hover: hover) {
  .btn-fill {
    position: relative; overflow: hidden; z-index: 1; transition: color 0.3s;
  }
  .btn-fill::before {
    content: ''; position: absolute; inset: 0;
    background: var(--fill-color, #000);
    transform: scaleX(0); transform-origin: left;
    transition: transform 0.35s cubic-bezier(0.65, 0, 0.35, 1); z-index: -1;
  }
  .btn-fill:hover::before { transform: scaleX(1); }
  .btn-fill:hover { color: white; }
}
```

### Text color gradient wipe
Text color fills with a gradient from left to right on hover.

```css
@media (hover: hover) {
  .text-gradient-wipe {
    background-image: linear-gradient(90deg, var(--accent, #ff4040) 50%, currentColor 50%);
    background-size: 200% 100%; background-position: 100% 0;
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
    transition: background-position 0.4s cubic-bezier(0.65, 0, 0.35, 1);
  }
  .text-gradient-wipe:hover { background-position: 0 0; }
}
```
