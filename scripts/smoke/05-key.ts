// Smoke 5: OpenRouter key credit/limit. Prints only numeric limit/usage fields, never the key or its label.
import { get, show } from "./_lib.ts";
const r = await get("/v1/key");
const d = r.json?.data ?? {};
const pick: Record<string, unknown> = {};
for (const [k, v] of Object.entries(d)) if (typeof v === "number" || typeof v === "boolean" || v === null) pick[k] = v;
show(`GET /v1/key | HTTP ${r.status} | ${r.ms} ms`, pick);
process.exit(r.status === 200 ? 0 : 1);
