# Sources

## Corpus files consulted

| File | Contribution |
|---|---|
| `_raw/AThevon_genjutsu/skills/_jutsu/threejs-r3f/SKILL.md` | Performance patterns table listing `<Instances>` / InstancedMesh for 100+ identical meshes. Do-not rules on render-loop allocation and dispose. |
| `_raw/MustBeSimo_cinematic-scroll-skill/references/3d-stack.md` | Draw-call and geometry budgets per tier, instancing mandate for >8 repeats, disposal contract, DPR clamping |
| `_raw/MustBeSimo_cinematic-scroll-skill/references/performance-budget.md` | Frame budget (16.67ms), mobile degradation matrix, layer count budgets |
| `_raw/freshtechbro_claudedesignskills/.factory/droids/blender-web-pipeline.md` | GLB optimization (Draco, LOD generation from Blender) informing asset preparation for instanced crowd templates |

## Existing skills cross-referenced

| Skill | Relationship |
|---|---|
| `primitives/three-js-fundamentals` | Scene/renderer boilerplate, disposal pattern, resize handling |
| `primitives/react-three-fiber-drei` | drei's `<Instances>` / `<Instance>` declarative API as the R3F alternative |
| `primitives/webgl-particle-systems` | Point-sprite particles (distinct from shaped instanced meshes); GPGPU simulation patterns transferable to instanced crowd motion |
| `three/three-raycast-interaction` | Raycasting against InstancedMesh returns instanceId; picking pattern |
| `three/three-physics-rapier` | Per-instance physics body sync pattern |

## External documentation

- Three.js r169 docs: InstancedMesh, InstancedBufferAttribute, BufferAttribute.setUsage, BatchedMesh
- Three.js examples: instancing (webgl_instancing_performance, webgl_instancing_dynamic)
