---
name: hover-microinteraction-catalog
description: "Use when implementing hover effects on links, buttons, cards, or nav items, including underline wipes, mask reveals, character shuffles, border draws, icon swaps, tilt, and glow follow."
---

# Hover Microinteraction Catalog

## When to use this
- Styling navigation links with animated underlines, wipes, or reveals.
- Adding tactile hover feedback to cards (tilt, glow, border draw).
- Building text hover effects like character shuffles, color wipes, or split reveals.
- Implementing icon transitions on button hover (swap, rotate, slide).
- Do NOT use this for full-page transitions between routes; see `page-transition-choreography` instead.

## Mental model
Every hover effect follows the same structure: a resting state, a transition in, a hovered state, and a transition out. The in and out can be different (a line wiping left-to-right in, then right-to-left out, creating a continuous directional flow). The trick that separates professional hover effects from amateur ones is that the exit animation is not the reverse of the entrance.

CSS hover effects use pseudo-elements (`::before`, `::after`), `clip-path`, `background-size`/`background-position`, and `transform`. JS hover effects use class toggling or inline style updates on `mouseenter`/`mouseleave`.

The timing sweet spot for hover effects is 200-350ms. Under 150ms reads as instant (might as well not animate). Over 400ms feels sluggish and blocks the user from scanning quickly.

Hover effects must degrade on touch. Most CSS `:hover` effects on touch trigger on tap and stick until the user taps elsewhere, which looks broken. Use `@media (hover: hover)` to scope all hover animations to pointer devices.

## Setup
Pure CSS for most effects. JS only for character shuffles, glow follow, and tilt.

```css
@media (hover: hover) {
  /* All hover styles go here */
}
```

## Core API

| Technique | Property | Key detail |
|---|---|---|
| Underline wipe | `background-size` + `background-position` | Animates from `0% 2px` to `100% 2px` |
| Clip reveal | `clip-path: inset()` | Animate `inset(0 100% 0 0)` to `inset(0)` |
| Pseudo slide | `::before` + `transform: scaleX()` | `transform-origin` controls direction |
| Color wipe | `background-clip: text` + gradient | Shift `background-position` on hover |
| Border draw | Four pseudo-element borders | Each animates width/height sequentially |
| Tilt | `transform: perspective() rotateX() rotateY()` | Driven by mouse position within element |
| Glow follow | `radial-gradient` at mouse position | CSS custom properties for position |
| Character shuffle | JS replaces characters per tick | Resolve one character at a time left to right |

## Recipes

### 1. Underline wipe (left-to-right in, right-to-left out)
A directional underline that enters from the left and exits to the right, creating continuous flow.

```css
@media (hover: hover) {
  .link-wipe {
    text-decoration: none;
    background-image: linear-gradient(currentColor, currentColor);
    background-size: 0% 1.5px;
    background-position: left bottom;
    background-repeat: no-repeat;
    transition: background-size 0.3s cubic-bezier(0.65, 0, 0.35, 1);
    padding-bottom: 2px;
  }
  .link-wipe:hover {
    background-size: 100% 1.5px;
    background-position: left bottom;
  }
}
```

For the "through" effect (enter left, exit right), use the pseudo-element variant:

```css
@media (hover: hover) {
  .link-through {
    position: relative;
    text-decoration: none;
  }
  .link-through::after {
    content: '';
    position: absolute;
    bottom: 0; left: 0;
    width: 100%; height: 1.5px;
    background: currentColor;
    transform: scaleX(0);
    transform-origin: right;
    transition: transform 0.35s cubic-bezier(0.65, 0, 0.35, 1);
  }
  .link-through:hover::after {
    transform: scaleX(1);
    transform-origin: left;
  }
}
```

### 2. Mask text reveal (slide up with color swap)
Hover reveals a differently-colored copy of the text sliding up from behind.

```html
<a class="link-reveal" data-text="About">About</a>
```

```css
@media (hover: hover) {
  .link-reveal {
    position: relative;
    display: inline-block;
    overflow: hidden;
    text-decoration: none;
  }
  .link-reveal::after {
    content: attr(data-text);
    position: absolute;
    top: 100%; left: 0;
    color: var(--accent, #ff4040);
    transition: transform 0.3s cubic-bezier(0.65, 0, 0.35, 1);
  }
  .link-reveal:hover::after {
    transform: translateY(-100%);
  }
  .link-reveal:hover {
    color: transparent;
    transition: color 0s 0.15s;
  }
}
```

### 3. Character shuffle / decode
Text randomizes to garbage characters then resolves left-to-right on hover.

```js
class TextScramble {
  constructor(el, { chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%', speed = 30 } = {}) {
    this.el = el;
    this.chars = chars;
    this.speed = speed;
    this.original = el.textContent;
    this.queue = [];
    this.frame = 0;
    this.rafId = null;

    if (!matchMedia('(hover: hover)').matches) return;

    el.addEventListener('mouseenter', () => this.scramble());
    el.addEventListener('mouseleave', () => { this.el.textContent = this.original; });
  }

  scramble() {
    const text = this.original;
    this.queue = [];
    for (let i = 0; i < text.length; i++) {
      this.queue.push({
        from: text[i],
        to: text[i],
        start: Math.floor(Math.random() * 20),
        end: Math.floor(Math.random() * 20) + 20,
      });
    }
    cancelAnimationFrame(this.rafId);
    this.frame = 0;
    this.update();
  }

  update() {
    let output = '';
    let complete = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const { from, to, start, end } = this.queue[i];
      if (this.frame >= end) {
        complete++;
        output += to;
      } else if (this.frame >= start) {
        output += this.chars[Math.floor(Math.random() * this.chars.length)];
      } else {
        output += from;
      }
    }
    this.el.textContent = output;
    if (complete < this.queue.length) {
      this.rafId = requestAnimationFrame(() => {
        this.frame++;
        this.update();
      });
    }
  }
}

document.querySelectorAll('.scramble').forEach(el => new TextScramble(el));
```

### 4. Border draw on card hover
A border that draws itself around the card, animated as four separate edges sequentially.

```css
@media (hover: hover) {
  .card-border {
    position: relative;
  }
  .card-border::before,
  .card-border::after {
    content: '';
    position: absolute;
    transition: transform 0.35s cubic-bezier(0.65, 0, 0.35, 1);
  }
  .card-border::before {
    top: 0; left: 0;
    width: 100%; height: 1px;
    background: currentColor;
    transform: scaleX(0);
    transform-origin: left;
  }
  .card-border::after {
    bottom: 0; right: 0;
    width: 100%; height: 1px;
    background: currentColor;
    transform: scaleX(0);
    transform-origin: right;
  }
  .card-border:hover::before,
  .card-border:hover::after {
    transform: scaleX(1);
  }
}
```


### 5. Icon swap (slide out, slide in)
The default icon slides out upward; the hover icon slides in from below.

```css
@media (hover: hover) {
  .btn-icon-swap {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }
  .btn-icon-swap .icon-default,
  .btn-icon-swap .icon-hover {
    transition: transform 0.3s cubic-bezier(0.65, 0, 0.35, 1);
  }
  .btn-icon-swap .icon-hover {
    position: absolute;
    right: 0;
    transform: translateY(120%);
  }
  .btn-icon-swap:hover .icon-default {
    transform: translateY(-120%);
  }
  .btn-icon-swap:hover .icon-hover {
    transform: translateY(0);
  }
}
```

### 6. Tilt card on hover (mouse-position-driven)
Card tilts based on where the mouse is within the element. Top-left tilts one way, bottom-right tilts the other.

```js
function tiltCard(el, { maxTilt = 8, perspective = 800, scale = 1.02 } = {}) {
  if (!matchMedia('(hover: hover)').matches) return;

  el.style.transition = 'transform 0.5s cubic-bezier(0.23, 1, 0.32, 1)';
  el.style.transformStyle = 'preserve-3d';

  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.transform = `perspective(${perspective}px) rotateX(${-y * maxTilt}deg) rotateY(${x * maxTilt}deg) scale(${scale})`;
    el.style.transition = 'transform 0.1s ease-out';
  });

  el.addEventListener('mouseleave', () => {
    el.style.transform = '';
    el.style.transition = 'transform 0.5s cubic-bezier(0.23, 1, 0.32, 1)';
  });
}

document.querySelectorAll('.tilt-card').forEach(tiltCard);
```

### 7. Spotlight / glow follow
A radial gradient follows the cursor within the card, creating a spotlight effect.

```css
.glow-card {
  --glow-x: 50%;
  --glow-y: 50%;
  position: relative;
  overflow: hidden;
}
.glow-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    300px circle at var(--glow-x) var(--glow-y),
    rgba(255, 255, 255, 0.08),
    transparent 60%
  );
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}
@media (hover: hover) {
  .glow-card:hover::before { opacity: 1; }
}
```

```js
document.querySelectorAll('.glow-card').forEach((card) => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--glow-x', `${e.clientX - rect.left}px`);
    card.style.setProperty('--glow-y', `${e.clientY - rect.top}px`);
  });
});
```

### 8. Image peek on link hover
A small image appears near the cursor when hovering a link.

```js
function imagePeek(links) {
  if (!matchMedia('(hover: hover)').matches) return;

  const preview = document.createElement('div');
  preview.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;width:240px;height:160px;overflow:hidden;opacity:0;transition:opacity 0.25s;transform:translate(20px,-50%)';
  preview.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.style.cssText = 'width:100%;height:100%;object-fit:cover';
  preview.appendChild(img);
  document.body.appendChild(preview);

  links.forEach((link) => {
    link.addEventListener('mouseenter', () => {
      const src = link.dataset.image;
      if (!src) return;
      img.src = src;
      preview.style.opacity = '1';
    });
    link.addEventListener('mouseleave', () => {
      preview.style.opacity = '0';
    });
    link.addEventListener('mousemove', (e) => {
      preview.style.left = `${e.clientX}px`;
      preview.style.top = `${e.clientY}px`;
    });
  });
}

imagePeek(document.querySelectorAll('[data-image]'));
```

## Tuning the feel
- **Duration**: 200-350ms for hover in, 300-400ms for hover out. Slightly slower out feels more refined.
- **Easing (slide/wipe)**: `cubic-bezier(0.65, 0, 0.35, 1)` is a tight ease-in-out that starts and ends with purpose.
- **Easing (scale/tilt)**: `cubic-bezier(0.23, 1, 0.32, 1)` is a soft overshoot that settles naturally.
- **Tilt angle**: 5-10 degrees max. Above 12 degrees it looks like a bug.
- **Scale factor**: 1.01-1.04 for cards. Above 1.05 it breaks layout spacing.
- **Shadow on lift**: Start at `0 2px 8px rgba(0,0,0,0.08)`, end at `0 12px 40px rgba(0,0,0,0.12)`. Keep it subtle.
- **Underline thickness**: 1-2px. Above 2px it reads as a selected state, not a hover.

## Performance
- All CSS-only effects here are compositor-safe (`transform`, `opacity`, `clip-path` on promoted layers).
- `background-size` / `background-position` animations trigger paint but not layout. Acceptable for small elements like links.
- `clip-path` animation on large elements (full-screen cards) can be expensive. Test on mobile-class GPUs.

## Accessibility
```css
@media (prefers-reduced-motion: reduce) {
  .link-wipe, .link-through, .link-reveal, .btn-fill,
  .card-lift, .card-border, .btn-icon-swap,
  .link-through::after, .btn-fill::before { transition: none !important; }
}
```

- Hover effects must not convey essential information. They are visual feedback only.
- `:focus-visible` states must be equally prominent. Do not let hover styles overshadow focus rings.

## Anti-slop rules
1. Never use the same hover effect on every element. A site where every link has the same underline wipe reads as a template.
2. Never use `all` in `transition`. Specify exact properties.
3. Never exceed 400ms for a hover transition. Users scan links rapidly; slow hovers punish exploration.
4. Never animate `width`/`height` for underline effects. Use `transform: scaleX()` or `background-size`.
5. Never forget `@media (hover: hover)`. Touch devices show `:hover` after tap and it sticks.
6. Never use a reverse animation for exit that is identical to entrance played backward. The exit direction should continue the entrance direction (enter left, exit right).
7. Never apply tilt to elements with readable text. The perspective distortion makes text harder to read.
8. Never use more than two hover effects on one element simultaneously (e.g., tilt AND glow AND scale AND shadow). Pick one or two that complement each other.
9. Never animate `color` directly if you can use `background-clip: text` or a pseudo-element overlay; direct color transitions often flash an intermediate gray.

## Checklist
- [ ] All hover effects wrapped in `@media (hover: hover)`
- [ ] `prefers-reduced-motion` disables all transitions
- [ ] Exit animations are not just reversed entrances
- [ ] Duration is 200-350ms (not too fast, not sluggish)
- [ ] No `transition: all` anywhere
- [ ] `:focus-visible` styles are at least as prominent as hover
- [ ] Tilt/3D effects avoid text content areas
- [ ] Image peek has `pointer-events: none` and `aria-hidden`
