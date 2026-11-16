// The shard core lives with the actors (actors/src/fleet-shard-core.ts) so the FleetShard actor and the
// in-memory shard run the same code. Dependency-free, so importing it here pulls in nothing else.
export * from "../../../actors/src/fleet-shard-core.ts";
