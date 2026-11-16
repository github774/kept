import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { addTokens, zeroTokens, type SubagentInfo, type TokenCounts as Tokens } from "../src/types.ts";

interface RawUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

const toTokens = (u: RawUsage | undefined): Tokens => ({
  input: u?.input_tokens ?? 0,
  cached: u?.cached_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  reasoning: u?.reasoning_output_tokens ?? 0,
});

/** Incremental parser for `codex exec --json` stdout (parent thread only). */
export class ExecStreamParser {
  sessionId: string | null = null;
  parentTokens: Tokens = zeroTokens();
  turnsCompleted = 0;
  spawnCalls = 0;
  collabCalls = 0;
  errors: string[] = [];
  lastMessage: string | null = null;
  private firstTrapFailMs: number | null = null;
  recoveryMs: number | null = null;

  feed(line: string, tMs: number): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = ev.type as string;
    if (type === "thread.started") this.sessionId = (ev.thread_id as string) ?? null;
    else if (type === "turn.completed") {
      this.turnsCompleted++;
      this.parentTokens = addTokens(this.parentTokens, toTokens(ev.usage as RawUsage));
    } else if (type === "turn.failed" || type === "error") {
      const msg = (ev.error as { message?: string })?.message ?? (ev.message as string) ?? type;
      this.errors.push(String(msg).slice(0, 300));
    } else if (type === "item.completed") {
      const item = ev.item as Record<string, unknown>;
      if (item.type === "agent_message") this.lastMessage = String(item.text ?? "");
      if (item.type === "collab_tool_call") {
        this.collabCalls++;
        if (String(item.tool).includes("spawn")) this.spawnCalls++;
      }
      if (item.type === "command_execution" && /pytest/.test(String(item.command))) {
        const failed = item.exit_code !== 0;
        const trapFail = failed && /FAILED[^\n]*trap/i.test(String(item.aggregated_output ?? ""));
        if (trapFail && this.firstTrapFailMs === null) this.firstTrapFailMs = tMs;
        if (!failed && this.firstTrapFailMs !== null && this.recoveryMs === null)
          this.recoveryMs = tMs - this.firstTrapFailMs;
      }
    }
  }
}

export interface RolloutSummary {
  threads: number;
  tokens: Tokens;
  models: string[];
  rootId: string | null;
  subagents: SubagentInfo[];
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/**
 * Reads every thread's rollout under the per-run CODEX_HOME. The exec JSON stream reports only the
 * parent thread's usage, so subagent tokens come from each rollout's last token_count event.
 */
export async function readRollouts(codexHome: string): Promise<RolloutSummary> {
  const files = await walk(join(codexHome, "sessions"));
  let tokens = zeroTokens();
  const models = new Set<string>();
  const subagents: SubagentInfo[] = [];
  let rootId: string | null = null;
  for (const f of files) {
    let meta: Record<string, unknown> | null = null;
    let last: RawUsage | undefined;
    let model: string | null = null;
    for (const line of (await Bun.file(f).text()).split("\n")) {
      if (!line) continue;
      let rec: { type?: string; payload?: Record<string, unknown> };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = rec.payload ?? {};
      // Forked subagent rollouts also embed the parent's session_meta; the first one is this thread's.
      if (rec.type === "session_meta") meta ??= p;
      else if (rec.type === "turn_context" && typeof p.model === "string") model = p.model;
      else if (rec.type === "event_msg" && p.type === "token_count") {
        const info = p.info as { total_token_usage?: RawUsage } | null;
        if (info?.total_token_usage) last = info.total_token_usage;
      }
    }
    const t = toTokens(last);
    tokens = addTokens(tokens, t);
    if (model) models.add(model);
    const id = String(meta?.id ?? f);
    const spawn = ((meta?.source as Record<string, unknown> | undefined)?.subagent as
      | { thread_spawn?: Record<string, unknown> }
      | undefined)?.thread_spawn;
    if (meta?.parent_thread_id || spawn) {
      subagents.push({
        thread_id: id,
        nickname: (spawn?.agent_nickname as string) ?? null,
        role: (spawn?.agent_role as string) ?? null,
        agent_path: (spawn?.agent_path as string) ?? null,
        model,
        tokens: t,
      });
    } else rootId = id;
  }
  return { threads: files.length, tokens, models: [...models], rootId, subagents };
}
