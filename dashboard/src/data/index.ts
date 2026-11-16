// Dashboard data layer. See README.md in this folder. View-model types: ./model.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { BENCH_KEY, bench, caseFiles, type Resource } from "./cache";
import { EMPTY_CHUNKS, EMPTY_CLEANSING, EMPTY_FLEET_STATS } from "./fleet";
import type {
  AgentSlot,
  BenchResults,
  CaseFile,
  CaseSummary,
  ChunksState,
  CleansingState,
  FleetGridView,
  FleetStatsState,
  Health,
  LedgerTotals,
  Metrics,
  Recovery,
  RelayMessage,
  RunInfo,
  Snapshot,
  SwarmState,
} from "./model";
import { getCaseFile, getState, subscribe, type Connection, type DashboardState } from "./store";

export { api, API_URL, ApiError, DEMO_REPLAY, RECORDED, RECORDED_NOTE, type StartRunOptions } from "./client";
export { CHUNKS_CAP, CLEANSING_CAP, FLEET_CELL_CODES, FLEET_CELL_STATUS, FLEET_HISTORY_CAP } from "./fleet";
export type { Connection, DashboardState } from "./store";
export type { Resource } from "./cache";
export type * from "./model";

/** Whole dashboard state. The object is replaced only when something changes. */
export function useDashboard(): DashboardState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ------------------------------------------------------------------ selector hooks
// Each re-renders only when its slice's reference changes.
function useSlice<T>(select: (s: DashboardState) => T): T {
  const get = () => select(getState());
  return useSyncExternalStore(subscribe, get, get);
}
const sel = {
  snapshot: (s: DashboardState) => s.snapshot,
  connection: (s: DashboardState) => s.connection,
  selectedCaseId: (s: DashboardState) => s.selectedCaseId,
  run: (s: DashboardState) => s.snapshot?.run ?? null,
  roster: (s: DashboardState) => s.snapshot?.roster ?? null,
  ledger: (s: DashboardState) => s.snapshot?.ledger ?? null,
  cases: (s: DashboardState) => s.snapshot?.cases ?? null,
  relay: (s: DashboardState) => s.snapshot?.relay ?? null,
  recoveries: (s: DashboardState) => s.snapshot?.recoveries ?? null,
  metrics: (s: DashboardState) => s.snapshot?.metrics ?? null,
  health: (s: DashboardState) => s.snapshot?.health ?? null,
  swarm: (s: DashboardState) => s.snapshot?.swarm ?? null,
  fleetGrid: (s: DashboardState) => s.snapshot?.fleetGrid ?? null,
  fleetStats: (s: DashboardState) => s.snapshot?.fleetStats ?? EMPTY_FLEET_STATS,
  chunks: (s: DashboardState) => s.snapshot?.chunks ?? EMPTY_CHUNKS,
  cleansing: (s: DashboardState) => s.snapshot?.cleansing ?? EMPTY_CLEANSING,
};
export const useSnapshot = (): Snapshot | null => useSlice(sel.snapshot);
export const useConnection = (): Connection => useSlice(sel.connection);
export const useSelectedCaseId = (): string | null => useSlice(sel.selectedCaseId);
export const useRun = (): RunInfo | null => useSlice(sel.run);
export const useRoster = (): AgentSlot[] | null => useSlice(sel.roster);
export const useLedger = (): LedgerTotals | null => useSlice(sel.ledger);
export const useCases = (): CaseSummary[] | null => useSlice(sel.cases);
export const useRelay = (): RelayMessage[] | null => useSlice(sel.relay);
export const useRecoveries = (): Recovery[] | null => useSlice(sel.recoveries);
export const useMetrics = (): Metrics | null => useSlice(sel.metrics);
export const useHealth = (): Health | null => useSlice(sel.health);
export const useSwarm = (): SwarmState | null => useSlice(sel.swarm);

// ------------------------------------------------------------------ fleet-scale mode
/** Latest fleet.grid (~1/s): raw `cells` string, `prevCells` for diffing, precomputed `counts`. null until the first grid. */
export const useFleetGrid = (): FleetGridView | null => useSlice(sel.fleetGrid);
/** fleet.stats (~1/s): `current` (null until the first tick) and `history` (last 120 points, oldest first). */
export const useFleetStats = (): FleetStatsState => useSlice(sel.fleetStats);
/** Shared reasoning chunks: `recent` (last 200, newest last) and event-counted `totals`. */
export const useChunks = (): ChunksState => useSlice(sel.chunks);
/** Vector cleansing: `recent` context.cleansed events (last 100) plus count and total dropped tokens. */
export const useCleansing = (): CleansingState => useSlice(sel.cleansing);

/** One agent card's data; re-renders only when that slot's object changes. */
export function useAgent(slot: number): AgentSlot | null {
  const select = useCallback((s: DashboardState) => s.snapshot?.roster.find((a) => a.slot === slot) ?? null, [slot]);
  return useSlice(select);
}

/** Stable function to change the selected case (same as useDashboard().selectCase). */
export const selectCase = (id: string | null): void => getState().selectCase(id);

// ------------------------------------------------------------------ fetched detail
const NO_CASE: Resource<CaseFile> = { data: null, error: null, loading: false };
const storeCases = new WeakMap<CaseFile, Resource<CaseFile>>(); // one stable wrapper per store object, however many files are read at once

/**
 * Full CaseFile for an id. Served from the store when case.created was seen (kept
 * current as recipient replies arrive); otherwise fetched once from GET /api/cases/:id.
 */
export function useCase(id: string | null): Resource<CaseFile> & { reload(): void } {
  const sub = useCallback(
    (l: () => void) => {
      const offStore = subscribe(l);
      const offFetch = id ? caseFiles.subscribe(id, l, !getCaseFile(id)) : () => {};
      return () => {
        offStore();
        offFetch();
      };
    },
    [id],
  );
  const get = useCallback((): Resource<CaseFile> => {
    if (!id) return NO_CASE;
    const fromStore = getCaseFile(id);
    if (fromStore) {
      let r = storeCases.get(fromStore);
      if (!r) {
        r = { data: fromStore, error: null, loading: false };
        storeCases.set(fromStore, r);
      }
      return r;
    }
    return caseFiles.get(id);
  }, [id]);
  const value = useSyncExternalStore(sub, get, get);
  const reload = useCallback(() => {
    if (id) caseFiles.reload(id);
  }, [id]);
  return useMemo(() => ({ ...value, reload }), [value, reload]);
}

const subBench = (l: () => void) => bench.subscribe(BENCH_KEY, l);
const getBench = () => bench.get(BENCH_KEY);
const reloadBench = () => bench.reload(BENCH_KEY);

/** BenchResults from GET /api/bench, fetched once and cached. */
export function useBenchResults(): Resource<BenchResults> & { reload(): void } {
  const value = useSyncExternalStore(subBench, getBench, getBench);
  return useMemo(() => ({ ...value, reload: reloadBench }), [value]);
}
