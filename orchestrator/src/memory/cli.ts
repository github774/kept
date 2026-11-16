// Immune memory ops. Run from orchestrator/:
//   bun --env-file=../.env run src/memory/cli.ts migrate   # applies supabase/migrations/*.sql via SUPABASE_DB_URL
//   bun --env-file=../.env run src/memory/cli.ts sql       # prints the SQL (paste into the Supabase SQL editor)
//   bun --env-file=../.env run src/memory/cli.ts check     # 3 real poison-bench cases -> upsert -> match_cases
// `check` takes real case records from bench/poison/results.json (case id, run, task, slot -> function, category,
// the recorded claim). Their original lessons lived in that run's CaseLibrary actors, which are not on disk, so
// it re-runs the real lesson writer on the same evidence (spec excerpt + claim + category, as retire step 4
// does) and the real embedder (as retire step 5 does). Refuses to run with MOCK adapters. Never prints secrets.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lessonMessages, parseLesson, specExcerpt } from "../lessons.ts";
import { immuneMemory, MEMORY_DIMS, memoryMode, type CaseRow } from "./immune.ts";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

async function migrate() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL not set: run `sql` and paste the output into the Supabase SQL editor instead");
  const { SQL } = await import("bun");
  const sql = new SQL(url);
  try {
    await sql.unsafe(migrationSql());
    const [r] = await sql`select count(*)::int as n from public.cases`;
    console.log(`migration applied; public.cases has ${r.n} rows`);
  } finally {
    await sql.close();
  }
}

type PoisonRow = { side: string; task: string; poisons: Record<string, { detection_evidence?: string[] }>; cases?: { id: string; slot: number; category: string }[] };

async function check() {
  if (memoryMode() === "off") throw new Error("immune memory is off: set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
  const [{ config }, { getLlm }, { getEmbedder }] = await Promise.all([import("../config.ts"), import("../llm.ts"), import("../embeddings.ts")]);
  const llm = await getLlm();
  const embedder = await getEmbedder();
  if (llm.mock || embedder.mock) throw new Error("LLM or embedder is MOCK (no key): refusing to write mock lessons to immune memory");
  if (config.models.embedding.dimensions !== MEMORY_DIMS) throw new Error(`embedding dims ${config.models.embedding.dimensions} != ${MEMORY_DIMS}`);
  const { mem } = immuneMemory();

  // One real retire-case per task from the poison head-to-head (ours side).
  const rows = JSON.parse(readFileSync(join(ROOT, "bench", "poison", "results.json"), "utf8")) as PoisonRow[];
  const picked: { task: string; id: string; slot: number; category: string; claim: string; runId: string }[] = [];
  for (const r of rows) {
    if (r.side === "codex" || picked.some((p) => p.task === r.task)) continue;
    for (const c of r.cases ?? []) {
      const line = Object.values(r.poisons).flatMap((p) => p.detection_evidence ?? []).find((e) => e.startsWith(`case ${c.id} `));
      const claim = line?.slice(line.indexOf(": ") + 2);
      if (!claim) continue;
      picked.push({ task: r.task, id: c.id, slot: c.slot, category: c.category, claim, runId: c.id.split(".")[0]! });
      break;
    }
  }
  if (picked.length < 3) throw new Error(`found ${picked.length} real cases with recorded claims, need 3`);

  const meta = { category: "lesson_writer" as const, slot: "memory-check", gen: 0, step: 0 };
  const out: CaseRow[] = [];
  for (const p of picked) {
    const taskDir = join(ROOT, "bench", "tasks-v2", p.task);
    const fns = (JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as { functions: { name: string }[] }).functions;
    const fn = fns[p.slot]?.name ?? "";
    const spec = readFileSync(join(taskDir, "SPEC.md"), "utf8");
    const r = await llm.chatText({ model: config.models.lesson_writer, messages: lessonMessages({ specExcerpt: specExcerpt(spec), subtask: fn, category: p.category, claim: p.claim }), meta, maxTokens: 400 });
    const lesson = parseLesson(r.text, p.claim).lesson;
    const e = await embedder.embed([`${p.claim}\n${lesson ?? ""}\n${p.category}`], { ...meta, category: "embedding" });
    out.push({ id: p.id, lesson, category: p.category, task: p.task, function: fn, run_id: p.runId, library_id: `lib-${p.runId}`, created_at: new Date().toISOString(), embedding: e.vectors[0]! });
    console.log(`case ${p.id} (${p.task}/${fn}, ${p.category}) lesson: ${lesson ?? "(none)"}`);
  }
  await mem!.upsert(out);
  await mem!.upsert(out); // idempotent: same ids, no duplicates
  console.log(`upserted ${out.length} rows (twice, idempotent)`);

  // Query back: each case's own function subtask as the query, filtered to its task.
  for (const row of out) {
    const fnDef = (JSON.parse(readFileSync(join(ROOT, "bench", "tasks-v2", row.task, "task.json"), "utf8")) as { functions: { name: string; subgoal: string }[] }).functions.find((f) => f.name === row.function);
    const q = await embedder.embed([`${row.function}: ${fnDef?.subgoal ?? ""}`], { category: "embedding", slot: "memory-check", gen: 0, step: 1 });
    const hits = await mem!.match(q.vectors[0]!, row.task, 3);
    console.log(`match_cases(${row.task}, "${row.function}") -> ${hits.map((h) => `${h.id} sim=${h.similarity.toFixed(3)}`).join(", ") || "(none)"}${hits.some((h) => h.id === row.id) ? "  [found]" : "  [MISSING]"}`);
  }
}

const cmd = process.argv[2];
const run = cmd === "migrate" ? migrate : cmd === "check" ? check : cmd === "sql" ? async () => console.log(migrationSql()) : null;
if (!run) {
  console.error("usage: bun run src/memory/cli.ts migrate|sql|check");
  process.exit(2);
}
run().catch((e) => {
  console.error(`[memory] ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
