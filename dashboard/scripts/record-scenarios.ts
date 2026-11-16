// Records demo scenarios from the real orchestrator: for each task x possessed slot, start a real run,
// Possess that slot once the agents are working, and save every event of the run with its server timestamp.
// The hosted dashboard (VITE_DEMO_REPLAY=1) replays these at 3x instead of waiting on live models.
//
//   cd dashboard && bun scripts/record-scenarios.ts [--api http://127.0.0.1:3000] [--tasks a,b] [--slots 1,2,3,4]
//
// Output: public/scenarios/<task>.s<slot>.json and public/scenarios/index.json. Refuses a mock server.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    api: { type: "string", default: "http://127.0.0.1:3000" },
    tasks: { type: "string", default: "invoice_parser,shipping_rates,discount_engine" },
    slots: { type: "string", default: "1,2,3,4" },
    "possess-after-ms": { type: "string", default: "12000" },
    "timeout-ms": { type: "string", default: "300000" },
  },
});
const API = values.api!.replace(/\/+$/, "");
const OUT = join(import.meta.dir, "..", "public", "scenarios");
const POSSESS_AFTER = Number(values["possess-after-ms"]);
const TIMEOUT = Number(values["timeout-ms"]);

type Ev = { type: string; runId: string; ts: number; seq?: number; [k: string]: unknown };
const byRun = new Map<string, Ev[]>();
const finished = new Map<string, () => void>();

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function stream(since: number) {
  const res = await fetch(`${API}/api/events?since=${since}`, { headers: { accept: "text/event-stream" } });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let ev: Ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (!ev.runId || !ev.type) continue;
      const list = byRun.get(ev.runId);
      if (!list) continue;
      list.push(ev);
      const st = (ev as { run?: { status?: string } }).run?.status;
      if (ev.type === "run.status" && st && st !== "running") finished.get(ev.runId)?.();
    }
  }
}

async function scenario(task: string, slot: number) {
  const run = await json<{ runId: string }>("POST", "/api/runs", { taskId: task, mode: "ours" });
  const id = run.runId;
  byRun.set(id, []);
  const t0 = Date.now();
  const done = new Promise<void>((r) => finished.set(id, r));
  console.log(`[${task} s${slot}] started ${id}`);
  await Bun.sleep(POSSESS_AFTER);
  let possessTs: number | null = null;
  for (let k = 0; k < 15 && possessTs == null; k++) {
    try {
      await json("POST", `/api/runs/${id}/possess`, { slot });
      possessTs = Date.now();
    } catch (e) {
      console.log(`[${task} s${slot}] possess retry: ${(e as Error).message.slice(0, 80)}`);
      await Bun.sleep(2000);
    }
  }
  await Promise.race([done, Bun.sleep(Math.max(0, TIMEOUT - (Date.now() - t0)))]);
  await Bun.sleep(1500); // trailing ledger/case events
  const events = (byRun.get(id) ?? []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const summary = (await json<Record<string, unknown>[]>("GET", "/api/runs")).find((r) => r.runId === id);
  // The run as it looked at its start (the replay seeds the dashboard with it): running, every agent at gen 1.
  const roster = await json<Record<string, unknown>[]>("GET", `/api/runs/${id}/roster`);
  const roster0 = roster
    .map((c) => ({ ...c, name: `w${c.slot}-g1-${id}`, gen: 1, status: "trusted", step: 0, possessed: false, verifiedSteps: 0, lastSummary: null,
      tokens: { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 } }))
    .sort((a, b) => Number(a.slot) - Number(b.slot));
  const t0ev = byRun.get(id)?.[0]?.ts ?? t0;
  const { endedAt: _e, ...rest } = summary ?? {};
  const summary0 = { ...rest, status: "running", retires: 0, cases: 0, testsPassing: 0, usd: 0, startedAt: t0ev };
  const file = `${task}.s${slot}.json`;
  await writeFile(
    join(OUT, file),
    JSON.stringify({ task, slot, runId: id, recordedAt: new Date(t0).toISOString(), possessTs, summary, summary0, roster0, events }),
  );
  const status = (events.filter((e) => e.type === "run.status").at(-1) as { run?: { status?: string } } | undefined)?.run?.status ?? null;
  const rec = events.find((e) => e.type === "recovery") as { ms?: number } | undefined;
  console.log(`[${task} s${slot}] ${id}: ${events.length} events, possessed=${possessTs != null}, end=${status ?? "?"}, recovery=${rec?.ms ?? "-"}ms`);
  return { task, slot, file, runId: id, possessed: possessTs != null, end: status, recoveryMs: rec?.ms ?? null, events: events.length };
}

const meta = await json<{ mock: boolean; lastSeq: number }>("GET", "/api/meta");
if (meta.mock) throw new Error("refusing to record from a MOCK server");
await mkdir(OUT, { recursive: true });
void stream(meta.lastSeq);
await Bun.sleep(500);
const jobs: Promise<Awaited<ReturnType<typeof scenario>>>[] = [];
for (const task of values.tasks!.split(",")) for (const s of values.slots!.split(",")) jobs.push(scenario(task, Number(s)));
const results = await Promise.allSettled(jobs);
const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
for (const r of results) if (r.status === "rejected") console.log("FAILED", r.reason);
await writeFile(join(OUT, "index.json"), JSON.stringify({ recordedAt: new Date().toISOString(), scenarios: ok }, null, 2));
console.log(`wrote ${ok.length} scenarios to ${OUT}`);
process.exit(0);
