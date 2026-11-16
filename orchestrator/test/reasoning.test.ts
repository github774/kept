// Shared verified reasoning unit tests. All dependencies are labeled MOCKs (test/herd-fakes.ts).
import { describe, expect, test } from "bun:test";
import type { LedgerDraft } from "../src/ledger-entry.ts";
import { relayNames } from "../src/relay/bus.ts";
import { chunkText, maybeCreateChunk, retrieveChunks, revokeChunk, signatureOf } from "../src/runtime/reasoning.ts";
import type { AgentRef, StepRecord } from "../src/runtime/types.ts";
import { FNS, RUN, caps, makeFakes, noulResult } from "./herd-fakes.ts";

const CODE = ['from decimal import Decimal', '', 'def parse_line(line: str) -> dict:', '    """Parse one line."""', '    parts = line.split(",")', '    return {"amount": Decimal(parts[1])}'].join("\n");

function workerDraft(output: number): LedgerDraft {
  return { category: "worker", model: "MOCK", input_tokens: 100, cached_input_tokens: 0, output_tokens: output, reasoning_tokens: 0, usd: 0, slot: "0", gen: 1, step: 3, ts: 0 };
}

function stepRecord(ref: AgentRef, over: Partial<StepRecord> = {}): StepRecord {
  return {
    ref,
    step: 3,
    fn: FNS[ref.slot]!,
    output: { action: "write_code", file: FNS[ref.slot]!.file, code: CODE, message: null, claims: [], approach_note: "Parse the invoice amount as dollars with Decimal.", summary: "wrote parser" },
    injected: [],
    verified: true,
    reusedChunkIds: [],
    usage: [workerDraft(250), { ...workerDraft(999), category: "jev" }],
    startedAt: 0,
    endedAt: 1,
    ...over,
  };
}

describe("chunk text", () => {
  test("note + signature + at most 40 lines of code", () => {
    expect(signatureOf(CODE, "parse_line")).toBe("def parse_line(line: str) -> dict:");
    const long = Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join("\n");
    const t = chunkText("note", FNS[0]!, long);
    expect(t).toContain("Code (40 of 60 lines)");
    expect(t).not.toContain("x40 = 40");
  });
});

describe("maybeCreateChunk [MOCK deps]", () => {
  test("verified + consistent note + trusted -> stored with embedding and est tokens from worker usage", async () => {
    const f = makeFakes();
    const a = f.agents[0]!;
    const id = await maybeCreateChunk(f.ctx, a, stepRecord(a));
    expect(id).toBe(`${RUN}.0.g1.s3`);
    const c = f.chunks.get(id!)!;
    expect(c.sourceAgent).toBe(a.name);
    expect(c.estTokens).toBe(250); // worker output tokens only, from usage fields
    expect(c.text).toContain("Signature: def parse_line");
    expect(c.embedding?.length).toBeGreaterThan(0);
    expect(f.jevCalls.map((x) => x.q)).toEqual(["note_consistent_with_spec"]);
    // repeat is a no-op (no second Jev call)
    expect(await maybeCreateChunk(f.ctx, a, stepRecord(a))).toBe(id);
    expect(f.jevCalls.length).toBe(1);
  });

  test("not verified / probation / shared reasoning off / inconsistent note -> null", async () => {
    const f = makeFakes();
    const a = f.agents[0]!;
    expect(await maybeCreateChunk(f.ctx, a, stepRecord(a, { verified: false }))).toBeNull();
    f.slots[0]!.status = "probation";
    expect(await maybeCreateChunk(f.ctx, a, stepRecord(a))).toBeNull();
    f.slots[0]!.status = "trusted";
    const off = makeFakes({ sharedReasoning: false });
    expect(await maybeCreateChunk(off.ctx, off.agents[0]!, stepRecord(off.agents[0]!))).toBeNull();
    const bad = makeFakes({ jev: (q) => (q === "note_consistent_with_spec" ? noulResult(true, 0.9) : noulResult(false, 0.1)) });
    expect(await maybeCreateChunk(bad.ctx, bad.agents[0]!, stepRecord(bad.agents[0]!))).toBeNull();
    expect(bad.chunks.size).toBe(0);
    expect(f.chunks.size).toBe(0);
  });
});

describe("retrieveChunks [MOCK deps]", () => {
  test("top chunks >= chunk_similarity from other slots; markReused; one reuse_est row per (chunk, agent)", async () => {
    const f = makeFakes();
    const [a, b] = f.agents;
    await maybeCreateChunk(f.ctx, a!, stepRecord(a!));
    // own chunk is excluded
    expect(await retrieveChunks(f.ctx, a!, FNS[0]!.subgoal)).toEqual([]);
    const got = await retrieveChunks(f.ctx, b!, "parse invoice amount dollars line", 1);
    expect(got.length).toBe(1);
    expect(got[0]!.similarity).toBeGreaterThanOrEqual(0.75);
    expect(got[0]!.estTokens).toBe(250);
    expect(f.chunks.get(got[0]!.chunkId)!.reusers).toEqual([b!.name]);
    await retrieveChunks(f.ctx, b!, "parse invoice amount dollars line", 2);
    const est = f.ledgerRows.filter((r) => r.category === "reuse_est");
    expect(est.length).toBe(1);
    expect(est[0]).toMatchObject({ model: "est", usd: 0, input_tokens: 250, output_tokens: 0 });
    // dissimilar subgoal gets nothing
    expect(await retrieveChunks(f.ctx, f.agents[2]!, "due date weekend overdue")).toEqual([]);
  });

  test("at most max_chunks_in_prompt; revoked chunks never returned; off -> []", async () => {
    const f = makeFakes();
    for (const s of [0, 1, 2, 3]) {
      const ref = f.agents[s]!;
      await maybeCreateChunk(f.ctx, ref, stepRecord(ref, { fn: { ...FNS[s]!, subgoal: "parse invoice amount dollars line" } }));
    }
    const ref = { slot: 7, gen: 1, name: "w7-g1-x" };
    expect((await retrieveChunks(f.ctx, ref, "parse invoice amount dollars line")).length).toBe(caps.max_chunks_in_prompt);
    for (const id of f.chunks.keys()) f.chunks.get(id)!.revoked = true;
    expect(await retrieveChunks(f.ctx, { ...ref, name: "w8-g1-x", slot: 8 }, "parse invoice amount dollars line")).toEqual([]);
    const off = makeFakes({ sharedReasoning: false });
    expect(await retrieveChunks(off.ctx, ref, "x")).toEqual([]);
  });
});

describe("revokeChunk [MOCK deps]", () => {
  test("revokes and DMs every reuser once, from warden, published as relay.message kind revoke", async () => {
    const f = makeFakes();
    await f.register();
    const [a, b, c] = f.agents;
    const id = (await maybeCreateChunk(f.ctx, a!, stepRecord(a!)))!;
    f.ctx.task.functions[2] = { ...FNS[2]!, subgoal: "parse invoice amount dollars line" };
    await retrieveChunks(f.ctx, b!, "parse invoice amount dollars line");
    await retrieveChunks(f.ctx, c!, "parse invoice amount dollars line");
    await revokeChunk(f.ctx, id, "derived code failed test_amount_dollars");
    await revokeChunk(f.ctx, id, "derived code failed test_amount_dollars"); // idempotent
    expect(f.chunks.get(id)!.revoked).toBe(true);
    const dms = f.relay.history();
    expect(dms.map((m) => m.to).sort()).toEqual([`@${b!.name}`, `@${c!.name}`].sort());
    expect(dms.every((m) => m.from === relayNames.warden(RUN) && m.metadata.kind === "revoke")).toBe(true);
    const ev = f.events.filter((e) => e.type === "relay.message");
    expect(ev.length).toBe(2);
    expect(await retrieveChunks(f.ctx, b!, "parse invoice amount dollars line")).toEqual([]);
  });
});
