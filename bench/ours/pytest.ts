// Ground-truth test snapshots for "ours" benchmark trials.
// Copies the agent's code into a private temp dir together with the task's CANONICAL tests
// (bench/tasks/<id>/tests, never the agents' copy) and runs pytest with a JUnit XML report.
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Outcome = "passed" | "failed" | "error" | "skipped";

export interface CaseResult {
  /** "tests/test_parse_line.py::test_basic_row" (parametrized ids keep their [..] suffix). */
  nodeid: string;
  /** nodeid without the [param] suffix, matches task.json trap_test. */
  base: string;
  outcome: Outcome;
  message: string;
}

export interface Snapshot {
  /** ms since the trial started. */
  t_ms: number;
  cases: CaseResult[];
  /** Collection errors etc. (pytest exit 2/4 or missing report). */
  broken: boolean;
}

const SKIP = new Set(["__pycache__", ".pytest_cache", "tests", ".git", "node_modules"]);

/** Copies *.py from the run's work dir (root, plus a `starter/` or `src/` subfolder if that is where code lives). */
async function copyCode(workDir: string, dst: string): Promise<number> {
  let n = 0;
  const copyPy = async (dir: string) => {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const f of names) {
      if (SKIP.has(f) || !f.endsWith(".py")) continue;
      const s = await stat(join(dir, f)).catch(() => null);
      if (!s?.isFile()) continue;
      await cp(join(dir, f), join(dst, f));
      n++;
    }
  };
  await copyPy(workDir);
  if (n === 0) {
    for (const sub of ["starter", "src"]) await copyPy(join(workDir, sub));
  }
  return n;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

const attr = (attrs: string, name: string): string => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m?.[1] !== undefined ? decodeXml(m[1]) : "";
};

/** Parses a pytest JUnit XML report into per-test outcomes. Exported for tests. */
export function parseJunit(xml: string): CaseResult[] {
  const out: CaseResult[] = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const classname = attr(attrs, "classname");
    const name = attr(attrs, "name");
    let outcome: Outcome = "passed";
    let message = "";
    const fail = /<(failure|error)\b([^>]*)>?/.exec(body);
    if (fail) {
      outcome = fail[1] === "error" ? "error" : "failed";
      message = attr(fail[2] ?? "", "message");
    } else if (/<skipped\b/.test(body)) outcome = "skipped";
    // classname "tests.test_parse_line" -> "tests/test_parse_line.py"
    const file = classname ? `${classname.replace(/\./g, "/")}.py` : name.replace(/\./g, "/") + ".py";
    const nodeid = classname ? `${file}::${name}` : file;
    out.push({ nodeid, base: nodeid.replace(/\[.*\]$/, ""), outcome, message });
  }
  return out;
}

function runPytest(cwd: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(
      "python3",
      ["-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml=report.xml", "tests"],
      { cwd, stdio: "ignore", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** One snapshot of the agent code in `workDir` against the canonical tests in `taskDir/tests`. */
export async function snapshot(workDir: string, taskDir: string, t_ms: number, timeoutMs = 20_000): Promise<Snapshot> {
  const dir = await mkdtemp(join(tmpdir(), "bench-ours-"));
  try {
    await cp(join(taskDir, "tests"), join(dir, "tests"), { recursive: true });
    await copyCode(workDir, dir);
    const code = await runPytest(dir, timeoutMs);
    const f = Bun.file(join(dir, "report.xml"));
    if (!(await f.exists())) return { t_ms, cases: [], broken: true };
    const cases = parseJunit(await f.text());
    return { t_ms, cases, broken: code === null || code === 2 || code === 3 || code === 4 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Number of tests the canonical suite collects (so a run that breaks collection can't "pass"). */
export async function expectedTestCount(taskDir: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "bench-ours-collect-"));
  try {
    await cp(join(taskDir, "tests"), join(dir, "tests"), { recursive: true });
    await copyCode(join(taskDir, "starter"), dir);
    const out = await new Promise<string>((resolve) => {
      const p = spawn("python3", ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", "tests"], {
        cwd: dir,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      let s = "";
      p.stdout.on("data", (d) => (s += String(d)));
      p.on("close", () => resolve(s));
    });
    const m = /(\d+) tests? collected/.exec(out);
    if (!m?.[1]) throw new Error(`could not collect canonical tests in ${taskDir}`);
    return Number(m[1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
