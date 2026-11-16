// Workspace evidence for retire (Owner: retire implementer). Process-local caches only (rule 3): losing them on a
// restart only makes a lesson less specific or skips a targeted alert; nothing durable depends on them.
//  - notePassingRun: the worker records the shared folder's top-level .py files whenever a slot's tests pass, so a
//    retire can show which shared files changed since that slot last passed (a helper swapped under verified code).
//  - concreteEvidence: identifiers + changed-file diffs handed to the lesson writer, so a lesson can name the culprit.
//  - alerts: a filed case's lesson, queued for the next step of every agent whose file imports the changed module.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wrapQuoted } from "./prompt.ts";
import type { InboxItem, RunContext, TaskFn } from "./types.ts";

type Files = Map<string, string>;
const lastPass = new WeakMap<RunContext, Map<number, Files>>();
const alerts = new WeakMap<RunContext, Map<number, InboxItem[]>>();

/** Top-level *.py files of the shared folder (tests/ excluded), name -> content. */
export function workspaceFiles(dir: string): Files {
  const out: Files = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".py")) continue;
    try {
      out.set(f, readFileSync(join(dir, f), "utf8"));
    } catch {
      /* vanished */
    }
  }
  return out;
}

/** Worker: the slot's tests just passed; remember the folder as it was. */
export function notePassingRun(ctx: RunContext, slot: number): void {
  const m = lastPass.get(ctx) ?? new Map<number, Files>();
  m.set(slot, workspaceFiles(ctx.workDir));
  lastPass.set(ctx, m);
}

/** Lines removed (-) and added (+), in file order, at most `max` lines. Not a real diff: enough to name a change. */
export function lineDiff(before: string, after: string, max = 12): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const sa = new Set(a);
  const sb = new Set(b);
  const out = [...a.filter((l) => !sb.has(l) && l.trim()).map((l) => `- ${l.trim()}`), ...b.filter((l) => !sa.has(l) && l.trim()).map((l) => `+ ${l.trim()}`)];
  return out.length > max ? [...out.slice(0, max), `(${out.length - max} more lines)`].join("\n") : out.join("\n");
}

/** Module names and imported names of Python code: "billing_common", "billing_common.round_money". */
export function importsOf(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+\(?([^\n)#]+)/gm)) {
    out.add(m[1]!);
    for (const n of m[2]!.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean)) out.add(`${m[1]}.${n}`);
  }
  for (const m of code.matchAll(/^\s*import\s+([A-Za-z_][\w.,\s]*)/gm)) for (const n of m[1]!.split(",").map((x) => x.trim().split(/\s+/)[0]!).filter(Boolean)) out.add(n);
  return [...out];
}

/** Names from a pytest traceback: `File "x.py", line n, in f` frames and `module.func(` calls in E/> lines. */
export function tracebackNames(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/([A-Za-z_]\w*\.py):\d+: in (\w+)/g)) out.add(`${m[1]}:${m[2]}`);
  for (const m of output.matchAll(/File "[^"]*?([A-Za-z_]\w*\.py)", line \d+, in (\w+)/g)) out.add(`${m[1]}:${m[2]}`);
  for (const m of output.matchAll(/\b([a-z_]\w*\.[a-z_]\w*)\(/g)) if (!/^(self|decimal|datetime|pytest|re|math)\./.test(m[1]!)) out.add(m[1]!);
  return [...out].slice(0, 15);
}

export interface ConcreteEvidence {
  /** Failing test names, traceback names, imports of the function's file. */
  identifiers: string[];
  /** Shared files (not the function's own file, not tests) that changed since this slot's last passing run. */
  changedFiles: { file: string; diff: string }[];
}

/**
 * Concrete identifiers for the lesson writer. `code` is the function's file content to read imports from (the retire
 * protocol restores the file, so the caller also passes the last passing version when it has one).
 */
export function concreteEvidence(ctx: RunContext, slot: number, fn: TaskFn | undefined, ev: { failedTests?: string[]; testOutput?: string }): ConcreteEvidence {
  const now = workspaceFiles(ctx.workDir);
  const before = lastPass.get(ctx)?.get(slot);
  const own = fn?.file;
  const codes = [own ? now.get(own) : undefined, own ? before?.get(own) : undefined].filter((c): c is string => !!c);
  const imports = [...new Set(codes.flatMap(importsOf))].filter((i) => !/^(decimal|datetime|re|math|itertools|typing|collections|functools)(\.|$)/.test(i));
  const changedFiles: ConcreteEvidence["changedFiles"] = [];
  if (before) {
    for (const [file, cur] of now) {
      if (file === own || ctx.task.functions.some((f) => f.file === file)) continue; // only shared (non-function) files
      const prev = before.get(file);
      if (prev !== undefined && prev !== cur) changedFiles.push({ file, diff: lineDiff(prev, cur) });
    }
  }
  const identifiers = [
    ...(ev.failedTests ?? []).slice(0, 10).map((t) => `failed test ${t}`),
    ...tracebackNames(ev.testOutput ?? "").map((t) => `traceback ${t}`),
    ...imports.map((i) => `${fn?.file ?? "file"} imports ${i}`),
  ];
  return { identifiers, changedFiles };
}

/** Slots whose own function file currently imports `module` (e.g. "billing_common"). */
export function importerSlots(ctx: RunContext, module: string): number[] {
  const files = workspaceFiles(ctx.workDir);
  return ctx.task.functions
    .map((f, slot) => ({ slot, code: files.get(f.file) ?? "" }))
    .filter((x) => importsOf(x.code).some((i) => i === module || i.startsWith(`${module}.`)))
    .map((x) => x.slot);
}

/** Queues a case lesson for the next step of `slot` (rendered as a quoted case message in the inbox part). */
export function pushAlert(ctx: RunContext, slot: number, from: string, caseId: string, text: string): void {
  const m = alerts.get(ctx) ?? new Map<number, InboxItem[]>();
  const list = m.get(slot) ?? [];
  if (list.some((i) => i.caseId === caseId)) return;
  m.set(slot, [...list, { seq: -1, from, channel: "cases", kind: "case", caseId, text, wrapped: wrapQuoted(from, text, "case") }]);
  alerts.set(ctx, m);
}

/** Worker step 1: alerts queued for this slot (taken once). */
export function takeAlerts(ctx: RunContext, slot: number): InboxItem[] {
  const m = alerts.get(ctx);
  const list = m?.get(slot) ?? [];
  if (list.length) m!.delete(slot);
  return list;
}
