// Fetch-on-demand caches: a CaseFile not already in the store (GET /api/cases/:id)
// and the benchmark rows (GET /api/bench).
import { api } from "./client";
import { onCaseChanged } from "./store";
import type { BenchHeadline, BenchResults, CaseFile } from "./model";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface Entry<T> {
  value: Resource<T>;
  listeners: Set<() => void>;
  inflight: number; // only the latest response lands
}

const EMPTY: Resource<never> = { data: null, error: null, loading: false };

function createResource<T>(load: (key: string) => Promise<T>) {
  const entries = new Map<string, Entry<T>>();

  function entry(key: string): Entry<T> {
    let e = entries.get(key);
    if (!e) {
      e = { value: { data: null, error: null, loading: false }, listeners: new Set(), inflight: 0 };
      entries.set(key, e);
    }
    return e;
  }
  function update(e: Entry<T>, value: Resource<T>) {
    e.value = value;
    for (const l of e.listeners) l();
  }
  function fetchKey(key: string) {
    const e = entry(key);
    const ticket = ++e.inflight;
    update(e, { ...e.value, loading: true, error: null });
    load(key).then(
      (data) => ticket === e.inflight && update(e, { data, error: null, loading: false }),
      (err: unknown) => ticket === e.inflight && update(e, { ...e.value, error: err instanceof Error ? err.message : String(err), loading: false }),
    );
  }

  return {
    subscribe(key: string, listener: () => void, fetchIfMissing = true) {
      const e = entry(key);
      e.listeners.add(listener);
      if (fetchIfMissing && !e.value.data && !e.value.loading && !e.value.error) fetchKey(key);
      return () => {
        e.listeners.delete(listener);
      };
    },
    get(key: string): Resource<T> {
      return entries.get(key)?.value ?? EMPTY;
    },
    reload: fetchKey,
    refreshIfWatched(key: string) {
      const e = entries.get(key);
      if (e && e.listeners.size) fetchKey(key);
      else entries.delete(key);
    },
  };
}

export const caseFiles = createResource<CaseFile>((id) => api.getCase(id));
// case.created / case.reply: refetch a fetched case file that someone is watching.
onCaseChanged((id) => caseFiles.refreshIfWatched(id));
export const bench = createResource<BenchResults>(() => api.getBench());
export const BENCH_KEY = "bench";
export const benchHeadline = createResource<BenchHeadline | null>(() => api.getBenchHeadline());
