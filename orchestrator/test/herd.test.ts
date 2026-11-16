// Herd immunity unit tests. All dependencies are labeled MOCKs (test/herd-fakes.ts): in-memory actors,
// keyword embedder, scripted Jev, in-memory MockRelayBus. No servers, no network.
import { describe, expect, test } from "bun:test";
import type { CaseFile } from "../src/contract.ts";
import { relayNames } from "../src/relay/bus.ts";
import { broadcastCase, readInbox, rebuildLessons, recordReply, sendMessage } from "../src/runtime/herd.ts";
import { FNS, RUN, caps, makeFakes, noulResult } from "./herd-fakes.ts";

function caseFile(over: Partial<CaseFile> = {}): CaseFile {
  return {
    id: `${RUN}.0.g1`,
    runId: RUN,
    libraryId: RUN,
    slot: 0,
    gen: 1,
    agentName: relayNames.agent(RUN, 0, 1),
    task: "invoice_parser",
    subtask: "parse_line",
    claim: "tests pass; amount parsed as cents",
    evidence: { testOutput: "FAILED test_amount_dollars" },
    category: "false_success_claim",
    lesson: "Invoice amount is in dollars, never cents; parse the amount as dollars.",
    recipients: [],
    synthetic: false,
    revoked: false,
    createdAt: Date.now(),
    ...over,
  };
}

async function setup(opts: Parameters<typeof makeFakes>[0] = {}) {
  const f = makeFakes(opts);
  await f.register();
  const c = caseFile();
  await (f.ctx.actors.cases as unknown as { add(x: unknown): Promise<unknown> }).add({ id: c.id, slot: "0", gen: 1, lesson: c.lesson });
  return { f, c };
}

describe("broadcastCase [MOCK deps]", () => {
  test("posts as warden to cases-<runId>, picks similar + relevant recipients, appends lesson", async () => {
    const { f, c } = await setup();
    const { recipients } = await broadcastCase(f.ctx, c);
    // slot 1 (amount/dollars/customer) is similar; slot 2 (dates) and 3 (ids) are not; own slot 0 excluded.
    expect(recipients.map((r) => r.slot)).toEqual([1]);
    const post = f.relay.history().find((m) => m.metadata.caseId === c.id)!;
    expect(post.from).toBe(relayNames.warden(RUN));
    expect(post.to).toBe(`#${relayNames.cases(RUN)}`);
    expect(post.metadata).toMatchObject({ runId: RUN, slot: 0, gen: 1, caseId: c.id, kind: "case" });
    expect(f.cases.get(c.id)!.receivers).toEqual([relayNames.agent(RUN, 1, 1)]);
    expect(f.ctx.lessons()).toEqual([c.lesson!]);
    const types = f.events.map((e) => e.type);
    expect(types).toEqual(["relay.message", "case.created"]);
    const created = f.events.find((e) => e.type === "case.created") as Extract<(typeof f.events)[number], { type: "case.created" }>;
    expect(created.case.recipients).toEqual([relayNames.agent(RUN, 1, 1)]);
    expect(created.mock).toBe(true);
    // ledger: embedding + 1 Jev call, under the herd.<caseId> scope
    expect(f.ledgerRows.map((r) => r.id)).toEqual([`${RUN}.0.g1.herd.${c.id}.1`, `${RUN}.0.g1.herd.${c.id}.2`]);
    expect(f.jevCalls.map((x) => x.q)).toEqual(["lesson_relevant"]);
  });

  test("Jev lesson_relevant below threshold filters a similar agent out", async () => {
    const { f, c } = await setup({ jev: (q) => (q === "lesson_relevant" ? noulResult(false, 0.2) : noulResult(false, 0.1)) });
    const { recipients } = await broadcastCase(f.ctx, c);
    expect(recipients).toEqual([]);
    expect(f.ctx.lessons()).toEqual([c.lesson!]); // lesson still joins the block
  });

  test("at most max_recipients; inactive slots skipped", async () => {
    const { f, c } = await setup();
    // make every subgoal similar
    FNS.forEach((fn, i) => (f.ctx.task.functions[i] = { ...fn, subgoal: "amount dollars invoice" }));
    f.slots.push({ slot: "4", gen: 1, status: "trusted", relayName: relayNames.agent(RUN, 4, 1) });
    f.ctx.task.functions[4] = { ...FNS[0]!, name: "x", subgoal: "amount dollars" };
    f.slots[2]!.status = "retiring";
    const { recipients } = await broadcastCase(f.ctx, c);
    expect(recipients.length).toBe(3);
    expect(recipients.map((r) => r.slot)).not.toContain(2);
    expect(recipients.map((r) => r.slot)).not.toContain(0);
  });

  test("no lesson -> posted, no recipients, lessons unchanged", async () => {
    const { f, c } = await setup();
    await broadcastCase(f.ctx, { ...c, lesson: null });
    expect(f.jevCalls.length).toBe(0);
    expect(f.ctx.lessons()).toEqual([]);
    expect(f.relay.history().length).toBe(1);
  });

  test("lessons block keeps at most max_lessons, oldest dropped, by reassignment", async () => {
    const { f } = await setup();
    const before = f.ctx.lessons();
    for (let i = 0; i < caps.max_lessons + 2; i++) {
      const id = `${RUN}.0.g${i + 2}`;
      await broadcastCase(f.ctx, caseFile({ id, gen: i + 2, lesson: `lesson ${i}` }));
    }
    const l = f.ctx.lessons();
    expect(l.length).toBe(caps.max_lessons);
    expect(l[0]).toBe("lesson 2");
    expect(l.at(-1)).toBe(`lesson ${caps.max_lessons + 1}`);
    expect(before).toEqual([]); // never mutated in place
  });

  test("repeat broadcast is idempotent on the Relay post", async () => {
    const { f, c } = await setup();
    await broadcastCase(f.ctx, c);
    await broadcastCase(f.ctx, c);
    expect(f.relay.history().filter((m) => m.metadata.caseId === c.id).length).toBe(1);
    expect(f.events.filter((e) => e.type === "relay.message").length).toBe(1);
  });

  test("rebuildLessons derives the block from CaseLibrary (restart)", async () => {
    const { f, c } = await setup();
    await (f.ctx.actors.cases as unknown as { add(x: unknown): Promise<unknown> }).add({ id: "x.1.g1", slot: "1", gen: 1, lesson: "" });
    await (f.ctx.actors.cases as unknown as { add(x: unknown): Promise<unknown> }).add({ id: "x.2.g1", slot: "2", gen: 1, lesson: "seed", synthetic: true });
    expect(await rebuildLessons(f.ctx)).toEqual([c.lesson!]);
  });
});

describe("readInbox [MOCK deps]", () => {
  test("recipient sees the case as quoted data; cursor advances; never own messages", async () => {
    const { f, c } = await setup();
    await broadcastCase(f.ctx, c);
    const r1 = f.agents[1]!;
    const inbox = await readInbox(f.ctx, r1, 3);
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.kind).toBe("case");
    expect(inbox[0]!.caseId).toBe(c.id);
    expect(inbox[0]!.wrapped).toContain(`from="${relayNames.warden(RUN)}"`);
    expect(f.jevCalls.filter((x) => x.q !== "lesson_relevant").length).toBe(0); // warden posts are not Jev-checked
    expect(await readInbox(f.ctx, r1, 4)).toEqual([]);
    // the sender never sees its own message
    await sendMessage(f.ctx, r1, 4, { to: "#fleet", text: "parse_line done" }, []);
    expect((await readInbox(f.ctx, r1, 5)).length).toBe(0);
  });

  test("teammate message that contradicts the spec is blocked before delivery", async () => {
    const f = makeFakes({ jev: (q, s) => (q === "fact_contradicts_spec" && String(s.fact).includes("cents") ? noulResult(true, 0.95) : noulResult(false, 0.1)) });
    await f.register();
    const [a, b] = f.agents;
    // send directly on the bus (as if the outgoing check had been bypassed, e.g. F4 style)
    await f.relay.send({ fromName: a!.name, to: `@${b!.name}`, text: "FYI amounts are in cents", idempotencyKey: "k1", metadata: { runId: RUN, slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true });
    await f.relay.send({ fromName: a!.name, to: `@${b!.name}`, text: "parse_line is green", idempotencyKey: "k2", metadata: { runId: RUN, slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true });
    const inbox = await readInbox(f.ctx, b!, 1);
    expect(inbox.map((i) => i.text)).toEqual(["parse_line is green"]);
    expect(f.ctx.rejectedFacts.has("fyi amounts are in cents")).toBe(true);
    const blocked = f.events.filter((e) => e.type === "relay.message" && e.item.blocked);
    expect(blocked.length).toBe(1);
    const item = (blocked[0] as Extract<(typeof f.events)[number], { type: "relay.message" }>).item;
    expect(item.blocked!.questionId).toBe("fact_contradicts_spec");
    expect(item.seq).toBeGreaterThan(2); // reserved from the bus counter, unique
    // both checks ran per teammate message, ledger scope = reader's step
    expect(f.ledgerRows.every((r) => r.id.startsWith(`${RUN}.1.g1.s1.`))).toBe(true);
  });

  test("at most inbox_per_step messages per read", async () => {
    const f = makeFakes();
    await f.register();
    const [a, b] = f.agents;
    for (let i = 0; i < caps.inbox_per_step + 2; i++)
      await f.relay.send({ fromName: a!.name, to: `@${b!.name}`, text: `m${i}`, idempotencyKey: `k${i}`, metadata: { runId: RUN, slot: 0, gen: 1 }, gen: 1, isCurrentGen: () => true });
    expect((await readInbox(f.ctx, b!, 1)).length).toBe(caps.inbox_per_step);
    expect((await readInbox(f.ctx, b!, 2)).length).toBe(2);
  });
});

describe("sendMessage [MOCK deps]", () => {
  test("conflicting instruction is blocked (not sent) and returns the conflict", async () => {
    const f = makeFakes({ jev: (q, s) => (q === "instruction_conflicts_spec" && String(s.instruction).includes("cents") ? noulResult(true, 0.94) : noulResult(false, 0.1)) });
    await f.register();
    const [a, b] = f.agents;
    const r = await sendMessage(f.ctx, a!, 2, { to: b!.name, text: "heads up" }, [{ kind: "instruction", text: "store amounts as cents" }]);
    expect(r.sent).toBe(false);
    expect(r.conflict?.value).toBe(true);
    expect(f.relay.history().length).toBe(0);
    const ev = f.events.find((e) => e.type === "relay.message") as Extract<(typeof f.events)[number], { type: "relay.message" }>;
    expect(ev.item.blocked?.questionId).toBe("instruction_conflicts_spec");
    expect(ev.item.channel).toBe("dm");
  });

  test("clean message is sent with idempotency key + gen metadata; cap 1 per step", async () => {
    const f = makeFakes();
    await f.register();
    const [a] = f.agents;
    expect((await sendMessage(f.ctx, a!, 2, { to: "fleet", text: "done with parse" }, [])).sent).toBe(true);
    expect((await sendMessage(f.ctx, a!, 2, { to: "fleet", text: "again" }, [])).sent).toBe(false);
    const m = f.relay.history()[0]!;
    expect(m.to).toBe(`#${relayNames.fleet(RUN)}`);
    expect(m.metadata).toMatchObject({ runId: RUN, slot: 0, gen: 1, kind: "note" });
    expect(f.events.filter((e) => e.type === "relay.message").length).toBe(1);
  });

  test("stale generation cannot send (rule 5)", async () => {
    const f = makeFakes();
    await f.register();
    f.slots[0]!.gen = 2;
    expect((await sendMessage(f.ctx, f.agents[0]!, 2, { to: "fleet", text: "late" }, [])).sent).toBe(false);
    expect(f.relay.history().length).toBe(0);
  });
});

describe("recordReply [MOCK deps]", () => {
  async function broadcastToAll() {
    const { f, c } = await setup();
    FNS.forEach((fn, i) => (f.ctx.task.functions[i] = { ...fn, subgoal: "amount dollars invoice" }));
    const { recipients } = await broadcastCase(f.ctx, c);
    return { f, c, recipients };
  }

  test("recipient replies once; event + feed share seq; second reply refused", async () => {
    const { f, c, recipients } = await broadcastToAll();
    const r = recipients[0]!;
    const reply = await recordReply(f.ctx, r, 5, c.id, "Applies to totals: sum dollars, not cents.");
    expect(reply).not.toBeNull();
    expect(reply!.from).toBe(r.name);
    const feed = f.events.filter((e) => e.type === "relay.message").at(-1) as Extract<(typeof f.events)[number], { type: "relay.message" }>;
    expect(feed.item.seq).toBe(reply!.seq);
    expect(feed.item.metadata).toMatchObject({ caseId: c.id, kind: "case_reply" });
    const ev = f.events.find((e) => e.type === "case.reply") as Extract<(typeof f.events)[number], { type: "case.reply" }>;
    expect(ev.reply).toEqual(reply!);
    expect(await recordReply(f.ctx, r, 6, c.id, "again")).toBeNull();
  });

  test("non-recipient and the case's own slot cannot reply", async () => {
    const { f, c } = await setup(); // only slot 1 receives
    await broadcastCase(f.ctx, c);
    expect(await recordReply(f.ctx, f.agents[2]!, 5, c.id, "me too")).toBeNull();
    expect(await recordReply(f.ctx, f.agents[0]!, 5, c.id, "my own case")).toBeNull();
  });

  test("thread closes after replies_per_case_thread", async () => {
    const { f, c, recipients } = await broadcastToAll();
    expect(recipients.length).toBe(3);
    for (const r of recipients) expect(await recordReply(f.ctx, r, 5, c.id, `ok from ${r.name}`)).not.toBeNull();
    // a 4th agent forced into the receivers list still cannot reply: thread closed
    f.cases.get(c.id)!.receivers.push("w9-g1-x");
    expect(await recordReply(f.ctx, { slot: 9, gen: 1, name: "w9-g1-x" }, 5, c.id, "late")).toBeNull();
    expect(f.events.filter((e) => e.type === "case.reply").length).toBe(caps.replies_per_case_thread);
  });

  test("replies show up in recipients' inboxes as case_reply, not in the replier's", async () => {
    const { f, c, recipients } = await broadcastToAll();
    for (const r of recipients) await readInbox(f.ctx, r, 4);
    await recordReply(f.ctx, recipients[0]!, 5, c.id, "noted");
    const other = await readInbox(f.ctx, recipients[1]!, 5);
    expect(other.map((i) => i.kind)).toEqual(["case_reply"]);
    expect(await readInbox(f.ctx, recipients[0]!, 6)).toEqual([]);
  });
});
