// MOCK API server for dashboard work: serves MockRuntimeService through createApi().
//   bun run src/http/dev-mock.ts                    PORT=3000, speed 1, loop, autoStart
//   PORT=3300 MOCK_SPEED=4 bun run src/http/dev-mock.ts
//   bun run src/http/dev-mock.ts --no-supervise     single process (POST /api/demo/crash just exits)
// By default this file supervises itself: it runs the server in a child process and
// restarts it when it exits, so the mock-only POST /api/demo/crash shows the dashboard's
// "reconnecting" banner and recovery. Every response and event is flagged mock.
import { MockRuntimeService } from "../../mock/service.ts";
import { createApi, dashboardOrigins } from "./api.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const speed = Number(process.env.MOCK_SPEED ?? 1) || 1;
const loop = process.env.MOCK_LOOP !== "0";
const restartDelayMs = Number(process.env.RESTART_DELAY_MS ?? 1500);
const supervise = !process.argv.includes("--no-supervise") && process.env.DEV_MOCK_CHILD !== "1";

if (supervise) {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  const start = () => {
    child = Bun.spawn([process.execPath, import.meta.path, "--no-supervise"], {
      env: { ...process.env, DEV_MOCK_CHILD: "1" },
      stdio: ["inherit", "inherit", "inherit"],
    });
    child.exited.then((code) => {
      if (stopping) return;
      console.log(`[MOCK supervisor] server exited (${code}); restarting in ${restartDelayMs} ms`);
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
  const svc = new MockRuntimeService({ speed, loop, autoStart: true });
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
  console.log(`[MOCK] API on http://${HOST}:${server.port} (speed ${speed}x, loop ${loop}, boot ${api.bootId})`);
}
