// Scale probe 2: pytest throughput. Runs single-function test files against the v2 reference
// solutions, each in a fresh temp dir, N times at a given concurrency.
// Modes: spawn = orchestrator/src/testrunner.ts runTests (python3 -m pytest per run, as shipped);
//        fork  = scripts/scale-probe/pytest-forkserver.py (pytest pre-imported, fork per run).
// Usage: bun scripts/scale-probe/pytest-probe.ts <spawn|fork> <runs> <concurrency>[,<c>...]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runTests } from "../../orchestrator/src/testrunner.ts";

const ROOT = join(import.meta.dir, "..", "..");
const [mode, runsArg, concArg] = process.argv.slice(2);
if (mode !== "spawn" && mode !== "fork") throw new Error("mode: spawn|fork");
const RUNS = Number(runsArg ?? 1000);
const levels = (concArg ?? "8,16,32").split(",").map(Number);

// Baseline machine CPU (other processes) before the probe.
{
  const io = startIostat();
  await Bun.sleep(3500);
  const b = io.stop();
  console.log(JSON.stringify({ baseline_machine_cpu_busy_pct: Math.round(b.busy), idle_pct: Math.round(b.idle) }));
}

// Build one work folder per task: starter, overlaid with the reference solution, plus tests/fixtures.
const TEMPLATES = mkdtempSync(join(tmpdir(), "scale-probe-templates-"));
const jobs: { workDir: string; test: string }[] = [];
for (const task of ["invoice_parser", "discount_engine", "shipping_rates"]) {
  const src = join(ROOT, "bench/tasks-v2", task);
  const dst = join(TEMPLATES, task);
  mkdirSync(dst, { recursive: true });
  const skip = (p: string) => !p.includes("__pycache__");
  cpSync(join(src, "starter"), dst, { recursive: true, filter: skip });
  cpSync(join(src, "_solution"), dst, { recursive: true, filter: skip });
  cpSync(join(src, "tests"), join(dst, "tests"), { recursive: true, filter: skip });
  if (existsSync(join(src, "fixtures"))) cpSync(join(src, "fixtures"), join(dst, "fixtures"), { recursive: true });
  const fns = JSON.parse(readFileSync(join(src, "task.json"), "utf8")).functions as { test: string }[];
  for (const f of fns) jobs.push({ workDir: dst, test: f.test });
}

// ---- fork-server client ----
let fs: ReturnType<typeof spawn> | undefined;
const waiting = new Map<number, (r: { code: number; ms: number }) => void>();
if (mode === "fork") {
  fs = spawn("python3", ["-W", "ignore::DeprecationWarning", join(import.meta.dir, "pytest-forkserver.py")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" },
  });
  createInterface({ input: fs.stdout! }).on("line", (l) => {
    const r = JSON.parse(l);
    waiting.get(r.id)?.(r);
    waiting.delete(r.id);
  });
}
let nextId = 0;
async function forkRun(job: { workDir: string; test: string }): Promise<{ passed: boolean; ms: number }> {
  const t0 = performance.now();
  const tmp = mkdtempSync(join(tmpdir(), "ss-tests-fork-"));
  try {
    cpSync(job.workDir, tmp, { recursive: true });
    const id = nextId++;
    const r = await new Promise<{ code: number; ms: number }>((res) => {
      waiting.set(id, res);
      fs!.stdin!.write(JSON.stringify({ id, dir: tmp, test: job.test, timeout_s: 30 }) + "\n");
    });
    readFileSync(join(tmp, ".pytest-output.txt"), "utf8"); // same work as the spawn path (collect output)
    return { passed: r.code === 0, ms: performance.now() - t0 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- CPU sampler: iostat per-second us/sy/id for the whole machine ----
function startIostat(): { stop: () => { busy: number; idle: number; n: number } } {
  const p = spawn("iostat", ["-n", "0", "-w", "1"]);
  const rows: [number, number, number][] = [];
  createInterface({ input: p.stdout }).on("line", (l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s/);
    if (m) rows.push([+m[1]!, +m[2]!, +m[3]!]);
  });
  return {
    stop: () => {
      p.kill();
      const r = rows.slice(1); // first row is since-boot average
      const avg = (k: number) => r.reduce((a, x) => a + x[k]!, 0) / Math.max(1, r.length);
      return { busy: avg(0) + avg(1), idle: avg(2), n: r.length };
    },
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

const NCPU = cpus().length;
for (const c of levels) {
  let idx = 0;
  const durs: number[] = [];
  let failed = 0;
  const io = startIostat();
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (idx < RUNS) {
        const job = jobs[idx++ % jobs.length]!;
        if (mode === "spawn") {
          const r = await runTests({ workDir: job.workDir, testFile: job.test, timeoutMs: 30_000, agentId: "probe" });
          durs.push(r.durationMs);
          if (!r.passed) failed++;
        } else {
          const r = await forkRun(job);
          durs.push(r.ms);
          if (!r.passed) failed++;
        }
      }
    }),
  );
  const wall = (performance.now() - t0) / 1000;
  const cpu = io.stop();
  console.log(
    JSON.stringify({
      mode, concurrency: c, runs: RUNS, failed, wall_s: +wall.toFixed(1), runs_per_s: +(RUNS / wall).toFixed(1),
      p50_ms: Math.round(pct(durs, 50)), p95_ms: Math.round(pct(durs, 95)), max_ms: Math.round(pct(durs, 100)),
      machine_cpu_busy_pct: Math.round(cpu.busy), machine_cpu_idle_pct: Math.round(cpu.idle), cores: NCPU,
    }),
  );
}
fs?.stdin?.end();
fs?.kill();
rmSync(TEMPLATES, { recursive: true, force: true });
