---
name: three-instanced-crowds
description: Use when rendering thousands of repeated objects (crowds, forests, particle shapes, debris, props) with per-instance transforms, colors, and animation. Builds a complete InstancedMesh system with frustum culling, LOD, and disposal.
category: three
pairs_with: three-instanced-crowds-eval
---

# Three.js Instanced Crowds

## What this builds
A production instanced-mesh system that renders thousands of identical-geometry objects in a single draw call, with per-instance position, rotation, scale, color, and custom shader attributes. The finished system supports dynamic instance counts, frustum-aware rendering, LOD switching, and full disposal.

- InstancedMesh with typed-array-driven transforms updated per frame
- Per-instance color and custom attributes via InstancedBufferAttribute
- Dynamic instance show/hide without rebuilding the mesh
- LOD integration: swap geometry detail by camera distance
- Frustum culling at the instance level for open-world scenes
- Full disposal of geometry, material, and attribute buffers

## When to use / when not to
- Use when you have 50+ visually identical objects that differ only in transform, color, or a small set of per-instance parameters.
- Use for crowd simulation, vegetation scattering, debris fields, architectural repeated elements, data visualization with thousands of glyphs.
- Do NOT use for 5-10 unique meshes. Individual meshes at that count are cheaper to manage and simpler to interact with. The overhead of instancing (attribute setup, matrix management) is not worth it below ~30 instances.
- Do NOT use when every object has unique geometry. Instancing requires shared geometry; if shapes differ, use `BatchedMesh` (Three.js r159+) or merge geometries manually.
- For point-sprite particles (no mesh shape, just dots/quads), see `webgl-particle-systems`. Instancing is for shaped meshes (cubes, trees, characters).

## Stack decision

| Dependency | Version | Why |
|---|---|---|
| `three` | 0.169.0 | `InstancedMesh`, `InstancedBufferAttribute`, `DynamicDrawUsage` |
| No additional dependencies | -- | Instancing is a core Three.js feature. No wrapper library needed. |

**R3F alternative:** drei's `<Instances>` / `<Instance>` provides a declarative API. Use it when you are already in R3F and instance count is under ~5,000. For 10k+ with custom shader attributes, drop to raw `InstancedMesh` via refs even inside R3F.

**Cheaper alternative:** `mergeBufferGeometries` from Three.js utilities bakes all instances into one static geometry. Zero per-frame cost but no per-instance animation possible.

## Architecture

```
InstancedCrowd
  |- InstancedMesh (single draw call)
  |    |- shared BufferGeometry (the template shape)
  |    |- shared Material (standard or custom ShaderMaterial)
  |    |- instanceMatrix (InstancedBufferAttribute, float32, 16 per instance)
  |    |- instanceColor (InstancedBufferAttribute, float32, 3 per instance)
  |    |- custom attributes (InstancedBufferAttribute, any)
  |
  |- TransformManager
  |    |- holds position/rotation/scale arrays
  |    |- composes into matrix4 per instance
  |    |- marks instanceMatrix.needsUpdate = true
  |
  |- DynamicCount
  |    |- mesh.count controls how many instances draw
  |    |- swap-to-end pattern for hiding instances without gaps
  |
  |- LODController (optional)
  |    |- multiple InstancedMesh at different detail levels
  |    |- reassigns instances between LODs based on camera distance
  |
  |- Disposer
       |- geometry.dispose(), material.dispose()
       |- texture disposal if material has maps
```

Lifecycle: create geometry + material -> create InstancedMesh(geo, mat, maxCount) -> populate instance matrices -> render loop updates matrices -> resize/route-change disposes everything.

## Build it: step by step

### Phase 1: Create the base InstancedMesh

```js
import * as THREE from 'three'

const COUNT = 10000
const dummy = new THREE.Object3D() // reusable for composing matrices

// Template geometry: one low-poly shape shared by all instances
const geometry = new THREE.BoxGeometry(0.5, 1.0, 0.5)
const material = new THREE.MeshStandardMaterial({
  color: 0x88aacc,
  roughness: 0.6,
  metalness: 0.2,
})

const crowd = new THREE.InstancedMesh(geometry, material, COUNT)
crowd.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // hint: we update every frame
crowd.castShadow = true
crowd.receiveShadow = true
scene.add(crowd)
```

### Phase 2: Populate initial transforms

Scatter instances across a ground plane using seeded positions. Never allocate new objects per instance; reuse the dummy Object3D to compose each matrix.

```js
function populateTransforms(crowd, count, spread) {
  const dummy = new THREE.Object3D()
  for (let i = 0; i < count; i++) {
    // Distribute on a disc
    const angle = Math.random() * Math.PI * 2
    const radius = Math.sqrt(Math.random()) * spread
    dummy.position.set(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius,
    )
    dummy.rotation.y = Math.random() * Math.PI * 2
    const s = 0.6 + Math.random() * 0.8
    dummy.scale.set(s, s + Math.random() * 0.5, s)
    dummy.updateMatrix()
    crowd.setMatrixAt(i, dummy.matrix)
  }
  crowd.instanceMatrix.needsUpdate = true
  // Compute bounding sphere for frustum culling to work
  crowd.computeBoundingSphere()
}

populateTransforms(crowd, COUNT, 50)
```

### Phase 3: Per-instance color

```js
function assignColors(crowd, count) {
  const color = new THREE.Color()
  for (let i = 0; i < count; i++) {
    // HSL palette with hue variation
    color.setHSL(0.55 + Math.random() * 0.15, 0.5, 0.4 + Math.random() * 0.3)
    crowd.setColorAt(i, color)
  }
  crowd.instanceColor.needsUpdate = true
}

assignColors(crowd, COUNT)
```

### Phase 4: Per-frame animation

Animate a subset of instances each frame. The key discipline: never allocate in the render loop. Pre-allocate all working objects.

```js
const _matrix = new THREE.Matrix4()
const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _euler = new THREE.Euler()

// Per-instance velocity stored in a flat array (cheaper than object allocation)
const velocities = new Float32Array(COUNT)
for (let i = 0; i < COUNT; i++) {
  velocities[i] = 0.2 + Math.random() * 0.8 // radians/sec
}

function animateCrowd(crowd, count, delta) {
  for (let i = 0; i < count; i++) {
    crowd.getMatrixAt(i, _matrix)
    _matrix.decompose(_position, _quaternion, _scale)

    // Simple: rotate each instance around Y at its own speed
    _euler.setFromQuaternion(_quaternion)
    _euler.y += velocities[i] * delta
    _quaternion.setFromEuler(_euler)

    _matrix.compose(_position, _quaternion, _scale)
    crowd.setMatrixAt(i, _matrix)
  }
  crowd.instanceMatrix.needsUpdate = true
}

// In render loop:
const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta()
  animateCrowd(crowd, COUNT, delta)
  renderer.render(scene, camera)
})
```

### Phase 5: Dynamic instance count (show/hide)

`InstancedMesh.count` controls how many instances are drawn. To "hide" an instance, swap its matrix with the last visible instance and decrement count. This avoids gaps in the attribute arrays.

```js
class CrowdManager {
  constructor(mesh, maxCount) {
    this.mesh = mesh
    this.maxCount = maxCount
    this.activeCount = maxCount
    // Map from logical ID to current buffer index
    this.idToIndex = new Uint32Array(maxCount)
    this.indexToId = new Uint32Array(maxCount)
    for (let i = 0; i < maxCount; i++) {
      this.idToIndex[i] = i
      this.indexToId[i] = i
    }
  }

  hide(id) {
    const idx = this.idToIndex[id]
    if (idx >= this.activeCount) return // already hidden
    this.activeCount--
    const lastIdx = this.activeCount
    const lastId = this.indexToId[lastIdx]

    // Swap matrices
    const _m = new THREE.Matrix4()
    this.mesh.getMatrixAt(idx, _m)
    const _mLast = new THREE.Matrix4()
    this.mesh.getMatrixAt(lastIdx, _mLast)
    this.mesh.setMatrixAt(idx, _mLast)
    this.mesh.setMatrixAt(lastIdx, _m)

    // Swap colors if present
    if (this.mesh.instanceColor) {
      const _c = new THREE.Color()
      const _cLast = new THREE.Color()
      this.mesh.getColorAt(idx, _c)
      this.mesh.getColorAt(lastIdx, _cLast)
      this.mesh.setColorAt(idx, _cLast)
      this.mesh.setColorAt(lastIdx, _c)
    }

    // Update maps
    this.idToIndex[lastId] = idx
    this.indexToId[idx] = lastId
    this.idToIndex[id] = lastIdx
    this.indexToId[lastIdx] = id

    this.mesh.count = this.activeCount
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  show(id) {
    const idx = this.idToIndex[id]
    if (idx < this.activeCount) return // already visible
    // Swap with the first hidden instance (at activeCount)
    const swapIdx = this.activeCount
    const swapId = this.indexToId[swapIdx]

    const _m = new THREE.Matrix4()
    this.mesh.getMatrixAt(idx, _m)
    const _mSwap = new THREE.Matrix4()
    this.mesh.getMatrixAt(swapIdx, _mSwap)
    this.mesh.setMatrixAt(idx, _mSwap)
    this.mesh.setMatrixAt(swapIdx, _m)

    if (this.mesh.instanceColor) {
      const _c = new THREE.Color()
      const _cSwap = new THREE.Color()
      this.mesh.getColorAt(idx, _c)
      this.mesh.getColorAt(swapIdx, _cSwap)
      this.mesh.setColorAt(idx, _cSwap)
      this.mesh.setColorAt(swapIdx, _c)
    }

    this.idToIndex[swapId] = idx
    this.indexToId[idx] = swapId
    this.idToIndex[id] = swapIdx
    this.indexToId[swapIdx] = id

    this.activeCount++
    this.mesh.count = this.activeCount
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}
```

### Phase 6: Custom per-instance attributes via shader

When you need per-instance data beyond transform and color (e.g., animation phase, type index, highlight intensity), add `InstancedBufferAttribute` to the geometry and read it in a custom shader.

```js
// Add a per-instance "phase" attribute for wave animation
const phases = new Float32Array(COUNT)
for (let i = 0; i < COUNT; i++) {
  phases[i] = Math.random() * Math.PI * 2
}
geometry.setAttribute(
  'aPhase',
  new THREE.InstancedBufferAttribute(phases, 1),
)

// Custom ShaderMaterial that uses per-instance phase
const customMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0x88aacc) },
  },
  vertexShader: `
    attribute float aPhase;
    uniform float uTime;
    varying float vHeight;

    void main() {
      // Instance matrix is automatically applied by Three.js
      vec3 pos = position;
      // Per-instance vertical bob
      float bob = sin(uTime * 2.0 + aPhase) * 0.3;
      pos.y += bob;
      vHeight = pos.y;

      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    varying float vHeight;

    void main() {
      // Height-based color variation
      vec3 col = uColor * (0.7 + vHeight * 0.3);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
})

// Update uniform in render loop
renderer.setAnimationLoop(() => {
  customMaterial.uniforms.uTime.value = clock.getElapsedTime()
  renderer.render(scene, camera)
})
```

### Phase 7: LOD for instanced crowds

Create multiple InstancedMesh objects at different geometry resolutions. Each frame, sort instances by camera distance and assign them to the appropriate LOD tier.

```js
class InstancedLOD {
  constructor(scene, material, maxCount) {
    // Three LOD tiers
    this.tiers = [
      { mesh: null, geo: new THREE.SphereGeometry(0.5, 16, 16), maxDist: 30 },
      { mesh: null, geo: new THREE.SphereGeometry(0.5, 8, 8), maxDist: 80 },
      { mesh: null, geo: new THREE.SphereGeometry(0.5, 4, 4), maxDist: Infinity },
    ]
    this.maxCount = maxCount
    this.positions = new Float32Array(maxCount * 3) // cached world positions

    for (const tier of this.tiers) {
      tier.mesh = new THREE.InstancedMesh(tier.geo, material, maxCount)
      tier.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      tier.mesh.count = 0
      scene.add(tier.mesh)
    }
  }

  setPosition(i, x, y, z) {
    this.positions[i * 3] = x
    this.positions[i * 3 + 1] = y
    this.positions[i * 3 + 2] = z
  }

  update(camera) {
    const counts = this.tiers.map(() => 0)
    const _dummy = new THREE.Object3D()
    const camPos = camera.position

    for (let i = 0; i < this.maxCount; i++) {
      const x = this.positions[i * 3]
      const y = this.positions[i * 3 + 1]
      const z = this.positions[i * 3 + 2]
      const dist = Math.sqrt(
        (x - camPos.x) ** 2 + (y - camPos.y) ** 2 + (z - camPos.z) ** 2,
      )

      // Find the right tier
      for (let t = 0; t < this.tiers.length; t++) {
        if (dist < this.tiers[t].maxDist) {
          _dummy.position.set(x, y, z)
          _dummy.updateMatrix()
          this.tiers[t].mesh.setMatrixAt(counts[t], _dummy.matrix)
          counts[t]++
          break
        }
      }
    }

    for (let t = 0; t < this.tiers.length; t++) {
      this.tiers[t].mesh.count = counts[t]
      this.tiers[t].mesh.instanceMatrix.needsUpdate = true
    }
  }

  dispose() {
    for (const tier of this.tiers) {
      tier.mesh.dispose()
      tier.geo.dispose()
    }
  }
}
```

### Phase 8: Frustum culling at the instance level

Three.js frustum-culls the entire InstancedMesh as one bounding sphere. For large spreads, many off-screen instances still get drawn. Instance-level culling requires checking each instance position against the camera frustum and only uploading visible matrices.

```js
const _frustum = new THREE.Frustum()
const _projScreenMatrix = new THREE.Matrix4()

function frustumCullInstances(crowd, positions, count, camera) {
  _projScreenMatrix.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  )
  _frustum.setFromProjectionMatrix(_projScreenMatrix)

  const _dummy = new THREE.Object3D()
  const _sphere = new THREE.Sphere()
  const instanceRadius = 1.0 // bounding radius of one instance

  let visibleCount = 0

  for (let i = 0; i < count; i++) {
    _sphere.center.set(
      positions[i * 3],
      positions[i * 3 + 1],
      positions[i * 3 + 2],
    )
    _sphere.radius = instanceRadius

    if (_frustum.intersectsSphere(_sphere)) {
      _dummy.position.copy(_sphere.center)
      _dummy.updateMatrix()
      crowd.setMatrixAt(visibleCount, _dummy.matrix)
      visibleCount++
    }
  }

  crowd.count = visibleCount
  crowd.instanceMatrix.needsUpdate = true
}
```

### Phase 9: Disposal

```js
function disposeCrowd(crowd) {
  crowd.geometry.dispose()

  const materials = Array.isArray(crowd.material)
    ? crowd.material
    : [crowd.material]
  materials.forEach((mat) => {
    Object.values(mat).forEach((val) => {
      if (val && val.isTexture) val.dispose()
    })
    mat.dispose()
  })

  crowd.dispose() // disposes the instanceMatrix buffer
}
```

## The full reference implementation

```js
import * as THREE from 'three'

class InstancedCrowd {
  constructor(scene, camera, opts = {}) {
    this.scene = scene
    this.camera = camera
    this.maxCount = opts.maxCount ?? 10000
    this.spread = opts.spread ?? 50
    this.enableLOD = opts.enableLOD ?? false
    this.enableFrustumCull = opts.enableFrustumCull ?? false

    this.mesh = null
    this.positions = new Float32Array(this.maxCount * 3)
    this.velocities = new Float32Array(this.maxCount)
    this.activeCount = this.maxCount
    this.disposed = false

    this._dummy = new THREE.Object3D()
    this._matrix = new THREE.Matrix4()
    this._pos = new THREE.Vector3()
    this._quat = new THREE.Quaternion()
    this._scale = new THREE.Vector3()
    this._euler = new THREE.Euler()
    this._frustum = new THREE.Frustum()
    this._projMatrix = new THREE.Matrix4()
    this._sphere = new THREE.Sphere()
  }

  init(geometry, material) {
    this.mesh = new THREE.InstancedMesh(geometry, material, this.maxCount)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true

    const color = new THREE.Color()
    for (let i = 0; i < this.maxCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const radius = Math.sqrt(Math.random()) * this.spread
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius

      this.positions[i * 3] = x
      this.positions[i * 3 + 1] = 0
      this.positions[i * 3 + 2] = z

      this._dummy.position.set(x, 0, z)
      this._dummy.rotation.y = Math.random() * Math.PI * 2
      const s = 0.6 + Math.random() * 0.8
      this._dummy.scale.set(s, s + Math.random() * 0.5, s)
      this._dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this._dummy.matrix)

      color.setHSL(0.55 + Math.random() * 0.15, 0.5, 0.4 + Math.random() * 0.3)
      this.mesh.setColorAt(i, color)

      this.velocities[i] = 0.2 + Math.random() * 0.8
    }

    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
    this.mesh.computeBoundingSphere()
    this.scene.add(this.mesh)
  }

  update(delta) {
    if (this.disposed || !this.mesh) return

    if (this.enableFrustumCull) {
      this._projMatrix.multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      )
      this._frustum.setFromProjectionMatrix(this._projMatrix)
    }

    let visible = 0
    for (let i = 0; i < this.maxCount; i++) {
      const px = this.positions[i * 3]
      const py = this.positions[i * 3 + 1]
      const pz = this.positions[i * 3 + 2]

      if (this.enableFrustumCull) {
        this._sphere.center.set(px, py, pz)
        this._sphere.radius = 1.5
        if (!this._frustum.intersectsSphere(this._sphere)) continue
      }

      this.mesh.getMatrixAt(i, this._matrix)
      this._matrix.decompose(this._pos, this._quat, this._scale)
      this._euler.setFromQuaternion(this._quat)
      this._euler.y += this.velocities[i] * delta
      this._quat.setFromEuler(this._euler)
      this._pos.set(px, py, pz)
      this._matrix.compose(this._pos, this._quat, this._scale)

      if (this.enableFrustumCull) {
        this.mesh.setMatrixAt(visible, this._matrix)
        visible++
      } else {
        this.mesh.setMatrixAt(i, this._matrix)
      }
    }

    if (this.enableFrustumCull) {
      this.mesh.count = visible
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      const mats = Array.isArray(this.mesh.material)
        ? this.mesh.material : [this.mesh.material]
      mats.forEach((m) => {
        Object.values(m).forEach((v) => { if (v?.isTexture) v.dispose() })
        m.dispose()
      })
      this.mesh.dispose()
      this.mesh = null
    }
  }
}
```

## Tuning the feel

| Parameter | Value | Why |
|---|---|---|
| Max instance count | 10,000 boxes / 5,000 low-poly models | Each instance is one matrix upload (64 bytes). 10k = 640KB per frame of CPU-side matrix math. |
| Spread radius | 50 units | Enough to feel like a crowd without instances being invisible specks. Adjust with camera FOV. |
| Scale variation | 0.6 - 1.4 | 0.6 minimum prevents "missing" instances; 1.4 max avoids standouts. |
| Rotation speed | 0.2 - 1.0 rad/s | Visible motion without disorienting spin. Above 2.0 reads as glitchy. |
| LOD distance thresholds | 30 / 80 / Infinity | Near: full detail. Mid: half geo. Far: lowest. Tune so transitions are not visible at normal camera speed. |
| Frustum culling radius | 1.5x instance bounding radius | Margin prevents popping at frustum edges during camera rotation. |
| DynamicDrawUsage | Always set | Tells WebGL the buffer is updated frequently. Without it, the driver may place the buffer in slow-read GPU memory. |
| Bounding sphere | Always compute after init | Three.js skips the entire InstancedMesh draw call if the bounding sphere is outside the frustum. Without it, frustum culling at the mesh level is disabled. |

## Variants

### 1. Vegetation scatter
Use a cross-billboard geometry (two intersecting planes) instead of 3D meshes. Apply an alpha-cutout leaf texture. Wind animation via a sine wave on the vertex Y position, driven by per-instance phase attribute and a global uTime uniform. 50,000+ instances feasible because geometry is 4 triangles.

### 2. Architectural repeats
Columns, windows, facade modules. Use merged geometry (no per-frame updates needed) via `mergeBufferGeometries` for maximum draw efficiency. Per-instance color variation for weathering. Static after initial placement; set `instanceMatrix.setUsage(StaticDrawUsage)`.

### 3. Data visualization glyphs
Each instance represents a data point. Map data dimensions to position (X/Z), height (Y scale), and color. Animate transitions by lerping instance matrices between two states. Count is typically 1,000-5,000.

### 4. Skeletal crowd (advanced)
Store bone transforms in a DataTexture. Each instance samples its animation frame from the texture in the vertex shader using instance ID as a row offset. Requires a custom ShaderMaterial. 500-2,000 animated characters feasible on desktop.

### 5. Debris / destruction
Instances start hidden (count = 0). On an event, set initial positions/velocities and increment count each frame. Apply gravity (Y velocity -= 9.81 * delta) and ground collision (clamp Y >= 0, zero velocity). Fade out by scaling to zero over 2 seconds.

## Performance budget

| Metric | Target | Lever |
|---|---|---|
| Draw calls | 1 per InstancedMesh (the entire point) | If you see more, you have multiple meshes instead of instances |
| Triangles per instance | < 200 for 10k+ instances, < 2000 for 1k instances | Reduce geometry complexity first |
| Instance matrix upload | < 2ms for 10k instances | Profile `needsUpdate` cost. If over, consider updating only a subset per frame |
| Total triangles on screen | < 2M | 10k instances * 200 tris = 2M. Stay under with LOD. |
| Texture memory | < 8MB for the crowd's materials | One shared material; texture atlases if variants needed |
| CPU per-instance work | < 0.1us per instance per frame | Decompose/compose is the bottleneck. Avoid per-instance object creation. |

**What to cut first:**
1. Geometry complexity (halve triangle count = halve GPU vertex work)
2. Instance count (reduce from 10k to 5k, often invisible in dense scenes)
3. Per-frame update scope (update only instances within 2x frustum, skip distant ones)
4. LOD (swap to 4-triangle billboards beyond 50 units)
5. Shadow casting (disable `castShadow` on crowd; use a projected shadow texture instead)

## Accessibility

### prefers-reduced-motion
```js
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  // Populate initial transforms but skip per-frame animation
  // The crowd is visible as a static scatter
}
```

### Semantics
An instanced crowd is decorative. The canvas should have `role="img"` with an `aria-label` like "Decorative 3D crowd of objects" or a more specific description.

### Honest cost
Instanced crowds are purely visual. They consume GPU resources (fill rate, vertex processing) that could affect device battery and thermal performance. On low-end devices, reduce instance count or disable entirely.

## Anti-slop rules
1. DO NOT create one Mesh per object when count exceeds 30. That is N draw calls instead of 1. Use InstancedMesh.
2. DO NOT call `new Object3D()` or `new Matrix4()` inside the render loop. Pre-allocate all working objects outside the loop and reuse them.
3. DO NOT forget `instanceMatrix.needsUpdate = true` after modifying matrices. Without it, the GPU buffer is not updated and instances appear frozen.
4. DO NOT forget `mesh.computeBoundingSphere()` after populating matrices. Without it, Three.js cannot frustum-cull the InstancedMesh and it draws even when entirely off screen.
5. DO NOT set `instanceMatrix.setUsage(StaticDrawUsage)` if you update matrices per frame. The driver will place the buffer in optimized-for-read memory, and your per-frame writes will stall.
6. DO NOT assume `mesh.count` defaults to 0. It defaults to `maxCount`. Set it explicitly if you want to start with fewer visible instances.
7. DO NOT skip disposal. `InstancedMesh.dispose()` only disposes the instance attributes. You still need to dispose the shared geometry and material separately.
8. DO NOT read `instanceMatrix` back from the GPU to decide game logic. Store positions in your own typed arrays and write to instanceMatrix; never use instanceMatrix as your source of truth.
9. DO NOT add per-instance userData or custom properties by wrapping each instance in a JS object. The overhead of 10,000 JS objects defeats the purpose. Use flat typed arrays indexed by instance ID.
10. DO NOT render 50,000 instances at full geometry detail. LOD is not optional at scale. 50k * 500 tris = 25M triangles per frame, which no consumer GPU handles at 60fps.

## Integration notes

- **`three-js-fundamentals`**: Scene/renderer/camera setup. The crowd plugs into this scene.
- **`three-raycast-interaction`**: Raycasting against InstancedMesh returns `instanceId` on the intersection result. Use this to identify which instance was clicked/hovered. See that toolkit for the pattern.
- **`three-postprocessing-stack`**: Bloom on instanced crowds works if the material has emissive values. Per-instance emissive requires a custom shader attribute.
- **`three-physics-rapier`**: Each instance can correspond to a Rapier rigid body. Sync transforms from physics world to instance matrices each frame.
- **Known conflict**: drei's `<Instances>` component creates its own InstancedMesh. Do not mix it with a raw InstancedMesh for the same objects.
- **Known conflict**: `InstancedMesh.frustumCulled` culls the ENTIRE mesh. For per-instance culling, you must implement your own frustum test and compact the visible matrices as shown in Phase 8.

## Ship checklist
- [ ] InstancedMesh created with correct maxCount (not higher than needed; VRAM allocated upfront)
- [ ] `instanceMatrix.setUsage(DynamicDrawUsage)` set if updating per frame
- [ ] `computeBoundingSphere()` called after initial population
- [ ] No allocations (`new Vector3`, `new Matrix4`, `new Object3D`) inside the render loop
- [ ] `instanceMatrix.needsUpdate = true` set after every frame's matrix updates
- [ ] Instance count verified: `renderer.info.render.calls` shows 1 draw call for the crowd
- [ ] Disposal tested: geometry, material, textures, and mesh all disposed on teardown
- [ ] LOD implemented or max triangle count per frame documented and within budget
- [ ] Per-instance color or custom attributes use `InstancedBufferAttribute`, not per-instance materials
- [ ] Tested at target count on a mid-range device (not just a desktop with a 4090)
- [ ] Frustum culling confirmed: rotating camera away from crowd drops draw call triangle count
- [ ] `prefers-reduced-motion` disables per-frame animation; crowd is still visible as static geometry
