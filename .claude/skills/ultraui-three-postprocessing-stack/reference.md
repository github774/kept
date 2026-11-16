# Postprocessing Stack Reference

## Effect cost table

Every effect listed with its approximate per-frame cost at 1080p DPR 1 on a mid-range desktop GPU (GTX 1060 class). Costs scale linearly with pixel count (resolution * DPR^2).

| Effect | Internal passes | ~Cost at 1080p | Notes |
|---|---|---|---|
| BloomEffect (mipmapBlur) | 1 bright extract + 5-7 mip blur + 1 composite | 1.5-2.5ms | Cost depends on kernel size. SMALL: ~1.2ms, LARGE: ~2.8ms |
| BloomEffect (legacy) | 1 bright + 2 separable blur + 1 composite | 1.0-1.8ms | Lower quality than mipmap variant |
| VignetteEffect | 0 (merged into parent EffectPass) | ~0.1ms | Trivial per-pixel multiply |
| NoiseEffect | 0 (merged) | ~0.1ms | Hash-based, no texture sample |
| ChromaticAberrationEffect | 0 (merged) | 0.2-0.5ms | Radial modulation adds 2 extra texture samples |
| DepthOfFieldEffect | 1 CoC compute + 2 separable blur | 1.5-3.0ms | Cost scales with bokehScale |
| ToneMappingEffect | 0 (merged) | ~0.05ms | Single pow/multiply per pixel |
| SMAAEffect | 2 passes (edge detect + blend weight) | 0.5-1.0ms | Preset affects quality/cost tradeoff |
| SSAOEffect | 1 AO pass + 1 blur | 2.0-4.0ms | Expensive. samples parameter is the main cost lever |
| SSREffect | 1 ray march pass | 3.0-6.0ms | Most expensive stock effect. Use only on desktop HIGH tier |

## EffectPass merging rules

The `postprocessing` library merges effects placed in the same `EffectPass` into a single compiled fragment shader. This is the primary performance advantage over Three's own per-pass compositor. Rules:

1. Effects that only read the color buffer can merge freely.
2. Effects that need the depth buffer (DOF, SSAO) force the EffectPass to sample depth. If mixed with non-depth effects, all effects in that pass pay the depth sample cost.
3. Effects that write their own render targets internally (Bloom, SSR) cannot truly "merge" but their composite step can merge with subsequent color-only effects.
4. Maximum ~6 effects per EffectPass before shader compilation time becomes noticeable on first frame (1-3 second stall on low-end GPUs). Split into two passes if needed.

## BloomEffect parameter reference

| Parameter | Type | Default | Range | Behavior |
|---|---|---|---|---|
| intensity | float | 1.0 | 0.0 - 5.0 | Multiplier on the bloom composite. Above 2.0 produces heavy glow. |
| luminanceThreshold | float | 0.9 | 0.0 - 1.0 | Brightness cutoff. Only pixels above this contribute to bloom. |
| luminanceSmoothing | float | 0.025 | 0.0 - 1.0 | Softness of the threshold edge. Higher = more gradual falloff. |
| mipmapBlur | bool | false | -- | Use mip-chain blur instead of separable Gaussian. Better quality, slightly more memory. |
| kernelSize | KernelSize | LARGE | VERY_SMALL(0) to HUGE(5) | Number of mip levels for blur radius. Each level doubles the visual radius. |

## DepthOfFieldEffect parameter reference

| Parameter | Type | Default | Range | Behavior |
|---|---|---|---|---|
| focusDistance | float | 0.0 | 0.0 - 1.0 | Normalized focus plane distance (0 = near, 1 = far). |
| focalLength | float | 0.1 | 0.0 - 1.0 | Depth range in focus. Smaller = shallower DOF. |
| focusRange | float | 0.1 | 0.0 - 1.0 | Alternative to focalLength; width of the in-focus band. |
| bokehScale | float | 1.0 | 0.0 - 10.0 | Multiplier on the blur radius. Higher = more pronounced blur. |

To auto-focus on a mesh, compute `focusDistance` from camera-to-mesh distance divided by camera far plane:
```js
const dist = camera.position.distanceTo(target.position)
dofEffect.cocMaterial.uniforms.focusDistance.value = dist / (camera.far - camera.near)
```

## ChromaticAberrationEffect parameter reference

| Parameter | Type | Default | Behavior |
|---|---|---|---|
| offset | Vector2 | (0.001, 0.001) | RGB channel separation in UV space. Larger = more visible fringing. |
| radialModulation | bool | false | When true, aberration increases toward screen edges (like a real lens). |
| modulationOffset | float | 0.15 | Center radius where aberration starts (radial mode only). |

## ToneMappingMode values

| Mode | Look | Use case |
|---|---|---|
| LINEAR | No curve, raw values | Product photography requiring color accuracy |
| REINHARD | Soft rolloff | General purpose, less contrast than ACES |
| ACES_FILMIC | Film-like S-curve with highlight compression | Cinematic, the most common choice |
| AGX | Balanced, less saturation shift than ACES | Preferred for scenes with saturated colors that ACES would clip |

## SMAAPreset values

| Preset | Edge detection | Blend passes | Quality | Cost |
|---|---|---|---|---|
| LOW | threshold 0.15 | 8 steps | Acceptable | ~0.3ms |
| MEDIUM | threshold 0.1 | 16 steps | Good | ~0.5ms |
| HIGH | threshold 0.1 | 32 steps | Very good | ~0.8ms |
| ULTRA | threshold 0.05 | 64 steps | Excellent | ~1.2ms |

At DPR >= 2, pixel density already handles most aliasing. Drop to LOW or skip SMAA entirely.

## KernelSize enum

| Name | Value | Mip levels | Visual radius | Relative cost |
|---|---|---|---|---|
| VERY_SMALL | 0 | 1 | Tight halo | 1x |
| SMALL | 1 | 2 | Subtle glow | 1.2x |
| MEDIUM | 2 | 3 | Standard bloom | 1.5x |
| LARGE | 3 | 5 | Wide glow | 2x |
| VERY_LARGE | 4 | 7 | Very wide | 2.8x |
| HUGE | 5 | 9 | Screen-filling | 3.5x |

## Common effect orderings

### Cinematic (film look)
RenderPass -> EffectPass(Bloom, Vignette, Grain, ToneMapping, SMAA) -> EffectPass(DOF)

### Clean product
RenderPass -> EffectPass(ToneMapping[LINEAR], SMAA[ULTRA])

### Stylized/glitch
RenderPass -> EffectPass(Bloom[high intensity], CA[animated], CustomGlitch) -> EffectPass(Grain, ToneMapping)

### Performance-critical (mobile)
RenderPass -> EffectPass(Vignette, ToneMapping)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Scene looks washed out / flat highlights | Double tone mapping | Set `renderer.toneMapping = NoToneMapping` |
| Bloom visible everywhere, not just bright areas | Threshold too low or no HDR materials | Raise threshold or add emissive values > 1.0 |
| Black screen after adding composer | Forgot RenderPass as first pass | Always add `new RenderPass(scene, camera)` first |
| Pixelated output | composer.setSize not called or called with wrong dimensions | Pass physical pixel dims (CSS * DPR) |
| Flash of wrong-size output on resize | Resize fires before camera projection update | Update camera aspect + projection BEFORE composer.setSize |
| DOF has no effect | focusDistance/focalLength not tuned to scene scale | Log camera-to-subject distance; set focusDistance to normalized value |
| Grain is invisible | Opacity too low or blendFunction wrong | Try 0.08 opacity with SOFT_LIGHT; check on a non-Retina screen |
| SMAA edges visible as artifacts | Preset too aggressive for the content | Lower preset or switch to renderer-level MSAA |
| Composer crashes on context loss | Not handling webglcontextlost | Add context loss handler per `three-js-fundamentals` |
| Memory grows on repeat init/dispose | Effect instances not disposed before re-creation | Call `.dispose()` on every effect before creating new ones |
