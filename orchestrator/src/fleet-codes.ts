// Runtime lookup for FleetGrid.cells (contract.ts stays types-only).
import type { FleetGridCodeMap } from "./contract.ts";

export const FLEET_GRID_CODES: FleetGridCodeMap = {
  ".": "queued",
  T: "trusted",
  P: "probation",
  I: "under_investigation",
  R: "retired",
  F: "failed",
  D: "done",
  X: "possessed",
};
