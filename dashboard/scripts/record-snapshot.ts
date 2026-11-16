// Records one real run from a running orchestrator into static files under public/api/,
// so a static host (Vercel) can serve /live as a labelled recording. Read-only: GETs only.
//
//   cd dashboard && bun scripts/record-snapshot.ts [runId] [--api http://127.0.0.1:3000]
//
// With no runId it picks the latest finished non-mock run that caught at least one failure.
// Build the dashboard with VITE_API_URL=recorded to read these files (see src/data/http.ts).
// Every JSON response is written as `<path>.json` (so /api/runs and /api/runs/<id>/... can
// coexist on disk); /api/events is a two-event SSE body with no extension.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const apiIdx = args.indexOf("--api");
const API = (apiIdx >= 0 ? args[apiIdx + 1] : "http://127.0.0.1:3000").replace(/\/+$/, "");
const wantRun = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--api") ?? null;
const OUT = join(import.meta.dir, "..", "public", "api");

async function get(path: string): Promise<unknown> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function put(path: string, body: string) {
  const file = join(OUT, path.replace(/^\/api\//, ""));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  console.log(`  ${path}  ${body.length} B`);
}
const putJson = (path: string, data: unknown) => put(`${path}.json`, JSON.stringify(data));

interface Run {
  runId: string;
  status: string;
  startedAt: number;
  cases: number;
  agents: number;
}

const meta = (await get("/api/meta")) as { mock: boolean };
if (meta.mock) throw new Error("The orchestrator is in mock mode; record a real run.");

const runs = (await get("/api/runs")) as Run[];
const run = wantRun
  ? runs.find((r) => r.runId === wantRun)
  : runs
      .filter((r) => r.status === "finished" && r.cases >= 1 && r.agents <= 8)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
if (!run) throw new Error(wantRun ? `No run ${wantRun}` : "No finished run with a case file");
console.log(`Recording ${run.runId} from ${API} into ${OUT}`);

await rm(OUT, { recursive: true, force: true });
const enc = encodeURIComponent(run.runId);
await putJson("/api/runs", [run]); // only this run, so the client opens it
for (const part of ["roster", "ledger", "relay", "cases"]) await putJson(`/api/runs/${enc}/${part}`, await get(`/api/runs/${enc}/${part}`));
const cases = (await get(`/api/runs/${enc}/cases`)) as { id: string }[];
for (const c of cases) await putJson(`/api/cases/${encodeURIComponent(c.id)}`, await get(`/api/cases/${encodeURIComponent(c.id)}`));
await putJson("/api/jev", await get("/api/jev"));
await putJson("/api/bench", await get("/api/bench"));
await putJson("/api/bench/summary", await get("/api/bench/summary"));
await putJson("/api/meta", { mock: false, bootId: "recorded", lastSeq: 0, recorded: true, runId: run.runId, recordedAt: Date.now() });
// hello then live: the client bootstraps from the REST files above and applies no events.
// retry keeps the browser from re-requesting the finished stream for 10 minutes.
await put(
  "/api/events",
  `retry: 600000\n\nevent: hello\ndata: {"bootId":"recorded","mock":false,"gap":false}\n\nevent: live\ndata: {}\n\n`,
);
console.log("Done.");
