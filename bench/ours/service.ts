// Tiny adapter that loads the orchestrator's RuntimeService (orchestrator/src/service.ts, owned by
// another agent). If the module or a needed capability is missing we fail loudly — the benchmark
// never fabricates a result.
import { join } from "node:path";
import { REPO_ROOT } from "../src/config.ts";
import type { RunId, RunSummary, RuntimeService } from "../../orchestrator/src/contract.ts";

export const SERVICE_PATH = join(REPO_ROOT, "orchestrator", "src", "service.ts");

export class ServiceUnavailable extends Error {
  constructor(detail: string) {
    super(`orchestrator service not available: ${detail}`);
    this.name = "ServiceUnavailable";
  }
}

/**
 * Optional extensions the benchmark needs beyond contract.ts. The service may provide either
 * `RunSummary.workDir` or `getRunWorkDir(runId)`: the folder holding the agents' final .py files
 * (next to tests/). Without it we cannot run pytest on the final code, so we refuse to run.
 */
export type BenchService = RuntimeService & {
  getRunWorkDir?: (runId: RunId) => Promise<string | null> | string | null;
};
export type RunSummaryExt = RunSummary & { workDir?: string };

const FACTORY_NAMES = ["createRuntimeService", "createService", "getRuntimeService", "getService"] as const;

function looksLikeService(x: unknown): x is BenchService {
  const s = x as Partial<RuntimeService> | null;
  return !!s && typeof s.startRun === "function" && typeof s.getLedger === "function" && typeof s.listRuns === "function";
}

/** Must be called after process.env.MODEL_PROFILE is set: the service's config reads it at import. */
export async function loadService(): Promise<BenchService> {
  if (!(await Bun.file(SERVICE_PATH).exists())) throw new ServiceUnavailable(`${SERVICE_PATH} does not exist yet`);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(SERVICE_PATH)) as Record<string, unknown>;
  } catch (e) {
    throw new ServiceUnavailable(`import failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const name of FACTORY_NAMES) {
    const f = mod[name];
    if (typeof f === "function") {
      const svc = await (f as () => unknown | Promise<unknown>)();
      if (looksLikeService(svc)) return svc;
    }
  }
  for (const name of ["service", "runtimeService", "default"]) {
    if (looksLikeService(mod[name])) return mod[name] as BenchService;
  }
  throw new ServiceUnavailable(
    `service.ts exports none of ${[...FACTORY_NAMES, "service", "runtimeService", "default"].join(", ")} as a RuntimeService`,
  );
}

export async function resolveWorkDir(svc: BenchService, run: RunSummaryExt): Promise<string> {
  if (run.workDir) return run.workDir;
  if (svc.getRunWorkDir) {
    const d = await svc.getRunWorkDir(run.runId);
    if (d) return d;
  }
  throw new ServiceUnavailable(
    `run ${run.runId}: service exposes no work dir (need RunSummary.workDir or getRunWorkDir(runId)); cannot run pytest on final code`,
  );
}
