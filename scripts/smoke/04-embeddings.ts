// Smoke 4: embeddings via OpenRouter. Tries config model first, then alternatives from /api/v1/models.
import { post, get, show, models } from "./_lib.ts";

const input = ["parse invoice amounts as dollars", "shipping rate weight brackets"];
async function tryModel(id: string, dims?: number) {
  const body: any = { model: id, input };
  if (dims) body.dimensions = dims;
  const r = await post("/v1/embeddings", body, 30_000);
  const d = r.json?.data;
  const summary = {
    status: r.status, ms: r.ms, returned_model: r.json?.model, provider: r.json?.provider,
    n: Array.isArray(d) ? d.length : null,
    dims: Array.isArray(d) ? d[0]?.embedding?.length : null,
    usage: r.json?.usage, error: r.json?.error ?? r.text,
  };
  show(`embeddings ${id}${dims ? ` dims=${dims}` : ""}`, summary);
  return r.status === 200 && Array.isArray(d) && d.length === input.length;
}

const primary = models.embedding.model;
const okPrimary = await tryModel(primary, models.embedding.dimensions);

// List embedding-capable models on OpenRouter.
const list = await get("/v1/models?output_modalities=embeddings");
let ids: string[] = (list.json?.data ?? []).map((m: any) => m.id);
if (!ids.length) {
  const all = await get("/v1/models");
  ids = (all.json?.data ?? [])
    .filter((m: any) => JSON.stringify(m.architecture ?? {}).includes("embedding") || /embed/i.test(m.id))
    .map((m: any) => m.id);
}
show("embedding models listed", { status: list.status, count: ids.length, ids: ids.slice(0, 40) });

if (!okPrimary) {
  for (const id of ids.filter((x) => x !== primary).slice(0, 6)) {
    if (await tryModel(id, 256)) { show("best alternative", id); break; }
    if (await tryModel(id)) { show("best alternative (no dimensions param)", id); break; }
  }
}
process.exit(okPrimary ? 0 : 1);
