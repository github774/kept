// REST + SSE layer over RuntimeService (docs/DATA_CONTRACT.md, "Suggested routes").
// Framework-free: createApi() returns a fetch handler for Bun.serve. Works the same
// with the real service and with MockRuntimeService.
import type { ActionResult, FaultId, Mode, RuntimeService, SequencedEvent, StartRunOpts } from "../contract.ts";

export interface ApiOptions {
  /** Allowed browser origins (CORS). Default: dashboardOrigins() (5173, DASHBOARD_PORT, CORS_ORIGIN). */
  origins?: string[];
  /** SSE heartbeat comment interval. Default 15 s. */
  heartbeatMs?: number;
  /** Called for POST /api/demo/crash; only routed when svc.mock is true. Default: exit(75). */
  onCrash?: () => void;
  log?: (...args: unknown[]) => void;
  /**
   * Health source for GET /api/relay/observer. Default: the Relay observer singleton
   * (src/relay/observer.ts), started here when the service is live and RELAY_OBSERVER !== "0".
   */
  relayObserver?: () => Promise<unknown>;
}

export interface Api {
  /** Pass `server` so long-lived SSE requests are exempt from Bun's idle timeout. */
  fetch(req: Request, server?: { timeout?(req: Request, seconds: number): void }): Promise<Response>;
  /** Changes on every process start; lets SSE clients detect a restart (seq numbers reset). */
  readonly bootId: string;
}

/**
 * Browser origins the dashboard may run on: Vite's default 5173, DASHBOARD_PORT (.env) and any
 * extra comma-separated CORS_ORIGIN entries. Both localhost and 127.0.0.1 per port.
 */
export function dashboardOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const ports = new Set(["5173", ...(env.DASHBOARD_PORT ? [env.DASHBOARD_PORT.trim()] : [])]);
  const out = [...ports].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
  return [...out, ...(env.CORS_ORIGIN ?? "").split(",").map((o) => o.trim()).filter(Boolean)];
}

const MODES: readonly Mode[] = ["ours", "baseline", "ablation"];
const FAULTS: readonly FaultId[] = ["F1", "F2", "F3", "F4"];

/** ActionResult error -> HTTP status. */
export const ACTION_STATUS: Record<Extract<ActionResult, { ok: false }>["error"], number> = {
  no_such_run: 404,
  no_such_slot: 404,
  slot_not_active: 409,
  already_possessed: 409,
  run_finished: 409,
  unsupported: 501,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(svc: RuntimeService, opts: ApiOptions = {}): Api {
  const origins = opts.origins ?? dashboardOrigins();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const log = opts.log ?? (() => {});
  const bootId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Relay observer plane -> feed (src/relay/observer.ts). Live only; the mock service never touches Relay.
  const observerMod = !opts.relayObserver && !svc.mock && process.env.RELAY_OBSERVER !== "0" ? import("../relay/observer.ts") : undefined;
  void observerMod?.then((m) => m.startRelayObserverFromConfig()).catch((e) => log("[relay-observer] start failed:", e));
  const observerHealth =
    opts.relayObserver ??
    (async () => (observerMod ? (await observerMod).relayObserverHealth() : { started: false, connected: false, cursor: null, events: 0, error: "mock service" }));

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    return {
      "Access-Control-Allow-Origin": origin && origins.includes(origin) ? origin : (origins[0] ?? "*"),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
      Vary: "Origin",
    };
  }

  const json = (req: Request, status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const action = (req: Request, r: ActionResult) => json(req, r.ok ? 200 : ACTION_STATUS[r.error], r);

  async function body(req: Request): Promise<Record<string, unknown>> {
    const raw = (await req.text()).trim();
    if (!raw) return {};
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "body must be JSON");
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "body must be a JSON object");
    return v as Record<string, unknown>;
  }

  function intField(b: Record<string, unknown>, k: string): number {
    const n = b[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new HttpError(400, `${k} must be a non-negative integer`);
    return n;
  }

  // ------------------------------------------------------------------ SSE
  function events(req: Request, url: URL): Response {
    const fromHeader = req.headers.get("last-event-id");
    const sinceRaw = fromHeader ?? url.searchParams.get("since") ?? "0";
    const since = Math.max(0, Number.parseInt(sinceRaw, 10) || 0);
    const clientBoot = url.searchParams.get("boot");
    const enc = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const write = (s: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            cleanup();
          }
        };
        const frame = (ev: SequencedEvent) => write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

        // Subscribe before reading the buffer so nothing published in between is lost.
        let replaying = true;
        const pending: SequencedEvent[] = [];
        let lastSent = since;
        const unsubscribe = svc.subscribe((ev) => {
          if (replaying) return void pending.push(ev);
          if (ev.seq > lastSent) {
            lastSent = ev.seq;
            frame(ev);
          }
        });

        const buffer = svc.replay(0);
        const firstSeq = buffer[0]?.seq ?? null;
        const lastSeq = buffer.at(-1)?.seq ?? 0;
        // A gap means the client cannot resume from its seq: it must reset and refetch snapshots.
        const restarted = (clientBoot !== null && clientBoot !== bootId) || since > lastSeq;
        const overflowed = firstSeq !== null && since < firstSeq - 1;
        const gap = restarted || overflowed;
        const items = gap ? buffer : buffer.filter((e) => e.seq > since);
        if (gap) lastSent = 0;

        write("retry: 1000\n\n");
        write(
          `event: hello\ndata: ${JSON.stringify({ bootId, mock: svc.mock, since, gap, restarted, firstSeq, lastSeq, replay: items.length })}\n\n`,
        );
        for (const ev of items) {
          lastSent = ev.seq;
          frame(ev);
        }
        for (const ev of pending) {
          if (ev.seq > lastSent) {
            lastSent = ev.seq;
            frame(ev);
          }
        }
        replaying = false;
        write(`event: live\ndata: ${JSON.stringify({ lastSeq: lastSent })}\n\n`);

        const beat = setInterval(() => write(`: ping ${Date.now()}\n\n`), heartbeatMs);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(beat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        };
        req.signal.addEventListener("abort", () => cleanup());
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders(req),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ------------------------------------------------------------------ routes
  async function route(req: Request, server?: { timeout?(req: Request, seconds: number): void }): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    const url = new URL(req.url);
    // Raw segments, decoded one by one, so ids with dots or %2E both work.
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "api") throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
    const [, a, id, b, c] = parts;
    const n = parts.length;
    const GET = req.method === "GET";
    const POST = req.method === "POST";

    if (GET && a === "events" && n === 2) {
      server?.timeout?.(req, 0);
      return events(req, url);
    }
    if (GET && a === "meta" && n === 2) {
      const buf = svc.replay(0);
      return json(req, 200, { mock: svc.mock, bootId, lastSeq: buf.at(-1)?.seq ?? 0 });
    }
    if (a === "runs" && n === 2) {
      if (GET) return json(req, 200, await svc.listRuns());
      if (POST) {
        const bd = await body(req);
        const { taskId, mode, libraryId, stepDelayMs, agents, poisonRate } = bd;
        if (typeof taskId !== "string" || !taskId) throw new HttpError(400, "taskId must be a non-empty string");
        if (typeof mode !== "string" || !MODES.includes(mode as Mode)) throw new HttpError(400, `mode must be one of ${MODES.join(", ")}`);
        if (libraryId !== undefined && (typeof libraryId !== "string" || !libraryId)) throw new HttpError(400, "libraryId must be a non-empty string when given");
        if (stepDelayMs !== undefined && (typeof stepDelayMs !== "number" || !Number.isFinite(stepDelayMs) || stepDelayMs < 0))
          throw new HttpError(400, "stepDelayMs must be a non-negative number when given");
        if (agents !== undefined && (!Number.isInteger(agents) || (agents as number) < 1 || (agents as number) > 10_000)) throw new HttpError(400, "agents must be an integer 1..10000 when given");
        if (poisonRate !== undefined && (typeof poisonRate !== "number" || !(poisonRate >= 0 && poisonRate <= 1)))
          throw new HttpError(400, "poisonRate must be a number from 0 to 1 when given");
        const opts: StartRunOpts = { taskId, mode: mode as Mode };
        if (libraryId) opts.libraryId = libraryId as string;
        if (stepDelayMs !== undefined) opts.stepDelayMs = stepDelayMs as number;
        if (agents !== undefined) opts.agents = agents as number;
        if (poisonRate !== undefined) opts.poisonRate = poisonRate as number;
        return json(req, 200, await svc.startRun(opts));
      }
    }
    if (a === "runs" && id && n >= 4) {
      if (POST && b === "stop" && n === 4) return action(req, await svc.stopRun(id));
      if (POST && b === "possess" && n === 4) return action(req, await svc.possess(id, intField(await body(req), "slot")));
      if (POST && b === "fault" && n === 4) {
        const bd = await body(req);
        const slot = intField(bd, "slot");
        if (!FAULTS.includes(bd.fault as FaultId)) throw new HttpError(400, `fault must be one of ${FAULTS.join(", ")}`);
        return action(req, await svc.injectFault(id, slot, bd.fault as FaultId));
      }
      if (GET && b === "roster" && n === 4) return json(req, 200, await svc.getRoster(id));
      if (GET && b === "ledger" && n === 4) return json(req, 200, await svc.getLedger(id)); // null before the first totals
      if (GET && b === "relay" && n === 4) {
        const s = url.searchParams.get("since");
        const sinceSeq = s === null ? undefined : Number.parseInt(s, 10);
        if (sinceSeq !== undefined && (!Number.isFinite(sinceSeq) || sinceSeq < 0)) throw new HttpError(400, "since must be a non-negative integer");
        return json(req, 200, await svc.getRelayFeed(id, sinceSeq));
      }
      if (GET && b === "cases" && n === 4) return json(req, 200, await svc.listCases({ runId: id }));
      if (GET && b === "grant" && c && n === 5) {
        if (c !== "fleet" && c !== "ledger") throw new HttpError(400, "kind must be fleet or ledger");
        return json(req, 200, await svc.actorSocketGrant(c, id));
      }
    }
    if (GET && a === "libraries" && id && b === "cases" && n === 4) return json(req, 200, await svc.listCases({ libraryId: id }));
    if (GET && a === "cases" && id && n === 3) {
      const cf = await svc.getCase(id);
      return cf ? json(req, 200, cf) : json(req, 404, { error: "no_such_case", detail: id });
    }
    if (GET && a === "relay" && id === "observer" && n === 3) return json(req, 200, await observerHealth());
    if (GET && a === "jev" && n === 2) return json(req, 200, await svc.getJevStatus());
    if (GET && a === "bench" && n === 2) return json(req, 200, await svc.getBenchmarkResults());
    if (GET && a === "bench" && id === "summary" && n === 3) {
      const summary = svc.getBenchmarkSummary ? await svc.getBenchmarkSummary() : null;
      return summary ? json(req, 200, summary) : json(req, 404, { error: "no_summary", detail: "bench/results.summary.json not available" });
    }
    if (POST && a === "swarm" && (n === 2 || (id === "start" && n === 3))) {
      if (!svc.startSwarm) return json(req, 501, { error: "unsupported", detail: "startSwarm not available" });
      return action(req, await svc.startSwarm({ agents: intField(await body(req), "agents") }));
    }
    // Mock-only demo crash. The real crash test is scripts/crash-test.sh (kill -9).
    if (POST && a === "demo" && id === "crash" && n === 3 && svc.mock) {
      log("[MOCK] POST /api/demo/crash: exiting so the supervisor restarts the server");
      setTimeout(opts.onCrash ?? (() => process.exit(75)), 100);
      return json(req, 200, { ok: true, detail: "MOCK: process exiting" });
    }
    throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
  }

  return {
    bootId,
    async fetch(req, server) {
      try {
        return await route(req, server);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status >= 500) log(`error on ${req.method} ${req.url}:`, e);
        return json(req, status, { error: e instanceof Error ? e.message : "internal error" });
      }
    },
  };
}
