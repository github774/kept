---
name: three-postprocessing-stack-eval
description: Use when verifying that three-postprocessing-stack was actually implemented correctly. Adversarial audit, not a summary.
pairs_with: three-postprocessing-stack
---

# Eval: Three.js Postprocessing Stack

## What this audits
The most common shipped failure is a postprocessing stack that looks correct on the developer's machine but either tanks frame rate on mid-range hardware, leaks GPU memory on route changes, or applies tone mapping twice (once via renderer, once via effect) producing washed-out highlights. A rushed build typically skips the budget monitor, hardcodes a single quality tier, and never tests disposal.

## Evidence required
- Source files containing the PostStack class or EffectComposer setup
- DevTools Performance panel recording showing frame times across a 10-second interaction
- `renderer.info.memory.textures` count before init, during render, and after dispose
- `renderer.toneMapping` value logged at runtime (must be `NoToneMapping`)
- Screenshot at 1080p comparing scene with postprocessing vs without (to prove effects are visible)
- Console log of tier transitions when CPU is throttled 4x in DevTools

## Automated checks

```js
// Static: verify renderer tone mapping is disabled
const src = await fs.readFile('src/postStack.js', 'utf8')
const hasToneOff = /renderer\s*\.\s*toneMapping\s*=\s*(THREE\.)?NoToneMapping/.test(src)
console.assert(hasToneOff, 'FAIL: renderer.toneMapping must be set to NoToneMapping when using ToneMappingEffect')

// Static: verify composer.setSize is called in resize
const hasComposerResize = /composer\s*(\?\.|\.)setSize/.test(src)
console.assert(hasComposerResize, 'FAIL: composer.setSize must be called in resize handler')

// Static: verify dispose method exists and calls composer.dispose
const hasDispose = /dispose\s*\(\s*\)[\s\S]{0,500}composer[\s\S]{0,50}\.dispose\(\)/.test(src)
console.assert(hasDispose, 'FAIL: dispose method must call composer.dispose()')

// Static: verify no renderer MSAA when using postprocessing SMAA
const hasAntialiasTrue = /WebGLRenderer\(\s*\{[^}]*antialias\s*:\s*true/.test(src)
const hasSMAA = /SMAAEffect|<SMAA/.test(src)
if (hasAntialiasTrue && hasSMAA) {
  console.error('FAIL: antialias:true on renderer AND SMAA in composer is redundant. Pick one.')
}

// Runtime: verify effects are actually producing visible output
const result = await page.evaluate(() => {
  const canvas = document.querySelector('canvas')
  if (!canvas) return { error: 'no canvas found' }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  // Sample center pixel
  const data = ctx?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
  return { pixel: data ? Array.from(data) : null }
})
// Non-black pixel confirms rendering is active
console.assert(result.pixel && result.pixel.some(v => v > 0), 'FAIL: canvas is rendering black or empty')

// Runtime: verify texture count is bounded
const texCount = await page.evaluate(() => {
  // Access Three.js renderer info if exposed
  if (window.__renderer) return window.__renderer.info.memory.textures
  return null
})
if (texCount !== null) {
  console.assert(texCount < 20, `FAIL: ${texCount} textures in memory; expected < 20 for a managed stack`)
}
```

## Manual inspection protocol

1. Open DevTools Performance panel. Record 5 seconds of idle scene rendering. FAIL if any frame exceeds 16.67ms on a desktop GPU.
2. Open DevTools > Application > GPU memory (or use `renderer.info.memory`). Note texture count. Navigate away from the page (route change). Check texture count again. FAIL if textures did not decrease to pre-init levels after dispose.
3. Throttle CPU 4x in DevTools Performance panel. Observe for 5 seconds. FAIL if no tier demotion message appears in console and effects remain at full quality while frame time exceeds 20ms.
4. Set `prefers-reduced-motion: reduce` in DevTools Rendering tab. FAIL if grain still flickers or CA offset still animates.
5. Resize the browser window by dragging. FAIL if the postprocessing output appears stretched, offset, or at the wrong resolution for more than one frame.
6. Check `renderer.toneMapping` at runtime via console. FAIL if it is anything other than `NoToneMapping`.
7. Add a mesh with `material.emissive = new Color(2, 2, 2)`. FAIL if bloom has no visible effect on that mesh (threshold too high or bloom not wired).
8. Remove all emissive materials. FAIL if bloom still produces a visible halo (threshold too low, wasting GPU on invisible work).

## Scoring rubric

| # | Criterion | Weight | 0 (fail) | 1 (partial) | 2 (pass) |
|---|---|---|---|---|---|
| 1 | Tone mapping correctness | 3 | Double tone mapping (renderer + effect) | Renderer TM disabled but no ToneMappingEffect | Renderer NoToneMapping, ToneMappingEffect in stack |
| 2 | Budget monitor active | 3 | No measurement, no tier switching | Timer exists but never triggers tier change | GPU or JS timer with automatic demotion/promotion |
| 3 | Disposal completeness | 3 | No dispose method or it skips render targets | Composer disposed but effects leak | All effects, composer, GPU queries, and resize observer disposed |
| 4 | Resize propagation | 2 | Composer size not updated on resize | Updated but resolution scale not reapplied | Renderer + composer + camera all updated, tier scale reapplied |
| 5 | Effect merging | 2 | Every effect in its own EffectPass | Some merged, some unnecessarily separate | Compatible effects merged; DOF isolated correctly |
| 6 | Tier degradation path | 2 | Only one quality level | Tiers exist but untested | HIGH/MEDIUM/LOW/OFF all produce correct output |
| 7 | Bloom requires HDR input | 1 | Bloom on with no emissive surfaces | Emissive exists but threshold not tuned | Threshold matches scene's actual brightness range |
| 8 | DPR clamped | 1 | No DPR handling | Clamped on renderer but not on composer | Both renderer and composer respect DPR <= 2 |
| 9 | Reduced motion | 1 | No prefers-reduced-motion handling | Query checked but some animated effects still run | All animated params frozen, static effects preserved |
| 10 | MSAA/SMAA conflict | 1 | Both renderer MSAA and SMAA active | Only one active but not explicitly documented | Correct choice made and renderer antialias matches |

**Total: 38 points. Ship threshold: 30+.**

## Common false passes

1. **"Bloom is working"** -- developer sees a bright scene but bloom threshold is below the scene's actual brightness range, meaning bloom is applied everywhere (expensive haze, not selective glow). Check by setting threshold to 1.0 and confirming bloom disappears on non-emissive surfaces.
2. **"Disposal works"** -- dispose is called but the resize observer is not disconnected, keeping a reference to the renderer alive and preventing full GC of the GL context.
3. **"Tier switching tested"** -- developer toggled tiers manually via a debug UI but the automatic budget monitor never ran. The demotion threshold is untested against real frame-time pressure.
4. **"Performance is fine"** -- tested on a discrete GPU at DPR 1. On a 3x DPR phone the same stack is 9x the fragment cost. No DPR clamp, no resolution scaling.
5. **"Resize works"** -- canvas resizes but `composer.setSize()` is called with CSS pixels, not physical pixels. Output is correct size but at quarter resolution on Retina.
6. **"Tone mapping is correct"** -- ToneMappingEffect added to the stack but `renderer.toneMapping` was never changed from the default `ACESFilmicToneMapping`, double-applying. Highlights look flat but developer attributes it to "the ACES look."
7. **"Effects are merged"** -- all effects placed in one EffectPass including DOF, which silently fails to produce correct depth-based blur because it needs to be isolated to access the depth buffer properly.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| Washed-out highlights | Double tone mapping | Set `renderer.toneMapping = THREE.NoToneMapping` |
| No visible bloom | No HDR/emissive surfaces above threshold | Add `material.emissive.setRGB(2, 2, 2)` or lower threshold |
| VRAM leak on route change | Missing dispose or incomplete cleanup | Call `stack.dispose()` which recursively disposes effects, composer, observer, queries |
| Frame rate drop on resize | `composer.setSize()` not called | Add `composer.setSize(w * dpr, h * dpr)` to resize handler |
| No tier switching under load | Budget monitor not wired or thresholds wrong | Verify `beginMeasure`/`endMeasure` bracket `composer.render`, test with CPU throttle |
| DOF not working when merged | DOF in same EffectPass as non-depth effects | Move DOF to its own EffectPass |
| Stretched output | Composer at wrong resolution | Pass physical pixel dimensions (CSS * DPR) to `composer.setSize()` |

## Verdict format

```
POSTPROCESSING STACK AUDIT
Score: XX / 38
Ship threshold: 30

| # | Criterion | Score | Note |
|---|-----------|-------|------|
| 1 | Tone mapping | X/6 | ... |
...

Blocking issues:
- (list any criterion scoring 0)

Verdict: SHIP / NO SHIP
```
