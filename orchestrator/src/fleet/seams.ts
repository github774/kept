// Routes the runtime's swappable collaborators (worker.ts `workerDeps`, retire.ts `retireDeps`, both
// exported for exactly this kind of substitution) to fleet implementations for fleet team contexts only.
// Every other context (the regular 4-agent runs, tests) keeps whatever function was installed before, so
// installing is safe while normal runs are live. docs/FLEET.md hook H3 replaces this with an explicit
// ctx field once the runtime fixer lands.
import type { CaseFile } from "../contract.ts";
import type { RunTestsResult } from "../testrunner.ts";
import { retireDeps } from "../runtime/retire.ts";
import type { AgentRef, InboxItem, RunContext, TaskFn } from "../runtime/types.ts";
import { workerDeps } from "../runtime/worker.ts";

export interface FleetCtxHooks {
  runFnTests(orig: typeof workerDeps.runFnTests, ctx: RunContext, fn: TaskFn, agentName: string): Promise<RunTestsResult>;
  revokeChunk(orig: typeof workerDeps.revokeChunk, ctx: RunContext, chunkId: string, reason: string): Promise<void>;
  broadcastCase(ctx: RunContext, caseFile: CaseFile): Promise<{ recipients: AgentRef[] }>;
  readInbox(orig: typeof workerDeps.readInbox, ctx: RunContext, ref: AgentRef, step: number): Promise<InboxItem[]>;
}

const registry = new WeakMap<RunContext, FleetCtxHooks>();
let installed: { runFnTests: typeof workerDeps.runFnTests; revokeChunk: typeof workerDeps.revokeChunk; readInbox: typeof workerDeps.readInbox; broadcastCase: typeof retireDeps.broadcastCase } | null = null;
let users = 0;

export function registerFleetCtx(ctx: RunContext, hooks: FleetCtxHooks) {
  registry.set(ctx, hooks);
}
export const isFleetCtx = (ctx: RunContext) => registry.has(ctx);

/** Installs the dispatchers (ref-counted). Returns an uninstall function. */
export function installFleetSeams(): () => void {
  if (!installed) {
    const prev = { runFnTests: workerDeps.runFnTests, revokeChunk: workerDeps.revokeChunk, readInbox: workerDeps.readInbox, broadcastCase: retireDeps.broadcastCase };
    installed = prev;
    workerDeps.runFnTests = (ctx, fn, name) => {
      const h = registry.get(ctx);
      return h ? h.runFnTests(prev.runFnTests, ctx, fn, name) : prev.runFnTests(ctx, fn, name);
    };
    workerDeps.revokeChunk = (ctx, id, reason) => {
      const h = registry.get(ctx);
      return h ? h.revokeChunk(prev.revokeChunk, ctx, id, reason) : prev.revokeChunk(ctx, id, reason);
    };
    workerDeps.readInbox = (ctx, ref, step) => {
      const h = registry.get(ctx);
      return h ? h.readInbox(prev.readInbox, ctx, ref, step) : prev.readInbox(ctx, ref, step);
    };
    retireDeps.broadcastCase = (ctx, cf) => {
      const h = registry.get(ctx);
      return h ? h.broadcastCase(ctx, cf) : prev.broadcastCase(ctx, cf);
    };
  }
  users++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users--;
    if (users === 0 && installed) {
      workerDeps.runFnTests = installed.runFnTests;
      workerDeps.revokeChunk = installed.revokeChunk;
      workerDeps.readInbox = installed.readInbox;
      retireDeps.broadcastCase = installed.broadcastCase;
      installed = null;
    }
  };
}
