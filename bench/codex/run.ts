import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_DIR, benchModel, loadCaps, loadModels, loadPrices, priceTokens } from "../src/config.ts";
import { runPytest, trapFamily } from "../src/pytest.ts";
import { assertTaskDir, copyTaskFolder, loadTaskMeta, resolveTaskDir } from "../src/tasks.ts";
import { totalTokens, type BenchmarkResultRow } from "../src/types.ts";
import { ExecStreamParser, readRollouts } from "./events.ts";
import { readTrace, traceMetrics, type TraceMetrics } from "./trace.ts";
import { codexPrompt, DEFAULT_AGENTS_MD, workerToml } from "./prompt.ts";

const PROVIDER = "openrouter";
const BASE_URL = "https://openrouter.ai/api/v1";
const ENV_KEY = "OPENROUTER_API_KEY";
const SIGKILL_GRACE_MS = 10_000;

export interface CodexTrialOpts {
  task: string;
  trial: number;
  taskDir?: string;
  /** Task suite: "v1" (bench/tasks, default), "v2" (bench/tasks-v2) or "v3" (bench/tasks-v3). Ignored when taskDir is set. */
  suite?: string;
  model?: string;
  wallClockMs?: number;
  log?: (msg: string) => void;
}

export const codexBin = () =>
  process.env.CODEX_BIN ?? Bun.which("codex") ?? join(process.env.HOME ?? "", ".local/bin/codex");

/**
 * Notes on codex-cli 0.157.1 (verified):
 *  - `--ephemeral` breaks subagents ("collab spawn failed: no thread with id"), so it is NOT passed.
 *    Isolation comes from a fresh per-run CODEX_HOME instead; the user's ~/.codex is never read.
 *  - `--ignore-user-config` skips $CODEX_HOME/config.toml; the provider is set with -c overrides.
 *  - The project's .codex/agents/worker.toml only loads for a trusted project, hence projects.<ws>.trust_level.
 */
export function codexArgs(ws: string, model: string): string[] {
  return [
    "exec",
    "--json",
    "--sandbox", "workspace-write",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--cd", ws,
    "-m", model,
    "-c", `model_provider="${PROVIDER}"`,
    "-c", `model_providers.${PROVIDER}.name="OpenRouter"`,
    "-c", `model_providers.${PROVIDER}.base_url="${BASE_URL}"`,
    "-c", `model_providers.${PROVIDER}.env_key="${ENV_KEY}"`,
    "-c", `model_providers.${PROVIDER}.wire_api="responses"`,
    "-c", `approval_policy="never"`,
    "-c", `projects."${ws}".trust_level="trusted"`,
  ];
}

async function openRouterKeyUsage(): Promise<number | null> {
  const key = process.env[ENV_KEY];
  if (!key) return null;
  try {
    const r = await fetch(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { usage?: number } };
    return typeof j.data?.usage === "number" ? j.data.usage : null;
  } catch {
    return null;
  }
}

/** First python on the harness PATH that can import pytest (BENCH_PYTHON wins). */
async function pythonWithPytest(): Promise<string | null> {
  const cands = [process.env.BENCH_PYTHON, "python3", "python3.13", "python3.12", "python"].filter(Boolean) as string[];
  for (const c of cands) {
    const bin = Bun.which(c) ?? (c.startsWith("/") ? c : null);
    if (!bin) continue;
    const p = Bun.spawnSync([bin, "-c", "import pytest"], { stdout: "ignore", stderr: "ignore" });
    if (p.exitCode === 0) return bin;
  }
  return null;
}

/**
 * Codex runs commands in login zsh shells (`zsh -lc`), whose profile puts a python3 without pytest first on
 * PATH (v1 runs: every subagent's `python3 -m pytest` failed with "No module named pytest"). Our system runs
 * the tests itself, so for a fair baseline the agents' `python3`/`pytest` must work too. A per-run ZDOTDIR
 * sources the user's own zsh files, then prepends a shim dir with python3/python/pytest from a python that
 * has pytest. Nothing in the user's home is changed.
 */
export async function pytestShellShim(tmp: string): Promise<{ env: Record<string, string>; note: string } | null> {
  const py = await pythonWithPytest();
  if (!py) return null;
  const shim = join(tmp, "shim");
  const zdot = join(tmp, "zdot");
  await mkdir(shim, { recursive: true });
  await mkdir(zdot, { recursive: true });
  for (const n of ["python3", "python"]) await symlink(py, join(shim, n));
  await writeFile(join(shim, "pytest"), `#!/bin/sh\nexec "${py}" -m pytest "$@"\n`, { mode: 0o755 });
  const prepend = `export PATH="${shim}:$PATH"\n`;
  const src = (f: string) => `[ -f "$HOME/${f}" ] && . "$HOME/${f}"\n`;
  await writeFile(join(zdot, ".zshenv"), src(".zshenv") + prepend);
  await writeFile(join(zdot, ".zprofile"), src(".zprofile") + prepend);
  await writeFile(join(zdot, ".zlogin"), src(".zlogin") + prepend);
  return { env: { ZDOTDIR: zdot, PATH: `${shim}:${process.env.PATH ?? ""}` }, note: `agent shells: python3/pytest -> ${py} (ZDOTDIR shim)` };
}

export async function runCodexTrial(o: CodexTrialOpts): Promise<BenchmarkResultRow> {
  const log = o.log ?? ((m: string) => console.error(`[codex ${o.task} t${o.trial}] ${m}`));
  const [models, caps, prices] = await Promise.all([loadModels(), loadCaps(), loadPrices()]);
  const model = o.model ?? benchModel(models);
  const wallClockMs = o.wallClockMs ?? caps.codex_wall_clock_ms;
  const mock = !process.env[ENV_KEY];
  const notes: string[] = [];
  if (mock) {
    notes.push(`MOCK: no ${ENV_KEY}; codex launched only to check the command line, row goes to results.mock.json`);
    log(`MOCK: no ${ENV_KEY} set`);
  }

  const srcDir = resolveTaskDir(o.task, o.taskDir, o.suite);
  await assertTaskDir(srcDir);
  const meta = await loadTaskMeta(srcDir);

  const startedAt = new Date();
  const runId = `codex.${o.task}.t${o.trial}.${startedAt.getTime().toString(36)}`;
  const tmp = await mkdtemp(join(tmpdir(), "ss-codex-"));
  const ws = join(tmp, "ws");
  const home = join(tmp, "home");
  await mkdir(join(ws, ".codex", "agents"), { recursive: true });
  await mkdir(home, { recursive: true });
  const copied = await copyTaskFolder(srcDir, ws);
  if (!copied.includes("AGENTS.md")) {
    await writeFile(join(ws, "AGENTS.md"), DEFAULT_AGENTS_MD);
    notes.push("task has no AGENTS.md; wrote the default spec-wins AGENTS.md");
  }
  await writeFile(join(ws, ".codex", "agents", "worker.toml"), workerToml(model, PROVIDER));
  const prompt = codexPrompt(meta.functions);
  await writeFile(join(tmp, "prompt.txt"), prompt);

  const runDir = join(BENCH_DIR, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const eventsFile = Bun.file(join(runDir, "events.jsonl")).writer();
  const stderrFile = Bun.file(join(runDir, "stderr.log")).writer();

  const shim = await pytestShellShim(tmp);
  if (!shim) notes.push("no python with pytest found for the agent shells: agents may be unable to run pytest");
  const env: Record<string, string | undefined> = { ...process.env, ...(shim?.env ?? {}), CODEX_HOME: home, NO_COLOR: "1" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;

  const usageBefore = await openRouterKeyUsage();
  const args = codexArgs(ws, model);
  log(`run ${runId} ws=${ws} functions=[${meta.functions.join(", ")}]`);
  const t0 = performance.now();
  const spawnedAtMs = Date.now();
  const proc = Bun.spawn([codexBin(), ...args, prompt], {
    cwd: ws,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const sigint = setTimeout(() => {
    timedOut = true;
    log(`wall clock ${wallClockMs} ms hit: SIGINT`);
    proc.kill("SIGINT");
  }, wallClockMs);
  const sigkill = setTimeout(() => {
    log("still running: SIGKILL");
    proc.kill("SIGKILL");
  }, wallClockMs + SIGKILL_GRACE_MS);

  const parser = new ExecStreamParser();
  const pumpOut = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        eventsFile.write(line + "\n");
        parser.feed(line, performance.now() - t0);
      }
    }
    if (buf) {
      eventsFile.write(buf + "\n");
      parser.feed(buf, performance.now() - t0);
    }
  })();
  const pumpErr = (async () => {
    for await (const chunk of proc.stderr) stderrFile.write(chunk);
  })();

  const exitCode = await proc.exited;
  const finishMs = performance.now() - t0;
  clearTimeout(sigint);
  clearTimeout(sigkill);
  await Promise.all([pumpOut, pumpErr]);
  await Promise.all([eventsFile.end(), stderrFile.end()]);
  const usageAfter = await openRouterKeyUsage();

  const rollouts = await readRollouts(home);
  const tests = await runPytest(ws, meta.traps);
  let tm: TraceMetrics | null = null;
  try {
    tm = traceMetrics({
      trace: await readTrace(join(home, "sessions")),
      t0_ms: spawnedAtMs,
      exit_ms: finishMs,
      functions: meta.functions,
      traps: meta.traps,
      sharedModule: meta.sharedModule,
      finalFailing: tests.summary.failing,
      finalSuccess: !timedOut && tests.success,
      testFiles: [],
    });
  } catch (e) {
    notes.push(`trace analysis failed: ${String(e)}`);
  }

  // Keep everything for traceability (bench/runs/ is gitignored).
  await cp(ws, join(runDir, "workspace"), { recursive: true });
  await cp(join(home, "sessions"), join(runDir, "sessions"), { recursive: true }).catch(() => {});
  await writeFile(join(runDir, "prompt.txt"), prompt);
  await writeFile(join(runDir, "argv.json"), JSON.stringify([codexBin(), ...args, "<prompt>"], null, 2));

  // Prefer rollout totals (parent + subagents). Fall back to the exec stream if no rollouts exist.
  const haveRollouts = rollouts.threads > 0;
  const tokens = haveRollouts ? rollouts.tokens : parser.parentTokens;
  if (!haveRollouts) notes.push("no rollout files: tokens are parent-only from turn.completed events");
  const modelsSeen = rollouts.models;
  if (modelsSeen.length === 0) notes.push("model not confirmed: no turn_context in rollouts");
  else if (modelsSeen.some((m) => m !== model)) notes.push(`MODEL MISMATCH: expected ${model}, saw ${modelsSeen.join(", ")}`);
  if (rollouts.subagents.length === 0) notes.push("NO SUBAGENTS: Codex did everything in the parent thread");
  if (timedOut) notes.push("timed out (killed): counted as failed");
  if (exitCode !== 0 && !timedOut) notes.push(`codex exited ${exitCode}`);
  for (const e of parser.errors.slice(0, 3)) notes.push(`codex error: ${e}`);

  let usd = 0;
  try {
    usd = priceTokens(prices, model, tokens);
  } catch (e) {
    notes.push(String(e));
  }

  const success = !timedOut && tests.success;
  const fields = traceFields(tm, tests.traps, meta.traps, parser.recoveryMs);
  const row: BenchmarkResultRow = {
    mode: "codex_baseline",
    model,
    task: meta.id,
    trial: o.trial,
    sourceId: parser.sessionId ?? rollouts.rootId ?? runId,
    success,
    tokens,
    tokens_per_passing_task: success ? totalTokens(tokens) : null,
    usd,
    trap_hits: fields.trap_hits,
    repeat_trap_hits: fields.repeat_trap_hits,
    recovery_ms: fields.recovery_ms,
    finish_ms: Math.round(finishMs),
    false_retires: null,
    subagents_spawned: rollouts.subagents.length,
    killed: timedOut,
    notes: notes.join("; "),
    ...(mock ? { mock: true as const } : {}),
    task_version: meta.version,
    tests: tests.summary,
    traps_hit: fields.traps_hit,
    ...fields.extra,
    ...(shim ? { env_note: shim.note } : {}),
    tokens_scope: haveRollouts
      ? `rollouts: parent + ${rollouts.subagents.length} subagent thread(s)`
      : "exec stream: parent only",
    tokens_parent_events: parser.parentTokens,
    usd_source: `config/prices.json (checked ${prices.checked})`,
    usd_openrouter_key_delta:
      usageBefore !== null && usageAfter !== null ? Math.round((usageAfter - usageBefore) * 1e6) / 1e6 : null,
    subagents: rollouts.subagents,
    models_seen: modelsSeen,
    exit_code: exitCode,
    run_dir: runDir,
    started_at: startedAt.toISOString(),
  };
  await writeFile(join(runDir, "row.json"), JSON.stringify(row, null, 2));
  return row;
}

/**
 * Row fields derived from the rollout trace + final pytest. trap_hits counts traps followed at any point
 * (in-run pytest failures ∪ final workspace), like bench/ours (snapshots); trap_hits_final = final only.
 */
export function traceFields(
  tm: TraceMetrics | null,
  final: { trap_hits: number; repeat_trap_hits: number; traps_hit: string[] },
  traps: import("../src/tasks.ts").TrapSpec[],
  parentRecoveryMs: number | null,
) {
  const hit = [...new Set([...(tm?.traps_hit_in_run ?? []), ...final.traps_hit])].sort();
  const perFam = new Map<string, number>();
  for (const h of hit) perFam.set(trapFamily(h, traps), (perFam.get(trapFamily(h, traps)) ?? 0) + 1);
  let repeats = 0;
  for (const n of perFam.values()) repeats += Math.max(0, n - 1);
  const subs = tm?.subagent_efficiency ?? [];
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const recovery_ms =
    tm?.time_to_recovery_s != null
      ? Math.round(tm.time_to_recovery_s * 1000)
      : parentRecoveryMs === null
        ? null
        : Math.round(parentRecoveryMs);
  return {
    trap_hits: hit.length,
    repeat_trap_hits: repeats,
    traps_hit: hit,
    recovery_ms,
    extra: {
      trap_hits_final: final.trap_hits,
      traps_hit_final: final.traps_hit,
      traps_hit_in_run: tm?.traps_hit_in_run ?? [],
      time_to_finish_s: tm?.time_to_finish_s ?? null,
      time_to_finish_basis: tm?.time_to_finish_basis ?? null,
      time_to_recovery_s: recovery_ms === null ? null : recovery_ms / 1000,
      false_completion_claims: tm ? tm.false_completion_claims : null,
      completion_claims: tm ? tm.completion_claims : null,
      unverified_pass_claims: tm ? tm.unverified_pass_claims : null,
      trap_following_edits: tm ? tm.trap_following_edits : null,
      repeat_trap_edits: tm ? tm.repeat_trap_edits : null,
      traps_followed_in_edits: tm?.traps_followed_in_edits ?? [],
      poisoned_facts_accepted: null,
      jev_blocked_messages: null,
      subagent_tokens_mean: mean(subs.map((x) => x.tokens_total)),
      subagent_model_calls_mean: mean(subs.map((x) => x.model_calls)),
      subagent_turns_mean: mean(subs.map((x) => x.turns)),
      wasted_tokens: tm ? subs.filter((x) => x.scope_passes_final === false).reduce((a, x) => a + x.tokens_total, 0) : null,
      wasted_tokens_basis: "tokens of subagents whose own function tests fail in the final workspace (Codex has no retire)",
      subagent_efficiency: subs,
      claims: tm?.claims ?? [],
      trap_edits: tm?.trap_edits ?? [],
      pytest_runs_total: tm?.pytest_runs_total ?? 0,
      pytest_runs_unavailable: tm?.pytest_runs_unavailable ?? 0,
    },
  };
}
