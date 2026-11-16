# Reference: Three.js Mobile Fallback Strategy

## GPU renderer string database

### Weak tier (always assign minimal)
| String fragment | Vendor | Devices |
|---|---|---|
| mali-g31 | ARM | Budget Samsung A-series (A03, A04), Redmi 9/10 |
| mali-g51 | ARM | Samsung A30/A50 (2019), Huawei P30 Lite |
| mali-g52 | ARM | Samsung A32/A33, Xiaomi Redmi Note 11 |
| adreno (tm) 505 | Qualcomm | Snapdragon 430/435 devices |
| adreno (tm) 506 | Qualcomm | Snapdragon 625/626 devices |
| adreno (tm) 509 | Qualcomm | Snapdragon 636 devices |
| adreno (tm) 610 | Qualcomm | Snapdragon 665/662 devices |
| adreno (tm) 612 | Qualcomm | Snapdragon 675 devices |
| powervr | Imagination | Very old devices, some smart TVs |
| sgx | Imagination | iPhone 4/5, iPad 2-4 era |
| apple a9 | Apple | iPhone 6S, iPad (5th gen) |
| apple a10 | Apple | iPhone 7 |
| apple a11 | Apple | iPhone 8/X |
| intel uhd graphics 6 | Intel | 8th/9th gen Core i-series integrated |
| intel hd graphics 5 | Intel | 6th/7th gen Core i-series integrated |

### Mid tier (assign reduced)
| String fragment | Vendor | Devices |
|---|---|---|
| mali-g57 | ARM | Dimensity 700/800 devices |
| mali-g68 | ARM | Samsung A54, Dimensity 1080 |
| mali-g72 | ARM | Samsung S9, Huawei P20 Pro |
| mali-g76 | ARM | Samsung S10, Huawei P30 Pro |
| adreno (tm) 618 | Qualcomm | Snapdragon 730/732G |
| adreno (tm) 619 | Qualcomm | Snapdragon 720G/750G |
| adreno (tm) 620 | Qualcomm | Snapdragon 765G |
| adreno (tm) 630 | Qualcomm | Snapdragon 845 |
| adreno (tm) 640 | Qualcomm | Snapdragon 855 |
| apple a12 | Apple | iPhone XS/XR |
| apple a13 | Apple | iPhone 11 |
| apple a14 | Apple | iPhone 12 |
| intel iris | Intel | 10th/11th gen Core i-series, MacBook Air (Intel) |
| intel uhd graphics 7 | Intel | 11th/12th gen Core i-series integrated |

### Full tier (assign full)
| String fragment | Vendor | Devices |
|---|---|---|
| mali-g710 | ARM | Samsung S23, Pixel 7 Pro |
| mali-g715 | ARM | Samsung S24, Dimensity 9200 |
| adreno (tm) 650 | Qualcomm | Snapdragon 865 |
| adreno (tm) 660 | Qualcomm | Snapdragon 888 |
| adreno (tm) 730 | Qualcomm | Snapdragon 8 Gen 1 |
| adreno (tm) 740 | Qualcomm | Snapdragon 8 Gen 2 |
| apple a15 | Apple | iPhone 13/14 |
| apple a16 | Apple | iPhone 14 Pro |
| apple a17 | Apple | iPhone 15 Pro |
| apple m1 | Apple | MacBook Air/Pro M1 |
| apple m2 | Apple | MacBook Air/Pro M2 |
| apple m3 | Apple | MacBook Air/Pro M3 |
| nvidia geforce | NVIDIA | Any discrete NVIDIA GPU |
| amd radeon | AMD | Any discrete AMD GPU |

## WebGL context limits by browser

| Browser | Max WebGL contexts (per page) | Behavior when exceeded |
|---|---|---|
| Chrome | 16 | Oldest context lost, `webglcontextlost` event fires |
| Firefox | 16 | Same as Chrome |
| Safari | 8 | Same as Chrome, but lower limit |
| Mobile Safari | 4-8 | Aggressive context eviction under memory pressure |

Creating a benchmark context counts against this limit. Always dispose it.

## Feature detection matrix

| Feature | WebGL2 | WebGL1 | Needed for |
|---|---|---|---|
| Instanced drawing | Native | `ANGLE_instanced_arrays` ext | InstancedMesh, particle systems |
| Float textures | Native | `OES_texture_float` ext | GPGPU, HDR render targets |
| MRT (multiple render targets) | Native | `WEBGL_draw_buffers` ext | Deferred rendering, G-buffer |
| sRGB textures | Native | `EXT_sRGB` ext | Correct color space |
| 3D textures | Native | Not available | Volume rendering, LUT |
| Transform feedback | Native | Not available | GPU-side simulation output |
| Uniform buffer objects | Native | Not available | Efficient large uniform sets |

## deviceMemory distribution (Chrome only)

The `navigator.deviceMemory` API returns approximate RAM in GB, rounded to a power of 2:
- 0.25: Very low-end (feature phones)
- 0.5: Low-end Android
- 1: Budget Android, older iPads
- 2: Mid-range Android
- 4: High-end Android, most iPhones (Safari does not expose this)
- 8: Desktop, high-end tablets
- 16+: Workstations

Safari and Firefox do not implement this API. Treat `undefined` as unknown (score it as mid-range).

## Thermal throttle detection

Mobile GPUs throttle frequency under sustained load. The only reliable runtime signal is frame time increasing without scene complexity changing. Pattern:

```typescript
// If average frame time increases by 30%+ over a 5-second window
// with no scene changes, the GPU is likely throttling.
function detectThermalThrottle(frameTimes: number[]): boolean {
  if (frameTimes.length < 300) return false; // need 5s at 60fps
  const firstHalf = frameTimes.slice(0, 150);
  const secondHalf = frameTimes.slice(150);
  const avgFirst = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
  return avgSecond > avgFirst * 1.3;
}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `WEBGL_debug_renderer_info` returns null | Safari privacy setting or Firefox resistFingerprinting | Fall through to hardware signals (memory, cores) for classification |
| Benchmark returns 0 FPS | requestAnimationFrame never fires (tab backgrounded, iframe hidden) | Check `document.hidden` before starting benchmark; defer if hidden |
| Context lost during benchmark | Device under memory pressure | Catch `webglcontextlost` event on benchmark canvas; classify as `minimal` |
| All mobile devices get `full` tier | DPR and viewport checks missing, or score thresholds too low | Add `(pointer: coarse)` penalty and verify score thresholds against real devices |
| Material swap causes white flash | New material compiles shader synchronously, causing 100ms+ stall | Pre-compile all tier materials at init (warm the shader cache with a single hidden render per material) |
| Tier demotion causes pop-in | Instant material/shadow swap is visually jarring | Fade canvas opacity to 0.8 during swap, then back to 1 over 200ms; the brief dim masks the transition |
