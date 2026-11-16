import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MockRuntimeService } from "../../mock/service.ts";
import type { ActionResult, CaseFile, DashboardEvent, RunSummary, RuntimeService, SequencedEvent } from "../contract.ts";
import { EventBus } from "../events.ts";
import { createApi } from "./api.ts";

const B = "http://test";
const get = (api: ReturnType<typeof createApi>, path: string, init?: RequestInit) => api.fetch(new Request(B + path, init));
const post = (api: ReturnType<typeof createApi>, path: string, body?: unknown) =>
  api.fetch(new Request(B + path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }));

const j = (r: Response): Promise<any> => r.json();

interface Frame {
  id?: string;
  event: string;
  data: any;
}

/** Reads SSE frames until `until` returns true (or timeout), then aborts the request. */
async function readSse(api: ReturnType<typeof createApi>, path: string, until: (f: Frame[]) => boolean, headers?: Record<string, string>, act?: () => void) {
  const ac = new AbortController();
  const res = await api.fetch(new Request(B + path, { headers, signal: ac.signal }));
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  let acted = false;
  const deadline = Date.now() + 3000;
  while (!until(frames) && Date.now() < deadline) {
    if (act && !acted && frames.some((f) => f.event === "live")) {
      acted = true;
      act();
    }
    const r = await Promise.race([reader.read(), Bun.sleep(50).then(() => null)]);
    if (r === null) continue;
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Partial<Frame> = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) f.id = line.slice(4);
        else if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
      }
      if (f.event) frames.push(f as Frame);
    }
  }
  ac.abort();
  return frames;
}

// ---------------------------------------------------------------- REST over the real mock
describe("routes over MockRuntimeService", () => {
  const svc = new MockRuntimeService();
  const api = createApi(svc);
  let run: RunSummary;
  let caseFile: CaseFile;

  beforeAll(async () => {
    svc.drain();
    run = (await svc.listRuns())[0]!;
    caseFile = (await svc.listCases({ runId: run.runId }))[0]!;
  });

  test("GET /api/runs", async () => {
    const r = await get(api, "/api/runs");
    expect(r.status).toBe(200);
    const runs = (await r.json()) as RunSummary[];
    expect(runs[0]!.runId).toBe(run.runId);
    expect(runs[0]!.mock).toBe(true);
  });

  test("roster, ledger, relay?since=, run and library cases", async () => {
    const roster = await j(await get(api, `/api/runs/${run.runId}/roster`));
    expect(roster).toHaveLength(4);
    const ledger = await j(await get(api, `/api/runs/${run.runId}/ledger`));
    expect(ledger.runId).toBe(run.runId);
    const all = await j(await get(api, `/api/runs/${run.runId}/relay`));
    const since = await j(await get(api, `/api/runs/${run.runId}/relay?since=10`));
    expect(since.length).toBe(all.filter((m: any) => m.seq > 10).length);
    expect((await get(api, `/api/runs/${run.runId}/relay?since=x`)).status).toBe(400);
    expect(await j(await get(api, `/api/runs/${run.runId}/cases`))).toHaveLength(1);
    expect(await j(await get(api, `/api/libraries/${run.libraryId}/cases`))).toHaveLength(1);
  });

  test("GET /api/cases/:id with a dotted id, raw or encoded", async () => {
    const raw = await get(api, `/api/cases/${caseFile.id}`);
    expect(raw.status).toBe(200);
    expect(((await raw.json()) as CaseFile).id).toBe(caseFile.id);
    const enc = await get(api, `/api/cases/${encodeURIComponent(caseFile.id).replaceAll(".", "%2E")}`);
    expect(enc.status).toBe(200);
    const missing = await get(api, "/api/cases/nope.1.g1");
    expect(missing.status).toBe(404);
    expect((await j(missing)).error).toBe("no_such_case");
  });

  test("possess, fault, stop map ActionResult to HTTP", async () => {
    const ok = await post(api, `/api/runs/${run.runId}/possess`, { slot: 3 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ActionResult).ok).toBe(true);
    expect((await post(api, `/api/runs/nope/possess`, { slot: 3 })).status).toBe(404);
    expect((await post(api, `/api/runs/${run.runId}/possess`, { slot: 9 })).status).toBe(404);
    expect((await post(api, `/api/runs/${run.runId}/possess`, { slot: "3" })).status).toBe(400);
    expect((await post(api, `/api/runs/${run.runId}/fault`, { slot: 1, fault: "F2" })).status).toBe(200);
    expect((await post(api, `/api/runs/${run.runId}/fault`, { slot: 1, fault: "F9" })).status).toBe(400);
    expect((await post(api, `/api/runs/nope/stop`)).status).toBe(404);
  });

  test("jev, bench, grant", async () => {
    expect((await j(await get(api, "/api/jev"))).mock).toBe(true);
    const bench = await j(await get(api, "/api/bench"));
    expect(bench.length).toBeGreaterThan(0);
    const grant = await j(await get(api, `/api/runs/${run.runId}/grant/fleet`));
    expect(grant.websocketUrl).toBe("");
    expect((await get(api, `/api/runs/${run.runId}/grant/other`)).status).toBe(400);
  });

  test("POST /api/runs validates and starts", async () => {
    expect((await post(api, "/api/runs", { taskId: "invoice_parser", mode: "nope" })).status).toBe(400);
    expect((await post(api, "/api/runs", { mode: "ours" })).status).toBe(400);
    expect((await post(api, "/api/runs", { taskId: "invoice_parser", mode: "ours", stepDelayMs: -1 })).status).toBe(400);
    let seen: unknown;
    const spy = createApi({ ...new FakeService(false), startRun: async (o: unknown) => ((seen = o), {} as RunSummary) } as unknown as RuntimeService);
    expect((await post(spy, "/api/runs", { taskId: "shipping_rates", mode: "baseline", stepDelayMs: 1500 })).status).toBe(200);
    expect(seen).toEqual({ taskId: "shipping_rates", mode: "baseline", stepDelayMs: 1500 });
    const r = await post(api, "/api/runs", { taskId: "invoice_parser", mode: "ours" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as RunSummary).runId).toBeTruthy();
    svc.stop();
  });

  test("CORS preflight and headers", async () => {
    const r = await api.fetch(new Request(B + "/api/runs", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } }));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const g = await get(api, "/api/jev", { headers: { Origin: "http://127.0.0.1:5173" } });
    expect(g.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
  });

  test("unknown route is 404; demo crash is routed only for mock services", async () => {
    expect((await get(api, "/api/nothing")).status).toBe(404);
    let crashed = false;
    const mockApi = createApi(svc, { onCrash: () => (crashed = true) });
    expect((await post(mockApi, "/api/demo/crash")).status).toBe(200);
    await Bun.sleep(150);
    expect(crashed).toBe(true);
    const real = createApi(new FakeService(false), { onCrash: () => (crashed = false) });
    expect((await post(real, "/api/demo/crash")).status).toBe(404);
  });
});

// ---------------------------------------------------------------- SSE over a controllable bus
class FakeService implements RuntimeService {
  readonly bus: EventBus;
  constructor(
    readonly mock: boolean,
    capacity = 2000,
  ) {
    this.bus = new EventBus(capacity);
  }
  emit(n: number) {
    for (let i = 0; i < n; i++) this.bus.publish({ type: "recovery", runId: "r1", ts: Date.now(), caseId: "r1.0.g1", ms: i } as DashboardEvent);
  }
  startRun = async () => ({}) as RunSummary;
  listRuns = async () => [];
  getRoster = async () => [];
  listCases = async () => [];
  getCase = async () => null;
  getLedger = async () => null;
  getRelayFeed = async () => [];
  possess = async (): Promise<ActionResult> => ({ ok: false, error: "slot_not_active" });
  injectFault = async (): Promise<ActionResult> => ({ ok: false, error: "unsupported" });
  stopRun = async (): Promise<ActionResult> => ({ ok: false, error: "run_finished" });
  getJevStatus = async () => ({ online: true, mode: "jev" as const, consecutiveFailures: 0, model: "x" });
  getBenchmarkResults = async () => [];
  actorSocketGrant = async (kind: "fleet" | "ledger") => ({ kind, actorId: "a", websocketUrl: "ws://x" });
  subscribe(cb: (ev: SequencedEvent) => void) {
    return this.bus.subscribe(cb);
  }
  replay(afterSeq: number) {
    return this.bus.replay(afterSeq);
  }
}

describe("SSE /api/events", () => {
  const svc = new FakeService(false, 10);
  const api = createApi(svc, { heartbeatMs: 100 });
  beforeAll(() => svc.emit(8)); // seq 1..8
  afterAll(() => {});

  const seqs = (f: Frame[]) => f.filter((x) => x.id).map((x) => Number(x.id));
  const hello = (f: Frame[]) => f.find((x) => x.event === "hello")!.data;

  test("fresh connect replays the buffer, then hello/live bracket it", async () => {
    const f = await readSse(api, "/api/events", (fr) => fr.some((x) => x.event === "live"));
    expect(f[0]!.event).toBe("hello");
    expect(hello(f)).toMatchObject({ gap: false, since: 0, lastSeq: 8, replay: 8, mock: false, bootId: api.bootId });
    expect(seqs(f)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.find((x) => x.id === "3")!.data.seq).toBe(3);
  });

  test("Last-Event-ID header and ?since= resume after that seq", async () => {
    const h = await readSse(api, "/api/events", (fr) => fr.some((x) => x.event === "live"), { "Last-Event-ID": "5" });
    expect(seqs(h)).toEqual([6, 7, 8]);
    const q = await readSse(api, "/api/events?since=7", (fr) => fr.some((x) => x.event === "live"));
    expect(seqs(q)).toEqual([8]);
    expect(hello(q).gap).toBe(false);
  });

  test("live events follow the replay without duplicates", async () => {
    const f = await readSse(api, "/api/events?since=8", (fr) => seqs(fr).length >= 2, undefined, () => svc.emit(2));
    expect(seqs(f)).toEqual([9, 10]);
  });

  test("gap: seq older than the buffer (overflow) sends the whole buffer with gap=true", async () => {
    svc.emit(5); // 15 events, capacity 10 -> buffer 6..15
    const f = await readSse(api, "/api/events?since=2", (fr) => fr.some((x) => x.event === "live"));
    expect(hello(f)).toMatchObject({ gap: true, restarted: false, firstSeq: 6, lastSeq: 15 });
    expect(seqs(f)[0]).toBe(6);
  });

  test("gap: client ahead of the server or another bootId means the server restarted", async () => {
    const ahead = await readSse(api, "/api/events?since=99", (fr) => fr.some((x) => x.event === "live"));
    expect(hello(ahead)).toMatchObject({ gap: true, restarted: true });
    const boot = await readSse(api, "/api/events?since=14&boot=old", (fr) => fr.some((x) => x.event === "live"));
    expect(hello(boot)).toMatchObject({ gap: true, restarted: true });
    expect(seqs(boot)[0]).toBe(6);
    const same = await readSse(api, `/api/events?since=14&boot=${api.bootId}`, (fr) => fr.some((x) => x.event === "live"));
    expect(hello(same).gap).toBe(false);
    expect(seqs(same)).toEqual([15]);
  });

  test("ActionResult errors map to 409/501", async () => {
    expect((await post(api, "/api/runs/r1/possess", { slot: 0 })).status).toBe(409);
    expect((await post(api, "/api/runs/r1/fault", { slot: 0, fault: "F1" })).status).toBe(501);
    expect((await post(api, "/api/runs/r1/stop")).status).toBe(409);
  });
});
