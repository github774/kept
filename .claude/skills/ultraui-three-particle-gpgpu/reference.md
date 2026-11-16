# GPGPU Particle Simulation Reference

## GPUComputationRenderer API
| Method | Signature | Description |
|---|---|---|
| constructor | `new GPUComputationRenderer(sizeX, sizeY, renderer)` | Creates compute context. sizeX * sizeY = max data points. |
| createTexture() | `() => DataTexture` | Returns a float DataTexture (RGBA, FloatType) pre-sized to sizeX*sizeY. Fill `.image.data` with initial values. |
| addVariable | `(name, shader, initialTexture) => Variable` | Registers a simulation variable. Shader is GLSL fragment source. |
| setVariableDependencies | `(variable, [deps])` => void | Declares which textures a variable's shader reads. Creates `texture2D(depName, uv)` samplers. |
| init() | `() => string/null` | Compiles shaders, creates render targets. Returns error string or null. |
| compute() | `() => void` | Runs all simulation passes once. Call once per frame. |
| getCurrentRenderTarget | `(variable) => WebGLRenderTarget` | Returns the current output target for reading in the render pass. |
| dispose() | `() => void` | Disposes all render targets and materials. |

## Variable uniforms
Uniforms are added to `variable.material.uniforms`:
```js
variable.material.uniforms.uMyUniform = { value: 0 };
```
The shader accesses them normally: `uniform float uMyUniform;`

Built-in uniforms injected by GPUComputationRenderer:
- `resolution` (vec2): texture size in pixels
- Each dependency becomes a sampler: `uniform sampler2D textureName;`

## Texture layout conventions
| Channel | Common usage (position) | Common usage (velocity) |
|---|---|---|
| R | x position | x velocity |
| G | y position | y velocity |
| B | z position | z velocity |
| A | age / life / particle ID | force accumulator / extra state |

## Particle count vs texture size
| Texture size | Particle count | VRAM (2 vars, ping-pong) | Recommended target |
|---|---|---|---|
| 64 x 64 | 4,096 | ~0.5 MB | Prototyping |
| 128 x 128 | 16,384 | ~2 MB | Mobile |
| 256 x 256 | 65,536 | ~8 MB | Standard web |
| 512 x 512 | 262,144 | ~32 MB | Desktop hero |
| 1024 x 1024 | 1,048,576 | ~128 MB | Desktop discrete GPU only |

## Common force implementations (GLSL)
```glsl
// Point attractor
vec3 toAttractor = attractorPos - pos.xyz;
float dist = length(toAttractor);
vel.xyz += normalize(toAttractor) * strength / (dist * dist + softening);

// Point repulsor
vec3 fromRepulsor = pos.xyz - repulsorPos;
float dist = length(fromRepulsor);
vel.xyz += normalize(fromRepulsor) * strength / (dist * dist + softening);

// Gravity (constant downward)
vel.y -= 0.01;

// Orbital (tangent force for swirling)
vec3 tangent = cross(normalize(pos.xyz), vec3(0, 1, 0));
vel.xyz += tangent * orbitalStrength;

// Boundary wrap (toroidal)
pos.xyz = mod(pos.xyz + halfBounds, bounds) - halfBounds;

// Boundary respawn (random)
if (length(pos.xyz) > maxDist) {
  pos.xyz = randomSpherePosition(seed) * spawnRadius;
  vel.xyz = vec3(0);
}
```

## WebGL float texture requirements
| Feature | WebGL1 | WebGL2 |
|---|---|---|
| Float textures (render target) | Requires `OES_texture_float` + `WEBGL_color_buffer_float` | Built-in |
| Float texture filtering | Requires `OES_texture_float_linear` | Built-in |
| Half-float textures | Requires `OES_texture_half_float` | Built-in |
| Availability | ~95% desktop, ~85% mobile | ~97% desktop, ~93% mobile |

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| `gpuCompute.init()` returns error | Float textures not supported | Check WebGL2 or required extensions |
| Particles at origin (0,0,0) | Render shader not sampling position texture | Set `material.uniforms.uPositionTexture.value = gpuCompute.getCurrentRenderTarget(posVar).texture` per frame |
| Particles move as a rigid block | Noise sampled at same coordinates for all | Include `pos.xyz` in noise sampling position |
| Simulation explodes after tab switch | Delta time uncapped | Add `Math.min(delta, 0.05)` |
| Particles disappear | Escaped bounds, no respawn | Add boundary check in position shader |
| VRAM grows | GPUComputationRenderer re-created or not disposed | Init once, dispose on teardown |
| Particles jitter at 120Hz | Forces not multiplied by delta | Multiply all forces by `uDelta` |
| Black screen | Render material blending wrong or depthWrite true | Set `depthWrite: false`, `transparent: true`, check blending mode |
