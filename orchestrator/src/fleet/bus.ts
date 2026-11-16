// FleetBus: the message transport for fleet-scale mode (1,000 agents). Implements the RelayBus interface
// the runtime already uses (herd.ts / reasoning.ts / retire.ts) with the same rules as the Relay buses:
// idempotency keys, released identities rejected, generation guard on every send (rule 5), no reply to a
// reply and at most repliesPerThread replies per thread (rule 8).
//
// Differences from SdkRelayBus / MockRelayBus, all for scale:
//  - Per-recipient mailboxes (inbox() is O(own messages), not O(all messages)).
//  - Membership is evaluated at post time (a respawned agent does not re-read old channel posts).
//  - `cc`: a channel post can also be delivered to named agents in other teams (fleet-wide case threads).
//    Replies to such a post reach the same cc list.
// Transport per message (`transportOf(seq)`):
//  - "relay": case posts (metadata.kind "case"), case-thread replies and ✅/🚫 reactions go to the real Agent
//    Relay server FIRST (through `remote`, behind the fleet Relay gate, <= 24 requests in flight: the local
//    engine crashed at 32-64), and the local copy carries the Relay message id. Low volume by design.
//  - "in-process": routine status/notes/DMs between teammates stay local (labelled on the feed).
// If Relay refuses or is down, the message is still delivered locally (counted in relayFailures).
import {
  RelayCapError,
  RelayNameConflictError,
  RelayReleasedError,
  StaleGenerationError,
  type BusMessage,
  type RelayBus,
  type ReplyInput,
  type SendInput,
} from "../relay/bus.ts";

export type FleetSendInput = SendInput & { cc?: string[] };

/** The real Relay side of the fleet bus: one fleet channel + fleet warden; repliers registered lazily. */
export interface FleetRelayRemote {
  bus: RelayBus;
  /** Gate for every Relay request (fleet limits.relay). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Relay channel for every fleet case thread, e.g. cases-<fleetRunId>. */
  channel: string;
  /** Relay identity that posts case files and reacts, e.g. warden-<fleetRunId>. */
  warden: string;
  /** Stored tokens (name -> token) so a restarted orchestrator reconnects instead of re-registering. */
  tokens: Map<string, string>;
  saveToken(name: string, token: string): void;
}

export class FleetBus implements RelayBus {
  readonly mock = false;
  readonly transport = "in-process" as const;
  private seq = 0;
  private n = 0;
  private readonly log_: BusMessage[] = [];
  private readonly byId = new Map<string, BusMessage>();
  private readonly idem = new Map<string, BusMessage>();
  private readonly tokens = new Map<string, string>(); // token -> name
  private readonly names = new Set<string>();
  private readonly released = new Set<string>();
  private readonly members = new Map<string, Set<string>>(); // channel -> names
  private readonly mailbox = new Map<string, BusMessage[]>(); // name -> messages (seq ascending)
  private readonly cc = new Map<string, string[]>(); // message id -> cc names
  private readonly replies = new Map<string, number>(); // parent id -> reply count
  private readonly listeners = new Set<(m: BusMessage) => void>();
  private readonly remoteSeqs = new Set<number>();
  private readonly remoteIds = new Set<string>();
  private readonly remoteReady = new Map<string, Promise<boolean>>();
  relayPosts = 0;
  relayFailures = 0;

  constructor(private readonly opts: { repliesPerThread: number; log?: (l: string) => void; remote?: FleetRelayRemote }) {}

  /** "relay" when the message went over the Agent Relay server, else "in-process". */
  transportOf(seq: number): "relay" | "in-process" {
    return this.remoteSeqs.has(seq) ? "relay" : "in-process";
  }

  /** Registers (or reconnects) `name` on Relay once, joined to the fleet case channel. */
  private ensureRemote(name: string): Promise<boolean> {
    const r = this.opts.remote;
    if (!r) return Promise.resolve(false);
    let p = this.remoteReady.get(name);
    if (!p) {
      p = (async () => {
        try {
          await r.run(() => r.bus.ensureChannel(r.channel));
          const tok = r.tokens.get(name);
          if (tok) await r.run(() => r.bus.reconnect(tok, [r.channel]));
          else {
            const reg = await r.run(() => r.bus.registerAgent(name, [r.channel]));
            r.tokens.set(name, reg.token);
            r.saveToken(name, reg.token);
          }
          return true;
        } catch (e) {
          this.relayFailures++;
          this.opts.log?.(`[fleetbus] Relay identity ${name} unavailable: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      })();
      this.remoteReady.set(name, p);
    }
    return p;
  }

  /** Posts to Relay first when the message belongs there; returns the Relay message id or null. */
  private async remotePost(kind: "send" | "reply", from: string, i: SendInput | ReplyInput, parentId?: string, dmTo?: string): Promise<string | null> {
    const r = this.opts.remote;
    if (!r) return null;
    const who = kind === "send" ? r.warden : from;
    if (!(await this.ensureRemote(who))) return null;
    if (dmTo && !(await this.ensureRemote(dmTo))) return null;
    try {
      const m =
        kind === "send"
          ? await r.run(() => r.bus.send({ ...i, fromName: who, to: dmTo ? `@${dmTo}` : `#${r.channel}`, isCurrentGen: () => true } as SendInput))
          : await r.run(() => r.bus.reply({ ...(i as ReplyInput), fromName: who, messageId: parentId! }));
      this.relayPosts++;
      this.remoteIds.add(m.id);
      return m.id;
    } catch (e) {
      if (e instanceof RelayCapError || e instanceof StaleGenerationError) throw e;
      this.relayFailures++;
      this.opts.log?.(`[fleetbus] Relay ${kind} failed, delivered in-process only: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** ✅ / 🚫 reactions: only on messages that exist on Relay, as the fleet warden. */
  async react(input: { fromName: string; messageId: string; emoji: string }): Promise<void> {
    const r = this.opts.remote;
    if (!r || !this.remoteIds.has(input.messageId)) throw new Error("not a Relay message (in-process only)");
    if (!r.bus.react) throw new Error("remote bus has no react()");
    if (!(await this.ensureRemote(r.warden))) throw new Error("Relay warden unavailable");
    await r.run(() => r.bus.react!({ fromName: r.warden, messageId: input.messageId, emoji: input.emoji }));
  }

  get size(): number {
    return this.log_.length;
  }

  async ensureWorkspace() {}
  async ensureChannel(name: string) {
    if (!this.members.has(name)) this.members.set(name, new Set());
  }
  private join(channels: string[], name: string) {
    for (const ch of channels) {
      const s = this.members.get(ch) ?? new Set<string>();
      s.add(name);
      this.members.set(ch, s);
    }
  }
  async registerAgent(name: string, channels: string[] = []) {
    if (this.names.has(name)) throw new RelayNameConflictError(name);
    this.names.add(name);
    const token = `fleet_tok_${++this.n}`;
    this.tokens.set(token, name);
    this.join(channels, name);
    return { name, token };
  }
  async reconnect(token: string, channels: string[] = []) {
    const name = this.tokens.get(token);
    if (!name) throw new Error("FleetBus: unknown token");
    this.join(channels, name);
    return { name };
  }
  async release(name: string) {
    this.released.add(name);
    for (const set of this.members.values()) set.delete(name);
  }

  private sender(i: { fromName?: string; fromToken?: string }) {
    const name = i.fromName ?? (i.fromToken ? this.tokens.get(i.fromToken) : undefined);
    if (!name || !this.names.has(name)) throw new Error(`FleetBus: unknown sender ${name ?? "(none)"}`);
    return name;
  }
  private async guard(from: string, i: SendInput | ReplyInput) {
    if (this.released.has(from)) throw new RelayReleasedError(from);
    if (i.metadata.gen !== i.gen) throw new StaleGenerationError(i.gen);
    if (!(await i.isCurrentGen(i.gen))) throw new StaleGenerationError(i.gen);
    if (!i.idempotencyKey) throw new Error("idempotencyKey is required");
  }

  private deliver(m: BusMessage, extra: string[]) {
    const to = new Set<string>();
    if (m.to.startsWith("@")) to.add(m.to.slice(1));
    else for (const n of this.members.get(m.to.slice(1)) ?? []) to.add(n);
    for (const n of extra) to.add(n);
    to.delete(m.from);
    for (const n of to) {
      if (m.to.startsWith("@") && !this.names.has(n)) continue;
      const box = this.mailbox.get(n) ?? [];
      box.push(m);
      this.mailbox.set(n, box);
    }
  }

  private post(from: string, to: string, i: SendInput | ReplyInput, parentId: string | undefined, cc: string[], remoteId: string | null = null): BusMessage {
    const key = `${from}|${i.idempotencyKey}`;
    const dup = this.idem.get(key);
    if (dup) return dup;
    if (to.startsWith("@") && !this.names.has(to.slice(1))) throw new Error(`FleetBus: recipient not found: ${to}`);
    const seq = ++this.seq;
    if (remoteId) this.remoteSeqs.add(seq);
    const m: BusMessage = {
      seq,
      id: remoteId ?? `fm_${seq}`,
      from,
      to,
      text: i.text,
      ...(parentId ? { parentId, threadId: parentId } : {}),
      metadata: { ...i.metadata },
      createdAt: new Date().toISOString(),
      confirmed: true,
      mock: false,
    };
    this.idem.set(key, m);
    this.byId.set(m.id, m);
    this.log_.push(m);
    if (cc.length) this.cc.set(m.id, cc);
    this.deliver(m, cc);
    for (const cb of this.listeners) {
      try {
        cb(m);
      } catch (e) {
        this.opts.log?.(`[fleetbus] listener error: ${String(e)}`);
      }
    }
    return m;
  }

  async send(i: FleetSendInput): Promise<BusMessage> {
    const from = this.sender(i);
    await this.guard(from, i);
    const dup = this.idem.get(`${from}|${i.idempotencyKey}`);
    if (dup) return dup;
    const { cc, ...rest } = i;
    // Case posts go to the fleet case channel on Relay; chunk revocations are Relay DMs to each reuser.
    const remoteId =
      i.metadata.kind === "case"
        ? await this.remotePost("send", from, rest)
        : i.metadata.kind === "revoke" && i.to.startsWith("@")
          ? await this.remotePost("send", from, rest, undefined, i.to.slice(1))
          : null;
    return this.post(from, i.to, i, undefined, cc ?? [], remoteId);
  }

  async reply(i: ReplyInput): Promise<BusMessage> {
    const from = this.sender(i);
    await this.guard(from, i);
    const dup = this.idem.get(`${from}|${i.idempotencyKey}`);
    if (dup) return dup;
    const parent = this.byId.get(i.messageId);
    const onRelay = this.remoteIds.has(i.messageId) || (!parent && !!this.opts.remote);
    if (!parent && !onRelay) throw new Error(`FleetBus: unknown message ${i.messageId}`);
    if (parent?.parentId) throw new RelayCapError(`Cannot reply to a reply (${i.messageId})`);
    const n = this.replies.get(i.messageId) ?? 0;
    if (n >= this.opts.repliesPerThread) throw new RelayCapError(`Thread ${i.messageId} is closed (${this.opts.repliesPerThread} replies)`);
    this.replies.set(i.messageId, n + 1); // reserve the slot before awaiting Relay: concurrent replies cannot both pass the cap
    // Thread on Relay (also after an orchestrator restart, when the root is no longer in this process).
    let remoteId: string | null;
    try {
      remoteId = onRelay ? await this.remotePost("reply", from, i, i.messageId) : null;
    } catch (e) {
      this.replies.set(i.messageId, (this.replies.get(i.messageId) ?? 1) - 1);
      throw e;
    }
    if (!parent && !remoteId) {
      this.replies.set(i.messageId, (this.replies.get(i.messageId) ?? 1) - 1);
      throw new Error(`FleetBus: unknown message ${i.messageId}`);
    }
    const to = parent?.to ?? `#${this.opts.remote!.channel}`;
    const m = this.post(from, to, i, i.messageId, [...(this.cc.get(i.messageId) ?? []), ...(parent ? [parent.from] : [])], remoteId);
    return m;
  }

  /** Replies posted under a thread root (rule 8 cap check in tests). */
  replyCount(parentId: string): number {
    return this.replies.get(parentId) ?? 0;
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
    const box = this.mailbox.get(name);
    if (!box?.length) return [];
    // binary search first seq > sinceSeq
    let lo = 0;
    let hi = box.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (box[mid]!.seq <= sinceSeq) lo = mid + 1;
      else hi = mid;
    }
    return box.slice(lo, lo + limit);
  }
  async close() {}
}
