// Static guard for agent-written Python, applied before any test run.
// Rejects process/network/FFI modules, shell/eval escapes, and open() outside the work folder.
// This is a tripwire for model mistakes, not a sandbox: the test run itself is also isolated
// in a temp folder with a timeout and, on macOS, a sandbox profile with no network and no reads
// under the repo root (testrunner.ts).

export interface GuardViolation {
  rule: "banned_import" | "banned_call" | "open_outside_workdir";
  line: number;
  snippet: string;
}
export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
}

const BANNED_MODULES = [
  // processes / FFI / dynamic import
  "subprocess", "ctypes", "multiprocessing", "importlib", "pty", "signal", "resource", "builtins", "runpy", "code", "pickle", "marshal", "shutil",
  // network
  "socket", "ssl", "select", "selectors", "asyncio", "urllib", "urllib3", "http", "ftplib", "smtplib", "poplib", "imaplib", "telnetlib", "xmlrpc", "requests", "httpx", "webbrowser",
];
const OS_PROCESS_FNS = "system|popen|fork|forkpty|setsid|setpgrp|setpgid|kill|killpg|exec\\w*|spawn\\w*|posix_spawn\\w*|startfile|remove|unlink|rmdir|removedirs";
const BANNED_CALLS: RegExp[] = [
  new RegExp(`\\bos\\s*\\.\\s*(${OS_PROCESS_FNS})\\b`),
  /(?<![\w.])(exec|eval|__import__|getattr|setattr|globals|vars|breakpoint)\s*\(/,
  new RegExp(`\\bfrom\\s+os\\s+import\\b[^\\n]*\\b(${OS_PROCESS_FNS})\\b`),
  /\b__builtins__\b|\b__subclasses__\b|\b__globals__\b/,
];

/** Replaces comments and string literals with spaces (keeps line numbers and offsets). */
function blankStringsAndComments(src: string): string {
  const re = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*)/g;
  return src.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function snippetAt(src: string, line: number): string {
  return (src.split("\n")[line - 1] ?? "").trim().slice(0, 120);
}

function isOutsidePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~") || p.startsWith("\\") || /^[A-Za-z]:/.test(p) ||
    p.split(/[\\/]/).includes("..");
}

export function checkCode(src: string): GuardResult {
  const code = blankStringsAndComments(src);
  const violations: GuardViolation[] = [];
  const add = (rule: GuardViolation["rule"], idx: number) => {
    const line = lineOf(src, idx);
    if (!violations.some((v) => v.rule === rule && v.line === line))
      violations.push({ rule, line, snippet: snippetAt(src, line) });
  };

  // import a, b.c as d   |   from a.b import c
  const importRe = /^[ \t]*(?:import[ \t]+([^\n#;]+)|from[ \t]+([\w.]+)[ \t]+import\b)/gm;
  for (const m of code.matchAll(importRe)) {
    const mods = m[1] !== undefined
      ? m[1].split(",").map((s) => s.trim().split(/\s+/)[0] ?? "")
      : [m[2] ?? ""];
    if (mods.some((mod) => BANNED_MODULES.includes(mod.split(".")[0] ?? ""))) add("banned_import", m.index);
  }

  for (const re of BANNED_CALLS) {
    for (const m of code.matchAll(new RegExp(re.source, "g"))) add("banned_call", m.index);
  }

  // open("<literal>") / Path("<literal>") — the literal is read from the original source at the same offset.
  for (const m of code.matchAll(/(?<![\w])(?:open|Path|PurePath|PosixPath)\s*\(/g)) {
    const rest = src.slice(m.index + m[0].length);
    const lit = /^\s*[rRbBuUfF]{0,2}(["'])(.*?)\1/.exec(rest);
    if (lit && isOutsidePath(lit[2] ?? "")) add("open_outside_workdir", m.index);
  }

  violations.sort((a, b) => a.line - b.line);
  return { ok: violations.length === 0, violations };
}
