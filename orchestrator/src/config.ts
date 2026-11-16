// Single source of config (BUILD_SPEC rule 10). Loads ../config/*.json and required env.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const CONFIG_DIR = join(REPO_ROOT, "config");
export const PROMPTS_DIR = join(REPO_ROOT, "prompts");

/** Per-model chat request options (llm.ts ModelRequestOptions). All optional; llm.ts has defaults. */
const RequestOptionsSchema = z
  .object({
    max_tokens: z.number().int().positive(),
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).nullable(),
    provider_order: z.array(z.string()).min(1),
    auto_pin_provider: z.boolean(),
  })
  .partial();

const ModelsSchema = z.object({
  worker: z.string(),
  fallback_judge: z.string(),
  lesson_writer: z.string(),
  embedding: z.object({ model: z.string(), dimensions: z.number().int().positive() }),
  jev: z.object({ model: z.string() }),
  /** Named overrides selected by env MODEL_PROFILE (e.g. "bench" → GPT-6 Luna). Top level = dev. */
  profiles: z
    .record(
      z.string(),
      z.object({ worker: z.string(), fallback_judge: z.string(), lesson_writer: z.string() }).partial(),
    )
    .optional(),
  /** Chat request options: `default` applies to every chat model, `models[<id>]` overrides it. */
  request_options: z
    .object({ default: RequestOptionsSchema.optional(), models: z.record(z.string(), RequestOptionsSchema).optional() })
    .optional(),
});

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  cached_input: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
});
const PricesSchema = z.object({ checked: z.string(), models: z.record(z.string(), PriceSchema) });

const NoulQuestion = z.object({
  type: z.literal("noul"),
  state_keys: z.array(z.string()).min(1),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }),
  stretch: z.boolean().optional(),
});
const ChoiceQuestion = z.object({
  type: z.literal("choice"),
  state_keys: z.array(z.string()).min(1),
  instructions: z.string(),
  options: z.record(z.string(), z.string()),
  stretch: z.boolean().optional(),
});
const JevQuestionSchema = z.discriminatedUnion("type", [NoulQuestion, ChoiceQuestion]);
export const JEV_QUESTION_IDS = [
  "instruction_conflicts_spec",
  "fact_contradicts_spec",
  "note_consistent_with_spec",
  "failure_category",
  "lesson_relevant",
  "subtask_difficulty",
] as const;
export type JevQuestionId = (typeof JEV_QUESTION_IDS)[number];
const JevQuestionsSchema = z.object(
  Object.fromEntries(JEV_QUESTION_IDS.map((id) => [id, JevQuestionSchema])) as Record<
    JevQuestionId,
    typeof JevQuestionSchema
  >,
);

const unit = z.number().min(0).max(1);
const ThresholdsSchema = z.object({
  act: unit,
  pass: unit,
  jev_timeout_ms: z.number().int().positive(),
  jev_fail_switch: z.number().int().positive(),
  jev_fallback_window_ms: z.number().int().positive(),
  case_similarity: unit,
  lesson_relevant: unit,
  chunk_similarity: unit,
  max_recipients: z.number().int().positive(),
  probation_verified_steps: z.number().int().nonnegative(),
  stuck_test_runs: z.number().int().positive(),
});

const posInt = z.number().int().positive();
const CapsSchema = z.object({
  agents_per_run: posInt,
  steps_per_generation: posInt,
  generations_per_slot: posInt,
  usd_per_run: z.number().positive(),
  usd_benchmark_total: z.number().positive(),
  concurrent_llm_calls_demo: posInt,
  concurrent_llm_calls_benchmark: posInt,
  relay_messages_per_agent_per_step: posInt,
  replies_per_case_thread: posInt,
  prompt_input_tokens_per_step: posInt,
  test_timeout_ms: posInt,
  max_lessons: posInt,
  max_chunks_in_prompt: posInt,
  inbox_per_step: posInt,
  codex_wall_clock_ms: posInt,
});

export type Models = z.infer<typeof ModelsSchema>;
export type Prices = z.infer<typeof PricesSchema>;
export type JevQuestion = z.infer<typeof JevQuestionSchema>;
export type JevQuestions = Record<JevQuestionId, JevQuestion>;
export type Thresholds = z.infer<typeof ThresholdsSchema>;
export type Caps = z.infer<typeof CapsSchema>;

function loadJson<T>(file: string, schema: z.ZodType<T>): T {
  const path = join(CONFIG_DIR, file);
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env ${name} (set it in .env; there are no defaults)`);
  return v;
}

function requirePort(name: string): number {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Env ${name} is not a valid port: ${raw}`);
  return n;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  // Treat unexpanded "${VAR}" placeholders as unset.
  return v && !v.startsWith("${") ? v : undefined;
}

export interface Env {
  ports: { actors: number; relay: number; orchestrator: number; dashboard: number };
  relayBaseUrl: string;
  actorsControlPlaneUrl: string;
  actorsProjectId: string;
  llmBaseUrl: string;
  jevBaseUrl: string;
  /** Absent => adapters must run labeled MOCKs (rule 6). Never log the value. */
  openrouterApiKey: string | undefined;
  llmApiKey: string | undefined;
  embedBaseUrl: string | undefined;
  embedApiKey: string | undefined;
  node22: string | undefined;
}

function loadEnv(): Env {
  const openrouterApiKey = optionalEnv("OPENROUTER_API_KEY");
  return {
    ports: {
      actors: requirePort("ACTORS_PORT"),
      relay: requirePort("RELAY_PORT"),
      orchestrator: requirePort("ORCHESTRATOR_PORT"),
      dashboard: requirePort("DASHBOARD_PORT"),
    },
    relayBaseUrl: requireEnv("RELAY_BASE_URL"),
    actorsControlPlaneUrl: requireEnv("DURABLE_ACTORS_CONTROL_PLANE_URL"),
    actorsProjectId: requireEnv("DURABLE_ACTORS_PROJECT_ID"),
    llmBaseUrl: requireEnv("LLM_BASE_URL"),
    jevBaseUrl: requireEnv("JEV_BASE_URL"),
    openrouterApiKey,
    llmApiKey: optionalEnv("LLM_API_KEY") ?? openrouterApiKey,
    embedBaseUrl: optionalEnv("EMBED_BASE_URL"),
    embedApiKey: optionalEnv("EMBED_API_KEY"),
    node22: optionalEnv("NODE22"),
  };
}

export interface Config {
  models: Models;
  prices: Prices;
  jevQuestions: JevQuestions;
  thresholds: Thresholds;
  caps: Caps;
  env: Env;
  /** True when no LLM key is present: every model call must be a labeled MOCK. */
  mock: boolean;
}

function loadConfig(): Config {
  const models = loadJson("models.json", ModelsSchema);
  const profile = optionalEnv("MODEL_PROFILE");
  if (profile) {
    const p = models.profiles?.[profile];
    if (!p) throw new Error(`MODEL_PROFILE=${profile} not found in config/models.json profiles`);
    Object.assign(models, p);
  }
  const workerOverride = optionalEnv("WORKER_MODEL");
  if (workerOverride) models.worker = workerOverride;
  const env = loadEnv();
  return {
    models,
    prices: loadJson("prices.json", PricesSchema),
    jevQuestions: loadJson("jev-questions.json", JevQuestionsSchema) as JevQuestions,
    thresholds: loadJson("thresholds.json", ThresholdsSchema),
    caps: loadJson("caps.json", CapsSchema),
    env,
    mock: !env.llmApiKey,
  };
}

export const config: Config = loadConfig();

export type PromptName = "worker_system" | "lesson_writer" | "fallback_judge";

/** Reads prompts/<name>.md and fills {placeholders}. Throws on any placeholder left unfilled. */
export function loadPrompt(name: PromptName, vars: Record<string, string> = {}): string {
  const text = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").trimEnd();
  const missing = new Set<string>();
  const out = text.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, key: string) => {
    const v = vars[key];
    if (v === undefined) missing.add(key);
    return v ?? m;
  });
  if (missing.size) throw new Error(`Prompt ${name} missing vars: ${[...missing].join(", ")}`);
  return out;
}
