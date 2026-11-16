// Shared helpers for real-API smoke tests. Never prints key values.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const OR = "https://openrouter.ai/api";
export const KEY = process.env.OPENROUTER_API_KEY ?? "";
if (!KEY) {
  console.error("OPENROUTER_API_KEY missing. Run with: bun --env-file=.env scripts/smoke/<file>.ts");
  process.exit(2);
}
export const models = JSON.parse(readFileSync(join(ROOT, "config/models.json"), "utf8"));
export const jevQuestions = JSON.parse(readFileSync(join(ROOT, "config/jev-questions.json"), "utf8"));

export function headers() {
  return { "content-type": "application/json", authorization: `Bearer ${KEY}` };
}

export async function post(path: string, body: unknown, timeoutMs = 120_000) {
  const t0 = performance.now();
  const res = await fetch(`${OR}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ms, json, text: json ? undefined : text.slice(0, 500) };
}

export async function get(path: string) {
  const t0 = performance.now();
  const res = await fetch(`${OR}${path}`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => null);
  return { status: res.status, ms: Math.round(performance.now() - t0), json };
}

export function show(label: string, v: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

// BUILD_SPEC "Step output schema" as an OpenAI strict json_schema.
// Strict mode requires every property listed in `required`; optional fields are nullable.
export const STEP_SCHEMA = {
  name: "worker_step",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "file", "code", "message", "claims", "approach_note", "summary"],
    properties: {
      action: { type: "string", enum: ["write_code", "run_tests", "message", "claim_done"] },
      file: { type: ["string", "null"] },
      code: { type: ["string", "null"] },
      message: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["to", "text"],
            properties: { to: { type: "string" }, text: { type: "string" } },
          },
        ],
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text"],
          properties: {
            kind: { type: "string", enum: ["tests_pass", "spec_fact", "instruction"] },
            text: { type: "string" },
          },
        },
      },
      approach_note: { type: "string" },
      summary: { type: "string" },
    },
  },
} as const;

export function validateStep(o: any): string[] {
  const errs: string[] = [];
  const actions = ["write_code", "run_tests", "message", "claim_done"];
  if (!o || typeof o !== "object") return ["not an object"];
  if (!actions.includes(o.action)) errs.push(`bad action ${o.action}`);
  if (o.action === "write_code" && (typeof o.file !== "string" || typeof o.code !== "string")) errs.push("write_code needs file+code");
  if (o.action === "message" && (!o.message || typeof o.message.to !== "string" || typeof o.message.text !== "string")) errs.push("message needs {to,text}");
  if (!Array.isArray(o.claims)) errs.push("claims not array");
  else for (const c of o.claims) if (!["tests_pass", "spec_fact", "instruction"].includes(c?.kind)) errs.push(`bad claim kind ${c?.kind}`);
  if (typeof o.approach_note !== "string") errs.push("approach_note missing");
  if (typeof o.summary !== "string") errs.push("summary missing");
  const extra = Object.keys(o).filter((k) => !["action", "file", "code", "message", "claims", "approach_note", "summary"].includes(k));
  if (extra.length) errs.push(`extra keys ${extra.join(",")}`);
  return errs;
}
