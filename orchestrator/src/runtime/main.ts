// Runtime entry point. Owner: service implementer.
//   bun --env-file=../.env run src/main.ts run --task invoice_parser [--mode ours] [--step-delay-ms N]
//        [--library <libraryId>] [--fault-drill] [--timeout-ms N]     one run, prints events, exits
//   bun --env-file=../.env run src/runtime/main.ts                      service only (reconcile + keep alive)
// HTTP/SSE routes are Amar's (src/http/api.ts, src/http/serve-live.ts); src/main.ts without "run"
// starts serve-live, which loads this service through src/service.ts.
// Only the agent explicitly told to may start servers (ports 7100/8787/3000).
import { parseArgs } from "node:util";
import type { Mode, RunSummary, SequencedEvent } from "../contract.ts";
import { createRuntimeService, type RealRuntimeService } from "./service.ts";

const TERMINAL = new Set(["finished", "failed", "stopped"]);

function describe(ev: SequencedEvent): string | null {
  const m = ev.mock ? " [MOCK]" : "";
  switch (ev.type) {
    case "run.status":
      return `run ${ev.run.runId} ${ev.run.status} tests ${ev.run.testsPassing}/${ev.run.testsTotal} retires ${ev.run.retires} cases ${ev.run.cases} $${ev.run.usd.toFixed(4)}${ev.banner ? ` (${ev.banner})` : ""}${m}`;
    case "agent.status":
      return `slot ${ev.slot} g${ev.gen} ${ev.status} step ${ev.step}${ev.reason ? `: ${ev.reason}` : ""}${m}`;
    case "relay.message":
      return `${ev.item.blocked ? "BLOCKED " : ""}${ev.item.from} -> ${ev.item.to ?? `#${ev.item.channel}`}: ${ev.item.text.slice(0, 160)}${ev.item.blocked ? ` [${ev.item.blocked.reason}]` : ""}${m}`;
    case "case.created":
      return `case ${ev.case.id} [${ev.case.category}] lesson: ${ev.case.lesson ?? "(none)"} -> ${ev.case.recipients.join(", ") || "no recipients"}${m}`;
    case "case.reply":
      return `reply on ${ev.caseId} from ${ev.reply.from}: ${ev.reply.text.slice(0, 120)}${m}`;
    case "recovery":
      return `recovery ${ev.caseId}: ${(ev.ms / 1000).toFixed(1)} s${m}`;
    case "jev.status":
      return `jev ${ev.status.mode}${m}`;
    default:
      return null;
  }
}

async function runCli(svc: RealRuntimeService, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string", default: "invoice_parser" },
      mode: { type: "string", default: "ours" },
      "step-delay-ms": { type: "string", default: "0" },
      library: { type: "string" },
      "fault-drill": { type: "boolean", default: false },
      "timeout-ms": { type: "string", default: "600000" },
      possess: { type: "string" },
      "possess-step": { type: "string", default: "2" },
    },
  });
  const mode = values.mode as Mode;
  if (!["ours", "baseline", "ablation"].includes(mode)) throw new Error(`--mode must be ours|baseline|ablation (got ${mode})`);
  await svc.ready;
  let runId = "";
  const buffered: SequencedEvent[] = [];
  const t0 = Date.now();
  const print = (ev: SequencedEvent) => {
    const d = describe(ev);
    if (d) console.log(`[${((ev.ts - t0) / 1000).toFixed(1).padStart(6)}s] ${d}`);
  };
  let resolveDone: (s: RunSummary) => void = () => {};
  const done = new Promise<RunSummary>((r) => (resolveDone = r));
  // --possess <slot>: press Possess (F1+F3) once that slot reaches --possess-step (demo button, from the CLI).
  const possessSlot = values.possess !== undefined ? Number(values.possess) : null;
  let possessed = false;
  const unsub = svc.subscribe((ev) => {
    if (!runId) return void buffered.push(ev);
    if (ev.runId !== runId) return;
    print(ev);
    if (possessSlot !== null && !possessed && ev.type === "agent.status" && ev.slot === possessSlot && ev.step >= Number(values["possess-step"])) {
      possessed = true;
      void svc.possess(runId, possessSlot).then((r) => console.log(`[cli] possess slot ${possessSlot}: ${JSON.stringify(r)}`));
    }
    if (ev.type === "run.status" && TERMINAL.has(ev.run.status)) resolveDone(ev.run);
  });
  const started = await svc.startRun({
    taskId: values.task,
    mode,
    ...(values.library ? { libraryId: values.library } : {}),
    stepDelayMs: Number(values["step-delay-ms"]),
    faultDrill: values["fault-drill"],
  });
  runId = started.runId;
  for (const ev of buffered.splice(0)) if (ev.runId === runId) print(ev);
  console.log(`run ${runId} started (task ${started.taskId}, mode ${mode}, library ${started.libraryId}, model ${started.model}); workDir ${await svc.getRunWorkDir(runId)}`);
  const stopOnSignal = async () => {
    console.log(`stopping run ${runId}`);
    await svc.stopRun(runId);
  };
  process.once("SIGINT", stopOnSignal);
  const timeout = setTimeout(() => void svc.stopRun(runId), Number(values["timeout-ms"]));
  const final = await done;
  clearTimeout(timeout);
  unsub();
  const ledger = await svc.getLedger(runId).catch(() => null);
  console.log(JSON.stringify({ run: final, ledger }, null, 2));
  return final.status === "finished" ? 0 : 1;
}

/**
 * Builds the service via createRuntimeService() (reconcile runs in the background; MOCK adapters are
 * logged), then either runs the `run` CLI or keeps the process alive. SIGINT/SIGTERM: stop loops (not
 * the Fleet state, so the next start reconciles) and close the Relay bus.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const svc = await createRuntimeService();
  if (argv[0] === "run") {
    const code = await runCli(svc, argv.slice(1));
    await svc.shutdown();
    process.exit(code);
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.log(`[main] ${sig}: stopping loops (Fleet state kept for reconcile)`);
      void svc.shutdown().finally(() => process.exit(0));
    });
  }
  await svc.ready;
  console.log("[main] runtime service ready (no HTTP here; use src/main.ts or src/http/serve-live.ts for the API)");
  setInterval(() => {}, 1 << 30); // keep alive
}

if (import.meta.main) await main();
