// The injection + snapshot loop both sides run while the agents work (same rule, same cadence).
import { changedFiles, COMMIT_FALLBACK_S, type Injection, poisonSnapshot, type PoisonSnap, starterFiles } from "./common.ts";
import { POISONS, type PoisonKind } from "./poisons.ts";

export interface DriverOpts {
  task: string;
  kinds: PoisonKind[];
  workDir: () => string | null;
  /** Injects one poison; returns ok/detail. */
  inject: (kind: PoisonKind) => Promise<{ ok: boolean; detail?: string }>;
  done: () => boolean;
  t0: number;
  pollMs?: number;
  snapEveryMs?: number;
  log: (m: string) => void;
}

export async function drive(o: DriverOpts): Promise<{ injections: Injection[]; snaps: PoisonSnap[] }> {
  const starter = await starterFiles(o.task);
  const target = POISONS[o.task]!.commit.file;
  const injections: Injection[] = [];
  const snaps: PoisonSnap[] = [];
  const since = () => (Date.now() - o.t0) / 1000;
  let firstAt: number | null = null;
  let lastSnap = 0;
  const fire = async (kind: PoisonKind, trigger: string) => {
    const at_s = since();
    const r = await o.inject(kind).catch((e) => ({ ok: false, detail: String(e) }));
    injections.push({ kind, at_s, trigger, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) });
    o.log(`inject ${kind} at ${at_s.toFixed(1)}s (${trigger}): ${r.ok ? "ok" : "FAILED"} ${r.detail ?? ""}`);
  };
  while (!o.done()) {
    await Bun.sleep(o.pollMs ?? 1000);
    const wd = o.workDir();
    if (!wd) continue;
    const changed = await changedFiles(wd, starter);
    if (firstAt === null && changed.length) {
      firstAt = since();
      for (const k of o.kinds) if (k !== "commit") await fire(k, `first edit (${changed.join(", ")})`);
    }
    if (firstAt !== null && o.kinds.includes("commit") && !injections.some((i) => i.kind === "commit")) {
      if (changed.includes(target)) await fire("commit", `${target} written by its owner`);
      else if (since() - firstAt >= COMMIT_FALLBACK_S) await fire("commit", `fallback ${COMMIT_FALLBACK_S}s after first edit`);
    }
    if (firstAt !== null && Date.now() - lastSnap >= (o.snapEveryMs ?? 3000)) {
      lastSnap = Date.now();
      snaps.push(await poisonSnapshot(o.task, wd, since()));
    }
  }
  return { injections, snaps };
}
