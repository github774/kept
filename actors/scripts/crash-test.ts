// Crash test (BUILD_SPEC milestone 11:20–11:45): write state, kill -9 the actor runtime's whole
// process tree, restart it, and verify Counter, Fleet roster and Ledger rows survived.
// Usage: bun scripts/crash-test.ts [--keep-running]
// Only processes descended from the runtime this project started (pid in .logs/dev.pid) are killed.
import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { actors } from "../generated/index.js"

const ROOT = join(import.meta.dir, "..")
const LOGS = join(ROOT, ".logs")
const PID_FILE = join(LOGS, "dev.pid")
const PORT = Number(process.env.ACTORS_PORT ?? process.env.DURABLE_ACTORS_PORT ?? 7100)
const keepRunning = process.argv.includes("--keep-running")
const log = (m: string) => console.log(`[crash-test] ${m}`)

function listening(): boolean {
    try {
        return execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"]).toString().trim().length > 0
    } catch {
        return false
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function tree(root: number): number[] {
    const parent = new Map<number, number>()
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="]).toString().trim().split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number)
        if (pid !== undefined && ppid !== undefined) parent.set(pid, ppid)
    }
    const out = new Set([root])
    for (let grew = true; grew; ) {
        grew = false
        for (const [pid, ppid] of parent) if (!out.has(pid) && out.has(ppid)) (out.add(pid), (grew = true))
    }
    return [...out]
}

async function waitFor(cond: () => boolean, ms: number, what: string) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (cond()) return
        await Bun.sleep(250)
    }
    throw new Error(`timed out waiting for ${what}`)
}

async function start(): Promise<number> {
    mkdirSync(LOGS, { recursive: true })
    const out = openSync(join(LOGS, "dev.log"), "a")
    const child = spawn("bunx", ["durable-actors", "dev", "--no-watch"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env, DURABLE_ACTORS_PORT: String(PORT) },
    })
    child.unref()
    writeFileSync(PID_FILE, String(child.pid))
    await waitFor(listening, 60_000, `runtime on :${PORT}`)
    return child.pid!
}

async function kill9(root: number) {
    const pids = tree(root)
    log(`kill -9 runtime tree root=${root} (${pids.length} processes)`)
    for (const p of pids) {
        try {
            process.kill(p, "SIGKILL")
        } catch {}
    }
    await waitFor(() => !listening() && pids.every(p => !alive(p)), 15_000, "runtime to die")
}

// After kill -9 the dead host's owner lease must expire before its actors reactivate;
// until then calls fail with code "unavailable". Methods are idempotent, so retrying is safe.
async function retry<T>(fn: () => Promise<T>, ms = 180_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
        try {
            return await fn()
        } catch (e) {
            if ((e as { code?: string }).code !== "unavailable" || Date.now() > end) throw e
            await Bun.sleep(2000)
        }
    }
}

function currentRoot(): number | null {
    if (!existsSync(PID_FILE)) return null
    const pid = Number(readFileSync(PID_FILE, "utf8").trim())
    return pid && alive(pid) ? pid : null
}

// ---------- run ----------
let root = currentRoot()
if (!root) {
    if (listening()) throw new Error(`port ${PORT} is held by a runtime this script did not start; stop it first`)
    log("starting runtime")
    root = await start()
}

const run = `crash${Date.now().toString(36)}`
const counter = actors.Counter.get(`ctr.${run}`)
const fleet = actors.Fleet.get(`run.${run}`)
const ledger = actors.Ledger.get(`ledger.${run}`)

for (let i = 0; i < 5; i++) await counter.increment()
await fleet.startRun({ runId: run, mode: "ours" })
await fleet.addSlot({ slot: "w1", relayName: `w1-g1-${run}` })
await fleet.addSlot({ slot: "w2" })
await fleet.setStatus("w2", 1, "under_investigation")
await fleet.beginRetire("w1", 1, "false_claim")
await ledger.record({
    id: `${run}.w1.g1.s1.0`, category: "worker", model: "openai/gpt-6-luna",
    input_tokens: 1234, cached_input_tokens: 100, output_tokens: 56, reasoning_tokens: 7, usd: 0.0042, mock: true,
})
const before = {
    counter: await counter.read(),
    roster: (await fleet.snapshot()).slots,
    totals: await ledger.totals(),
}
log(`before: counter=${before.counter} roster=${JSON.stringify(before.roster.map(s => [s.slot, s.gen, s.status]))} ledger.rows=${before.totals.rows} worker_usd=${before.totals.worker_usd}`)

await kill9(root)
log(`runtime dead; port ${PORT} free=${!listening()}`)
log("restarting runtime")
root = await start()

const t0 = Date.now()
const after = {
    counter: await retry(() => counter.read()),
    roster: (await retry(() => fleet.snapshot())).slots,
    totals: await retry(() => ledger.totals()),
}
log(`state readable ${((Date.now() - t0) / 1000).toFixed(1)}s after restart (old owner lease had to expire)`)
log(`after:  counter=${after.counter} roster=${JSON.stringify(after.roster.map(s => [s.slot, s.gen, s.status]))} ledger.rows=${after.totals.rows} worker_usd=${after.totals.worker_usd}`)

const strip = (t: typeof before.totals) => ({ ...t, updatedAt: 0 })
const ok =
    after.counter === 5 &&
    JSON.stringify(after.roster) === JSON.stringify(before.roster) &&
    JSON.stringify(strip(after.totals)) === JSON.stringify(strip(before.totals)) &&
    after.roster.find(s => s.slot === "w1")?.status === "retiring"
// retiring survives the crash, so a second beginRetire still reports already_retiring
const again = await fleet.beginRetire("w1", 1, "false_claim")
const guardOk = !again.ok && again.reason === "already_retiring"
log(`beginRetire after restart -> ${JSON.stringify(again)}`)

if (!keepRunning) {
    await kill9(root)
    log("runtime left STOPPED")
}
log(ok && guardOk ? "CRASH TEST PASS" : "CRASH TEST FAIL")
process.exit(ok && guardOk ? 0 : 1)
