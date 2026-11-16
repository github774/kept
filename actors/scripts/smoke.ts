// Calls every actor method once against the running runtime and asserts the contract.
// Usage: bun scripts/smoke.ts   (runtime on DURABLE_ACTORS_CONTROL_PLANE_URL, default 127.0.0.1:7100)
import { actors } from "../generated/index.js"

const run = `smk${Date.now().toString(36)}`
let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
    if (!cond) failures++
    console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : " " + JSON.stringify(detail)}`)
}

// ---- Fleet
const fleet = actors.Fleet.get(`run.${run}`)
const r = await fleet.startRun({ runId: run, mode: "ours", config: { steps: 12 } })
check("Fleet.startRun", r.runId === run)
check("Fleet.startRun idempotent", (await fleet.startRun({ runId: run, mode: "baseline" })).mode === "ours")
await fleet.addSlot({ slot: "w1", relayName: `w1-g1-${run}` })
await fleet.addSlot({ slot: "w2" })
check("Fleet.addSlot idempotent", (await fleet.addSlot({ slot: "w1", gen: 9 })).gen === 1)
check("Fleet.setStatus", (await fleet.setStatus("w2", 1, "under_investigation")).ok)
check("Fleet.setStatus stale gen", JSON.stringify(await fleet.setStatus("w2", 0, "trusted")).includes("stale_generation"))
check("Fleet.setStatus to retiring refused", JSON.stringify(await fleet.setStatus("w2", 1, "retiring")).includes("invalid_transition"))
check("Fleet.setStep", (await fleet.setStep("w1", 1, 3)).ok)
check("Fleet.markPossessed", (await fleet.markPossessed("w1")).ok)
const b1 = await fleet.beginRetire("w1", 1, "false_claim")
const b2 = await fleet.beginRetire("w1", 1, "false_claim")
const b3 = await fleet.beginRetire("w2", 7, "stuck")
const b4 = await fleet.beginRetire("nope", 1, "stuck")
check("Fleet.beginRetire ok", b1.ok, b1)
check("Fleet.beginRetire second -> already_retiring", !b2.ok && b2.reason === "already_retiring", b2)
check("Fleet.beginRetire stale -> stale_generation", !b3.ok && b3.reason === "stale_generation", b3)
check("Fleet.beginRetire unknown -> not_active", !b4.ok && b4.reason === "not_active", b4)
const c1 = await fleet.completeRetire("w1", 1, { relayName: `w1-g2-${run}` })
const c2 = await fleet.completeRetire("w1", 1)
check("Fleet.completeRetire -> gen 2", c1.ok && c1.gen === 2 && !c1.repeated, c1)
check("Fleet.completeRetire repeat is safe", c2.ok && c2.repeated, c2)
const snap = await fleet.snapshot()
check("Fleet.snapshot", snap.slots.find(s => s.slot === "w1")?.status === "probation" && snap.history.length === 1, snap.slots)
check("Fleet.setRunStatus", (await fleet.setRunStatus("done")).ok)

// ---- Agent
const ag = actors.Agent.get(`agent.${run}.w1.g1`)
await ag.init({ runId: run, slot: "w1", gen: 1, task: "parse_invoice", persona: "careful" })
check("Agent.setRelay", (await ag.setRelay(1, `w1-g1-${run}`, "tok-placeholder")).ok)
const s1 = await ag.appendStep(1, { step: 1, summary: "wrote parser", claims: ["tests_pass"], usage: { input: 100, cached: 20, output: 50, reasoning: 10, usd: 0.001 } })
const s1b = await ag.appendStep(1, { step: 1, summary: "dup", usage: { input: 999 } })
check("Agent.appendStep", s1.ok && s1.created, s1)
check("Agent.appendStep idempotent", s1b.ok && !s1b.created, s1b)
const stale = await ag.appendStep(0, { step: 2, summary: "late" })
check("Agent.appendStep stale gen rejected", !stale.ok && stale.reason === "stale_generation", stale)
check("Agent.checkpoint", (await ag.checkpoint(1, "parse_invoice", "def parse_invoice(): ...")).ok)
const staleCp = await ag.checkpoint(2, "x", "y")
check("Agent.checkpoint stale gen rejected", !staleCp.ok && staleCp.reason === "stale_generation", staleCp)
check("Agent.close", (await ag.close(1, "false_claim")).ok)
const afterClose = await ag.appendStep(1, { step: 3, summary: "late reply" })
check("Agent write after close rejected", !afterClose.ok && afterClose.reason === "closed", afterClose)
const ho = await ag.handoff()
check("Agent.handoff verified-only", ho?.checkpoints.length === 1 && ho.lastStep === 1, ho)
const st = await ag.state()
check("Agent.state totals from first insert only", st.totals.input === 100 && st.steps.length === 1, st.totals)

// ---- CaseLibrary
const lib = actors.CaseLibrary.get(`cases.${run}`)
const kase = {
    id: `${run}.w1.g1`, runId: run, slot: "w1", gen: 1, category: "false_claim", claim: "tests pass",
    evidence: { test_output: "1 failed" }, lesson: "Run the tests before claiming they pass.", embedding: [0.1, 0.2, 0.3],
}
check("CaseLibrary.add", (await lib.add(kase)).created)
check("CaseLibrary.add idempotent", !(await lib.add({ ...kase, lesson: "changed" })).created)
check("CaseLibrary.markReceived", (await lib.markReceived(kase.id, `agent.${run}.w2.g1`)).ok)
const got = await lib.get(kase.id)
check("CaseLibrary.get (embedding as JSON)", got?.lesson === kase.lesson && got.embedding?.length === 3 && got.receivers.length === 1, got?.embedding)
check("CaseLibrary.list", (await lib.list()).length === 1)
check("CaseLibrary.revoke", (await lib.revoke(kase.id, "bad case")).ok)
check("CaseLibrary.list hides revoked", (await lib.list()).length === 0 && (await lib.list({ includeRevoked: true })).length === 1)

// ---- ReasoningStore
const rs = actors.ReasoningStore.get(`chunks.${run}`)
const chunk = { id: `${run}.w2.g1.s1`, sourceAgent: `agent.${run}.w2.g1`, slot: "w2", gen: 1, step: 1, fn: "tax", text: "round half up", embedding: [1, 0], estTokens: 40 }
check("ReasoningStore.add", (await rs.add(chunk)).created)
check("ReasoningStore.add idempotent", !(await rs.add(chunk)).created)
check("ReasoningStore.markReused", (await rs.markReused(chunk.id, `agent.${run}.w1.g2`)).ok)
check("ReasoningStore.markReused idempotent", !((await rs.markReused(chunk.id, `agent.${run}.w1.g2`)) as { created: boolean }).created)
const lst = await rs.list()
check("ReasoningStore.list returns reusers", lst[0]?.reusers.length === 1, lst[0]?.reusers)
check("ReasoningStore.revoke", (await rs.revoke(chunk.id)).ok)
const rv = await rs.markReused(chunk.id, "someone")
check("ReasoningStore.markReused on revoked rejected", !rv.ok && rv.reason === "revoked", rv)

// ---- Ledger
const led = actors.Ledger.get(`ledger.${run}`)
const base = { model: "openai/gpt-6-luna", input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, reasoning_tokens: 100, slot: "w1", gen: 1, step: 1 }
check("Ledger.record", (await led.record({ ...base, id: `${run}.w1.g1.s1.0`, category: "worker", usd: 0.01 })).created)
check("Ledger.record idempotent", !(await led.record({ ...base, id: `${run}.w1.g1.s1.0`, category: "worker", usd: 99 })).created)
await led.record({ ...base, id: `${run}.w1.g1.s1.1`, category: "jev", model: "typesafe/jev-1.14", usd: 0.0001, output_tokens: 0, reasoning_tokens: 0 })
await led.record({ ...base, id: `${run}.w1.g1.s1.2`, category: "fallback_judge", usd: 0.002 })
await led.record({ id: `${run}.w1.g2.s1.reuse`, category: "reuse_est", model: "est", input_tokens: 40, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, usd: 5 })
const tot = await led.totals()
check("Ledger.totals worker_usd", Math.abs(tot.worker_usd - 0.01) < 1e-9, tot.worker_usd)
check("Ledger.totals overhead excludes reuse_est", Math.abs(tot.overhead_usd - 0.0021) < 1e-9, tot.overhead_usd)
check("Ledger.totals calls", tot.calls.jev === 1 && tot.calls.fallback === 1, tot.calls)
check("Ledger.totals tokens", tot.tokens.input === 3000 && tot.tokens.cached === 600 && tot.tokens.output === 600 && tot.tokens.reasoning === 200, tot.tokens)
check("Ledger.totals reuse_est_tokens", tot.reuse_est_tokens === 40 && !("reuse_est" in tot.by_category), tot.reuse_est_tokens)
check("Ledger.list", (await led.list()).length === 4)

// ---- SwarmShard
const sh = actors.SwarmShard.get(`swarm.${run}.0`)
check("SwarmShard.seed", (await sh.seed(`${run}.s0`, 100)).agents === 100)
const changes = [
    { id: "c1", agentId: `${run}.s0.1`, gen: 1, kind: "step" as const },
    { id: "c2", agentId: `${run}.s0.2`, gen: 1, kind: "retire" as const },
    { id: "c3", agentId: `${run}.s0.2`, gen: 1, kind: "step" as const }, // stale after retire
    { id: "c4", agentId: `${run}.s0.3`, gen: 1, kind: "status" as const, status: "under_investigation" as const },
]
const ab = await sh.applyBatch(changes)
const ab2 = await sh.applyBatch(changes)
check("SwarmShard.applyBatch", ab.handled === 3 && ab.rejected === 1, ab)
check("SwarmShard.applyBatch idempotent per change id", ab2.duplicates === 4 && ab2.handled === 0, ab2)
const ss = await sh.stats()
check("SwarmShard.stats", ss.agents === 100 && ss.handled === 3 && ss.rejected === 1, ss)

// ---- Counter
const ctr = actors.Counter.get(`ctr.${run}`)
check("Counter.increment/read", (await ctr.increment()) === 1 && (await ctr.read()) === 1)

console.log(`\nrun=${run} failures=${failures}`)
process.exit(failures ? 1 : 0)
