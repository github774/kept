// Orchestrator entry (`bun run dev` in orchestrator/, used by scripts/start-all.sh).
//   bun --env-file=../.env run src/main.ts run --task invoice_parser [--mode ours] [--step-delay-ms N]
//       one run from the CLI (runtime/main.ts), no HTTP
//   bun --env-file=../.env run src/main.ts [--no-supervise]
//       the HTTP/SSE API (Amar's src/http/serve-live.ts) over the real service from src/service.ts
if (process.argv[2] === "run") {
  const { main } = await import("./runtime/main.ts");
  await main(process.argv.slice(2));
} else {
  await import("./http/serve-live.ts");
}
export {};
