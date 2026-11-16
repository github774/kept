// Runs pytest for one agent in a private temp copy of its work folder.
// Code is guard-checked first; the run is killed (whole process group) on timeout.
// On macOS the run is also sandboxed (sandbox-exec): no network, no reads under the repo root (.env).
// The result never waits on pipes held by an escaped grandchild: it resolves on the child's exit
// (plus a short grace for buffered output) or on the timeout, whichever comes first.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCode, type GuardViolation } from "./codeguard.ts";

export interface RunTestsOptions {
  workDir: string;
  /** Relative to workDir, e.g. "tests/test_parse_line.py". Omit to run every test. */
  testFile?: string;
  /** Hard wall clock; callers pass caps.test_timeout_ms. */
  timeoutMs: number;
  /** Label for the temp folder (agent id); cosmetic. */
  agentId?: string;
}

export interface GuardRejection extends GuardViolation {
  file: string;
}

export interface RunTestsResult {
  passed: boolean;
  failedTests: string[];
  /** Combined stdout+stderr, last 4,000 characters. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** Present when the code guard refused to run the tests. */
  guard?: GuardRejection[];
}

const OUTPUT_LIMIT = 4000;
/** After the child exits, how long to wait for the pipes to drain before resolving anyway. */
const EXIT_GRACE_MS = 300;
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** python3 argv, wrapped in a macOS sandbox profile (deny network, deny reads under the repo) when available. */
function pythonCommand(args: string[]): { cmd: string; argv: string[] } {
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC) && process.env.SS_TEST_SANDBOX !== "0") {
    const q = (p: string) => JSON.stringify(p);
    const profile = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${q(REPO_ROOT)}))`;
    return { cmd: SANDBOX_EXEC, argv: ["-p", profile, "python3", ...args] };
  }
  return { cmd: "python3", argv: args };
}
const SKIP_DIRS = new Set(["__pycache__", ".pytest_cache", ".git", "node_modules"]);

function trimOutput(s: string): string {
  return s.length <= OUTPUT_LIMIT ? s : `...[trimmed ${s.length - OUTPUT_LIMIT} chars]\n${s.slice(-OUTPUT_LIMIT)}`;
}

/** Agent-authored .py files (everything except tests/ and conftest.py). */
function guardFolder(root: string): GuardRejection[] {
  const out: GuardRejection[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const rel = relative(root, p);
      if (statSync(p).isDirectory()) {
        if (rel !== "tests") walk(p);
      } else if (name.endsWith(".py") && name !== "conftest.py") {
        for (const v of checkCode(readFileSync(p, "utf8")).violations) out.push({ ...v, file: rel });
      }
    }
  };
  walk(root);
  return out;
}

export function parseFailedTests(output: string): string[] {
  const seen = new Set<string>();
  for (const m of output.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)) seen.add(m[1]!);
  return [...seen];
}

export async function runTests(opts: RunTestsOptions): Promise<RunTestsResult> {
  const t0 = performance.now();
  const done = (r: Omit<RunTestsResult, "durationMs">): RunTestsResult => ({
    ...r,
    durationMs: Math.round(performance.now() - t0),
  });

  if (opts.testFile !== undefined) {
    const n = normalize(opts.testFile);
    if (isAbsolute(n) || n.split(/[\\/]/).includes("..")) {
      return done({ passed: false, failedTests: [], output: `bad testFile: ${opts.testFile}`, timedOut: false });
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), `ss-tests-${(opts.agentId ?? "agent").replace(/[^\w.-]/g, "_")}-`));
  try {
    cpSync(opts.workDir, tmp, {
      recursive: true,
      filter: (src) => !SKIP_DIRS.has(src.split(/[\\/]/).pop() ?? ""),
    });

    const guard = guardFolder(tmp);
    if (guard.length > 0) {
      const lines = guard.map((g) => `${g.file}:${g.line} ${g.rule}: ${g.snippet}`);
      return done({
        passed: false,
        failedTests: [],
        output: trimOutput(`CODE GUARD REJECTED, tests not run:\n${lines.join("\n")}`),
        timedOut: false,
        guard,
      });
    }

    const args = ["-m", "pytest", "-q", "-rfE", "-p", "no:cacheprovider", "--color=no"];
    if (opts.testFile) args.push(opts.testFile);

    const { code, output, timedOut } = await new Promise<{ code: number | null; output: string; timedOut: boolean }>(
      (resolve) => {
        const py = pythonCommand(args);
        const child = spawn(py.cmd, py.argv, {
          cwd: tmp,
          detached: true, // own process group so the timeout kills grandchildren too
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" },
        });
        let buf = "";
        let killed = false;
        let settled = false;
        let exitCode: number | null = null;
        let grace: ReturnType<typeof setTimeout> | null = null;
        const onData = (d: Buffer) => {
          buf += d.toString("utf8");
          if (buf.length > 64 * OUTPUT_LIMIT) buf = buf.slice(-16 * OUTPUT_LIMIT);
        };
        child.stdout!.on("data", onData);
        child.stderr!.on("data", onData);
        const killGroup = () => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* group already gone */
          }
        };
        // Resolve once; drop the pipes so a process that escaped the group cannot keep us waiting.
        const settle = (r: { code: number | null; output: string; timedOut: boolean }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (grace) clearTimeout(grace);
          killGroup(); // leftovers that stayed in the group
          child.stdout!.destroy();
          child.stderr!.destroy();
          resolve(r);
        };
        const timer = setTimeout(() => {
          killed = true;
          killGroup();
          try {
            child.kill("SIGKILL");
          } catch {
            /* already exited */
          }
          settle({ code: null, output: buf, timedOut: true });
        }, opts.timeoutMs);
        child.on("error", (e) => settle({ code: null, output: `${buf}\nspawn error: ${e.message}`, timedOut: false }));
        child.on("exit", (c) => {
          exitCode = c;
          grace = setTimeout(() => settle({ code: exitCode, output: buf, timedOut: killed }), EXIT_GRACE_MS);
        });
        child.on("close", (c) => settle({ code: c ?? exitCode, output: buf, timedOut: killed }));
      },
    );

    const text = timedOut ? `${output}\nTIMEOUT: killed after ${opts.timeoutMs} ms` : output;
    return done({ passed: !timedOut && code === 0, failedTests: parseFailedTests(output), output: trimOutput(text), timedOut });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
