// Durable state for Kept. Rules (BUILD_SPEC "Rules for the build agent"):
// actors never touch the network or other actors; growing data lives in SQLite;
// persisted fields stay small and are always reassigned, never mutated;
// every agent write carries its generation and stale generations are rejected.
import { Actor, Emittable, Persisted } from "durable-actors"
import type { ActorDatabase, SqliteValue } from "durable-actors"
import { ShardCore, type ShardOp } from "./fleet-shard-core.js"

// ---------- shared helpers (module-level, not RPC) ----------

type Row = Record<string, SqliteValue>
const ready = new WeakSet<object>()

// NOTE: every method on an actor class is treated as RPC and must be async,
// so sync helpers live here as plain functions.
function ensure(actor: object, db: ActorDatabase, ddl: readonly string[]): ActorDatabase {
    if (!ready.has(actor)) {
        for (const sql of ddl) db.exec(sql)
        ready.add(actor)
    }
    return db
}

const now = () => Date.now()
const num = (v: SqliteValue | undefined): number => (v === null || v === undefined ? 0 : Number(v))
const str = (v: SqliteValue | undefined): string => (v === null || v === undefined ? "" : String(v))
const optStr = (v: SqliteValue | undefined): string | null => (v === null || v === undefined ? null : String(v))
const json = <T>(v: SqliteValue | undefined, fallback: T): T => {
    if (typeof v !== "string" || v === "") return fallback
    try {
        return JSON.parse(v) as T
    } catch {
        return fallback
    }
}

// ---------- shared types ----------

export type SlotStatus = "trusted" | "probation" | "under_investigation" | "retiring" | "retired" | "failed"
export const ACTIVE_STATUSES: readonly SlotStatus[] = ["trusted", "probation", "under_investigation"]
const isActive = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s)

export type Fail<R extends string> = { ok: false; reason: R }
export type Ok<T extends object = {}> = { ok: true } & T

// ======================================================================
// Fleet: run.<runId> — single source of truth for who is active
// ======================================================================

export type RunMode = "ours" | "baseline"
export type RunStatus = "running" | "done" | "stopped" | "failed"
export type RunInfo = { runId: string; mode: RunMode; status: RunStatus; config: Record<string, unknown>; startedAt: number }
export type SlotSummary = {
    slot: string
    gen: number
    status: SlotStatus
    possessed: boolean
    step: number
    relayName: string | null
    reason: string | null
    /** When beginRetire ran for the current retire (null when not retiring). */
    retireStartedAt: number | null
    /** The current generation's loop returned "done" (Fleet.markDone); cleared by clearDone. */
    done: boolean
}
export type Reassignment = { fn: string; toSlot: string; fromSlot: string; ts: number }
export type RosterSummary = { runId: string | null; mode: RunMode | null; status: RunStatus | null; slots: SlotSummary[]; updatedAt: number }
export type SlotHistory = { slot: string; gen: number; status: SlotStatus; reason: string | null; endedAt: number }

const FLEET_DDL = [
    `CREATE TABLE IF NOT EXISTS slots (
        slot TEXT PRIMARY KEY, gen INTEGER NOT NULL, status TEXT NOT NULL, possessed INTEGER NOT NULL DEFAULT 0,
        step INTEGER NOT NULL DEFAULT 0, relay_name TEXT, reason TEXT, retire_started_at INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS slot_history (
        slot TEXT NOT NULL, gen INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, ended_at INTEGER NOT NULL,
        PRIMARY KEY (slot, gen))`,
    `CREATE TABLE IF NOT EXISTS slot_done (slot TEXT PRIMARY KEY, gen INTEGER NOT NULL, ts INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS reassignments (fn TEXT PRIMARY KEY, to_slot TEXT NOT NULL, from_slot TEXT NOT NULL, ts INTEGER NOT NULL)`,
]
const SLOT_SELECT = `SELECT s.*, (SELECT COUNT(*) FROM slot_done d WHERE d.slot = s.slot AND d.gen = s.gen) AS done FROM slots s`

const slotFromRow = (r: Row): SlotSummary => ({
    slot: str(r.slot),
    gen: num(r.gen),
    status: str(r.status) as SlotStatus,
    possessed: num(r.possessed) === 1,
    step: num(r.step),
    relayName: optStr(r.relay_name),
    reason: optStr(r.reason),
    retireStartedAt: r.retire_started_at === null || r.retire_started_at === undefined ? null : num(r.retire_started_at),
    done: num(r.done) > 0,
})

const fleetDb = (a: Fleet) => ensure(a, a.db, FLEET_DDL)
function getSlot(a: Fleet, slot: string): SlotSummary | null {
    const r = fleetDb(a).exec(`${SLOT_SELECT} WHERE s.slot = ?`, slot)[0]
    return r ? slotFromRow(r) : null
}
function rosterOf(a: Fleet, run: RunInfo | null): RosterSummary {
    return {
        runId: run?.runId ?? null,
        mode: run?.mode ?? null,
        status: run?.status ?? null,
        slots: fleetDb(a).exec(`${SLOT_SELECT} ORDER BY s.slot`).map(slotFromRow),
        updatedAt: now(),
    }
}

export class Fleet extends Actor {
    @Persisted private run: RunInfo | null = null
    @Emittable @Persisted roster: RosterSummary = { runId: null, mode: null, status: null, slots: [], updatedAt: 0 }


    /** Idempotent: a repeat call returns the existing run unchanged. */
    async startRun(input: { runId: string; mode: RunMode; config?: Record<string, unknown> }): Promise<RunInfo> {
        if (!this.run) {
            this.run = { runId: input.runId, mode: input.mode, status: "running", config: input.config ?? {}, startedAt: now() }
            this.roster = rosterOf(this, this.run)
        }
        return this.run
    }

    async setRunStatus(status: RunStatus): Promise<Ok | Fail<"no_run">> {
        if (!this.run) return { ok: false, reason: "no_run" }
        this.run = { ...this.run, status }
        this.roster = rosterOf(this, this.run)
        return { ok: true }
    }

    /** Idempotent on slot: a repeat call returns the existing slot. */
    async addSlot(input: { slot: string; gen?: number; status?: SlotStatus; relayName?: string }): Promise<SlotSummary> {
        const existing = getSlot(this, input.slot)
        if (existing) return existing
        fleetDb(this).exec(
            "INSERT INTO slots (slot, gen, status, relay_name, updated_at) VALUES (?, ?, ?, ?, ?)",
            input.slot,
            input.gen ?? 1,
            input.status ?? "trusted",
            input.relayName ?? null,
            now(),
        )
        this.roster = rosterOf(this, this.run)
        return getSlot(this, input.slot)!
    }

    /** Changes status among active states (or to failed). Retiring goes only through beginRetire. */
    async setStatus(
        slot: string,
        gen: number,
        status: SlotStatus,
    ): Promise<Ok<{ slot: SlotSummary }> | Fail<"not_found" | "stale_generation" | "invalid_transition">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_found" }
        if (s.gen !== gen) return { ok: false, reason: "stale_generation" }
        const allowed = status === "retiring" || status === "retired" ? false : isActive(s.status) || (s.status === "retiring" && status === "failed")
        if (!allowed) return { ok: false, reason: "invalid_transition" }
        if (status === "failed") {
            fleetDb(this).exec(
                "INSERT OR IGNORE INTO slot_history (slot, gen, status, reason, ended_at) VALUES (?, ?, 'failed', ?, ?)",
                slot,
                gen,
                s.reason,
                now(),
            )
        }
        fleetDb(this).exec("UPDATE slots SET status = ?, updated_at = ? WHERE slot = ?", status, now(), slot)
        this.roster = rosterOf(this, this.run)
        return { ok: true, slot: getSlot(this, slot)! }
    }

    /** Dashboard "current step"; rejects stale generations. */
    async setStep(slot: string, gen: number, step: number): Promise<Ok | Fail<"not_found" | "stale_generation">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_found" }
        if (s.gen !== gen) return { ok: false, reason: "stale_generation" }
        if (step > s.step) {
            fleetDb(this).exec("UPDATE slots SET step = ?, updated_at = ? WHERE slot = ?", step, now(), slot)
            this.roster = rosterOf(this, this.run)
        }
        return { ok: true }
    }

    /** Succeeds only if the slot is active at this generation. A second caller gets already_retiring. */
    async beginRetire(
        slot: string,
        gen: number,
        reason: string,
    ): Promise<{ ok: true } | Fail<"already_retiring" | "stale_generation" | "not_active">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_active" }
        if (s.gen !== gen) return { ok: false, reason: "stale_generation" }
        if (s.status === "retiring") return { ok: false, reason: "already_retiring" }
        if (!isActive(s.status)) return { ok: false, reason: "not_active" }
        fleetDb(this).exec(
            "UPDATE slots SET status = 'retiring', reason = ?, retire_started_at = ?, updated_at = ? WHERE slot = ?",
            reason,
            now(),
            now(),
            slot,
        )
        this.roster = rosterOf(this, this.run)
        return { ok: true }
    }

    /** Moves a retiring slot to gen+1 on probation. Safe to repeat: a second call reports the new generation. */
    async completeRetire(
        slot: string,
        gen: number,
        next?: { relayName?: string },
    ): Promise<Ok<{ gen: number; repeated: boolean }> | Fail<"not_found" | "stale_generation" | "not_retiring">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_found" }
        if (s.gen === gen + 1 && isActive(s.status)) return { ok: true, gen: s.gen, repeated: true }
        if (s.gen !== gen) return { ok: false, reason: "stale_generation" }
        if (s.status !== "retiring") return { ok: false, reason: "not_retiring" }
        await this.db.transaction(async () => {
            fleetDb(this).exec(
                "INSERT OR IGNORE INTO slot_history (slot, gen, status, reason, ended_at) VALUES (?, ?, 'retired', ?, ?)",
                slot,
                gen,
                s.reason,
                now(),
            )
            fleetDb(this).exec(
                `UPDATE slots SET gen = ?, status = 'probation', possessed = 0, step = 0, reason = NULL,
                 retire_started_at = NULL, relay_name = ?, updated_at = ? WHERE slot = ?`,
                gen + 1,
                next?.relayName ?? null,
                now(),
                slot,
            )
        })
        this.roster = rosterOf(this, this.run)
        return { ok: true, gen: gen + 1, repeated: false }
    }

    /** Fault injection flag on the slot's current generation. Idempotent. */
    async markPossessed(slot: string): Promise<Ok<{ gen: number }> | Fail<"not_found" | "not_active">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_found" }
        if (!isActive(s.status)) return { ok: false, reason: "not_active" }
        if (!s.possessed) {
            fleetDb(this).exec("UPDATE slots SET possessed = 1, updated_at = ? WHERE slot = ?", now(), slot)
            this.roster = rosterOf(this, this.run)
        }
        return { ok: true, gen: s.gen }
    }

    /** Clears the possessed flag (reconcile: armed faults live in orchestrator memory and are gone after a restart). */
    async clearPossessed(slot: string): Promise<Ok | Fail<"not_found">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_found" }
        if (s.possessed) {
            fleetDb(this).exec("UPDATE slots SET possessed = 0, updated_at = ? WHERE slot = ?", now(), slot)
            this.roster = rosterOf(this, this.run)
        }
        return { ok: true }
    }

    /** The slot's current generation finished its work (loop returned "done"). Idempotent; stale gens rejected. */
    async markDone(slot: string, gen: number): Promise<Ok | Fail<"not_found" | "stale_generation">> {
        const s = getSlot(this, slot)
        if (!s) return { ok: false, reason: "not_found" }
        if (s.gen !== gen) return { ok: false, reason: "stale_generation" }
        fleetDb(this).exec("INSERT OR REPLACE INTO slot_done (slot, gen, ts) VALUES (?, ?, ?)", slot, gen, now())
        this.roster = rosterOf(this, this.run)
        return { ok: true }
    }

    /** Clears the done marker (the slot was given more work, e.g. a reassigned function). Idempotent. */
    async clearDone(slot: string): Promise<Ok> {
        fleetDb(this).exec("DELETE FROM slot_done WHERE slot = ?", slot)
        this.roster = rosterOf(this, this.run)
        return { ok: true }
    }

    /** Records that function `fn` (of a failed slot) is now owned by `toSlot`. Idempotent per fn (last write wins). */
    async reassign(fn: string, toSlot: string, fromSlot: string): Promise<Ok> {
        fleetDb(this).exec("INSERT OR REPLACE INTO reassignments (fn, to_slot, from_slot, ts) VALUES (?, ?, ?, ?)", fn, toSlot, fromSlot, now())
        return { ok: true }
    }

    async snapshot(): Promise<{ run: RunInfo | null; slots: SlotSummary[]; history: SlotHistory[]; reassignments: Reassignment[] }> {
        const db = fleetDb(this)
        return {
            run: this.run,
            reassignments: db.exec("SELECT * FROM reassignments ORDER BY ts, fn").map(r => ({
                fn: str(r.fn),
                toSlot: str(r.to_slot),
                fromSlot: str(r.from_slot),
                ts: num(r.ts),
            })),
            slots: db.exec(`${SLOT_SELECT} ORDER BY s.slot`).map(slotFromRow),
            history: db.exec("SELECT * FROM slot_history ORDER BY slot, gen").map(r => ({
                slot: str(r.slot),
                gen: num(r.gen),
                status: str(r.status) as SlotStatus,
                reason: optStr(r.reason),
                endedAt: num(r.ended_at),
            })),
        }
    }
}

// ======================================================================
// Agent: agent.<runId>.<slot>.g<gen> — one generation of one slot
// ======================================================================

export type TokenTotals = { input: number; cached: number; output: number; reasoning: number; usd: number }
export type AgentInfo = {
    runId: string
    slot: string
    gen: number
    task: string
    persona: string
    relayName: string | null
    relayToken: string | null
    handoff: Record<string, unknown> | null
    createdAt: number
}
export type StepInput = {
    step: number
    summary: string
    claims?: string[]
    usage?: Partial<TokenTotals>
}
export type StepRecord = { step: number; summary: string; claims: string[]; ts: number }
export type Checkpoint = { fn: string; code: string; ts: number }
type AgentWriteFail = Fail<"not_initialized" | "stale_generation" | "closed">

const AGENT_DDL = [
    `CREATE TABLE IF NOT EXISTS steps (step INTEGER PRIMARY KEY, summary TEXT NOT NULL, claims TEXT NOT NULL, ts INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS checkpoints (fn TEXT PRIMARY KEY, code TEXT NOT NULL, ts INTEGER NOT NULL)`,
]

const agentDb = (a: Agent) => ensure(a, a.db, AGENT_DDL)
function guard(info: AgentInfo | null, closed: unknown, gen: number): AgentWriteFail | null {
    if (!info) return { ok: false, reason: "not_initialized" }
    if (gen !== info.gen) return { ok: false, reason: "stale_generation" }
    if (closed) return { ok: false, reason: "closed" }
    return null
}

export class Agent extends Actor {
    @Persisted private info: AgentInfo | null = null
    @Persisted private closed: { at: number; reason: string } | null = null
    @Persisted private totals: TokenTotals = { input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 }


    /** Idempotent: a repeat call keeps the original info. */
    async init(input: {
        runId: string
        slot: string
        gen: number
        task: string
        persona: string
        relayName?: string
        relayToken?: string
        handoff?: Record<string, unknown>
    }): Promise<AgentInfo> {
        if (!this.info) {
            this.info = {
                runId: input.runId,
                slot: input.slot,
                gen: input.gen,
                task: input.task,
                persona: input.persona,
                relayName: input.relayName ?? null,
                relayToken: input.relayToken ?? null,
                handoff: input.handoff ?? null,
                createdAt: now(),
            }
        }
        return this.info
    }

    async setRelay(gen: number, relayName: string, relayToken: string): Promise<Ok | AgentWriteFail> {
        const bad = guard(this.info, this.closed, gen)
        if (bad) return bad
        this.info = { ...this.info!, relayName, relayToken }
        return { ok: true }
    }

    /** Idempotent on step number; usage is added only on first insert. */
    async appendStep(gen: number, step: StepInput): Promise<Ok<{ created: boolean }> | AgentWriteFail> {
        const bad = guard(this.info, this.closed, gen)
        if (bad) return bad
        const db = agentDb(this)
        if (db.exec("SELECT 1 FROM steps WHERE step = ?", step.step).length > 0) return { ok: true, created: false }
        db.exec("INSERT INTO steps (step, summary, claims, ts) VALUES (?, ?, ?, ?)", step.step, step.summary, JSON.stringify(step.claims ?? []), now())
        const u = step.usage ?? {}
        const t = this.totals
        this.totals = {
            input: t.input + (u.input ?? 0),
            cached: t.cached + (u.cached ?? 0),
            output: t.output + (u.output ?? 0),
            reasoning: t.reasoning + (u.reasoning ?? 0),
            usd: t.usd + (u.usd ?? 0),
        }
        return { ok: true, created: true }
    }

    /** Verified function (tests passed). Upsert on fn name. */
    async checkpoint(gen: number, fn: string, code: string): Promise<Ok | AgentWriteFail> {
        const bad = guard(this.info, this.closed, gen)
        if (bad) return bad
        agentDb(this).exec(
            "INSERT INTO checkpoints (fn, code, ts) VALUES (?, ?, ?) ON CONFLICT(fn) DO UPDATE SET code = excluded.code, ts = excluded.ts",
            fn,
            code,
            now(),
        )
        return { ok: true }
    }

    /** Retire step 2: after this every write from this generation is rejected. Idempotent. */
    async close(gen: number, reason: string): Promise<Ok | Fail<"not_initialized" | "stale_generation">> {
        if (!this.info) return { ok: false, reason: "not_initialized" }
        if (gen !== this.info.gen) return { ok: false, reason: "stale_generation" }
        if (!this.closed) this.closed = { at: now(), reason }
        return { ok: true }
    }

    /** Verified-only handoff for the next generation. */
    async handoff(): Promise<{ task: string; checkpoints: Checkpoint[]; lastStep: number } | null> {
        if (!this.info) return null
        const db = agentDb(this)
        return {
            task: this.info.task,
            checkpoints: db.exec("SELECT * FROM checkpoints ORDER BY fn").map(r => ({ fn: str(r.fn), code: str(r.code), ts: num(r.ts) })),
            lastStep: num(db.exec("SELECT MAX(step) AS m FROM steps")[0]?.m),
        }
    }

    async state(): Promise<{
        info: AgentInfo | null
        closed: { at: number; reason: string } | null
        totals: TokenTotals
        steps: StepRecord[]
        checkpoints: Checkpoint[]
    }> {
        const db = agentDb(this)
        return {
            info: this.info,
            closed: this.closed,
            totals: this.totals,
            steps: db.exec("SELECT * FROM steps ORDER BY step").map(r => ({
                step: num(r.step),
                summary: str(r.summary),
                claims: json<string[]>(r.claims, []),
                ts: num(r.ts),
            })),
            checkpoints: db.exec("SELECT * FROM checkpoints ORDER BY fn").map(r => ({ fn: str(r.fn), code: str(r.code), ts: num(r.ts) })),
        }
    }
}

// ======================================================================
// CaseLibrary: cases.<libraryId>
// ======================================================================

export type CaseInput = {
    id: string // <runId>.<slot>.g<gen>
    runId: string
    slot: string
    gen: number
    category: string
    claim: string
    evidence: Record<string, unknown>
    lesson: string
    driftTrace?: number[]
    embedding?: number[]
    synthetic?: boolean
}
export type CaseFile = Omit<CaseInput, "embedding" | "driftTrace" | "synthetic"> & {
    driftTrace: number[]
    embedding: number[] | null
    synthetic: boolean
    revoked: boolean
    revokedReason: string | null
    receivers: string[]
    replies: CaseReplyRow[]
    /** Delivery (warden post + recipients) finished (markBroadcast). */
    broadcast: boolean
    /** Relay message id of the warden's case post (thread root), when broadcast. */
    rootMessageId: string | null
    createdAt: number
}
export type CaseReplyRow = { from: string; slot: number; gen: number; text: string; ts: number; seq: number }

const CASE_DDL = [
    `CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, slot TEXT NOT NULL, gen INTEGER NOT NULL, category TEXT NOT NULL,
        claim TEXT NOT NULL, evidence TEXT NOT NULL, lesson TEXT NOT NULL, drift_trace TEXT NOT NULL, embedding TEXT,
        synthetic INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, revoked_reason TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS case_receivers (case_id TEXT NOT NULL, agent_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (case_id, agent_id))`,
    `CREATE TABLE IF NOT EXISTS case_replies (case_id TEXT NOT NULL, from_agent TEXT NOT NULL, slot INTEGER NOT NULL, gen INTEGER NOT NULL,
        text TEXT NOT NULL, ts INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (case_id, from_agent))`,
    `CREATE TABLE IF NOT EXISTS case_broadcast (case_id TEXT PRIMARY KEY, root_message_id TEXT, ts INTEGER NOT NULL)`,
]

const caseDb = (a: CaseLibrary) => ensure(a, a.db, CASE_DDL)
function broadcastOf(a: CaseLibrary, id: string): { broadcast: boolean; rootMessageId: string | null } {
    const b = caseDb(a).exec("SELECT root_message_id FROM case_broadcast WHERE case_id = ?", id)[0]
    return { broadcast: !!b, rootMessageId: b ? optStr(b.root_message_id) : null }
}
function toCase(a: CaseLibrary, r: Row, withEmbedding: boolean): CaseFile {
        const id = str(r.id)
        return {
            id,
            runId: str(r.run_id),
            slot: str(r.slot),
            gen: num(r.gen),
            category: str(r.category),
            claim: str(r.claim),
            evidence: json<Record<string, unknown>>(r.evidence, {}),
            lesson: str(r.lesson),
            driftTrace: json<number[]>(r.drift_trace, []),
            embedding: withEmbedding ? json<number[] | null>(r.embedding, null) : null,
            synthetic: num(r.synthetic) === 1,
            revoked: num(r.revoked) === 1,
            revokedReason: optStr(r.revoked_reason),
            receivers: caseDb(a)
                .exec("SELECT agent_id FROM case_receivers WHERE case_id = ? ORDER BY ts", id)
                .map(x => str(x.agent_id)),
            replies: caseDb(a)
                .exec("SELECT * FROM case_replies WHERE case_id = ? ORDER BY ts", id)
                .map(x => ({ from: str(x.from_agent), slot: num(x.slot), gen: num(x.gen), text: str(x.text), ts: num(x.ts), seq: num(x.seq) })),
            ...broadcastOf(a, id),
            createdAt: num(r.created_at),
        }
    }

export class CaseLibrary extends Actor {
    /** Idempotent on case id: a repeat call is a no-op. */
    async add(c: CaseInput): Promise<Ok<{ created: boolean }>> {
        const db = caseDb(this)
        if (db.exec("SELECT 1 FROM cases WHERE id = ?", c.id).length > 0) return { ok: true, created: false }
        db.exec(
            `INSERT INTO cases (id, run_id, slot, gen, category, claim, evidence, lesson, drift_trace, embedding, synthetic, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            c.id,
            c.runId,
            c.slot,
            c.gen,
            c.category,
            c.claim,
            JSON.stringify(c.evidence),
            c.lesson,
            JSON.stringify(c.driftTrace ?? []),
            c.embedding ? JSON.stringify(c.embedding) : null,
            c.synthetic ? 1 : 0,
            now(),
        )
        return { ok: true, created: true }
    }

    async list(opts?: { includeRevoked?: boolean; withEmbeddings?: boolean; limit?: number }): Promise<CaseFile[]> {
        const where = opts?.includeRevoked ? "" : "WHERE revoked = 0"
        return caseDb(this)
            .exec(`SELECT * FROM cases ${where} ORDER BY created_at, id LIMIT ?`, opts?.limit ?? 1000)
            .map(r => toCase(this, r, opts?.withEmbeddings ?? false))
    }

    async get(id: string): Promise<CaseFile | null> {
        const r = caseDb(this).exec("SELECT * FROM cases WHERE id = ?", id)[0]
        return r ? toCase(this, r, true) : null
    }

    async markReceived(caseId: string, agentId: string): Promise<Ok<{ created: boolean }> | Fail<"not_found">> {
        const db = caseDb(this)
        if (db.exec("SELECT 1 FROM cases WHERE id = ?", caseId).length === 0) return { ok: false, reason: "not_found" }
        const before = db.exec("SELECT 1 FROM case_receivers WHERE case_id = ? AND agent_id = ?", caseId, agentId).length
        if (!before) db.exec("INSERT INTO case_receivers (case_id, agent_id, ts) VALUES (?, ?, ?)", caseId, agentId, now())
        return { ok: true, created: !before }
    }

    /** Idempotent on (caseId, from): one reply per agent per case. */
    async addReply(caseId: string, r: CaseReplyRow): Promise<Ok<{ created: boolean }> | Fail<"not_found">> {
        const db = caseDb(this)
        if (db.exec("SELECT 1 FROM cases WHERE id = ?", caseId).length === 0) return { ok: false, reason: "not_found" }
        const before = db.exec("SELECT 1 FROM case_replies WHERE case_id = ? AND from_agent = ?", caseId, r.from).length
        if (!before)
            db.exec(
                "INSERT INTO case_replies (case_id, from_agent, slot, gen, text, ts, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
                caseId, r.from, r.slot, r.gen, r.text, r.ts, r.seq,
            )
        return { ok: true, created: !before }
    }

    /** Marks delivery finished and stores the thread root id. Idempotent: the first root id is kept. */
    async markBroadcast(caseId: string, rootMessageId: string | null): Promise<Ok<{ created: boolean }> | Fail<"not_found">> {
        const db = caseDb(this)
        if (db.exec("SELECT 1 FROM cases WHERE id = ?", caseId).length === 0) return { ok: false, reason: "not_found" }
        const before = db.exec("SELECT root_message_id FROM case_broadcast WHERE case_id = ?", caseId)[0]
        if (!before) db.exec("INSERT INTO case_broadcast (case_id, root_message_id, ts) VALUES (?, ?, ?)", caseId, rootMessageId, now())
        else if (before.root_message_id === null && rootMessageId) db.exec("UPDATE case_broadcast SET root_message_id = ? WHERE case_id = ?", rootMessageId, caseId)
        return { ok: true, created: !before }
    }

    async revoke(id: string, reason: string): Promise<Ok | Fail<"not_found">> {
        const db = caseDb(this)
        if (db.exec("SELECT 1 FROM cases WHERE id = ?", id).length === 0) return { ok: false, reason: "not_found" }
        db.exec("UPDATE cases SET revoked = 1, revoked_reason = COALESCE(revoked_reason, ?) WHERE id = ?", reason, id)
        return { ok: true }
    }
}

// ======================================================================
// ReasoningStore: chunks.<runId> — verified reasoning shared between agents
// ======================================================================

export type ChunkInput = {
    id: string
    sourceAgent: string
    slot: string
    gen: number
    step: number
    fn?: string
    text: string
    embedding?: number[]
    estTokens?: number // labeled "est." on the dashboard
}
export type Chunk = Required<Omit<ChunkInput, "embedding" | "fn">> & {
    fn: string | null
    embedding: number[] | null
    revoked: boolean
    reusers: string[]
    createdAt: number
}

const CHUNK_DDL = [
    `CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, source_agent TEXT NOT NULL, slot TEXT NOT NULL, gen INTEGER NOT NULL, step INTEGER NOT NULL,
        fn TEXT, text TEXT NOT NULL, embedding TEXT, est_tokens INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS reuse (chunk_id TEXT NOT NULL, agent_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (chunk_id, agent_id))`,
]

const chunkDb = (a: ReasoningStore) => ensure(a, a.db, CHUNK_DDL)

export class ReasoningStore extends Actor {
    async add(c: ChunkInput): Promise<Ok<{ created: boolean }>> {
        const db = chunkDb(this)
        if (db.exec("SELECT 1 FROM chunks WHERE id = ?", c.id).length > 0) return { ok: true, created: false }
        db.exec(
            `INSERT INTO chunks (id, source_agent, slot, gen, step, fn, text, embedding, est_tokens, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            c.id,
            c.sourceAgent,
            c.slot,
            c.gen,
            c.step,
            c.fn ?? null,
            c.text,
            c.embedding ? JSON.stringify(c.embedding) : null,
            c.estTokens ?? 0,
            now(),
        )
        return { ok: true, created: true }
    }

    /** Idempotent per (chunk, agent). Revoked chunks cannot be reused. */
    async markReused(chunkId: string, agentId: string): Promise<Ok<{ created: boolean }> | Fail<"not_found" | "revoked">> {
        const db = chunkDb(this)
        const c = db.exec("SELECT revoked FROM chunks WHERE id = ?", chunkId)[0]
        if (!c) return { ok: false, reason: "not_found" }
        if (num(c.revoked) === 1) return { ok: false, reason: "revoked" }
        const before = db.exec("SELECT 1 FROM reuse WHERE chunk_id = ? AND agent_id = ?", chunkId, agentId).length
        if (!before) db.exec("INSERT INTO reuse (chunk_id, agent_id, ts) VALUES (?, ?, ?)", chunkId, agentId, now())
        return { ok: true, created: !before }
    }

    async revoke(chunkId: string): Promise<Ok | Fail<"not_found">> {
        const db = chunkDb(this)
        if (db.exec("SELECT 1 FROM chunks WHERE id = ?", chunkId).length === 0) return { ok: false, reason: "not_found" }
        db.exec("UPDATE chunks SET revoked = 1 WHERE id = ?", chunkId)
        return { ok: true }
    }

    async list(opts?: { includeRevoked?: boolean; withEmbeddings?: boolean }): Promise<Chunk[]> {
        const db = chunkDb(this)
        const where = opts?.includeRevoked ? "" : "WHERE revoked = 0"
        return db.exec(`SELECT * FROM chunks ${where} ORDER BY created_at, id`).map(r => ({
            id: str(r.id),
            sourceAgent: str(r.source_agent),
            slot: str(r.slot),
            gen: num(r.gen),
            step: num(r.step),
            fn: optStr(r.fn),
            text: str(r.text),
            estTokens: num(r.est_tokens),
            embedding: opts?.withEmbeddings ? json<number[] | null>(r.embedding, null) : null,
            revoked: num(r.revoked) === 1,
            reusers: db.exec("SELECT agent_id FROM reuse WHERE chunk_id = ? ORDER BY ts", str(r.id)).map(x => str(x.agent_id)),
            createdAt: num(r.created_at),
        }))
    }
}

// ======================================================================
// Ledger: ledger.<runId> — one row per API call, from usage fields only
// ======================================================================

export type LedgerCategory =
    | "worker"
    | "jev"
    | "fallback_judge"
    | "embedding"
    | "lesson_writer"
    | "case_discussion"
    | "reuse_est" // estimate rows: NOT spend, never counted in usd/tokens
export type LedgerEntry = {
    id: string // <runId>.<slot>.g<gen>.s<step>.<n>
    category: LedgerCategory
    model: string
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    reasoning_tokens: number
    usd: number
    slot?: string
    gen?: number
    step?: number
    ts?: number
    mock?: boolean
}
export type LedgerTotals = {
    worker_usd: number
    overhead_usd: number
    by_category: Record<string, { calls: number; usd: number; input?: number; cached?: number; output?: number; reasoning?: number }>
    calls: { jev: number; fallback: number }
    tokens: { input: number; cached: number; output: number; reasoning: number }
    reuse_est_tokens: number
    rows: number
    mock_rows: number
    updatedAt: number
}

const LEDGER_DDL = [
    `CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, usd REAL NOT NULL, slot TEXT, gen INTEGER, step INTEGER,
        ts INTEGER NOT NULL, mock INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS entries_category ON entries (category)`,
]

const emptyTotals = (): LedgerTotals => ({
    worker_usd: 0,
    overhead_usd: 0,
    by_category: {},
    calls: { jev: 0, fallback: 0 },
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
    reuse_est_tokens: 0,
    rows: 0,
    mock_rows: 0,
    updatedAt: 0,
})

function computeTotals(a: Ledger): LedgerTotals {
        const db = ensure(a, a.db, LEDGER_DDL)
        const t = emptyTotals()
        for (const r of db.exec(
            `SELECT category, COUNT(*) AS calls, SUM(usd) AS usd, SUM(input_tokens) AS i, SUM(cached_input_tokens) AS c,
             SUM(output_tokens) AS o, SUM(reasoning_tokens) AS rz, SUM(mock) AS m FROM entries GROUP BY category`,
        )) {
            const cat = str(r.category)
            t.rows += num(r.calls)
            t.mock_rows += num(r.m)
            if (cat === "reuse_est") {
                t.reuse_est_tokens += num(r.i)
                continue
            }
            t.by_category[cat] = { calls: num(r.calls), usd: num(r.usd), input: num(r.i), cached: num(r.c), output: num(r.o), reasoning: num(r.rz) }
            if (cat === "worker") t.worker_usd += num(r.usd)
            else t.overhead_usd += num(r.usd)
            if (cat === "jev") t.calls.jev += num(r.calls)
            if (cat === "fallback_judge") t.calls.fallback += num(r.calls)
            t.tokens.input += num(r.i)
            t.tokens.cached += num(r.c)
            t.tokens.output += num(r.o)
            t.tokens.reasoning += num(r.rz)
        }
        t.updatedAt = now()
        return t
    }

export class Ledger extends Actor {
    @Emittable @Persisted summary: LedgerTotals = emptyTotals()

    /** Idempotent on entry id. */
    async record(e: LedgerEntry): Promise<Ok<{ created: boolean }>> {
        const db = ensure(this, this.db, LEDGER_DDL)
        if (db.exec("SELECT 1 FROM entries WHERE id = ?", e.id).length > 0) return { ok: true, created: false }
        db.exec(
            `INSERT INTO entries (id, category, model, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, usd, slot, gen, step, ts, mock)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            e.id,
            e.category,
            e.model,
            e.input_tokens,
            e.cached_input_tokens,
            e.output_tokens,
            e.reasoning_tokens,
            e.category === "reuse_est" ? 0 : e.usd,
            e.slot ?? null,
            e.gen ?? null,
            e.step ?? null,
            e.ts ?? now(),
            e.mock ? 1 : 0,
        )
        this.summary = computeTotals(this)
        return { ok: true, created: true }
    }

    async totals(): Promise<LedgerTotals> {
        return computeTotals(this)
    }

    /** Highest n among ids `<prefix>.<n>` (0 if none). Lets a restarted writer continue numbering a step's calls. */
    async maxIndex(prefix: string): Promise<number> {
        const db = ensure(this, this.db, LEDGER_DDL)
        const head = `${prefix}.`
        let max = 0
        for (const r of db.exec("SELECT id FROM entries WHERE substr(id, 1, ?) = ?", head.length, head)) {
            const rest = str(r.id).slice(head.length)
            if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest))
        }
        return max
    }

    async list(opts?: { category?: LedgerCategory; limit?: number }): Promise<LedgerEntry[]> {
        const db = ensure(this, this.db, LEDGER_DDL)
        const rows = opts?.category
            ? db.exec("SELECT * FROM entries WHERE category = ? ORDER BY ts, id LIMIT ?", opts.category, opts.limit ?? 1000)
            : db.exec("SELECT * FROM entries ORDER BY ts, id LIMIT ?", opts?.limit ?? 1000)
        return rows.map(r => ({
            id: str(r.id),
            category: str(r.category) as LedgerCategory,
            model: str(r.model),
            input_tokens: num(r.input_tokens),
            cached_input_tokens: num(r.cached_input_tokens),
            output_tokens: num(r.output_tokens),
            reasoning_tokens: num(r.reasoning_tokens),
            usd: num(r.usd),
            ...(r.slot !== null ? { slot: str(r.slot) } : {}),
            ...(r.gen !== null ? { gen: num(r.gen) } : {}),
            ...(r.step !== null ? { step: num(r.step) } : {}),
            ts: num(r.ts),
            mock: num(r.mock) === 1,
        }))
    }
}

// ======================================================================
// SwarmShard: swarm.<runId>.<n> — many simulated agents as SQLite rows (DECISIONS #6)
// ======================================================================

export type SwarmChange = {
    id: string // idempotency key
    agentId: string
    gen: number
    kind: "step" | "status" | "retire"
    status?: SlotStatus
}
export type SwarmStats = {
    agents: number
    byStatus: Record<string, number>
    handled: number
    rejected: number
    duplicates: number
}

const SWARM_DDL = [
    `CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, gen INTEGER NOT NULL, status TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS applied (id TEXT PRIMARY KEY, outcome TEXT NOT NULL)`,
]

export class SwarmShard extends Actor {
    @Persisted private counts: { handled: number; rejected: number; duplicates: number } = { handled: 0, rejected: 0, duplicates: 0 }


    /** Creates agents `<prefix>.<i>` for i in [0, count). Idempotent. */
    async seed(prefix: string, count: number): Promise<{ agents: number }> {
        const db = ensure(this, this.db, SWARM_DDL)
        await this.db.transaction(async () => {
            for (let i = 0; i < count; i++)
                db.exec("INSERT OR IGNORE INTO agents (id, gen, status, updated_at) VALUES (?, 1, 'trusted', ?)", `${prefix}.${i}`, now())
        })
        return { agents: num(db.exec("SELECT COUNT(*) AS n FROM agents")[0]?.n) }
    }

    /** Idempotent per change id; stale-generation or unknown-agent changes are rejected. */
    async applyBatch(changes: SwarmChange[]): Promise<{ handled: number; rejected: number; duplicates: number }> {
        const db = ensure(this, this.db, SWARM_DDL)
        const out = { handled: 0, rejected: 0, duplicates: 0 }
        await this.db.transaction(async () => {
            for (const c of changes) {
                if (db.exec("SELECT 1 FROM applied WHERE id = ?", c.id).length > 0) {
                    out.duplicates++
                    continue
                }
                const a = db.exec("SELECT gen, status FROM agents WHERE id = ?", c.agentId)[0]
                let ok = !!a && num(a.gen) === c.gen && str(a.status) !== "retired" && str(a.status) !== "failed"
                if (ok && c.kind === "step") db.exec("UPDATE agents SET steps = steps + 1, updated_at = ? WHERE id = ?", now(), c.agentId)
                else if (ok && c.kind === "status" && c.status && c.status !== "retiring" && c.status !== "retired")
                    db.exec("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?", c.status, now(), c.agentId)
                else if (ok && c.kind === "retire")
                    db.exec("UPDATE agents SET gen = gen + 1, status = 'probation', steps = 0, updated_at = ? WHERE id = ?", now(), c.agentId)
                else ok = false
                db.exec("INSERT INTO applied (id, outcome) VALUES (?, ?)", c.id, ok ? "handled" : "rejected")
                if (ok) out.handled++
                else out.rejected++
            }
            this.counts = {
                handled: this.counts.handled + out.handled,
                rejected: this.counts.rejected + out.rejected,
                duplicates: this.counts.duplicates + out.duplicates,
            }
        })
        return out
    }

    async stats(): Promise<SwarmStats> {
        const db = ensure(this, this.db, SWARM_DDL)
        const byStatus: Record<string, number> = {}
        let agents = 0
        for (const r of db.exec("SELECT status, COUNT(*) AS n FROM agents GROUP BY status")) {
            byStatus[str(r.status)] = num(r.n)
            agents += num(r.n)
        }
        return { agents, byStatus, ...this.counts }
    }
}

// ======================================================================
// Counter: crash-test fixture
// ======================================================================

export class Counter extends Actor {
    @Persisted private value = 0

    async read(): Promise<number> {
        return this.value
    }

    async increment(by = 1): Promise<number> {
        this.value = this.value + by
        return this.value
    }
}

// ======================================================================
// RunIndex: runs.index — which runs exist, so a restarted orchestrator can find them (rule 3).
// One row per run; Fleet (run.<runId>) stays the source of truth for the run's state.
// ======================================================================

export type RunIndexEntry = {
    runId: string
    taskId: string
    mode: string
    libraryId: string
    model: string
    workDir: string
    startedAt: number
    /** Contract RunStatus as last written by the orchestrator. */
    status: string
    endedAt: number | null
    testsPassing: number | null
    testsTotal: number
}

const RUN_INDEX_DDL = [
    `CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, library_id TEXT NOT NULL, model TEXT NOT NULL,
        work_dir TEXT NOT NULL, started_at INTEGER NOT NULL, status TEXT NOT NULL, ended_at INTEGER, tests_passing INTEGER,
        tests_total INTEGER NOT NULL)`,
]

const runIndexFromRow = (r: Row): RunIndexEntry => ({
    runId: str(r.run_id),
    taskId: str(r.task_id),
    mode: str(r.mode),
    libraryId: str(r.library_id),
    model: str(r.model),
    workDir: str(r.work_dir),
    startedAt: num(r.started_at),
    status: str(r.status),
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : num(r.ended_at),
    testsPassing: r.tests_passing === null || r.tests_passing === undefined ? null : num(r.tests_passing),
    testsTotal: num(r.tests_total),
})

export class RunIndex extends Actor {
    /** Idempotent on runId: a repeat call keeps the original row. */
    async add(e: RunIndexEntry): Promise<Ok<{ created: boolean }>> {
        const db = ensure(this, this.db, RUN_INDEX_DDL)
        if (db.exec("SELECT 1 FROM runs WHERE run_id = ?", e.runId).length > 0) return { ok: true, created: false }
        db.exec(
            `INSERT INTO runs (run_id, task_id, mode, library_id, model, work_dir, started_at, status, ended_at, tests_passing, tests_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            e.runId,
            e.taskId,
            e.mode,
            e.libraryId,
            e.model,
            e.workDir,
            e.startedAt,
            e.status,
            e.endedAt,
            e.testsPassing,
            e.testsTotal,
        )
        return { ok: true, created: true }
    }

    /** Status change; ended runs keep their first endedAt (safe to repeat). */
    async setStatus(
        runId: string,
        status: string,
        endedAt?: number | null,
        testsPassing?: number | null,
    ): Promise<Ok | Fail<"not_found">> {
        const db = ensure(this, this.db, RUN_INDEX_DDL)
        if (db.exec("SELECT 1 FROM runs WHERE run_id = ?", runId).length === 0) return { ok: false, reason: "not_found" }
        db.exec(
            `UPDATE runs SET status = ?, ended_at = COALESCE(ended_at, ?), tests_passing = COALESCE(?, tests_passing) WHERE run_id = ?`,
            status,
            endedAt ?? null,
            testsPassing ?? null,
            runId,
        )
        return { ok: true }
    }

    async get(runId: string): Promise<RunIndexEntry | null> {
        const r = ensure(this, this.db, RUN_INDEX_DDL).exec("SELECT * FROM runs WHERE run_id = ?", runId)[0]
        return r ? runIndexFromRow(r) : null
    }

    /** Newest first. */
    async list(opts?: { limit?: number }): Promise<RunIndexEntry[]> {
        return ensure(this, this.db, RUN_INDEX_DDL)
            .exec("SELECT * FROM runs ORDER BY started_at DESC, run_id LIMIT ?", opts?.limit ?? 500)
            .map(runIndexFromRow)
    }
}

// ======================================================================
// FleetShard: fleetshard.<fleetRunId>.<n> — Fleet + Agent state for ~50 fleet-mode agents (DECISIONS #16)
// ======================================================================
// One actor per ~50 agents instead of one Agent actor per agent (DECISIONS #6/#13). The logic is ShardCore
// (fleet-shard-core.ts, shared with the orchestrator's in-memory shard); this class only backs its KV with
// SQLite. Every op keeps the Fleet/Agent generation guards and idempotency. fleetshard.index holds the
// fleet list, config, stats snapshots and Relay tokens (metaGet / metaSet).

const SHARD_DDL = [`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`]

export class FleetShard extends Actor {
    async call(op: ShardOp, args: unknown[]): Promise<unknown> {
        const db = ensure(this, this.db, SHARD_DDL)
        const kv = {
            get: (k: string) => {
                const r = db.exec("SELECT v FROM kv WHERE k = ?", k)[0]
                return r ? String(r.v) : undefined
            },
            set: (k: string, v: string) => void db.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, v),
            keys: (p: string) => db.exec("SELECT k FROM kv WHERE substr(k, 1, ?) = ?", p.length, p).map(r => String(r.k)),
        }
        return new ShardCore(kv).apply(op, args)
    }
}
