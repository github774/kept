// Relay observer plane -> dashboard feed.
// Mints a read-only observer token (POST /v1/observer-tokens with the workspace key; scopes
// stream:read, messages:read, threads:read, dms:read, reactions:read; filters.include_dms) and runs
// `new AgentRelay({observerToken, sinceSeq, onCursor})`. The SDK backfills Relay's own durable,
// per-workspace event log (GET /v1/workspace/events) and then follows the live /v1/ws stream, so the
// feed is Relay's record of what happened, resumable by cursor across orchestrator restarts.
// Each message.created / thread.reply / dm.received / message.reacted becomes a "relay.message" item.
//
// Modes (RELAY_FEED_SOURCE):
//   "supplement" (default): items the herd already published (same sender + text, last 2 min) are
//      counted as `confirmed` and not re-published; everything else (messages missed while the
//      orchestrator was down, foreign senders, reactions) is published.
//   "observer": publish every observed message; pair with herd's own publishFeed turned off.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentRelay } from "@agent-relay/sdk";
import type { DashboardEvent, RelayFeedItem, RelayMetadata, SequencedEvent } from "../contract.ts";

export const OBSERVER_SCOPES = ["stream:read", "messages:read", "threads:read", "dms:read", "reactions:read"] as const;
/** Feed seqs for observer items start here so they never collide with RelayBus seqs. */
const SEQ_BASE = 1_000_000_000;
const DEDUPE_WINDOW_MS = 120_000;
const DEDUPE_WAIT_MS = 500;
/** Module-level so feed seqs stay unique even if an observer is restarted in-process. */
let feedSeq = SEQ_BASE;

export type ObserverMode = "supplement" | "observer";

export interface ObserverSink {
  publish(ev: DashboardEvent): unknown;
  subscribe(cb: (ev: SequencedEvent) => void): () => void;
}

export interface RelayObserverOptions {
  baseUrl: string;
  workspaceKey: string;
  events: ObserverSink;
  /** JSON file for {baseUrl, cursor, tokenId}. Gitignored (.relay/). Without it the cursor is in-memory. */
  stateFile?: string;
  mode?: ObserverMode;
  log?: (line: string) => void;
}

export interface ObserverHealth {
  started: boolean;
  connected: boolean;
  mode: ObserverMode;
  /** Last durable-log seq consumed (Relay's per-workspace sequence). */
  cursor: number | null;
  /** Relay's latest_seq right now (null when the engine did not answer). */
  latestSeq: number | null;
  /** latestSeq - cursor. */
  lag: number | null;
  resumedFrom: number | null;
  events: number;
  published: number;
  confirmed: number;
  reactions: number;
  unattributed: number;
  byType: Record<string, number>;
  lastEventAt: string | null;
  tokenId: string | null;
  error: string | null;
}

interface ObserverState {
  baseUrl: string;
  cursor: number;
  tokenId?: string;
}

interface Envelope {
  type?: string;
  message?: {
    id?: string;
    text?: string;
    from?: { name?: string };
    channel?: { name?: string };
    threadId?: string;
    parentId?: string;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    conversationId?: string;
  };
  messageId?: string;
  emoji?: string;
  agentName?: string;
  action?: string;
}

const KINDS = new Set(["status", "case", "case_reply", "note", "dm", "revoke"]);

/** runId from metadata, else from the per-run channel or identity name (fleet-<id>, w3-g2-<id>, warden-<id>). */
export function runIdOf(meta: Record<string, unknown> | null | undefined, channel?: string, from?: string): string | undefined {
  if (meta && typeof meta.runId === "string" && meta.runId) return meta.runId;
  const ch = channel?.match(/^(?:fleet|cases)-(.+)$/);
  if (ch) return ch[1];
  const who = from?.match(/^(?:w\d+-g\d+|warden)-(.+)$/);
  return who?.[1];
}

export class RelayObserver {
  private relay?: AgentRelay;
  private unsub?: () => void;
  private unsubSink?: () => void;
  private token?: { id: string; token: string };
  private cursor: number | null = null;
  private resumedFrom: number | null = null;
  private lastWrite = 0;
  private readonly mode: ObserverMode;
  private readonly recent = new Map<string, number>(); // `${from}|${text}` -> ts published by the herd
  private readonly seen = new Set<string>(); // relay message ids already handled
  private readonly textById = new Map<string, { text: string; runId?: string; channel?: string }>();
  private readonly stats = {
    events: 0,
    published: 0,
    confirmed: 0,
    reactions: 0,
    unattributed: 0,
    byType: {} as Record<string, number>,
    lastEventAt: null as string | null,
    error: null as string | null,
  };

  constructor(private readonly o: RelayObserverOptions) {
    this.mode = o.mode ?? "supplement";
  }

  private log(line: string) {
    (this.o.log ?? console.log)(`[relay-observer] ${line}`);
  }

  private async api<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.o.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: { message?: string } };
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${j.error?.message ?? ""}`.trim());
    return (j.data ?? j) as T;
  }

  private readState(): ObserverState | undefined {
    const f = this.o.stateFile;
    if (!f || !existsSync(f)) return undefined;
    try {
      const s = JSON.parse(readFileSync(f, "utf8")) as ObserverState;
      return s.baseUrl === this.o.baseUrl ? s : undefined;
    } catch {
      return undefined;
    }
  }
  private writeState(force = false) {
    const f = this.o.stateFile;
    if (!f || this.cursor === null) return;
    const now = Date.now();
    if (!force && now - this.lastWrite < 1000) return;
    this.lastWrite = now;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ baseUrl: this.o.baseUrl, cursor: this.cursor, tokenId: this.token?.id } satisfies ObserverState, null, 2), { mode: 0o600 });
  }

  /** Relay's latest durable-log seq, read with the observer token. */
  async latestSeq(): Promise<number | null> {
    if (!this.token) return null;
    try {
      const d = await this.api<{ latest_seq?: number }>("GET", "/v1/workspace/events?since=0&limit=1", this.token.token);
      return typeof d.latest_seq === "number" ? d.latest_seq : null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.relay) return;
    const prev = this.readState();
    // One live token per orchestrator: revoke the previous process's token before minting.
    if (prev?.tokenId) await this.api("DELETE", `/v1/observer-tokens/${encodeURIComponent(prev.tokenId)}`, this.o.workspaceKey).catch(() => undefined);
    this.token = await this.api<{ id: string; token: string }>("POST", "/v1/observer-tokens", this.o.workspaceKey, {
      name: `dashboard-observer-${process.pid}-${Date.now().toString(36)}`,
      description: "SmarterSubagents dashboard feed (read-only)",
      scopes: [...OBSERVER_SCOPES],
      filters: { include_dms: true },
    });
    if (!this.token?.token?.startsWith("ot_")) throw new Error("observer token mint returned no ot_ token");
    // Resume from the stored cursor; on a first start, begin at "now" instead of replaying every old run.
    const since = prev ? prev.cursor : ((await this.latestSeq()) ?? 0);
    this.cursor = since;
    this.resumedFrom = prev ? prev.cursor : null;

    this.unsubSink = this.o.events.subscribe((ev) => {
      if (ev.type !== "relay.message" || ev.item.seq >= SEQ_BASE) return;
      this.recent.set(`${ev.item.from}|${ev.item.text}`, Date.now());
    });
    this.relay = new AgentRelay({
      observerToken: this.token.token,
      baseUrl: this.o.baseUrl,
      sinceSeq: since,
      onCursor: (seq) => {
        this.cursor = seq;
        this.writeState();
      },
      onError: (e) => {
        this.stats.error = e instanceof Error ? e.message : String(e);
        this.log(`stream error: ${this.stats.error}`);
      },
    });
    this.unsub = this.relay.addListener("*", (ev) => this.onEvent(ev as unknown as Envelope));
    this.writeState(true);
    this.log(`streaming Relay's durable event log (token ${this.token.id}, ${prev ? `resumed after seq ${since}` : `from seq ${since}`}, mode ${this.mode})`);
  }

  private onEvent(ev: Envelope) {
    const type = ev.type ?? "?";
    this.stats.events++;
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    this.stats.lastEventAt = new Date().toISOString();
    this.stats.error = null;
    // Reactions wait out the dedupe delay too, so they land after the message they point at.
    if (type === "message.reacted") return void setTimeout(() => this.onReaction(ev), DEDUPE_WAIT_MS + 50);
    if (type !== "message.created" && type !== "thread.reply" && type !== "dm.received") return;
    const m = ev.message;
    if (!m?.id || this.seen.has(m.id)) return;
    this.seen.add(m.id);
    const from = m.from?.name ?? "?";
    const channel = m.channel?.name;
    const runId = runIdOf(m.metadata, channel, from);
    this.textById.set(m.id, { text: m.text ?? "", runId, channel });
    if (!runId) {
      this.stats.unattributed++;
      return;
    }
    const meta = (m.metadata ?? {}) as Partial<RelayMetadata> & Record<string, unknown>;
    const kind = KINDS.has(String(meta.kind))
      ? (meta.kind as RelayMetadata["kind"])
      : type === "thread.reply"
        ? "case_reply"
        : type === "dm.received"
          ? "dm"
          : "note";
    const threadId = m.parentId ?? (m.threadId && m.threadId !== m.id ? m.threadId : undefined);
    const item: RelayFeedItem = {
      seq: 0,
      channel: channel ?? "dm",
      from,
      text: m.text ?? "",
      ts: Date.parse(m.createdAt ?? "") || Date.now(),
      metadata: {
        runId,
        ...(typeof meta.slot === "number" ? { slot: meta.slot } : {}),
        ...(typeof meta.gen === "number" ? { gen: meta.gen } : {}),
        ...(typeof meta.caseId === "string" ? { caseId: meta.caseId } : {}),
        kind,
        ...(threadId ? { threadId } : {}),
      },
    };
    if (this.mode === "observer") return this.publish(item);
    // Supplement: let the herd's own publish land first, then publish only what it did not.
    setTimeout(() => {
      const t = this.recent.get(`${item.from}|${item.text}`);
      if (t && Date.now() - t < DEDUPE_WINDOW_MS) {
        this.stats.confirmed++;
        return;
      }
      this.publish(item);
    }, DEDUPE_WAIT_MS);
  }

  private onReaction(ev: Envelope) {
    if (ev.action && ev.action !== "added") return;
    this.stats.reactions++;
    const target = ev.messageId ? this.textById.get(ev.messageId) : undefined;
    const runId = target?.runId ?? runIdOf(undefined, undefined, ev.agentName);
    if (!runId) {
      this.stats.unattributed++;
      return;
    }
    const snippet = target?.text ? `: "${target.text.length > 60 ? `${target.text.slice(0, 59)}…` : target.text}"` : "";
    this.publish({
      seq: 0,
      channel: target?.channel ?? `cases-${runId}`,
      from: ev.agentName ?? "?",
      text: `${ev.emoji ?? "?"} reacted${snippet}`,
      ts: Date.now(),
      metadata: { runId, kind: "status", ...(ev.messageId ? { threadId: ev.messageId } : {}) },
    });
  }

  private publish(item: RelayFeedItem) {
    item.seq = ++feedSeq;
    this.stats.published++;
    this.o.events.publish({ type: "relay.message", runId: item.metadata.runId, ts: item.ts, item });
  }

  async health(): Promise<ObserverHealth> {
    const latest = await this.latestSeq();
    return {
      started: !!this.relay,
      connected: !!this.relay && latest !== null && !this.stats.error,
      mode: this.mode,
      cursor: this.cursor,
      latestSeq: latest,
      lag: latest !== null && this.cursor !== null ? Math.max(0, latest - this.cursor) : null,
      resumedFrom: this.resumedFrom,
      events: this.stats.events,
      published: this.stats.published,
      confirmed: this.stats.confirmed,
      reactions: this.stats.reactions,
      unattributed: this.stats.unattributed,
      byType: { ...this.stats.byType },
      lastEventAt: this.stats.lastEventAt,
      tokenId: this.token?.id ?? null,
      error: this.stats.error,
    };
  }

  stop() {
    this.unsub?.();
    this.unsubSink?.();
    this.writeState(true);
    this.relay = undefined;
  }
}

// ---------- process singleton (wired from http/api.ts in live mode) ----------

let singleton: RelayObserver | undefined;
let startError: string | null = null;

/** Starts the observer for the configured workspace (.relay/workspace-<port>.json) and the process EventBus. */
export async function startRelayObserverFromConfig(): Promise<RelayObserver | undefined> {
  if (singleton) return singleton;
  try {
    const [{ config, REPO_ROOT }, { RELAY_STATE_FILE, LEGACY_RELAY_STATE_FILE, migrateLegacyRelayState }, { bus }] = await Promise.all([
      import("../config.ts"),
      import("./index.ts"),
      import("../events.ts"),
    ]);
    await migrateLegacyRelayState({ baseUrl: config.env.relayBaseUrl, stateFile: RELAY_STATE_FILE, legacyStateFile: LEGACY_RELAY_STATE_FILE });
    if (!existsSync(RELAY_STATE_FILE)) throw new Error(`no workspace state at ${RELAY_STATE_FILE}`);
    const ws = JSON.parse(readFileSync(RELAY_STATE_FILE, "utf8")) as { baseUrl?: string; workspaceKey?: string };
    if (!ws.workspaceKey || ws.baseUrl !== config.env.relayBaseUrl) throw new Error("workspace state does not match RELAY_BASE_URL");
    const port = new URL(config.env.relayBaseUrl).port || "80";
    const obs = new RelayObserver({
      baseUrl: config.env.relayBaseUrl,
      workspaceKey: ws.workspaceKey,
      events: bus,
      stateFile: `${REPO_ROOT}/.relay/observer-${port}.json`,
      mode: process.env.RELAY_FEED_SOURCE === "observer" ? "observer" : "supplement",
    });
    await obs.start();
    singleton = obs;
    startError = null;
    return obs;
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e);
    console.log(`[relay-observer] not started: ${startError}`);
    return undefined;
  }
}

/** Health for GET /api/relay/observer. */
export async function relayObserverHealth(): Promise<ObserverHealth | { started: false; connected: false; cursor: null; events: 0; error: string | null }> {
  if (singleton) return singleton.health();
  return { started: false, connected: false, cursor: null, events: 0, error: startError ?? "observer not started (mock service or RELAY_OBSERVER=0)" };
}
