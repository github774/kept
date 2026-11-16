// Typed in-process event bus for DashboardEvent, with a replay buffer so an SSE client
// reconnecting with Last-Event-ID can resume from its last seq.
import { EventEmitter } from "node:events";
import type { DashboardEvent, SequencedEvent } from "./contract.ts";

const CHANNEL = "event";

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: SequencedEvent[] = [];
  private seq: number;

  constructor(
    private readonly capacity = 2000,
    startSeq = 0,
  ) {
    this.seq = startSeq;
    this.emitter.setMaxListeners(0);
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Assigns the next seq, buffers, and delivers to subscribers. A throwing listener never breaks others. */
  publish(ev: DashboardEvent): SequencedEvent {
    const out = { ...ev, seq: ++this.seq } as SequencedEvent;
    this.buffer.push(out);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    this.emitter.emit(CHANNEL, out);
    return out;
  }

  subscribe(cb: (ev: SequencedEvent) => void): () => void {
    const safe = (ev: SequencedEvent): void => {
      try {
        cb(ev);
      } catch (err) {
        console.error("[events] subscriber threw:", err);
      }
    };
    this.emitter.on(CHANNEL, safe);
    return () => this.emitter.off(CHANNEL, safe);
  }

  /** Events with seq > afterSeq still in the buffer (oldest first). */
  replay(afterSeq = 0): SequencedEvent[] {
    const first = this.buffer[0];
    if (!first || afterSeq < first.seq - 1) return [...this.buffer];
    return this.buffer.filter((e) => e.seq > afterSeq);
  }

  /** True when afterSeq is older than the buffer: the client missed events and should refetch snapshots. */
  hasGap(afterSeq: number): boolean {
    const first = this.buffer[0];
    return !!first && afterSeq < first.seq - 1;
  }
}

/** Process-wide bus used by the orchestrator. */
export const bus = new EventBus();
