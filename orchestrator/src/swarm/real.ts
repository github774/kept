// Real SwarmShard factory over the durable-actors generated client.
// The generated client is owned by the actors agent; we only need `actors.SwarmShard.get(key)`.
import type { ShardClient, ShardFactory } from "./types.ts";

export interface GeneratedActors {
  SwarmShard: { get(key: string): ShardClient };
}

export function realShardFactory(actors: GeneratedActors): ShardFactory {
  return (key) => actors.SwarmShard.get(key);
}

/** Tries known locations of the generated client; returns null if none exists yet. */
export async function loadGeneratedActors(extra: string[] = []): Promise<GeneratedActors | null> {
  const candidates = [...extra, "../actors.ts", "../generated/index.js", "../../generated/index.js", "../../../actors/generated/index.js"];
  for (const rel of candidates) {
    try {
      const spec = rel.startsWith("/") ? rel : new URL(rel, import.meta.url).href;
      const mod = (await import(spec)) as { actors?: Partial<GeneratedActors> };
      if (mod.actors?.SwarmShard?.get) return mod.actors as GeneratedActors;
    } catch {
      // not there yet
    }
  }
  return null;
}
