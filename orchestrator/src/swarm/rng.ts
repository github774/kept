// Deterministic, stateless randomness: value depends only on (seed, agent index, tick, salt).
// No Math.random anywhere in the swarm engine, so runs and tests are reproducible.

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Uniform in [0, 1). */
export function rand(seed: number, index: number, tick: number, salt = 0): number {
  let h = mix32(seed >>> 0);
  h = mix32(h ^ (index >>> 0));
  h = mix32(h ^ Math.imul(tick + 1, 0x9e3779b1));
  h = mix32(h ^ Math.imul(salt + 1, 0x85ebca6b));
  return h / 4294967296;
}
