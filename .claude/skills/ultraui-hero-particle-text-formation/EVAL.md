---
name: hero-particle-text-formation-eval
description: Use when verifying that hero-particle-text-formation was actually implemented correctly. Adversarial audit, not a summary.
pairs_with: hero-particle-text-formation
---

# Eval: Particle Text Formation Hero

## What this audits
The most common shipped failure is particles that "form" into an unreadable blob because the text sampling canvas was too small or the aspect ratio correction was skipped. The second failure is particles that look correct on desktop but are invisible on mobile because `gl_PointSize` lacks the DPR factor.

## Evidence required
- The built HTML file, opened at 1440x900 and 375x812
- Screenshot at full formation (uProgress = 1) proving text is legible
- Screenshot at full scatter (uProgress = 0) proving particles fill the viewport
- Chrome DevTools Performance recording of 3 seconds during formation animation
- Console output confirming actual particle count (print `geometry.attributes.position.count`)
- Source: vertex shader and fragment shader code
- `prefers-reduced-motion` enabled reload showing fallback text

## Automated checks

```bash
# PASS: Three.js imported
grep -qE "from\s*['\"]three['\"]" index.html && echo "PASS: Three.js" || echo "FAIL: missing Three.js"

# PASS: ShaderMaterial used (not PointsMaterial)
grep -qE "ShaderMaterial" index.html && echo "PASS: ShaderMaterial" || echo "FAIL: using PointsMaterial or other"

# PASS: Custom attributes declared
grep -qE "aTarget|aScatter" index.html && echo "PASS: custom attributes" || echo "FAIL: no custom particle attributes"

# PASS: depthWrite false
grep -qE "depthWrite.*false" index.html && echo "PASS: depthWrite false" || echo "FAIL: depthWrite not disabled"

# PASS: AdditiveBlending
grep -qE "AdditiveBlending" index.html && echo "PASS: additive blending" || echo "FAIL: missing additive blending"

# PASS: DPR cap
grep -qE "Math.min.*devicePixelRatio.*2" index.html && echo "PASS: DPR cap" || echo "FAIL: no DPR cap"

# PASS: ScrollTrigger integrated
grep -qE "ScrollTrigger" index.html && echo "PASS: ScrollTrigger" || echo "FAIL: no ScrollTrigger"

# PASS: Reduced motion
grep -qE "prefers-reduced-motion" index.html && echo "PASS: reduced motion" || echo "FAIL: no reduced motion"

# PASS: dispose on teardown
grep -qE "\.dispose\(\)" index.html && echo "PASS: dispose calls" || echo "FAIL: no disposal"
```

### Runtime checks
```js
// Check particle count
const pts = document.querySelector('canvas').__r3f?.root?.getState?.()?.scene?.children?.[0];
// Fallback: direct Three.js
const c = renderer.domElement;
console.log(`Particle count: ${geometry?.attributes?.position?.count || 'unknown'}`);

// Check gl_PointSize includes DPR
// Verify visually: particles should be ~3px visual diameter on screen

// Check formation is legible
// Manual: take screenshot at uProgress=1, verify text readable

// Frame time
let f=0;const s=performance.now();
function ct(){f++;if(performance.now()-s<2000)requestAnimationFrame(ct);else console.log(`${f} frames/2s = ${(f/2)|0}fps`);}
ct();
```

## Manual inspection protocol

1. Load page at 1440x900. Wait for formation animation to complete (~2.5s). FAIL if the formed text is not clearly readable from normal viewing distance.
2. Scroll down slowly. FAIL if particles do not smoothly scatter as you scroll.
3. Scroll back to top. FAIL if particles do not re-form into text.
4. Check particle density: FAIL if large gaps or holes are visible in the letter strokes.
5. Look at the scatter state. FAIL if particles are clustered in one area instead of distributed across the viewport.
6. Resize the window to half width. FAIL if the text aspect ratio distorts (letters squished or stretched).
7. Open DevTools Performance, record formation animation. FAIL if any frame exceeds 16ms for more than 3 consecutive frames.
8. Load at 375x812 (mobile). FAIL if particles are invisible (too small) or if there is visible banding in the scatter.
9. Enable reduced motion in OS settings. Reload. FAIL if no fallback text appears or if the canvas is still visible.
10. View source. FAIL if there are allocations (`new Float32Array`, `new THREE.BufferAttribute`) inside the render loop.

## Scoring rubric

| # | Criterion | Weight | 0 (Fail) | 1 (Partial) | 2 (Pass) |
|---|---|---|---|---|---|
| 1 | Text legibility at formation | 3 | Unreadable blob | Mostly readable but with gaps or wrong proportions | Clearly readable text with good density |
| 2 | Text sampling correctness | 2 | No text sampling; positions hardcoded or random | Sampling exists but no aspect ratio correction | Full sampling with aspect correction and font.ready gate |
| 3 | Scatter distribution | 2 | Particles clustered or all at origin | Distributed but biased toward center (no cbrt) | Uniform volume distribution (cbrt) |
| 4 | Formation animation | 2 | No animation; particles start formed | Linear interpolation, no easing | Eased formation with visible timing |
| 5 | Scroll-driven dispersion | 2 | No scroll interaction | Scroll triggers but binary (0 or 1), not smooth | Smooth progress mapping via ScrollTrigger |
| 6 | ShaderMaterial with custom attributes | 2 | PointsMaterial with no custom data | ShaderMaterial but missing some attributes | Full ShaderMaterial with aTarget, aScatter, aRandom |
| 7 | Point size DPR correction | 1 | No DPR factor in gl_PointSize | DPR factor but uncapped | DPR-capped and applied in shader |
| 8 | depthWrite/blending correct | 1 | depthWrite:true or no additive blending | One correct, one missing | Both depthWrite:false and AdditiveBlending |
| 9 | Reduced motion fallback | 2 | Not handled | Canvas hidden but no text fallback | Canvas hidden + matching DOM text shown |
| 10 | Performance | 2 | Below 30fps during formation | 30-55fps | 55fps+ at target particle count |
| 11 | Cleanup/disposal | 1 | No teardown | Partial (geometry but not material/renderer) | Full dispose + forceContextLoss |

**Total: 40 points. Ship threshold: 32+ with no criterion at 0.**

## Common false passes

1. **Text "legible" only at one exact viewport size.** If the text sampling does not normalize by aspect ratio, the text stretches on wide viewports and compresses on tall ones. It looks correct at the developer's specific test resolution.
2. **Particles invisible on 1x DPR screens.** If `gl_PointSize` is hardcoded to 3.0 without DPR multiplication, on a 1x screen each particle is 3 CSS pixels, which may be fine. But if the value was tuned on a 2x screen where `3 * 2 = 6` backing-store pixels looked good, 1x screens get particles half the intended size.
3. **Formation looks correct but text is wrong font.** If sampling runs before `document.fonts.ready`, the hidden canvas uses the system fallback font. The particles form letters in the wrong typeface, which may be similar enough to pass casual inspection.
4. **Scroll "works" but stutters.** If the render loop reads `uProgress` from a GSAP-animated value that the ScrollTrigger also writes to, both systems fight over the same value, causing jitter during scroll.
5. **`needsUpdate = true` in the render loop.** If someone tries CPU-side position updates (writing to the position attribute each frame), setting `needsUpdate = true` re-uploads the entire buffer every frame, which kills performance above 10k particles.
6. **Center-biased scatter.** Using `Math.random()` for the radius without the cube root gives a density that falls off linearly from center, making the scatter look like a pulsing star instead of a uniform cloud.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| Unreadable blob | Sampling canvas too small or no aspect correction | Use 200px font, normalize x by aspect ratio |
| Stretched text | Missing aspect ratio in position normalization | Multiply x by `(canvasWidth / canvasHeight)` |
| Wrong font in particles | Sampling before font load | Gate behind `document.fonts.ready.then(...)` |
| Invisible on mobile | No DPR in gl_PointSize | Multiply point size by `uDpr` in vertex shader |
| Center-biased scatter | Linear random radius | Use `Math.cbrt(Math.random())` for radius |
| Holes in text at overlap | depthWrite:true | Set `depthWrite: false` on material |
| Jitter during scroll | GSAP tween and ScrollTrigger both writing uProgress | Kill the entrance tween before ScrollTrigger takes over, or use ScrollTrigger's own animation |
| Low fps | Buffer re-upload every frame | Remove `needsUpdate = true` from render loop; use uniforms only |

## Verdict format
```
## Particle Text Hero Audit

| # | Criterion | Score |
|---|---|---|
| 1 | Text legibility at formation | X/2 |
| ... | ... | ... |

**Total: XX / 40**
**Blocking issues:** [list or "none"]
**SHIP / NO SHIP**
```
