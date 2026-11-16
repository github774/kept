# Instanced Crowds Reference

## InstancedMesh API quick reference

| Method/Property | Signature | Note |
|---|---|---|
| `new InstancedMesh(geometry, material, count)` | constructor | count is the maximum; cannot grow after creation |
| `mesh.count` | number | How many instances are actually drawn. Default = maxCount. |
| `mesh.setMatrixAt(index, matrix4)` | method | Write one instance's world transform |
| `mesh.getMatrixAt(index, target)` | method | Read one instance's transform into target Matrix4 |
| `mesh.setColorAt(index, color)` | method | Write per-instance color (creates instanceColor attribute on first call) |
| `mesh.getColorAt(index, target)` | method | Read per-instance color into target Color |
| `mesh.instanceMatrix` | InstancedBufferAttribute | The raw typed array. Set `.needsUpdate = true` after writes. |
| `mesh.instanceColor` | InstancedBufferAttribute | Created on first `setColorAt`. Set `.needsUpdate = true` after writes. |
| `mesh.computeBoundingSphere()` | method | Must call after populating matrices for frustum culling to work |
| `mesh.dispose()` | method | Disposes instance attributes only. Geometry and material must be disposed separately. |

## InstancedBufferAttribute for custom data

```js
// Add per-instance float attribute
const data = new Float32Array(count)
// ... fill data
geometry.setAttribute('aMyAttr', new THREE.InstancedBufferAttribute(data, 1))
// In vertex shader: attribute float aMyAttr;
// Three.js auto-handles the instanced divisor.
```

Supported types:
| JS Type | GLSL Type | itemSize |
|---|---|---|
| Float32Array | float | 1 |
| Float32Array | vec2 | 2 |
| Float32Array | vec3 | 3 |
| Float32Array | vec4 | 4 |
| Float32Array | mat4 | 16 |

## Buffer usage hints

| Usage | When | Performance implication |
|---|---|---|
| `THREE.StaticDrawUsage` | Set once, never updated | GPU places in fast-read memory. Writes stall. |
| `THREE.DynamicDrawUsage` | Updated every frame | GPU places in write-friendly memory. Slightly slower reads. |
| `THREE.StreamDrawUsage` | Written once, used once | Rare in instancing; used for one-shot uploads. |

Default is StaticDrawUsage. Always set DynamicDrawUsage on instanceMatrix when updating per frame.

## Matrix composition cost

Decompose/compose per instance per frame is the CPU bottleneck in instanced crowds:
- `matrix.decompose(pos, quat, scale)`: ~0.05us per call
- `matrix.compose(pos, quat, scale)`: ~0.03us per call
- Total: ~0.08us per instance = ~0.8ms for 10,000 instances

Optimization: if only position changes (no rotation/scale animation), skip decompose and write position directly into the matrix's elements [12], [13], [14]:
```js
// Direct position write (skips decompose/compose)
const arr = mesh.instanceMatrix.array
arr[i * 16 + 12] = x
arr[i * 16 + 13] = y
arr[i * 16 + 14] = z
mesh.instanceMatrix.needsUpdate = true
```

## Instance matrix layout (column-major)

The 16 floats of each instance matrix in the buffer:
```
[ m00, m01, m02, m03,   // column 0 (X axis + padding)
  m10, m11, m12, m13,   // column 1 (Y axis + padding)
  m20, m21, m22, m23,   // column 2 (Z axis + padding)
  m30, m31, m32, m33 ]  // column 3 (position + w)
```
Position is at indices 12 (x), 13 (y), 14 (z). This is the Three.js column-major layout matching WebGL's expectation.

## BatchedMesh (Three.js r159+)

For crowds where instances share geometry type but have different geometries (e.g. 3 tree variants), `BatchedMesh` allows batching different geometries into a single draw call:

```js
const batched = new THREE.BatchedMesh(maxGeoCount, maxVertexCount, maxIndexCount, material)
const geoId1 = batched.addGeometry(treeGeo1)
const geoId2 = batched.addGeometry(treeGeo2)
const inst1 = batched.addInstance(geoId1)
const inst2 = batched.addInstance(geoId2)
batched.setMatrixAt(inst1, matrix1)
batched.setMatrixAt(inst2, matrix2)
```

Use BatchedMesh when you have 2-8 geometry variants. For 50+ unique geometries, use separate InstancedMesh per variant.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| All instances at origin | Forgot to call `updateMatrix()` on dummy before `setMatrixAt` | Call `dummy.updateMatrix()` after setting position/rotation/scale |
| Instances flicker | `needsUpdate` called inconsistently | Set `needsUpdate = true` exactly once per frame, after all writes |
| Performance worse than individual meshes | Count too low (< 30) or geometry too complex | Instancing overhead is constant; it only wins above ~30 instances |
| Shadow artifacts | Shadow camera frustum does not cover the crowd spread | Expand directional light shadow camera bounds to cover crowd extent |
| Colors appear black | `instanceColor.needsUpdate` not set | Set after all color writes |
| Only first instance visible | `mesh.count` never set or set to 1 | Set `mesh.count = actualCount` after populating |
| Crash on 100k+ instances | GPU buffer size limit exceeded | Stay under 65,536 for 16-bit index buffers; use 32-bit or split |
| Memory leak on dispose | Only `mesh.dispose()` called, not geometry/material | Dispose geometry, material, and textures separately |
