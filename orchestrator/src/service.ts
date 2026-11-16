// The real RuntimeService (DECISIONS #8). Implementation lives in runtime/service.ts; this path is what
// src/http/serve-live.ts and bench/ours/service.ts import.
export { RealRuntimeService, createRuntimeService, type GrantFn, type ServiceOptions } from "./runtime/service.ts";
export { RunManager, type RunManagerDeps, type StartRunOptsExt } from "./runtime/runs.ts";
