# Reference: Particle Text Formation Hero

## Text sampling resolution guide

| Text length | Font size | Canvas approx size | Pixel coverage | Recommended particle count |
|---|---|---|---|---|
| 1-3 chars | 200px | 600x260 | ~30k pixels | 8k-12k |
| 4-8 chars | 200px | 1200x260 | ~50k pixels | 12k-20k |
| 9-15 chars | 180px | 1800x240 | ~60k pixels | 15k-25k |
| Full word + icon | 200px | 1000x300 | ~40k pixels | 10k-15k for text + separate sampling for icon |

The thinning step (stride sampling) should use `Math.floor(i * stride)` not `Math.round(i * stride)` to avoid index out-of-bounds at the final element.

## Point sprite rendering details

In `gl_PointCoord`, `(0,0)` is the top-left of the point sprite quad, `(1,1)` is bottom-right. The coordinate is always in this range regardless of `gl_PointSize`.

`gl_PointSize` has a hardware maximum (query with `gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)`). Common limits: 64-256px on desktop, 64-128px on mobile. If you need larger particles, switch from `Points` to `InstancedMesh` with quad geometry.

The `300.0 / -mvPos.z` factor in the vertex shader creates perspective-correct point sizing: particles closer to the camera appear larger. The 300.0 constant should be tuned to match the camera distance and desired visual size.

## Scatter distribution math

Three scatter patterns ranked by visual quality:

### 1. Uniform sphere volume (recommended)
```js
const theta = Math.random() * Math.PI * 2;
const phi = Math.acos(2 * Math.random() - 1);
const r = RADIUS * Math.cbrt(Math.random());
x = r * Math.sin(phi) * Math.cos(theta);
y = r * Math.sin(phi) * Math.sin(theta);
z = r * Math.cos(phi);
```

### 2. Sphere surface only (hollow look)
```js
const theta = Math.random() * Math.PI * 2;
const phi = Math.acos(2 * Math.random() - 1);
x = RADIUS * Math.sin(phi) * Math.cos(theta);
y = RADIUS * Math.sin(phi) * Math.sin(theta);
z = RADIUS * Math.cos(phi);
```

### 3. Box volume (simple, less organic)
```js
x = (Math.random() - 0.5) * SIZE;
y = (Math.random() - 0.5) * SIZE;
z = (Math.random() - 0.5) * SIZE;
```

## GSAP/ScrollTrigger interaction with uProgress

The formation entrance tween and the scroll-driven dispersion both write to `uProgress`. To avoid fights:

```js
// Option A: Kill entrance tween when ScrollTrigger activates
const entranceTween = gsap.to(mat.uniforms.uProgress, { value: 1, duration: 2, ease: 'power3.inOut' });

ScrollTrigger.create({
  trigger: '#hero',
  start: 'top top',
  end: 'bottom top',
  onEnter: () => entranceTween.kill(),
  onUpdate: (self) => { mat.uniforms.uProgress.value = 1 - self.progress; },
});

// Option B: Use ScrollTrigger's own tween (entrance is scroll-driven too)
gsap.to(mat.uniforms.uProgress, {
  value: 1,
  scrollTrigger: { trigger: '#hero', start: 'top bottom', end: 'top top', scrub: 1 },
});
// Then separate ScrollTrigger for dispersion after top
```

## SVG path sampling for logo formation

```js
async function sampleSVGPath(svgUrl, maxPoints) {
  const resp = await fetch(svgUrl);
  const text = await resp.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const paths = doc.querySelectorAll('path');
  const positions = [];

  paths.forEach(path => {
    const len = path.getTotalLength();
    const pointCount = Math.ceil(len / 2); // ~1 point per 2px of path length
    for (let i = 0; i < pointCount; i++) {
      const pt = path.getPointAtLength((i / pointCount) * len);
      positions.push(pt.x, pt.y, 0);
    }
  });

  // Normalize to centered coordinates
  const bbox = doc.querySelector('svg').viewBox.baseVal;
  const result = new Float32Array(positions.length);
  for (let i = 0; i < positions.length / 3; i++) {
    result[i * 3] = (positions[i * 3] - bbox.width / 2) / bbox.height;
    result[i * 3 + 1] = -(positions[i * 3 + 1] - bbox.height / 2) / bbox.height;
    result[i * 3 + 2] = 0;
  }
  return result;
}
```

## Color-mapped particles

To pass per-particle color from the sampled canvas:
```js
// During sampling, read RGB as well as position
const r = pixels[i] / 255;
const g = pixels[i + 1] / 255;
const b = pixels[i + 2] / 255;
colors.push(r, g, b);

// Add as attribute
geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colorArray, 3));

// In vertex shader
attribute vec3 aColor;
varying vec3 vColor;
// ...
vColor = aColor;

// In fragment shader
varying vec3 vColor;
// ...
gl_FragColor = vec4(vColor, alpha);
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Text is mirrored | Y axis not flipped during sampling | Negate Y: `-(y / height - 0.5)` |
| Text is off-center | Sampling canvas not centered at origin | Subtract 0.5 from both x and y normalized coords |
| Thin strokes missing | Font size too small on sampling canvas | Increase FONT_SIZE to 200+ |
| Particles clip at edges | Camera FOV too narrow for text width | Increase FOV or move camera back (larger z) |
| Formation "pops" at end | Linear interpolation with no ease | Use eased `uProgress` via GSAP tween |
| Particles visible through text on light bg | Additive blending on light background | Switch to `NormalBlending` and adjust alpha |
