import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCode } from "../src/codeguard.ts";
import { runTests } from "../src/testrunner.ts";

const TASK = resolve(import.meta.dir, "..", "..", "bench", "tasks", "invoice_parser");

/** Work folder = tests/ + chosen code layers (later layers overwrite earlier ones). */
function workDir(layers: string[], extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ss-tr-test-"));
  cpSync(join(TASK, "tests"), join(dir, "tests"), { recursive: true });
  for (const layer of layers)
    for (const f of readdirSync(join(TASK, layer))) if (f.endsWith(".py")) cpSync(join(TASK, layer, f), join(dir, f));
  for (const [p, src] of Object.entries(extra)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), src);
  }
  return dir;
}

describe("runTests", () => {
  test("passing: reference solution", async () => {
    const r = await runTests({ workDir: workDir(["_solution"]), timeoutMs: 20_000 });
    expect(r.passed).toBe(true);
    expect(r.failedTests).toEqual([]);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("passed");
  });

  test("failing: trap variant fails only the trap test", async () => {
    const r = await runTests({
      workDir: workDir(["_solution", "_trap_variant"]),
      testFile: "tests/test_parse_line.py",
      timeoutMs: 20_000,
    });
    expect(r.passed).toBe(false);
    expect(r.failedTests).toEqual(["tests/test_parse_line.py::test_trap_amount_is_dollars"]);
  });

  test("hanging: killed at timeout", async () => {
    const dir = workDir([], { "tests/test_hang.py": "import time\n\ndef test_hang():\n    time.sleep(60)\n" });
    const r = await runTests({ workDir: dir, testFile: "tests/test_hang.py", timeoutMs: 1_500 });
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.durationMs).toBeLessThan(10_000);
    expect(r.output).toContain("TIMEOUT");
  });

  test("guard rejects: tests are not run", async () => {
    const dir = workDir(["_solution"], { "parse_line.py": "import subprocess\n\ndef parse_line(l):\n    return {}\n" });
    const r = await runTests({ workDir: dir, timeoutMs: 20_000 });
    expect(r.passed).toBe(false);
    expect(r.guard?.[0]).toMatchObject({ file: "parse_line.py", rule: "banned_import", line: 1 });
    expect(r.output).toContain("CODE GUARD REJECTED");
  });

  test("rejects testFile escaping the work folder", async () => {
    const r = await runTests({ workDir: workDir(["_solution"]), testFile: "../x.py", timeoutMs: 5_000 });
    expect(r.passed).toBe(false);
    expect(r.output).toContain("bad testFile");
  });
});

describe("checkCode", () => {
  const bad: [string, string][] = [
    ["import subprocess", "banned_import"],
    ["import os, socket as s", "banned_import"],
    ["from ctypes import CDLL", "banned_import"],
    ["from multiprocessing.pool import Pool", "banned_import"],
    ["import os\nos.system('ls')", "banned_call"],
    ["import os\nx = os.popen('ls')", "banned_call"],
    ["from os import system", "banned_call"],
    ["eval('1+1')", "banned_call"],
    ["exec('x=1')", "banned_call"],
    ["m = __import__('socket')", "banned_call"],
    ["open('/etc/passwd')", "open_outside_workdir"],
    ["open(r'../secrets.txt', 'r')", "open_outside_workdir"],
    ["with open('data/../../x') as f: pass", "open_outside_workdir"],
  ];
  for (const [src, rule] of bad) {
    test(`rejects ${JSON.stringify(src)}`, () => {
      const r = checkCode(src);
      expect(r.ok).toBe(false);
      expect(r.violations.map((v) => v.rule)).toContain(rule as never);
    });
  }

  const good = [
    "import os\nfrom decimal import Decimal",
    "# import subprocess in a comment\nx = 'eval(1)'",
    '"""uses os.system in a docstring"""',
    "open('data/input.csv')",
    "re.compile('x').evaluate(1)",
    "def my_eval(x):\n    return x",
  ];
  for (const src of good) {
    test(`allows ${JSON.stringify(src)}`, () => expect(checkCode(src)).toEqual({ ok: true, violations: [] }));
  }
});
