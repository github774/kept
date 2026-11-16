// Fleet-scale mode (DECISIONS #16): 1,000 real agents as 250 teams of 4. See docs/FLEET.md.
export { FleetRunner, pickPoisoned, V2_TASKS, type FleetRunnerDeps } from "./runner.ts";
export { FleetBus } from "./bus.ts";
export { FleetAggregator } from "./stats.ts";
export { FleetGates, Gate } from "./limits.ts";
export { ShardCore, MemoryKV, SHARD_OPS, type ShardKV, type ShardOp } from "./shard-core.ts";
export { MemoryFleetShard, memoryShardFactory, DEFAULT_LIMITS, type FleetStartOpts, type FleetLimits, type ShardClient, type ShardFactory } from "./types.ts";
export { MemoryCaseLibrary, MemoryChunkStore, FleetLedger } from "./stores.ts";
