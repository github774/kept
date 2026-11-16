// Base URL and JSON request helper for the orchestrator API (docs/DATA_CONTRACT.md).
//
// VITE_API_URL=recorded (the Vercel build, dashboard/.env.production) reads a recorded real run
// from static files on the same origin (public/api/, written by scripts/record-snapshot.ts):
// GET /api/x is served from /api/x.json and anything that would change the run is refused.
const ENV_API = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
/** VITE_DEMO_REPLAY=1: Start run and Possess replay real runs recorded by scripts/record-scenarios.ts (store.ts). */
export const DEMO_REPLAY: boolean = import.meta.env.VITE_DEMO_REPLAY === "1";
/** GETs come from the static snapshot in public/api (recorded run, or the demo replay's bench and case data). */
const STATIC: boolean = ENV_API === "recorded";
export const RECORDED: boolean = STATIC && !DEMO_REPLAY;
export const API_URL: string = STATIC ? "" : (ENV_API || "http://127.0.0.1:3000").replace(/\/+$/, "");
/** Shown wherever a control needs the real orchestrator. */
export const RECORDED_NOTE = "Needs the local orchestrator. This page replays a recorded run; run Kept locally to drive it (see README).";

export class ApiError extends Error {
  readonly status: number;
  /** ActionResult error code when the server sent one, e.g. "slot_not_active". */
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (STATIC && method !== "GET") throw new ApiError(409, RECORDED_NOTE, "recorded");
  const url = STATIC ? `${path.split("?")[0]}.json` : API_URL + path;
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const o = (data && typeof data === "object" ? data : {}) as { error?: unknown; detail?: unknown };
    const code = typeof o.error === "string" ? o.error : null;
    const detail = typeof o.detail === "string" ? o.detail : null;
    const msg = [code, detail].filter(Boolean).join(": ") || `${method} ${path} failed (${res.status})`;
    throw new ApiError(res.status, msg, code);
  }
  return data as T;
}
