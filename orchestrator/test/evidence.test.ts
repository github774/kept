import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concreteEvidence, importerSlots, importsOf, lineDiff, notePassingRun, pushAlert, takeAlerts, tracebackNames } from "../src/runtime/evidence.ts";
import type { RunContext } from "../src/runtime/types.ts";

const fns = [
  { name: "line_net", file: "line_net.py", test: "tests/test_line_net.py", subgoal: "" },
  { name: "due_date", file: "due_date.py", test: "tests/test_due_date.py", subgoal: "" },
];
function ctxIn(dir: string) {
  return { workDir: dir, task: { functions: fns } } as unknown as RunContext;
}

describe("evidence", () => {
  test("importsOf names modules and imported names", () => {
    expect(importsOf("from billing_common import round_money, tax_rate as tr\nimport re, math\n")).toEqual(
      expect.arrayContaining(["billing_common", "billing_common.round_money", "billing_common.tax_rate", "re", "math"]),
    );
  });
  test("lineDiff shows removed and added lines", () => {
    expect(lineDiff("a\nrounding=UP\nb", "a\nrounding=EVEN\nb")).toBe("- rounding=UP\n+ rounding=EVEN");
  });
  test("tracebackNames reads pytest frames", () => {
    expect(tracebackNames('billing_common.py:12: in round_money\n  x = billing_common.round_money(a)')).toEqual(
      expect.arrayContaining(["billing_common.py:round_money", "billing_common.round_money"]),
    );
  });
  test("changed shared file since the last passing run, importer slots, alerts taken once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    writeFileSync(join(dir, "billing_common.py"), "def round_money(x):\n    return up(x)\n");
    writeFileSync(join(dir, "line_net.py"), "from billing_common import round_money\n");
    writeFileSync(join(dir, "due_date.py"), "import datetime\n");
    const ctx = ctxIn(dir);
    notePassingRun(ctx, 0);
    writeFileSync(join(dir, "billing_common.py"), "def round_money(x):\n    return even(x)\n");
    const ev = concreteEvidence(ctx, 0, fns[0], { failedTests: ["tests/test_line_net.py::test_half"] });
    expect(ev.changedFiles).toEqual([{ file: "billing_common.py", diff: "- return up(x)\n+ return even(x)" }]);
    expect(ev.identifiers).toEqual(expect.arrayContaining(["failed test tests/test_line_net.py::test_half", "line_net.py imports billing_common.round_money"]));
    expect(importerSlots(ctx, "billing_common")).toEqual([0]);
    pushAlert(ctx, 1, "warden", "c1", "lesson");
    pushAlert(ctx, 1, "warden", "c1", "lesson");
    expect(takeAlerts(ctx, 1).map((a) => a.caseId)).toEqual(["c1"]);
    expect(takeAlerts(ctx, 1)).toEqual([]);
  });
});
