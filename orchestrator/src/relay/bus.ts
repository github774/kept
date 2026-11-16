// Relay layer (workstream B). Talks to the local Relaycast engine through @agent-relay/sdk,
// which works directly under Bun (smoke-tested; see docs/DECISIONS.md), so no Node bridge.
// Rules honored here: rule 5 (generation guard on every send), rule 6 (mock is labeled
// "MOCK" in every log line and on every message), rule 8 (thread reply cap, no reply-to-reply).
import { AgentRelay, type RelayAgentClient, type RelayMessage } from "@agent-relay/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RelayMeta {
  runId: string;
  slot: number;
  gen: number;
  caseId?: string;
  /** Message kind for the dashboard feed (contract RelayMetadata.kind). Added for herd.ts. */
  kind?: "status" | "case" | "case_reply" | "note" | "dm" | "revoke";
}

export interface BusMessage {
  /** Local, monotonically increasing sequence; inbox cursors use it. */
  seq: number;
  id: string;
  from: string;
  /** "#channel" or "@name". "@?" when a DM was observed but not sent through this bus. */
  to: string;
  text: string;
  threadId?: string;
  /** Set on thread replies: id of the message replied to. */
  parentId?: string;
  metadata: Partial<RelayMeta>;
  createdAt: string;
  /** True once the Relay listener has delivered this message back (proves server fan-out). */
  confirmed: boolean;
  mock: boolean;
}

export type GenCheck = (gen: number) => boolean | Promise<boolean>;

interface SendBase {
  fromName?: string;
  fromToken?: string;
  text: string;
  /** `<runId>.<slot>.g<gen>.s<step>`; a retry with the same key never posts twice. */
  idempotencyKey: string;
  metadata: RelayMeta;
  /** Caller's generation; must equal metadata.gen and pass isCurrentGen. */
  gen: number;
  isCurrentGen: GenCheck;
}
export interface SendInput extends SendBase {
  to: string;
}
export interface ReplyInput extends SendBase {
  messageId: string;
}

export interface RelayBus {
  readonly mock: boolean;
  ensureWorkspace(): Promise<void>;
  ensureChannel(name: string): Promise<void>;
  /** Create-only. Throws RelayNameConflictError on 409. Joins the given channels. */
  registerAgent(name: string, channels?: string[]): Promise<{ name: string; token: string }>;
  /** Rehydrate an identity from a stored token (e.g. after an orchestrator restart). */
  reconnect(token: string, channels?: string[]): Promise<{ name: string }>;
  send(input: SendInput): Promise<BusMessage>;
  reply(input: ReplyInput): Promise<BusMessage>;
  /** Releases the identity; every later send from it is rejected locally. */
  release(name: string): Promise<void>;
  onMessage(cb: (m: BusMessage) => void): () => void;
  /** Messages addressed to `name` (DMs + its channels), excluding its own, with seq > sinceSeq. */
  inbox(name: string, sinceSeq: number, limit: number): BusMessage[];
  /** Every message this bus has seen, oldest first (in-process only). Added for herd.ts thread lookup. */
  history?(): readonly BusMessage[];
  /**
   * Reserves a seq from the same counter as BusMessage.seq without posting anything, for feed items that
   * never reach Relay (blocked messages), so feed seqs stay unique and monotonic. Added for herd.ts.
   */
  reserveSeq?(): number;
  /**
   * Adds an emoji reaction to a Relay message as `fromName` (a registered identity, normally the
   * run's warden). Used for the herd-immunity signals in reactions.ts (lesson adopted, message blocked).
   */
  react?(input: { fromName: string; messageId: string; emoji: string }): Promise<void>;
  close(): Promise<void>;
}

export class RelayNameConflictError extends Error {
  constructor(readonly agentName: string) {
    super(`Relay name already registered (409 name_conflict): ${agentName}`);
  }
}
export class RelayReleasedError extends Error {
  constructor(readonly agentName: string) {
    super(`Relay identity ${agentName} was released; send rejected`);
  }
}
export class StaleGenerationError extends Error {
  constructor(readonly gen: number) {
    super(`Send rejected: generation g${gen} is not current`);
  }
}
export class RelayCapError extends Error {}

export const relayNames = {
  fleet: (runId: string) => `fleet-${runId}`,
  cases: (runId: string) => `cases-${runId}`,
  warden: (runId: string) => `warden-${runId}`,
  agent: (runId: string, slot: number, gen: number) => `w${slot}-g${gen}-${runId}`,
  idempotencyKey: (runId: string, slot: number, gen: number, step: number) => `${runId}.${slot}.g${gen}.s${step}`,
};

export interface RelayBusOptions {
  baseUrl: string;
  /** JSON file holding {workspaceKey, adminToken}, one per engine (relayStateFileFor). Gitignored (.relay/). */
  stateFile: string;
  /** Old shared `.relay/workspace.json`; copied into stateFile once if it names this baseUrl and its key works. */
  legacyStateFile?: string;
  workspaceName: string;
  repliesPerThread: number;
  log?: (line: string) => void;
}

const ADMIN_NAME = "orchestrator";

interface WorkspaceState {
  baseUrl: string;
  workspaceKey: string;
  adminToken?: string;
  createdAt: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** Per-engine workspace state file: `<dir>/workspace-<port>.json` (host added for non-loopback engines). */
export function relayStateFileFor(dir: string, baseUrl: string): string {
  const u = new URL(baseUrl);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const host = LOOPBACK.has(u.hostname) ? "" : `${u.hostname.replace(/[^a-z0-9.-]/gi, "_")}-`;
  return join(dir, `workspace-${host}${port}.json`);
}

/** True when the engine at baseUrl accepts workspaceKey (GET /v1/workspace). Unreachable counts as false. */
export async function relayKeyWorks(baseUrl: string, workspaceKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/workspace`, { headers: { Authorization: `Bearer ${workspaceKey}` }, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One-time migration from the old shared `.relay/workspace.json`: copies it to stateFile when stateFile is
 * absent, the legacy file was written for this baseUrl, and its key still works. The legacy file is left
 * in place and never written again. Returns true when stateFile exists afterwards.
 */
export async function migrateLegacyRelayState(o: { baseUrl: string; stateFile: string; legacyStateFile?: string; log?: (line: string) => void }): Promise<boolean> {
  if (existsSync(o.stateFile)) return true;
  const legacy = o.legacyStateFile;
  if (!legacy || resolve(legacy) === resolve(o.stateFile) || !existsSync(legacy)) return false;
  let s: Partial<WorkspaceState>;
  try {
    s = JSON.parse(readFileSync(legacy, "utf8")) as Partial<WorkspaceState>;
  } catch {
    return false;
  }
  if (s.baseUrl !== o.baseUrl || !s.workspaceKey || !(await relayKeyWorks(o.baseUrl, s.workspaceKey))) return false;
  mkdirSync(dirname(o.stateFile), { recursive: true });
  try {
    writeFileSync(o.stateFile, JSON.stringify(s, null, 2), { mode: 0o600, flag: "wx" }); // wx: never clobber
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
  }
  o.log?.(`migrated workspace for ${o.baseUrl} from ${legacy} to ${o.stateFile}`);
  return true;
}

function errStatus(e: unknown): { status?: number; code?: string } {
  const o = (e ?? {}) as { status?: number; statusCode?: number; code?: string };
  return { status: o.status ?? o.statusCode, code: o.code };
}
const isConflict = (e: unknown) => {
  const { status, code } = errStatus(e);
  return status === 409 || code === "name_conflict" || code === "conflict";
};

/** Shared bookkeeping for the real and mock buses. */
abstract class BusCore {
  protected seq = 0;
  protected readonly byId = new Map<string, BusMessage>();
  protected readonly log_: BusMessage[] = [];
  protected readonly listeners = new Set<(m: BusMessage) => void>();
  protected readonly released = new Set<string>();
  /** channel name (no #) -> member names */
  protected readonly members = new Map<string, Set<string>>();
  abstract readonly mock: boolean;
  constructor(protected readonly opts: Pick<RelayBusOptions, "repliesPerThread" | "log">) {}

  protected log(line: string) {
    (this.opts.log ?? console.log)(`[relay${this.mock ? " MOCK" : ""}] ${line}`);
  }

  protected addMember(channel: string, name: string) {
    const set = this.members.get(channel) ?? new Set<string>();
    set.add(name);
    this.members.set(channel, set);
  }

  /** Record once by id; emit to subscribers only on first sighting. */
  protected record(m: Omit<BusMessage, "seq" | "mock" | "confirmed">, confirmed: boolean): BusMessage {
    const existing = this.byId.get(m.id);
    if (existing) {
      if (confirmed) existing.confirmed = true;
      return existing;
    }
    const msg: BusMessage = { ...m, seq: ++this.seq, confirmed, mock: this.mock };
    this.byId.set(msg.id, msg);
    this.log_.push(msg);
    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch (e) {
        this.log(`listener error: ${String(e)}`);
      }
    }
    return msg;
  }

  protected async guard(from: string, input: SendBase) {
    if (this.released.has(from)) throw new RelayReleasedError(from);
    if (input.metadata.gen !== input.gen) throw new StaleGenerationError(input.gen);
    if (!(await input.isCurrentGen(input.gen))) throw new StaleGenerationError(input.gen);
    if (!input.idempotencyKey) throw new Error("idempotencyKey is required");
  }

  /** Rule 8: never reply to a reply; at most repliesPerThread replies per thread. */
  protected checkThreadCap(parentId: string, parentIsReply: boolean, serverReplyCount: number) {
    if (parentIsReply) throw new RelayCapError(`Cannot reply to a reply (${parentId})`);
    const local = this.log_.filter((m) => m.parentId === parentId).length;
    if (Math.max(local, serverReplyCount) >= this.opts.repliesPerThread)
      throw new RelayCapError(`Thread ${parentId} is closed (${this.opts.repliesPerThread} replies)`);
  }

  onMessage(cb: (m: BusMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  history(): readonly BusMessage[] {
    return this.log_;
  }

  reserveSeq(): number {
    return ++this.seq;
  }

  inbox(name: string, sinceSeq: number, limit: number): BusMessage[] {
    const out: BusMessage[] = [];
    for (const m of this.log_) {
      if (m.seq <= sinceSeq || m.from === name) continue;
      const mine = m.to === `@${name}` || (m.to.startsWith("#") && this.members.get(m.to.slice(1))?.has(name));
      if (mine) out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  }
}

export class SdkRelayBus extends BusCore implements RelayBus {
  readonly mock = false;
  private relay?: AgentRelay;
  private admin?: RelayAgentClient;
  private readonly clients = new Map<string, RelayAgentClient>();
  private readonly channelsReady = new Set<string>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly o: RelayBusOptions) {
    super(o);
  }

  /** Throws when stateFile belongs to another engine: creating a workspace here would overwrite its key. */
  private readState(): WorkspaceState | undefined {
    if (!existsSync(this.o.stateFile)) return undefined;
    const s = JSON.parse(readFileSync(this.o.stateFile, "utf8")) as WorkspaceState;
    if (s.baseUrl !== this.o.baseUrl)
      throw new Error(`${this.o.stateFile} holds the workspace for ${s.baseUrl}, not ${this.o.baseUrl}; refusing to overwrite it (use relayStateFileFor)`);
    return s;
  }
  private writeState(s: WorkspaceState) {
    this.readState(); // ownership check right before writing
    mkdirSync(dirname(this.o.stateFile), { recursive: true });
    writeFileSync(this.o.stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  async ensureWorkspace(): Promise<void> {
    if (this.relay) return;
    let state = this.readState();
    if (!state && (await migrateLegacyRelayState({ ...this.o, log: (l) => this.log(l) }))) state = this.readState();
    if (!state) {
      const created = await AgentRelay.createWorkspace({ name: this.o.workspaceName, baseUrl: this.o.baseUrl });
      if (!created.workspaceKey) throw new Error("Relay createWorkspace returned no workspace key");
      state = { baseUrl: this.o.baseUrl, workspaceKey: created.workspaceKey, createdAt: new Date().toISOString() };
      this.writeState(state);
      this.log(`workspace created (${this.o.workspaceName}); key stored in ${this.o.stateFile}`);
    }
    this.relay = new AgentRelay({
      workspaceKey: state.workspaceKey,
      baseUrl: this.o.baseUrl,
      onError: (e) => this.log(`listener error: ${String(e)}`),
    });
    if (state.adminToken) {
      this.admin = await this.relay.workspace.reconnect({ apiToken: state.adminToken });
    } else {
      this.admin = await this.relay.workspace.register({ name: ADMIN_NAME, type: "agent" });
      this.writeState({ ...state, adminToken: this.admin.token });
    }
    this.clients.set(ADMIN_NAME, this.admin);
    for (const sel of ["message.created", "thread.reply", "dm.received"] as const)
      this.unsubs.push(this.relay.addListener(sel, ({ message, envelope }) => this.fromRelay(message, envelope.channel?.name)));
  }

  private fromRelay(m: RelayMessage, channel: string | undefined, deferred = false) {
    const known = this.byId.get(m.id);
    if (known) {
      known.confirmed = true;
      return;
    }
    // The listener can beat our own send() response; give the local record (which knows the
    // DM recipient and full metadata) a moment to land before recording a foreign message.
    if (!deferred) {
      setTimeout(() => this.fromRelay(m, channel, true), 300);
      return;
    }
    this.record(
      {
        id: m.id,
        from: m.from?.name ?? "?",
        to: channel ? `#${channel}` : "@?",
        text: m.text,
        threadId: m.threadId,
        parentId: m.parentId,
        metadata: (m.metadata ?? {}) as Partial<RelayMeta>,
        createdAt: m.createdAt ?? new Date().toISOString(),
      },
      true,
    );
  }

  private ready(): { relay: AgentRelay; admin: RelayAgentClient } {
    if (!this.relay || !this.admin) throw new Error("RelayBus: call ensureWorkspace() first");
    return { relay: this.relay, admin: this.admin };
  }

  async ensureChannel(name: string): Promise<void> {
    if (this.channelsReady.has(name)) return;
    const { admin } = this.ready();
    await admin.channels.create({ name }).catch((e: unknown) => {
      if (!isConflict(e)) throw e;
    });
    await admin.channels.join(name).catch(() => undefined);
    this.addMember(name, ADMIN_NAME);
    this.channelsReady.add(name);
  }

  private async joinAll(client: RelayAgentClient, channels: string[]) {
    for (const ch of channels) {
      await this.ensureChannel(ch);
      await client.channels.join(ch);
      this.addMember(ch, client.name);
    }
  }

  async registerAgent(name: string, channels: string[] = []) {
    const { relay } = this.ready();
    let client: RelayAgentClient;
    try {
      client = await relay.workspace.register({ name, type: "agent" });
    } catch (e) {
      if (isConflict(e)) throw new RelayNameConflictError(name);
      throw e;
    }
    if (!client.token) throw new Error(`Relay register returned no token for ${name}`);
    this.clients.set(name, client);
    await this.joinAll(client, channels);
    this.log(`registered ${name}`);
    return { name: client.name, token: client.token };
  }

  async reconnect(token: string, channels: string[] = []) {
    const { relay } = this.ready();
    const client = await relay.workspace.reconnect({ apiToken: token });
    this.clients.set(client.name, client);
    await this.joinAll(client, channels);
    this.log(`reconnected ${client.name}`);
    return { name: client.name };
  }

  private clientFor(input: SendBase): RelayAgentClient {
    const c = input.fromName
      ? this.clients.get(input.fromName)
      : [...this.clients.values()].find((x) => x.token === input.fromToken);
    if (!c) throw new Error(`RelayBus: unknown sender ${input.fromName ?? "(token)"}; register or reconnect first`);
    return c;
  }

  async send(input: SendInput): Promise<BusMessage> {
    const client = this.clientFor(input);
    await this.guard(client.name, input);
    if (!/^[#@]/.test(input.to)) throw new Error(`RelayBus: 'to' must start with # or @ (got ${input.to})`);
    const m = await client.sendMessage({
      to: input.to,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      metadata: { ...input.metadata },
    });
    return this.record(this.toBus(m, client.name, input.to, input.metadata), false);
  }

  async reply(input: ReplyInput): Promise<BusMessage> {
    const client = this.clientFor(input);
    await this.guard(client.name, input);
    const { relay } = this.ready();
    const parent = await relay.messages.get(input.messageId);
    const local = this.byId.get(input.messageId);
    const parentIsReply = Boolean(
      local?.parentId || [parent.parentId, parent.threadId].some((x) => x && x !== parent.id),
    );
    this.checkThreadCap(input.messageId, parentIsReply, parent.replyCount ?? 0);
    const m = await client.reply({
      messageId: input.messageId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      metadata: { ...input.metadata },
    });
    const to = this.byId.get(input.messageId)?.to ?? (parent.channel?.name ? `#${parent.channel.name}` : "@?");
    return this.record({ ...this.toBus(m, client.name, to, input.metadata), parentId: input.messageId }, false);
  }

  private toBus(m: RelayMessage, from: string, to: string, meta: RelayMeta): Omit<BusMessage, "seq" | "mock" | "confirmed"> {
    return {
      id: m.id,
      from,
      to,
      text: m.text,
      threadId: m.threadId,
      parentId: m.parentId,
      metadata: { ...meta },
      createdAt: m.createdAt ?? new Date().toISOString(),
    };
  }

  async react(input: { fromName: string; messageId: string; emoji: string }): Promise<void> {
    const c = this.clients.get(input.fromName);
    if (!c) throw new Error(`RelayBus: unknown reactor ${input.fromName}; register or reconnect first`);
    if (this.released.has(input.fromName)) throw new RelayReleasedError(input.fromName);
    await c.react({ messageId: input.messageId, emoji: input.emoji });
  }

  async release(name: string): Promise<void> {
    this.released.add(name); // local rejection first: the server keeps accepting sends after release
    this.clients.delete(name);
    const { relay } = this.ready();
    await relay.workspace.release({ name, reason: "retired" }).catch((e: unknown) => this.log(`release ${name}: ${String(e)}`));
    this.log(`released ${name}`);
  }

  async close(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }
}

/** In-memory bus. Every log line and message is labeled MOCK (rule 6). */
export class MockRelayBus extends BusCore implements RelayBus {
  readonly mock = true;
  private readonly names = new Map<string, string>(); // token -> name
  private readonly idem = new Map<string, BusMessage>();
  private n = 0;

  async ensureWorkspace() {
    this.log("using in-memory MOCK relay (no server)");
  }
  async ensureChannel(name: string) {
    if (!this.members.has(name)) this.members.set(name, new Set());
  }
  async registerAgent(name: string, channels: string[] = []) {
    if ([...this.names.values()].includes(name)) throw new RelayNameConflictError(name);
    const token = `mock_tok_${++this.n}`;
    this.names.set(token, name);
    for (const ch of channels) this.addMember(ch, name);
    return { name, token };
  }
  async reconnect(token: string, channels: string[] = []) {
    const name = this.names.get(token);
    if (!name) throw new Error("MOCK relay: unknown token");
    for (const ch of channels) this.addMember(ch, name);
    return { name };
  }
  private sender(i: SendBase) {
    const name = i.fromName ?? (i.fromToken ? this.names.get(i.fromToken) : undefined);
    if (!name) throw new Error("MOCK relay: unknown sender");
    return name;
  }
  private post(from: string, to: string, i: SendBase, parentId?: string) {
    const key = `${from}|${i.idempotencyKey}`;
    const dup = this.idem.get(key);
    if (dup) return dup;
    const msg = this.record(
      {
        id: `mock_${++this.n}`,
        from,
        to,
        text: i.text,
        parentId,
        threadId: parentId,
        metadata: { ...i.metadata },
        createdAt: new Date().toISOString(),
      },
      true,
    );
    this.idem.set(key, msg);
    return msg;
  }
  async send(i: SendInput) {
    const from = this.sender(i);
    await this.guard(from, i);
    return this.post(from, i.to, i);
  }
  async reply(i: ReplyInput) {
    const from = this.sender(i);
    await this.guard(from, i);
    const parent = this.byId.get(i.messageId);
    if (!parent) throw new Error(`MOCK relay: unknown message ${i.messageId}`);
    this.checkThreadCap(i.messageId, Boolean(parent.parentId), 0);
    return this.post(from, parent.to, i, i.messageId);
  }
  async release(name: string) {
    this.released.add(name);
    this.log(`released ${name}`);
  }
  /** MOCK reactions are logged only (labeled MOCK, rule 6). */
  readonly reactions: Array<{ fromName: string; messageId: string; emoji: string }> = [];
  async react(input: { fromName: string; messageId: string; emoji: string }) {
    if (!this.byId.has(input.messageId)) throw new Error(`MOCK relay: unknown message ${input.messageId}`);
    this.reactions.push({ ...input });
    this.log(`${input.fromName} reacted ${input.emoji} on ${input.messageId}`);
  }
  async close() {}
}

/** Reachability probe: the engine answers 404 JSON on unknown routes, so any HTTP reply counts. */
export async function relayReachable(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real bus when the engine answers; otherwise a labeled MOCK only if allowMock, else throw.
 * Never falls back silently.
 */
export async function createRelayBus(opts: RelayBusOptions & { allowMock: boolean }): Promise<RelayBus> {
  const bus: RelayBus = (await relayReachable(opts.baseUrl))
    ? new SdkRelayBus(opts)
    : opts.allowMock
      ? new MockRelayBus(opts)
      : (() => {
          throw new Error(`Relay engine not reachable at ${opts.baseUrl} (run scripts/relay-server.sh)`);
        })();
  await bus.ensureWorkspace();
  return bus;
}
