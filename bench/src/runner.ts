#!/usr/bin/env bun
/**
 * Benchmark runner.
 *   bun bench/src/runner.ts --mode codex --task invoice_parser --trial 1 [--suite v1|v2|v3|humaneval] [--task-dir <dir>] [--no-append]
 * Modes ours / warm / ablation are TODO: they will call into the orchestrator. They exit non-zero and
 * never write a row, so no fake numbers reach results.json (rule 6).
 */
import { parseArgs } from "node:util";
import { runCodexTrial } from "../codex/run.ts";
import { loadRepoEnv } from "./config.ts";
import { appendResult } from "./results.ts";
import { CLI_MODES, type BenchmarkResultRow, type CliMode } from "./types.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    task: { type: "string" },
    trial: { type: "string", default: "1" },
    "task-dir": { type: "string" },
    suite: { type: "string", default: "v1" },
    model: { type: "string" },
    "wall-clock-ms": { type: "string" },
    "no-append": { type: "boolean", default: false },
  },
  strict: true,
});

const mode = values.mode as CliMode | undefined;
if (!mode || !(mode in CLI_MODES) || !values.task) {
  console.error(`usage: bun bench/src/runner.ts --mode <${Object.keys(CLI_MODES).join("|")}> --task <name> --trial <n> [--suite v1|v2|v3|humaneval] [--task-dir dir]`);
  process.exit(2);
}
const trial = Number(values.trial);
if (!Number.isInteger(trial) || trial < 1) {
  console.error("--trial must be a positive integer");
  process.exit(2);
}

await loadRepoEnv();

async function run(): Promise<BenchmarkResultRow> {
  switch (mode) {
    case "codex":
      return runCodexTrial({
        task: values.task!,
        trial,
        taskDir: values["task-dir"],
        suite: values.suite,
        model: values.model,
        wallClockMs: values["wall-clock-ms"] ? Number(values["wall-clock-ms"]) : undefined,
      });
    case "ours":
    case "warm":
    case "ablation":
      // TODO(orchestrator): start a run via orchestrator/src/service.ts with a fresh run ID
      // (cold/ablation: fresh library ID; ablation: shared reasoning off), wait for it, then build the
      // row from the Ledger actor's totals and bench/src/pytest.ts on the final workspace.
      throw new Error(`mode "${mode}" not implemented yet (TODO: orchestrator integration)`);
    default:
      throw new Error(`unknown mode ${String(mode)}`);
  }
}

try {
  const row = await run();
  if (!values["no-append"]) {
    const path = await appendResult(row);
    console.error(`${row.mock ? "MOCK row" : "row"} appended to ${path}`);
  }
  console.log(JSON.stringify(row, null, 2));
  process.exit(0);
} catch (e) {
  console.error(`runner failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
