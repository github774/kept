// Orchestrator HTTP entry: serves createApi(svc) (src/http/api.ts) over the REAL RuntimeService.
//   bun --env-file=../.env run src/http/serve-live.ts          live, ORCHESTRATOR_PORT (default 3000)
//   ORCHESTRATOR_PORT=3301 bun run src/http/serve-live.ts --mock   MockRuntimeService (everything flagged mock)
//   ... --no-supervise                                         single process (use under scripts/start-all.sh)
// Same shape as dev-mock.ts: by default it supervises itself (child process, restarted when it exits),
// so the mock-only POST /api/demo/crash shows the dashboard's reconnect. In live mode api.ts does not
// route /api/demo/crash; the real crash test is scripts/crash-test.sh (kill -9 of the whole tree).
import type { RuntimeService } from "../contract.ts";
import { createApi, dashboardOrigins } from "./api.ts";

/** The real service module. When it lands, this is the only line to touch if the path differs. */
const LIVE_SERVICE_MODULE = "../service.ts";

const mockMode = process.argv.includes("--mock");
const PORT = Number(process.env.ORCHESTRATOR_PORT ?? process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const restartDelayMs = Number(process.env.RESTART_DELAY_MS ?? 1500);
const supervise = !process.argv.includes("--no-supervise") && process.env.SERVE_LIVE_CHILD !== "1";
const tag = mockMode ? "[MOCK]" : "[live]";

/**
 * Finds a RuntimeService in the live module. Accepted exports (first match wins):
 * `createRuntimeService()` / `createService()` (sync or async factory), `service` / `runtime` / default
 * (an instance), or a class `RuntimeServiceImpl` / `LiveRuntimeService` / `OrchestratorService` (no-arg ctor).
 */
async function loadLiveService(): Promise<RuntimeService> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(LIVE_SERVICE_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `cannot import the real RuntimeService from orchestrator/src/${LIVE_SERVICE_MODULE.replace("../", "")} (${String(err)}).\n` +
        `  It is not finished yet. Use --mock for MockRuntimeService, or set LIVE_SERVICE_MODULE in src/http/serve-live.ts.`,
    );
  }
  const isSvc = (v: unknown): v is RuntimeService =>
    !!v && typeof v === "object" && typeof (v as RuntimeService).subscribe === "function" && typeof (v as RuntimeService).startRun === "function";
  for (const k of ["createRuntimeService", "createService"]) {
    const f = mod[k];
    if (typeof f === "function") {
      const v = await (f as () => unknown)();
      if (isSvc(v)) return v;
    }
  }
  for (const k of ["service", "runtime", "default"]) if (isSvc(mod[k])) return mod[k];
  for (const k of ["RuntimeServiceImpl", "LiveRuntimeService", "OrchestratorService"]) {
    const C = mod[k];
    if (typeof C === "function") {
      const v = new (C as new () => unknown)();
      if (isSvc(v)) return v;
    }
  }
  throw new Error(`${LIVE_SERVICE_MODULE} exports no RuntimeService (exports: ${Object.keys(mod).join(", ") || "none"})`);
}

if (supervise) {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  const start = () => {
    child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2), "--no-supervise"], {
      env: { ...process.env, SERVE_LIVE_CHILD: "1" },
      stdio: ["inherit", "inherit", "inherit"],
    });
    child.exited.then((code) => {
      if (stopping) return;
      // Exit 2 = configuration error (e.g. no live service yet): restarting would only loop.
      if (code === 2) {
        console.error(`${tag} supervisor: server failed to start (exit 2); not restarting`);
        process.exit(2);
      }
      console.log(`${tag} supervisor: server exited (${code}); restarting in ${restartDelayMs} ms`);
      setTimeout(start, restartDelayMs);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
      child?.kill();
      process.exit(0);
    });
  }
  start();
} else {
  let svc: RuntimeService;
  if (mockMode) {
    const { MockRuntimeService } = await import("../../mock/service.ts");
    svc = new MockRuntimeService({ speed: Number(process.env.MOCK_SPEED ?? 1) || 1, loop: process.env.MOCK_LOOP !== "0", autoStart: true });
  } else {
    try {
      svc = await loadLiveService();
    } catch (err) {
      console.error(`[live] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    if (svc.mock) console.warn("[live] WARNING: the loaded service reports mock=true; the dashboard will show MOCK");
  }
  const api = createApi(svc, {
    origins: dashboardOrigins(),
    log: console.log,
  });
  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 60, // SSE requests opt out via server.timeout(req, 0)
    fetch: (req, srv) => api.fetch(req, srv),
  });
  console.log(`${tag} orchestrator API on http://${HOST}:${server.port} (boot ${api.bootId})`);
}
