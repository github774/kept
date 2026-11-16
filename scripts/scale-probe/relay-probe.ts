// Scale probe 3: Relay engine at fleet scale, through the shipped SdkRelayBus.
// Registers <agents> identities (one per agent, 4 per team channel), then posts <messages> messages
// spread across the team channels. Reports time, errors and listener fan-out.
// Usage: RELAY_BASE_URL=http://127.0.0.1:8794 STATE_FILE=/tmp/x/ws.json \
//        bun scripts/scale-probe/relay-probe.ts <agents> <teams> <messages> <concurrency> [per-team]
// per-team: register one identity per team instead of per agent (agents ignored for identities).
import { createRelayBus } from "../../orchestrator/src/relay/bus.ts";

const [agentsArg, teamsArg, msgsArg, concArg, scheme] = process.argv.slice(2);
const AGENTS = Number(agentsArg ?? 1000);
const TEAMS = Number(teamsArg ?? 250);
const MSGS = Number(msgsArg ?? 2000);
const CONC = Number(concArg ?? 32);
const perTeam = scheme === "per-team";
const baseUrl = process.env.RELAY_BASE_URL!;
const runId = `probe${Date.now().toString(36)}`;

const bus = await createRelayBus({
  baseUrl,
  stateFile: process.env.STATE_FILE!,
  workspaceName: "scale-probe",
  repliesPerThread: 3,
  allowMock: false,
  log: () => {},
});
if (bus.mock) throw new Error("expected a real engine");
let confirmed = 0;
bus.onMessage(() => confirmed++);

async function pool<T>(items: T[], c: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const errs: string[] = [];
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (i < items.length) {
        const x = items[i++]!;
        try {
          await fn(x);
        } catch (e) {
          errs.push(String((e as Error).message ?? e).slice(0, 120));
        }
      }
    }),
  );
  return errs;
}

const ch = (t: number) => `team-${t}-${runId}`;
// Channels first (admin creates + joins), so the registration phase measures identities.
let t0 = performance.now();
const chErrs = await pool([...Array(TEAMS).keys()], CONC, (t) => bus.ensureChannel(ch(t)));
const chanS = (performance.now() - t0) / 1000;

const ids = perTeam
  ? [...Array(TEAMS).keys()].map((t) => ({ name: `team${t}-${runId}`, team: t }))
  : [...Array(AGENTS).keys()].map((a) => ({ name: `w${a}-g1-${runId}`, team: Math.floor(a / (AGENTS / TEAMS)) }));
t0 = performance.now();
const regErrs = await pool(ids, CONC, async (id) => {
  await bus.registerAgent(id.name, [ch(id.team)]);
});
const regS = (performance.now() - t0) / 1000;

const msgs = [...Array(MSGS).keys()].map((k) => {
  const id = ids[k % ids.length]!;
  return { k, from: id.name, team: id.team };
});
const lat: number[] = [];
t0 = performance.now();
const sendErrs = await pool(msgs, CONC, async (m) => {
  const s = performance.now();
  await bus.send({
    fromName: m.from,
    to: `#${ch(m.team)}`,
    text: `step ${m.k}: claim tests_pass for subtask`,
    idempotencyKey: `${runId}.${m.k}`,
    metadata: { runId, slot: m.k % ids.length, gen: 1, kind: "status" },
    gen: 1,
    isCurrentGen: () => true,
  });
  lat.push(performance.now() - s);
});
const sendS = (performance.now() - t0) / 1000;
await Bun.sleep(3000); // let listener fan-out arrive
lat.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    scheme: perTeam ? "per-team" : "per-agent",
    identities: ids.length, teams: TEAMS, messages: MSGS, concurrency: CONC,
    channels_s: +chanS.toFixed(1), channel_errors: chErrs.length,
    register_s: +regS.toFixed(1), register_per_s: +(ids.length / regS).toFixed(1), register_errors: regErrs.length,
    send_s: +sendS.toFixed(1), send_per_s: +(MSGS / sendS).toFixed(1), send_errors: sendErrs.length,
    send_p50_ms: Math.round(lat[Math.floor(lat.length * 0.5)] ?? 0), send_p95_ms: Math.round(lat[Math.floor(lat.length * 0.95)] ?? 0),
    listener_confirmed: confirmed,
    sample_errors: [...new Set([...chErrs, ...regErrs, ...sendErrs])].slice(0, 3),
  }),
);
await bus.close();
process.exit(0);
