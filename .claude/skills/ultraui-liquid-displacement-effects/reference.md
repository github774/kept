# Liquid Displacement Effects -- Reference

## Displacement map sources
| Type | Where to get | Notes |
|---|---|---|
| Water surface | Photograph water, desaturate, adjust levels to center on 128 | Most organic look |
| Perlin noise | Generate with any noise tool (Photoshop Clouds, shadertoy) | Smooth, controllable |
| Smoke/clouds | Photograph or generate | Gives wispy, directional warps |
| Radial gradient | Generated procedurally (see recipe 6) | Good for centered ripple effects |
| Hand-drawn | Paint strokes in grayscale | Unique, art-directed |
| Voronoi | Generated from cell noise | Creates cracked/shattered displacement |

## Displacement map authoring rules
1. **Center on 50% gray**: Regions at exactly `#808080` produce zero displacement. Lighter shifts one way, darker shifts the other.
2. **Blur heavily**: Sharp transitions in the map create tears in the output. Apply 5-20px Gaussian blur.
3. **Separate X and Y channels**: For independent horizontal and vertical displacement, use R channel for X and G channel for Y. Single-channel maps move in one direction only.
4. **Tile if needed**: If the effect repeats or scrolls, ensure the displacement map tiles seamlessly. Use the offset filter in Photoshop or `stitchTiles="stitch"` in SVG turbulence.
5. **Resolution 256x256 is usually enough**: The GPU interpolates between texels. A 256x256 map applied to a 1920x1080 image still produces smooth displacement because bilinear filtering fills in the gaps.

## Common gotchas

1. **UV wrapping**: If distorted UVs go below 0 or above 1, WebGL wraps by default (`gl.REPEAT`). This pulls in the opposite edge of the image, creating visible seams. Set wrap mode to `gl.CLAMP_TO_EDGE` or clamp UVs in the shader: `clamp(distortedUv, 0.0, 1.0)`.
2. **Aspect ratio**: If the image and displacement map have different aspect ratios, the distortion stretches in one direction. Ensure both textures share the same UV space, or compensate in the shader.
3. **Texture loading order**: If the displacement map loads after the image, the first few frames show the image with no displacement (fine) or a black displacement map (which shifts everything to the left, not fine). Initialize `uScale` to 0 until both textures are loaded.
4. **Mouse coordinate mapping**: `e.clientX / window.innerWidth` gives normalized viewport coordinates, but if the canvas is not fullscreen, you need `e.offsetX / canvas.clientWidth` for coordinates relative to the canvas element.
5. **Touch events**: Mobile has no hover. `touchstart`/`touchmove` can substitute, but the interaction pattern is fundamentally different -- design for tap-and-hold or drag, not enter/leave.

## Additional recipes

### Liquid cursor trail
Displacement follows the cursor with a fading trail.
```glsl
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uTrail; // render target from previous frame, faded
uniform float uScale;
varying vec2 vUv;

void main() {
  vec4 trail = texture2D(uTrail, vUv);
  // Trail R channel drives displacement
  float displace = (trail.r - 0.5) * 2.0 * uScale;
  vec2 uv = vUv + vec2(displace * 0.1, displace * 0.05);
  gl_FragColor = texture2D(uImage, uv);
}
```
The trail texture is a ping-pong FBO: each frame, render a fading copy of the previous trail plus a new bright spot at the cursor position.
```js
// Pseudo-code for trail update:
// 1. Bind trailFBO_B as render target
// 2. Draw trailFBO_A with 0.95 opacity (fade)
// 3. Draw a white circle at cursor position
// 4. Swap A and B
// 5. Pass trailFBO_B to the displacement shader
```

### Distortion grid for portfolio images
Multiple images on a single canvas, each independently displaced on hover.
```js
function createImagePlane(gl, imgSrc, x, y, w, h, camera) {
  const texture = new Texture(gl);
  const img = new Image();
  img.crossOrigin = '';
  img.src = imgSrc;
  img.onload = () => { texture.image = img; };

  const geometry = new Plane(gl, { widthSegments: 1, heightSegments: 1 });
  const program = new Program(gl, {
    vertex: displacementVertexShader,
    fragment: displacementFragmentShader,
    uniforms: {
      uImage: { value: texture },
      uDisplacement: { value: sharedDispTexture },
      uScale: { value: 0 },
    },
  });

  const mesh = new Mesh(gl, { geometry, program });
  mesh.scale.set(w, h, 1);
  mesh.position.set(x, y, 0);

  let hoverTarget = 0;
  return {
    mesh,
    setHover(v) { hoverTarget = v; },
    update() {
      const current = program.uniforms.uScale.value;
      program.uniforms.uScale.value += (hoverTarget - current) * 0.08;
    },
  };
}

// Create planes matching DOM grid positions
const planes = images.map((src, i) => {
  const rect = domImages[i].getBoundingClientRect();
  // Convert DOM coords to WebGL world coords...
  return createImagePlane(gl, src, worldX, worldY, worldW, worldH, camera);
});

// Single render loop for all
requestAnimationFrame(function loop() {
  planes.forEach(p => p.update());
  renderer.render({ scene, camera });
  requestAnimationFrame(loop);
});
```

### Noise-based animated displacement (no pre-made map)
Generate displacement in the shader from noise, eliminating the need for a texture asset.
```glsl
precision highp float;
uniform sampler2D uImage;
uniform float uTime;
uniform float uScale;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

void main() {
  float n = noise(vUv * 8.0 + uTime * 0.5) - 0.5;
  vec2 offset = vec2(n * uScale * 0.1, n * uScale * 0.05);
  gl_FragColor = texture2D(uImage, vUv + offset);
}
```
