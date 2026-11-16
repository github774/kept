// Global limits for fleet-scale mode: one FIFO gate each for LLM calls, pytest runs and Jev checks,
// shared by every team. Each gate records its peak so tests (and the smoke report) can prove the cap held.
import type { Embedder } from "../embeddings.ts";
import type { Jev } from "../jev.ts";
import type { Llm } from "../llm.ts";
import type { FleetLimits } from "./types.ts";

export class Gate {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  peak = 0;
  total = 0;
  constructor(
    readonly name: string,
    private cap: number,
  ) {}
  get inFlight() {
    return this.active;
  }
  get waiting() {
    return this.queue.length;
  }
  get limit() {
    return this.cap;
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.cap) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.total++;
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      return await fn();
    } finally {
      this.active--;
      while (this.active < this.cap && this.queue.length) {
        this.active++;
        this.queue.shift()!();
      }
    }
  }
}

export class FleetGates {
  readonly llm: Gate;
  readonly tests: Gate;
  readonly jev: Gate;
  readonly relay: Gate;
  constructor(readonly limits: FleetLimits) {
    this.relay = new Gate("relay", limits.relay);
    this.llm = new Gate("llm", limits.llm);
    this.tests = new Gate("tests", limits.tests);
    this.jev = new Gate("jev", limits.jev);
  }
}

export interface PromptTap {
  /** Every worker / lesson-writer call: messages as sent and the usage-backed draft that came back. */
  (team: number, call: { category: string; slot: string; gen: number; step: number; system: string }): void;
}

/**
 * Team-scoped LLM adapter: the shared Llm behind the fleet LLM gate. `tap` sees each worker prompt's
 * system message (lessons delivered = lessons present in a sent prompt; measured, not assumed).
 */
export function teamLlm(base: Llm, gates: FleetGates, team: number, tap: PromptTap): Llm {
  const sys = (m: { role: string; content: string }[]) => m.find((x) => x.role === "system")?.content ?? "";
  const wrapped = {
    ...base,
    chatStructured: <T>(o: Parameters<Llm["chatStructured"]>[0]) =>
      gates.llm.run(async () => {
        tap(team, { category: o.meta.category, slot: o.meta.slot, gen: o.meta.gen, step: o.meta.step, system: sys(o.messages) });
        return base.chatStructured<T>(o as never);
      }, o.signal),
    chatText: (o: Parameters<Llm["chatText"]>[0]) =>
      gates.llm.run(async () => {
        tap(team, { category: o.meta.category, slot: o.meta.slot, gen: o.meta.gen, step: o.meta.step, system: sys(o.messages) });
        return base.chatText(o);
      }, o.signal),
    // Fleet owns the cap; a regular run must not lower it while the fleet runs (hook H4 in docs/FLEET.md).
    setConcurrency: (_n: number) => {},
  };
  return wrapped as unknown as Llm;
}

/** Jev behind the fleet Jev gate (its fallback judge still goes through the shared llm limiter). */
export function gatedJev(base: Jev, gates: FleetGates): Jev {
  return { ...base, check: (q, s, m, signal) => gates.jev.run(() => base.check(q, s, m, signal), signal) } as Jev;
}

export function passEmbedder(base: Embedder): Embedder {
  return base;
}
