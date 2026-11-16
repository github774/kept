---
name: liquid-displacement-effects
description: Use when building hover-triggered image distortion, liquid transitions between images, RGB-shift effects, or WebGL displacement map-driven warps on DOM elements.
---

# Liquid Displacement Effects

## When to use this
- You want images that ripple, warp, or melt on hover.
- The design calls for a liquid transition between two images (portfolio, slider, reveal).
- You need an RGB channel-shift (chromatic aberration) effect tied to mouse movement or scroll.
- You are building a displacement-map-driven distortion on a DOM-synced WebGL plane.
- Do NOT use this for full-page turbulence or noise distortion applied to text -- see `svg-filter-effects` for that. This skill is about image-specific displacement driven by interaction.

## Mental model
Displacement maps work by shifting each pixel's position based on a lookup into a grayscale (or color) texture. The displacement map is a grayscale image where:
- 50% gray (128) = no displacement
- Lighter than 128 = shift in positive direction
- Darker than 128 = shift in negative direction

The fragment shader samples the displacement map at each UV coordinate, reads the grayscale value, converts it to a signed offset, and uses that offset to look up the source image at a shifted position. The `scale` uniform controls how much the displacement map actually moves pixels.

For hover distortion, the displacement scale is animated from 0 (no effect) to some peak value and back to 0. The displacement map itself is typically a pre-authored texture -- a photograph of water surface, a noise pattern, or a hand-drawn grayscale brush stroke.

The RGB-shift variant samples R, G, and B channels at three slightly different UV positions, creating chromatic aberration. This is often combined with displacement for a liquid-chrome feel.

For transitions between two images, you crossfade the source textures while simultaneously applying displacement. The displacement peaks at the midpoint of the transition and settles to zero at both ends.

## Setup
```bash
npm i ogl@1.0.8  # or three@0.168
```
Minimal raw WebGL works too. The effect is a single fullscreen quad with a fragment shader.

## Core API
| Concept | Role |
|---|---|
| Displacement map texture | Grayscale image that controls per-pixel offset |
| `scale` uniform | Multiplier for displacement strength (0 = none) |
| Source texture(s) | The image(s) being distorted |
| `progress` uniform | 0-1 crossfade between two images |
| UV offset | `texture2D(source, uv + offset)` -- the core displacement operation |
| Mouse position uniform | Normalized cursor position for interactive effects |
| Easing/lerp on uniforms | Smooth mouse-follow, not raw coordinates |

## Recipes

### 1. Hover image distortion (OGL)
Image ripples when the mouse enters. The foundational hover-displacement effect.
```js
import { Renderer, Program, Mesh, Texture, Plane } from 'ogl';

const renderer = new Renderer({ alpha: true, dpr: 2 });
const gl = renderer.gl;
document.getElementById('container').appendChild(gl.canvas);
renderer.setSize(600, 400);

const imgTexture = new Texture(gl);
const dispTexture = new Texture(gl);

const imgEl = new Image(); imgEl.crossOrigin = '';
imgEl.src = '/photo.jpg';
imgEl.onload = () => { imgTexture.image = imgEl; };

const dispEl = new Image(); dispEl.crossOrigin = '';
dispEl.src = '/displacement.jpg'; // grayscale water/noise texture
dispEl.onload = () => { dispTexture.image = dispEl; };

const geometry = new Plane(gl, { widthSegments: 1, heightSegments: 1 });
const program = new Program(gl, {
  vertex: `
    attribute vec3 position;
    attribute vec2 uv;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragment: `
    precision highp float;
    uniform sampler2D uImage;
    uniform sampler2D uDisplacement;
    uniform float uScale;
    varying vec2 vUv;
    void main() {
      vec4 disp = texture2D(uDisplacement, vUv);
      float displaceAmount = (disp.r - 0.5) * 2.0 * uScale;
      vec2 distortedUv = vUv + vec2(displaceAmount * 0.1, displaceAmount * 0.05);
      gl_FragColor = texture2D(uImage, distortedUv);
    }
  `,
  uniforms: {
    uImage: { value: imgTexture },
    uDisplacement: { value: dispTexture },
    uScale: { value: 0 },
  },
});

const mesh = new Mesh(gl, { geometry, program });
let target = 0, current = 0;

gl.canvas.addEventListener('mouseenter', () => { target = 1; });
gl.canvas.addEventListener('mouseleave', () => { target = 0; });

requestAnimationFrame(function loop() {
  current += (target - current) * 0.07;
  program.uniforms.uScale.value = current;
  renderer.render({ scene: mesh });
  requestAnimationFrame(loop);
});
```

### 2. Two-image liquid transition
Crossfade between two images with displacement peaking at the midpoint.
```glsl
// Fragment shader
precision highp float;
uniform sampler2D uImage1;
uniform sampler2D uImage2;
uniform sampler2D uDisplacement;
uniform float uProgress; // 0 = image1, 1 = image2
varying vec2 vUv;

void main() {
  vec4 disp = texture2D(uDisplacement, vUv);
  float displaceFactor = (disp.r - 0.5) * 2.0;

  // Displacement peaks at progress=0.5
  float strength = sin(uProgress * 3.14159) * 0.15;

  vec2 uv1 = vUv + vec2(displaceFactor * strength, 0.0);
  vec2 uv2 = vUv - vec2(displaceFactor * strength, 0.0);

  vec4 color1 = texture2D(uImage1, uv1);
  vec4 color2 = texture2D(uImage2, uv2);

  gl_FragColor = mix(color1, color2, uProgress);
}
```
```js
// JS: animate progress on click/swipe
let progress = 0, targetProgress = 0;
let currentImage = 0;

function nextImage() {
  currentImage = 1 - currentImage;
  targetProgress = currentImage;
}

requestAnimationFrame(function loop() {
  progress += (targetProgress - progress) * 0.04;
  program.uniforms.uProgress.value = progress;
  renderer.render({ scene: mesh });
  requestAnimationFrame(loop);
});
```

### 3. RGB channel shift on mouse move
Chromatic aberration that follows the cursor velocity.
```glsl
precision highp float;
uniform sampler2D uImage;
uniform vec2 uMouse;      // normalized mouse position [0,1]
uniform vec2 uVelocity;   // mouse velocity (smoothed)
varying vec2 vUv;

void main() {
  float dist = distance(vUv, uMouse);
  float falloff = smoothstep(0.5, 0.0, dist);

  vec2 offset = uVelocity * 0.02 * falloff;

  float r = texture2D(uImage, vUv + offset).r;
  float g = texture2D(uImage, vUv).g;
  float b = texture2D(uImage, vUv - offset).b;

  gl_FragColor = vec4(r, g, b, 1.0);
}
```
```js
// JS: track mouse velocity
let mouseX = 0.5, mouseY = 0.5;
let velX = 0, velY = 0;
let prevX = 0.5, prevY = 0.5;

document.addEventListener('mousemove', (e) => {
  mouseX = e.clientX / window.innerWidth;
  mouseY = 1.0 - e.clientY / window.innerHeight;
});

requestAnimationFrame(function loop() {
  velX += ((mouseX - prevX) - velX) * 0.1;
  velY += ((mouseY - prevY) - velY) * 0.1;
  prevX = mouseX;
  prevY = mouseY;

  program.uniforms.uMouse.value = [mouseX, mouseY];
  program.uniforms.uVelocity.value = [velX * 50, velY * 50];
  renderer.render({ scene: mesh });
  requestAnimationFrame(loop);
});
```

### 4. Radial ripple from click point
A ripple emanates from the click position and decays over time.
```glsl
precision highp float;
uniform sampler2D uImage;
uniform vec2 uClick;   // normalized click position
uniform float uTime;   // time since click
varying vec2 vUv;

void main() {
  float dist = distance(vUv, uClick);
  float ripple = sin(dist * 40.0 - uTime * 8.0) * exp(-dist * 6.0) * exp(-uTime * 2.0);
  vec2 offset = normalize(vUv - uClick + 0.001) * ripple * 0.02;
  gl_FragColor = texture2D(uImage, vUv + offset);
}
```
```js
let clickTime = -10; // far in the past
let clickPos = [0.5, 0.5];

gl.canvas.addEventListener('click', (e) => {
  clickPos = [e.offsetX / gl.canvas.clientWidth, 1 - e.offsetY / gl.canvas.clientHeight];
  clickTime = performance.now() * 0.001;
});

requestAnimationFrame(function loop(t) {
  const elapsed = t * 0.001 - clickTime;
  program.uniforms.uClick.value = clickPos;
  program.uniforms.uTime.value = elapsed;
  renderer.render({ scene: mesh });
  requestAnimationFrame(loop);
});
```

### 5. Scroll-driven reveal with displacement
Image assembles from chaos as it scrolls into view.
```glsl
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uDisplacement;
uniform float uProgress; // 0 = fully displaced, 1 = normal
varying vec2 vUv;

void main() {
  vec4 disp = texture2D(uDisplacement, vUv);
  float strength = (1.0 - uProgress) * 0.4;

  vec2 distorted = vUv + (disp.rg - 0.5) * strength;
  vec4 color = texture2D(uImage, distorted);

  // Fade in with progress
  color.a *= smoothstep(0.0, 0.3, uProgress);
  gl_FragColor = color;
}
```
```js
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    scrollProgress = entry.intersectionRatio;
  });
}, { threshold: Array.from({ length: 50 }, (_, i) => i / 49) });
observer.observe(containerEl);

requestAnimationFrame(function loop() {
  currentProgress += (scrollProgress - currentProgress) * 0.06;
  program.uniforms.uProgress.value = currentProgress;
  renderer.render({ scene: mesh });
  requestAnimationFrame(loop);
});
```

### 6. Generating displacement maps procedurally
When you do not have a pre-made displacement texture.
```js
function generateDisplacementMap(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Layered radial gradients for organic displacement
  const layers = [
    { x: 0.3, y: 0.4, r: 0.4 },
    { x: 0.7, y: 0.6, r: 0.35 },
    { x: 0.5, y: 0.3, r: 0.3 },
  ];

  ctx.fillStyle = '#808080'; // neutral gray = no displacement
  ctx.fillRect(0, 0, size, size);

  for (const l of layers) {
    const g = ctx.createRadialGradient(
      l.x * size, l.y * size, 0,
      l.x * size, l.y * size, l.r * size
    );
    g.addColorStop(0, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.15)');
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  return canvas;
}

// Use as texture
const dispCanvas = generateDisplacementMap();
const dispTexture = new Texture(gl, { image: dispCanvas });
```

## Tuning the feel
- **Displacement scale**: 0.02-0.08 for subtle warp. 0.1-0.2 for obvious liquid. Above 0.3 tears the image.
- **Hover lerp factor**: 0.05-0.1 for smooth, languid response. 0.15-0.25 for snappy. Below 0.03 feels sluggish.
- **RGB shift offset**: 0.005-0.02 in UV space. Above 0.03 the color channels separate too far and the image becomes unrecognizable.
- **Transition duration**: 600-1200ms for liquid crossfades. Under 400ms does not give the displacement time to develop. Over 1500ms feels slow.
- **Ripple frequency**: 30-50 for fine ripples. 10-20 for broad waves. Above 60 creates moire patterns.
- **Ripple decay**: `exp(-t * 2)` for quick decay (0.5s visible). `exp(-t * 0.5)` for slow decay (2s visible). Match to interaction tempo.

## Performance
- A single fullscreen quad with a displacement shader costs 1 texture sample (displacement map) + 1-3 texture samples (source image channels) per pixel. At 1080p DPR 2, that is ~25M texture lookups per frame. Any modern GPU handles this at 60fps.
- The CPU cost is near zero -- just updating 2-3 uniform floats per frame.
- Multiple displacement effects on the same page (e.g. a grid of 12 portfolio images, each with its own WebGL plane) need shared context management. Use a single WebGL canvas with multiple planes, not 12 separate canvases.
- Displacement map texture: 256x256 is sufficient for most effects. The map does not need to match the source image resolution because the shader interpolates.
- Mobile: the shader runs fine, but touch-based interactions lack the continuous hover state. Use scroll-driven displacement or tap-to-trigger instead.

## Accessibility
```js
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
if (reduced.matches) {
  // Skip displacement, show images normally
  program.uniforms.uScale.value = 0;
}
reduced.addEventListener('change', (e) => {
  if (e.matches) program.uniforms.uScale.value = 0;
});
```
- Liquid distortion can be disorienting for vestibular sensitivity. Always respect `prefers-reduced-motion`.
- The distortion is visual only. It must not change the semantic content or prevent interaction.
- Ensure the undistorted image is accessible (alt text, focus management).

## Anti-slop rules
1. Never apply displacement to text. It makes text unreadable and serves no purpose.
2. Never use a displacement map with hard edges (sharp black-to-white transitions). Hard edges create visible tears in the image. Use soft, blurred maps.
3. Never animate displacement scale faster than the lerp can follow. Jumpy scale values create frame-by-frame popping.
4. Never use displacement as the only interaction feedback. Pair it with a CSS state change (opacity, scale) so the interaction reads even without WebGL.
5. Never forget to clamp UV coordinates after displacement. Without clamping, out-of-bounds UVs sample garbage or wrap around.
6. Never run 12 separate WebGL contexts for a grid of displaced images. Share one context with multiple planes.
7. Never use RGB shift with displacement scale above 0.03 simultaneously. The combined effect is overwhelming.
8. Never ship without testing the zero-displacement state. The image must look perfect when the effect is inactive.

## Checklist
- [ ] Displacement map is soft (blurred, no hard edges)
- [ ] UV clamping or repeat mode set correctly
- [ ] Hover lerp smooths the transition (no jumps)
- [ ] `prefers-reduced-motion` disables displacement
- [ ] Image alt text present on underlying element
- [ ] Zero-displacement state looks correct
- [ ] Mobile fallback (no hover) tested
- [ ] Shared WebGL context for multiple instances
- [ ] Displacement scale within 0.02-0.2 range
