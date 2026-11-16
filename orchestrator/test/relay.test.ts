// Relay layer checks. Real-engine tests run when the engine answers on RELAY_BASE_URL
// (default http://127.0.0.1:8787 for tests only); MOCK tests always run.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  MockRelayBus,
  RelayCapError,
  RelayNameConflictError,
  RelayReleasedError,
  SdkRelayBus,
  StaleGenerationError,
  relayNames as N,
  relayReachable,
  relayStateFileFor,
  type BusMessage,
  type RelayBus,
} from "../src/relay/bus.ts";

const baseUrl = process.env.RELAY_BASE_URL ?? "http://127.0.0.1:8787";
const relayDir = join(resolve(import.meta.dir, "..", ".."), ".relay");
const stateFile = relayStateFileFor(relayDir, baseUrl);
const legacyStateFile = join(relayDir, "workspace.json");
const live = await relayReachable(baseUrl);
const logs: string[] = [];
const log = (l: string) => logs.push(l);
const yes = () => true;

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(50);
  return cond();
};

function suite(label: string, make: () => RelayBus, isLive: boolean) {
  describe(label, () => {
    const runId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const fleet = N.fleet(runId);
    const cases = N.cases(runId);
    let bus: RelayBus;
    let a: { name: string; token: string };
    let b: { name: string; token: string };
    let warden: { name: string; token: string };
    const seen: BusMessage[] = [];
    const meta = (slot: number, gen = 1) => ({ runId, slot, gen });

    test("setup: workspace, channels, identities", async () => {
      bus = make();
      await bus.ensureWorkspace();
      bus.onMessage((m) => seen.push(m));
      await bus.ensureChannel(fleet);
      await bus.ensureChannel(cases);
      warden = await bus.registerAgent(N.warden(runId), [fleet, cases]);
      a = await bus.registerAgent(N.agent(runId, 0, 1), [fleet, cases]);
      b = await bus.registerAgent(N.agent(runId, 1, 1), [fleet, cases]);
      expect(a.token.length).toBeGreaterThan(0);
    }, 30000);

    test("two identities exchange a DM", async () => {
      const m1 = await bus.send({ fromName: a.name, to: `@${b.name}`, text: "hi b", idempotencyKey: N.idempotencyKey(runId, 0, 1, 1), metadata: meta(0), gen: 1, isCurrentGen: yes });
      const m2 = await bus.send({ fromName: b.name, to: `@${a.name}`, text: "hi a", idempotencyKey: N.idempotencyKey(runId, 1, 1, 1), metadata: meta(1), gen: 1, isCurrentGen: yes });
      expect(bus.inbox(b.name, 0, 5).map((m) => m.id)).toContain(m1.id);
      expect(bus.inbox(a.name, 0, 5).map((m) => m.id)).toContain(m2.id);
      expect(m1.mock).toBe(!isLive);
    }, 15000);

    test("channel post is seen by the Relay listener, metadata intact", async () => {
      const m = await bus.send({ fromName: warden.name, to: `#${cases}`, text: "case: amounts are dollars", idempotencyKey: `${runId}.warden.c1`, metadata: { ...meta(-1, 0), caseId: "c1" }, gen: 0, isCurrentGen: yes });
      expect(await until(() => m.confirmed)).toBe(true); // flipped only by the SDK listener on the real bus
      expect(seen.find((x) => x.id === m.id)?.metadata.caseId).toBe("c1");
      expect(bus.inbox(a.name, 0, 10).some((x) => x.id === m.id)).toBe(true);
      expect(bus.inbox(warden.name, 0, 10).some((x) => x.id === m.id)).toBe(false);
    }, 15000);

    test("idempotent resend does not double-post", async () => {
      const key = N.idempotencyKey(runId, 0, 1, 2);
      const in1 = { fromName: a.name, to: `#${fleet}`, text: "status: tests green", idempotencyKey: key, metadata: meta(0), gen: 1, isCurrentGen: yes };
      const p1 = await bus.send(in1);
      const p2 = await bus.send(in1);
      expect(p2.id).toBe(p1.id);
      expect(seen.filter((x) => x.id === p1.id).length).toBe(1);
    }, 15000);

    test("409 on duplicate registration", async () => {
      await expect(bus.registerAgent(a.name)).rejects.toBeInstanceOf(RelayNameConflictError);
    }, 15000);

    test("thread caps: 3 replies max, never reply to a reply", async () => {
      const root = await bus.send({ fromName: warden.name, to: `#${cases}`, text: "case 2", idempotencyKey: `${runId}.warden.c2`, metadata: { ...meta(-1, 0), caseId: "c2" }, gen: 0, isCurrentGen: yes });
      const r1 = await bus.reply({ fromName: a.name, messageId: root.id, text: "applies", idempotencyKey: N.idempotencyKey(runId, 0, 1, 3), metadata: meta(0), gen: 1, isCurrentGen: yes });
      await expect(bus.reply({ fromName: b.name, messageId: r1.id, text: "re", idempotencyKey: N.idempotencyKey(runId, 1, 1, 3), metadata: meta(1), gen: 1, isCurrentGen: yes })).rejects.toBeInstanceOf(RelayCapError);
      await bus.reply({ fromName: b.name, messageId: root.id, text: "ok", idempotencyKey: N.idempotencyKey(runId, 1, 1, 4), metadata: meta(1), gen: 1, isCurrentGen: yes });
      await bus.reply({ fromName: warden.name, messageId: root.id, text: "noted", idempotencyKey: `${runId}.warden.r`, metadata: meta(-1, 0), gen: 0, isCurrentGen: yes });
      await expect(bus.reply({ fromName: a.name, messageId: root.id, text: "4th", idempotencyKey: N.idempotencyKey(runId, 0, 1, 5), metadata: meta(0), gen: 1, isCurrentGen: yes })).rejects.toBeInstanceOf(RelayCapError);
    }, 20000);

    test("generation guard rejects stale gen", async () => {
      await expect(bus.send({ fromName: a.name, to: `#${fleet}`, text: "late", idempotencyKey: N.idempotencyKey(runId, 0, 1, 9), metadata: meta(0), gen: 1, isCurrentGen: (g) => g === 2 })).rejects.toBeInstanceOf(StaleGenerationError);
    });

    test("reconnect with stored token works (fresh bus = orchestrator restart)", async () => {
      const bus2 = make();
      await bus2.ensureWorkspace();
      const r = await bus2.reconnect(b.token, [fleet]);
      expect(r.name).toBe(b.name);
      const m = await bus2.send({ fromToken: b.token, to: `#${fleet}`, text: "back after restart", idempotencyKey: N.idempotencyKey(runId, 1, 1, 6), metadata: meta(1), gen: 1, isCurrentGen: yes });
      expect(m.from).toBe(b.name);
      await bus2.close();
    }, 15000);

    test("released identity cannot send", async () => {
      await bus.release(a.name);
      await expect(bus.send({ fromName: a.name, to: `#${fleet}`, text: "ghost", idempotencyKey: N.idempotencyKey(runId, 0, 1, 10), metadata: meta(0), gen: 1, isCurrentGen: yes })).rejects.toThrow();
      await bus.close();
    }, 15000);
  });
}

if (live) suite(`real Relay engine at ${baseUrl}`, () => new SdkRelayBus({ baseUrl, stateFile, legacyStateFile, workspaceName: "smarter-subagents", repliesPerThread: 3, log }), true);
else test.skip("real Relay engine (not reachable; start scripts/relay-server.sh)", () => {});

test("workspace state file is keyed per engine port", () => {
  expect(relayStateFileFor("/r", "http://127.0.0.1:8787")).toBe("/r/workspace-8787.json");
  expect(relayStateFileFor("/r", "http://localhost:8796/")).toBe("/r/workspace-8796.json");
  expect(relayStateFileFor("/r", "https://relay.example.com")).toBe("/r/workspace-relay.example.com-443.json");
});

// The mock bus shares tokens via its own instance; reconnect needs the same instance.
const mockShared = new MockRelayBus({ repliesPerThread: 3, log });
suite("MOCK relay (in-memory)", () => mockShared, false);

test("MOCK logs are labeled", () => {
  expect(logs.some((l) => l.startsWith("[relay MOCK]"))).toBe(true);
});

test("released error type", () => {
  expect(new RelayReleasedError("x").message).toContain("released");
});
