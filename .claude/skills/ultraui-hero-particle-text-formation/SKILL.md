---
name: hero-particle-text-formation
description: Use when building a hero where particles assemble into readable text or a logo shape, then disperse on scroll or interaction. Builds a complete Three.js Points-based particle formation hero with text sampling, scatter/form animation, and scroll-driven dispersion.
category: hero
pairs_with: hero-particle-text-formation-eval
---

# Particle Text Formation Hero

## What this builds
A full-viewport hero section where thousands of particles start in a random scattered state, animate into a readable headline or logo shape, and disperse again as the user scrolls. The text positions are sampled from a hidden 2D canvas, each particle stores a "home" (text) position and a "scattered" position, and the animation interpolates between them.

- Three.js `Points` + `BufferGeometry` renders 10k-50k particles as point sprites
- Text positions sampled from a hidden canvas via `getImageData()` pixel scanning
- GSAP ScrollTrigger drives the formation/dispersion progress (0 = scattered, 1 = formed)
- Custom `ShaderMaterial` handles per-particle size, opacity, and color
- Additive blending creates the characteristic glow-where-particles-overlap look
- Particles drift with curl noise while scattered for organic motion

## When to use / when not to
- Use when the hero moment is "chaos becomes order" -- particles forming a word, logo, or icon.
- Use when the brand can support a dark/dramatic hero (additive blending needs a dark background).
- Use when the text being formed is short (1-3 words, 6-20 characters). Longer text requires more particles and higher canvas resolution, which scales poorly.
- Do NOT use for ambient floating particles without a formation target. Use `webgl-particle-systems` directly.
- Do NOT use for CSS-animatable text reveals. Use `hero-kinetic-typography` instead; it is 100x lighter for text-only motion.
- Do NOT use on light backgrounds without switching to normal blending. Additive blending on white produces invisible particles.

## Stack decision
| Dependency | Version | Why | Cheaper alternative |
|---|---|---|---|
| Three.js | 0.169+ | `Points`, `BufferGeometry`, `ShaderMaterial` for GPU-driven particles. The standard for WebGL particle work on the web. | Raw WebGL2 (`gl.drawArrays(POINTS, ...)`) saves the Three.js bundle but requires manual matrix math and resize handling. See `webgl-particle-systems` for the raw approach. |
| GSAP + ScrollTrigger | 3.13+ | `ScrollTrigger` maps scroll position to a 0-1 progress value that drives formation. Free since 3.13. | CSS `animation-timeline: view()` cannot drive uniform values inside a WebGL shader. IntersectionObserver gives only enter/leave, not continuous progress. |
| No GPGPU | - | CPU-driven position interpolation is sufficient for 10k-50k particles. GPGPU adds complexity for a gain only visible above 100k. | If particle count exceeds 100k, switch to FBO ping-pong simulation. See `webgl-particle-systems` for the GPGPU recipe. |

## Architecture

```
Hidden <canvas>  --->  Sample text pixel positions  --->  Float32Array of (x,y) targets
                                                              |
Three.js scene  <---  Points(BufferGeometry, ShaderMaterial) <-+
  |                       |
  |                       +-- attribute: aTarget (vec3) -- text position
  |                       +-- attribute: aScatter (vec3) -- random start position
  |                       +-- attribute: aRandom (float) -- per-particle random seed
  |                       +-- uniform: uProgress (float) -- 0=scattered, 1=formed
  |                       +-- uniform: uTime (float) -- drives idle drift
  |
  +-- Renderer  <---  rAF loop  <---  GSAP ScrollTrigger feeds uProgress
```

**Lifecycle:**
1. **Sample**: Render text into a hidden 2D canvas. Scan pixels. Collect non-transparent pixel positions. Thin to target particle count.
2. **Init geometry**: Create `BufferGeometry` with `aTarget` (sampled positions), `aScatter` (random sphere positions), `aRandom` (per-particle seed for noise offset).
3. **Shader**: Vertex shader interpolates `mix(aScatter, aTarget, uProgress)`. Fragment shader draws soft circles with falloff.
4. **Entrance**: Animate `uProgress` from 0 to 1 over ~2 seconds on load.
5. **Scroll disperse**: ScrollTrigger maps scroll progress to `uProgress` (1 at top, 0 when scrolled past).
6. **Idle drift**: While formed, particles jitter by a tiny curl-noise offset keyed to `uTime` and `aRandom`.
7. **Teardown**: Dispose geometry, material, renderer on unmount.

## Build it: step by step

### Phase 1: HTML shell

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Particle Text Hero</title>
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  body{background:#050508;color:#e8e8e8;font-family:system-ui,sans-serif;overflow-x:hidden}
  .hero{position:relative;height:100vh;overflow:hidden}
  .hero canvas{display:block;position:absolute;inset:0}
  .hero__content{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;height:100%;pointer-events:none}
  .spacer{height:200vh}
  @media(prefers-reduced-motion:reduce){
    .hero canvas{display:none}
    .hero__content{pointer-events:auto}
    .hero__fallback{display:block;font-size:clamp(2.5rem,6vw,5rem);font-weight:700;letter-spacing:-0.03em}
  }
  .hero__fallback{display:none}
</style>
</head>
<body>
<section class="hero" id="hero" aria-label="Animated particle text hero">
  <div class="hero__content">
    <span class="hero__fallback">YOUR TEXT</span>
  </div>
</section>
<div class="spacer"></div>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
  "gsap": "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.js",
  "gsap/ScrollTrigger": "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrollTrigger.js"
}}
</script>
<script type="module">
// Phases 2-8
</script>
</body>
</html>
```

### Phase 2: Text position sampling from hidden canvas

```js
import * as THREE from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const TEXT = 'YOUR TEXT';
const PARTICLE_COUNT = 15000;
const FONT_SIZE = 200; // px on sampling canvas
const FONT = '700 ' + FONT_SIZE + 'px system-ui, sans-serif';

function sampleTextPositions(text, maxPoints) {
  const offCanvas = document.createElement('canvas');
  const ctx = offCanvas.getContext('2d');
  ctx.font = FONT;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const textHeight = FONT_SIZE * 1.2;

  offCanvas.width = Math.ceil(textWidth) + 20;
  offCanvas.height = Math.ceil(textHeight) + 20;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, offCanvas.width, offCanvas.height);
  ctx.font = FONT; // must re-set after resize
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10, offCanvas.height / 2);

  const imageData = ctx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const pixels = imageData.data;
  const positions = [];

  // Collect all white pixel positions
  for (let y = 0; y < offCanvas.height; y++) {
    for (let x = 0; x < offCanvas.width; x++) {
      const i = (y * offCanvas.width + x) * 4;
      if (pixels[i] > 128) {
        // Normalize to [-aspect/2, aspect/2] x [-0.5, 0.5] centered at origin
        const nx = (x / offCanvas.width - 0.5) * (offCanvas.width / offCanvas.height);
        const ny = -(y / offCanvas.height - 0.5); // flip Y for 3D convention
        positions.push(nx, ny, 0);
      }
    }
  }

  // Thin to target count by random sampling
  const totalPixels = positions.length / 3;
  if (totalPixels <= maxPoints) return new Float32Array(positions);

  const stride = totalPixels / maxPoints;
  const thinned = new Float32Array(maxPoints * 3);
  for (let i = 0; i < maxPoints; i++) {
    const srcIdx = Math.floor(i * stride) * 3;
    thinned[i * 3] = positions[srcIdx];
    thinned[i * 3 + 1] = positions[srcIdx + 1];
    thinned[i * 3 + 2] = positions[srcIdx + 2];
  }
  return thinned;
}

const targetPositions = sampleTextPositions(TEXT, PARTICLE_COUNT);
const actualCount = targetPositions.length / 3;
```

### Phase 3: Generate scatter positions and random seeds

```js
const SCATTER_RADIUS = 4.0; // units from center

const scatterPositions = new Float32Array(actualCount * 3);
const randomSeeds = new Float32Array(actualCount);

for (let i = 0; i < actualCount; i++) {
  // Random point on a sphere surface, then scale randomly for volume distribution
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const r = SCATTER_RADIUS * Math.cbrt(Math.random()); // cube root for uniform volume

  scatterPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  scatterPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  scatterPositions[i * 3 + 2] = r * Math.cos(phi);

  randomSeeds[i] = Math.random();
}
```

### Phase 4: Three.js scene, geometry, and ShaderMaterial

```js
const container = document.getElementById('hero');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
camera.position.z = 3.5;

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setClearColor(0x050508);
container.prepend(renderer.domElement);

// Geometry
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(targetPositions, 3)); // starts at target, shader mixes
geometry.setAttribute('aTarget', new THREE.Float32BufferAttribute(targetPositions, 3));
geometry.setAttribute('aScatter', new THREE.Float32BufferAttribute(scatterPositions, 3));
geometry.setAttribute('aRandom', new THREE.Float32BufferAttribute(randomSeeds, 1));

// Shader material
const material = new THREE.ShaderMaterial({
  uniforms: {
    uProgress: { value: 0.0 },
    uTime: { value: 0.0 },
    uSize: { value: 3.0 },
    uDpr: { value: Math.min(window.devicePixelRatio, 2) },
  },
  vertexShader: `
    attribute vec3 aTarget;
    attribute vec3 aScatter;
    attribute float aRandom;
    uniform float uProgress;
    uniform float uTime;
    uniform float uSize;
    uniform float uDpr;
    varying float vAlpha;

    // Simple curl-noise-like drift
    vec3 drift(vec3 p, float t, float seed) {
      float s = seed * 6.2832;
      return vec3(
        sin(t * 0.5 + s) * 0.02,
        cos(t * 0.3 + s * 1.3) * 0.015,
        sin(t * 0.4 + s * 0.7) * 0.01
      );
    }

    void main() {
      vec3 scattered = aScatter + drift(aScatter, uTime, aRandom) * (1.0 - uProgress);
      vec3 formed = aTarget + drift(aTarget, uTime, aRandom) * 0.15 * uProgress;
      vec3 pos = mix(scattered, formed, uProgress);

      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPos;
      gl_PointSize = uSize * uDpr * (300.0 / -mvPos.z);

      // Fade in as particles form, stay visible when scattered
      vAlpha = mix(0.4, 0.9, uProgress) + aRandom * 0.1;
    }
  `,
  fragmentShader: `
    varying float vAlpha;
    void main() {
      // Soft circle with falloff
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float alpha = smoothstep(0.5, 0.1, d) * vAlpha;
      gl_FragColor = vec4(vec3(0.6, 0.7, 1.0), alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const points = new THREE.Points(geometry, material);
scene.add(points);
```

### Phase 5: Resize handler

```js
function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  material.uniforms.uDpr.value = Math.min(window.devicePixelRatio, 2);
}
window.addEventListener('resize', onResize);
```

### Phase 6: Entrance animation (formation)

```js
// Animate progress from 0 to 1 on load
gsap.to(material.uniforms.uProgress, {
  value: 1,
  duration: 2.0,
  ease: 'power3.inOut',
  delay: 0.3,
});
```

### Phase 7: Scroll-driven dispersion

```js
ScrollTrigger.create({
  trigger: '#hero',
  start: 'top top',
  end: 'bottom top',
  onUpdate: (self) => {
    // Reverse progress as user scrolls: 1 at top (formed), 0 at bottom (scattered)
    material.uniforms.uProgress.value = 1 - self.progress;
  },
});
```

### Phase 8: Render loop and reduced motion

```js
const clock = new THREE.Clock();
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

if (!prefersReduced.matches) {
  renderer.setAnimationLoop(() => {
    material.uniforms.uTime.value = clock.getElapsedTime();
    renderer.render(scene, camera);
  });
} else {
  // Render one formed frame, then stop
  material.uniforms.uProgress.value = 1;
  material.uniforms.uTime.value = 0;
  renderer.render(scene, camera);
}

// Teardown
function teardown() {
  renderer.setAnimationLoop(null);
  geometry.dispose();
  material.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  ScrollTrigger.getAll().forEach(t => t.kill());
}
```

## The full reference implementation

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Particle Text Hero</title>
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  body{background:#050508;color:#e8e8e8;font-family:system-ui,sans-serif;overflow-x:hidden}
  .hero{position:relative;height:100vh;overflow:hidden}
  .hero canvas{display:block;position:absolute;inset:0}
  .hero__content{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;height:100%;pointer-events:none}
  .spacer{height:200vh}
  @media(prefers-reduced-motion:reduce){.hero canvas{display:none}.hero__fallback{display:block!important}}
  .hero__fallback{display:none;font-size:clamp(2.5rem,6vw,5rem);font-weight:700;letter-spacing:-0.03em}
</style>
</head>
<body>
<section class="hero" id="hero" aria-label="Animated particle text hero">
  <div class="hero__content"><span class="hero__fallback">HELLO</span></div>
</section>
<div class="spacer"></div>
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
"gsap":"https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.js",
"gsap/ScrollTrigger":"https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrollTrigger.js"}}
</script>
<script type="module">
import * as THREE from 'three';
import gsap from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const TEXT='HELLO',COUNT=15000,FSIZE=200,SRAD=4.0;
function sample(text,max){
  const c=document.createElement('canvas'),x=c.getContext('2d');
  x.font='700 '+FSIZE+'px system-ui';const m=x.measureText(text);
  c.width=Math.ceil(m.width)+20;c.height=Math.ceil(FSIZE*1.2)+20;
  x.fillStyle='#000';x.fillRect(0,0,c.width,c.height);
  x.font='700 '+FSIZE+'px system-ui';x.fillStyle='#fff';x.textBaseline='middle';
  x.fillText(text,10,c.height/2);
  const d=x.getImageData(0,0,c.width,c.height).data,pos=[];
  const ar=c.width/c.height;
  for(let y=0;y<c.height;y++)for(let xp=0;xp<c.width;xp++){
    if(d[(y*c.width+xp)*4]>128)pos.push((xp/c.width-0.5)*ar,-(y/c.height-0.5),0);
  }
  const tot=pos.length/3;if(tot<=max)return new Float32Array(pos);
  const s=tot/max,out=new Float32Array(max*3);
  for(let i=0;i<max;i++){const si=Math.floor(i*s)*3;out[i*3]=pos[si];out[i*3+1]=pos[si+1];out[i*3+2]=pos[si+2];}
  return out;
}
const tgt=sample(TEXT,COUNT),n=tgt.length/3;
const scat=new Float32Array(n*3),rng=new Float32Array(n);
for(let i=0;i<n;i++){
  const th=Math.random()*Math.PI*2,ph=Math.acos(2*Math.random()-1),r=SRAD*Math.cbrt(Math.random());
  scat[i*3]=r*Math.sin(ph)*Math.cos(th);scat[i*3+1]=r*Math.sin(ph)*Math.sin(th);scat[i*3+2]=r*Math.cos(ph);
  rng[i]=Math.random();
}
const el=document.getElementById('hero');
const scene=new THREE.Scene(),cam=new THREE.PerspectiveCamera(50,el.clientWidth/el.clientHeight,0.1,100);
cam.position.z=3.5;
const ren=new THREE.WebGLRenderer({antialias:false,alpha:false});
ren.setPixelRatio(Math.min(devicePixelRatio,2));ren.setSize(el.clientWidth,el.clientHeight);ren.setClearColor(0x050508);
el.prepend(ren.domElement);
const geo=new THREE.BufferGeometry();
geo.setAttribute('position',new THREE.Float32BufferAttribute(tgt,3));
geo.setAttribute('aTarget',new THREE.Float32BufferAttribute(tgt,3));
geo.setAttribute('aScatter',new THREE.Float32BufferAttribute(scat,3));
geo.setAttribute('aRandom',new THREE.Float32BufferAttribute(rng,1));
const mat=new THREE.ShaderMaterial({
  uniforms:{uProgress:{value:0},uTime:{value:0},uSize:{value:3},uDpr:{value:Math.min(devicePixelRatio,2)}},
  vertexShader:`attribute vec3 aTarget;attribute vec3 aScatter;attribute float aRandom;
uniform float uProgress,uTime,uSize,uDpr;varying float vA;
vec3 drift(vec3 p,float t,float s){float a=s*6.2832;return vec3(sin(t*.5+a)*.02,cos(t*.3+a*1.3)*.015,sin(t*.4+a*.7)*.01);}
void main(){vec3 sc=aScatter+drift(aScatter,uTime,aRandom)*(1.-uProgress);
vec3 fm=aTarget+drift(aTarget,uTime,aRandom)*.15*uProgress;vec3 p=mix(sc,fm,uProgress);
vec4 mv=modelViewMatrix*vec4(p,1);gl_Position=projectionMatrix*mv;
gl_PointSize=uSize*uDpr*(300./-mv.z);vA=mix(.4,.9,uProgress)+aRandom*.1;}`,
  fragmentShader:`varying float vA;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
float a=smoothstep(.5,.1,d)*vA;gl_FragColor=vec4(vec3(.6,.7,1),a);}`,
  transparent:true,depthWrite:false,blending:THREE.AdditiveBlending
});
scene.add(new THREE.Points(geo,mat));
window.addEventListener('resize',()=>{cam.aspect=el.clientWidth/el.clientHeight;cam.updateProjectionMatrix();
ren.setSize(el.clientWidth,el.clientHeight);mat.uniforms.uDpr.value=Math.min(devicePixelRatio,2);});
gsap.to(mat.uniforms.uProgress,{value:1,duration:2,ease:'power3.inOut',delay:0.3});
ScrollTrigger.create({trigger:'#hero',start:'top top',end:'bottom top',
onUpdate:s=>{mat.uniforms.uProgress.value=1-s.progress;}});
const clk=new THREE.Clock();
const mq=matchMedia('(prefers-reduced-motion:reduce)');
if(!mq.matches){ren.setAnimationLoop(()=>{mat.uniforms.uTime.value=clk.getElapsedTime();ren.render(scene,cam);});}
else{mat.uniforms.uProgress.value=1;ren.render(scene,cam);}
</script>
</body>
</html>
```

## Tuning the feel

| Parameter | Value | Rationale |
|---|---|---|
| Particle count | 10k-15k for short words, 25k-50k for logos | Below 5k the text is too sparse to read. Above 50k, CPU-driven updates bottleneck. |
| Sampling font size | 200px | High enough to capture fine letter detail. Below 100px, thin strokes (I, l, serifs) lose pixels. Above 300px, diminishing returns. |
| Scatter radius | 4.0 units | Fills the viewport at camera distance 3.5. Below 2.0, scatter feels cramped. Above 6.0, particles start off-screen. |
| Formation duration | 2.0s with `power3.inOut` | Slow enough to perceive the assembly. The inOut ease gives a brief pause at the start (particles "decide" to move) before accelerating. |
| Formation ease | `power3.inOut` | The inOut curve creates a "gather momentum then settle" feel. `linear` looks mechanical. `power2.out` rushes the beginning. |
| Idle drift amplitude | 0.02 units | Just visible -- particles shimmer without losing legibility. Above 0.05 the text smears. |
| Point size | 3.0 * DPR | Visible on desktop, not oversized on mobile. Below 2.0, particles are sub-pixel on 1x screens. Above 5.0, the text becomes blobby. |
| Particle color | `vec3(0.6, 0.7, 1.0)` | Cool blue-white. Additive blending brightens overlaps to near-white. Warm colors (orange, red) read as fire, which may not suit all brands. |
| Camera FOV | 50 degrees | Moderate perspective. 35 compresses the text too much. 75 makes it feel distant. |

## Variants

### 1. Logo formation from SVG path
Replace canvas text sampling with SVG path point sampling. Use `getPointAtLength()` to sample N evenly-spaced points along the path's outline. Produces a particle outline rather than a filled shape.

### 2. Color-mapped formation
Assign each particle a color from the sampled pixel (read RGB from `getImageData`). Pass as a `vec3` attribute. The formation reveals a full-color image or gradient text, not monochrome.

### 3. Mouse repulsion while formed
Add a `uMouse` uniform (world-space coordinates via raycasting). In the vertex shader, displace particles away from `uMouse` position when formed, creating a ripple/hole effect under the cursor.

### 4. Sequential word formation
Multiple words form one at a time. Store word index per particle. Animate `uProgress` per word with staggered delays. First word forms, then second, etc.

### 5. Explosion disperse (not scroll-linked)
Instead of smooth scroll dispersion, trigger an explosive scatter on a button click. Particles fly outward along their normal from the text surface (compute surface normal from neighboring pixel positions).

## Performance budget

| Metric | Target | Lever |
|---|---|---|
| Particle count | 10k-50k | Reduce to 10k for mobile. Below 10k, switch to CSS text animation. |
| Frame time | < 8ms | CPU cost is near-zero (uniform uploads only). GPU cost scales with particle count * point size^2. |
| Draw calls | 1 | Single `Points` object, single draw call. |
| JS bundle | ~150KB (Three.js) + ~45KB (GSAP) gzipped | If Three.js is already in the project, marginal cost is just the shader code. |
| GPU memory | ~2MB for 50k particles (4 attributes * 50k * 4 bytes) | Trivial. |
| LCP impact | Moderate | Canvas render is not LCP-eligible. Include a DOM fallback text for LCP scoring. |

**What to cut first:** Reduce particle count to 10k. Remove idle drift (static when formed). Remove additive blending (use normal alpha blending, cheaper compositing). On mobile, render particles as smaller points (size 2.0 instead of 3.0).

## Accessibility

- `prefers-reduced-motion` hides the canvas and shows the `.hero__fallback` DOM text element. The fallback text must match the particle text exactly.
- The canvas is decorative; `aria-hidden="true"` on the canvas element (Three.js generates it).
- The hero `<section>` carries `aria-label` describing the section.
- The particle animation conveys no information beyond the text itself, which is also available as the fallback span. Screen readers always get the text content.
- Epilepsy: additive blending can create bright flashes where many particles overlap suddenly during formation. Keep formation duration above 1.5 seconds and use an eased curve to avoid sudden brightness spikes.

## Anti-slop rules

1. DO NOT render text sampling canvas at the same resolution as the display canvas. The sampling canvas only needs to be large enough to capture letter shapes (200px font, ~1000x300px canvas). Rendering at display resolution wastes memory and produces too many sample points.
2. DO NOT create new `Float32Array`s inside the render loop. Allocate once, mutate with `attribute.needsUpdate = true` if doing CPU-side position updates.
3. DO NOT use `PointsMaterial` for formation effects. It lacks custom attributes. You need `ShaderMaterial` to access `aTarget`, `aScatter`, `aRandom` in the vertex shader.
4. DO NOT skip the cube-root in scatter volume distribution. `Math.random()` alone biases points toward the sphere center. `Math.cbrt(Math.random())` gives uniform volume distribution.
5. DO NOT use `Math.random()` for per-particle seeds inside the shader. Generate seeds on the CPU and pass as an attribute. GLSL has no `random()` function; hash-based noise is expensive per-vertex for thousands of particles.
6. DO NOT forget `depthWrite: false` on the material. With additive blending, depth writing causes particles behind others to disappear, creating holes in the text.
7. DO NOT animate the camera position as a substitute for scroll-driven dispersion. The text should scatter, not the viewpoint. Camera movement while particles are stationary looks like a zoom, not a dispersion.
8. DO NOT set `gl_PointSize` without the DPR factor. On 2x screens, points render at half the intended visual size without DPR compensation.
9. DO NOT sample text before web fonts load. The sampling canvas uses the system fallback font, producing wrong letter shapes if a custom font is specified. Gate sampling behind `document.fonts.ready`.
10. DO NOT skip the aspect ratio correction in text sampling. Without `(canvasWidth / canvasHeight)` normalization, the text appears stretched when the hero is wider than it is tall.

## Integration notes

- **With `lenis-smooth-scroll`:** Pass Lenis scroll to ScrollTrigger via `ScrollTrigger.scrollerProxy()`. The formation/dispersion logic stays the same; only the scroll input source changes.
- **With `hero-webgl-shader-fullscreen`:** Mutually exclusive. Both create a WebGL canvas for the hero. Choose one.
- **With `noise-grain-texture`:** Add grain inside the fragment shader: `gl_FragColor.rgb += (hash(gl_PointCoord + uTime) - 0.5) * 0.05`. Do not apply CSS grain filter on top of the WebGL canvas.
- **Known conflict with multiple WebGL contexts:** If other parts of the page also use WebGL (shader backgrounds, 3D product viewers), the browser context limit (8-16) applies. This hero uses one context.
- **With `gsap-scrolltrigger`:** This toolkit already uses ScrollTrigger. If other sections also use ScrollTrigger, they share the same GSAP instance. No conflict.

## Ship checklist

- [ ] Text sampling gated behind `document.fonts.ready` if using a custom font
- [ ] Sampling canvas resolution matches font size, not display resolution
- [ ] Aspect ratio correction applied to sampled positions
- [ ] Scatter positions use `Math.cbrt(Math.random())` for uniform volume distribution
- [ ] `ShaderMaterial` used (not `PointsMaterial`) with custom attributes
- [ ] `depthWrite: false` and `AdditiveBlending` set on material
- [ ] `gl_PointSize` includes DPR factor
- [ ] Formation entrance plays on load with eased timing
- [ ] ScrollTrigger drives `uProgress` for scroll-based dispersion
- [ ] `prefers-reduced-motion` hides canvas, shows fallback DOM text
- [ ] Fallback text matches particle text exactly
- [ ] Geometry/material/renderer disposed on unmount
- [ ] Frame rate verified at target particle count (DevTools Performance)
- [ ] No `new Float32Array` or `new BufferAttribute` inside render loop
