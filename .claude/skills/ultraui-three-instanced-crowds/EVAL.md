---
name: three-instanced-crowds-eval
description: Use when verifying that three-instanced-crowds was actually implemented correctly. Adversarial audit, not a summary.
pairs_with: three-instanced-crowds
---

# Eval: Three.js Instanced Crowds

## What this audits
The most common shipped failure is an instanced crowd where the developer creates one Mesh per object instead of an InstancedMesh, resulting in thousands of draw calls and single-digit frame rates. The second most common: an InstancedMesh that allocates new objects inside the render loop, creating garbage collection spikes that appear as periodic stutter every 2-3 seconds.

## Evidence required
- Source file containing the InstancedMesh setup and render loop
- `renderer.info.render.calls` logged per frame (must be 1 for the crowd, not N)
- `renderer.info.render.triangles` logged per frame
- DevTools Performance recording showing frame times and GC events over 10 seconds
- `renderer.info.memory` before init, during render, and after dispose
- Screenshot showing the crowd rendering with visible per-instance variation (color, scale, rotation)

## Automated checks

```js
const src = await fs.readFile('src/crowd.js', 'utf8')

// Must use InstancedMesh, not N separate Meshes
const hasInstanced = /InstancedMesh/.test(src)
console.assert(hasInstanced, 'FAIL: Must use InstancedMesh, not individual meshes')

// Must set DynamicDrawUsage if updating per frame
const hasDynamic = /DynamicDrawUsage/.test(src)
const hasNeedsUpdate = /instanceMatrix\s*\.\s*needsUpdate\s*=\s*true/.test(src)
if (hasNeedsUpdate) {
  console.assert(hasDynamic, 'FAIL: Updating instanceMatrix per frame without DynamicDrawUsage hint')
}

// Must not allocate in render loop
const loopMatch = src.match(/setAnimationLoop\s*\(\s*(?:function\s*)?\([\s\S]*?\{([\s\S]*?)\}\s*\)/)?.[1]
  || src.match(/function\s+(?:animate|render|loop|update|tick)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1]
if (loopMatch) {
  const hasNewInLoop = /new\s+THREE\.\w+/.test(loopMatch)
  console.assert(!hasNewInLoop, 'FAIL: new THREE.* allocation found inside render loop')
}

// Must compute bounding sphere
const hasBoundingSphere = /computeBoundingSphere/.test(src)
console.assert(hasBoundingSphere, 'FAIL: Must call computeBoundingSphere() after populating matrices')

// Must have dispose
const hasDispose = /\.dispose\(\)/.test(src)
console.assert(hasDispose, 'FAIL: No dispose() calls found')

// Runtime: check draw calls
const drawCalls = await page.evaluate(() => {
  if (window.__renderer) return window.__renderer.info.render.calls
  return null
})
if (drawCalls !== null) {
  console.assert(drawCalls < 10, `FAIL: ${drawCalls} draw calls; expected ~1 for instanced crowd`)
}
```

## Manual inspection protocol

1. Log `renderer.info.render.calls` to console. FAIL if the crowd contributes more than 1 draw call (2 if shadow-casting).
2. Open DevTools Performance panel, record 10 seconds. FAIL if GC events (yellow bars) appear more than twice, indicating render-loop allocations.
3. Open DevTools Performance panel, record 10 seconds. FAIL if any frame exceeds 16.67ms on desktop (with 10k instances).
4. Rotate the camera so the crowd is entirely behind you. Check `renderer.info.render.triangles`. FAIL if triangle count does not decrease (frustum culling broken).
5. Trigger a route change or unmount. Check `renderer.info.memory.geometries` and `textures` before and after. FAIL if they do not decrease.
6. Set `prefers-reduced-motion: reduce`. FAIL if instances are still animating per frame.
7. Inspect instance variation visually. FAIL if all instances have identical scale, rotation, and color (no per-instance variation applied).
8. Log `mesh.count` and compare to intended active count. FAIL if it equals `maxCount` when some instances should be hidden.

## Scoring rubric

| # | Criterion | Weight | 0 (fail) | 1 (partial) | 2 (pass) |
|---|---|---|---|---|---|
| 1 | Uses InstancedMesh | 3 | Individual Mesh per object | InstancedMesh but count hardcoded | InstancedMesh with correct maxCount |
| 2 | Zero render-loop allocations | 3 | new Vector3/Matrix4 in loop | Some pre-allocated, some not | All working objects pre-allocated outside loop |
| 3 | DynamicDrawUsage set | 2 | Not set, updating per frame | Set but on wrong attribute | Set on instanceMatrix and any updated attributes |
| 4 | Bounding sphere computed | 2 | Not computed | Computed but not after all matrices set | Computed after full population |
| 5 | Disposal complete | 2 | No disposal | Mesh disposed but geometry/material leak | Geometry, material, textures, and mesh all disposed |
| 6 | Per-instance variation | 1 | All identical | Position varies, but color/scale uniform | Position, rotation, scale, and color all varied |
| 7 | Dynamic count (show/hide) | 1 | Not implemented | Count changes but gaps in buffer | Swap-to-end pattern with correct count |
| 8 | Frame time at target count | 2 | > 16.67ms | Occasional spikes | Stable < 16.67ms |
| 9 | LOD or geometry budget | 1 | 50k instances at full detail | Budget documented but no LOD | LOD implemented or count proven within budget |
| 10 | Reduced motion | 1 | Not handled | Checked but animation still runs | Static crowd displayed, no per-frame updates |

**Total: 36 points. Ship threshold: 28+.**

## Common false passes

1. **"Draw calls are 1"** -- confirmed in DevTools but the crowd is only 50 instances. The real test is whether it stays 1 at 10,000.
2. **"No allocations in the loop"** -- but `mesh.getMatrixAt()` allocates internally if you pass no target matrix. Must pass a pre-allocated Matrix4.
3. **"Bounding sphere computed"** -- but computed before matrices were populated, so it is a default sphere at origin. Instances outside it are culled incorrectly.
4. **"Disposal works"** -- mesh.dispose() called but the shared geometry is still referenced by a variable, preventing GC. Must null all references.
5. **"Per-instance color works"** -- colors set but `instanceColor.needsUpdate = true` never called after initialization. Colors appear only on first render or not at all.
6. **"LOD works"** -- transitions are visible as popping because distance thresholds are too close together. Need hysteresis or a transition band.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| Thousands of draw calls | Individual Mesh per object | Replace with single InstancedMesh |
| Periodic stutter (GC spikes) | new Object3D/Matrix4/Vector3 in render loop | Pre-allocate all working objects as class properties |
| Instances frozen after init | Missing `instanceMatrix.needsUpdate = true` | Set flag after every batch of matrix writes |
| Entire crowd culled when partially visible | Missing or wrong bounding sphere | Call `computeBoundingSphere()` after populating all matrices |
| VRAM leak on unmount | Incomplete disposal | Dispose geometry, material, all textures, and the mesh itself |
| Colors not appearing | Missing `instanceColor.needsUpdate = true` | Set flag after color writes |
| Wrong instances rendered | swap-to-end bookkeeping error | Verify index/ID mapping arrays are updated symmetrically |

## Verdict format

```
INSTANCED CROWDS AUDIT
Score: XX / 36
Ship threshold: 28

| # | Criterion | Score | Note |
|---|-----------|-------|------|
| 1 | InstancedMesh used | X/6 | ... |
...

Blocking issues:
- (list any criterion scoring 0)

Verdict: SHIP / NO SHIP
```
