// Barebones debug UI for testing the orchestrator API by hand. Not the demo dashboard.
// Serves index.html and proxies /api/* (SSE included) to the orchestrator, so no CORS setup.
//   bun run debug-ui/serve.ts                       UI on :5174, API at http://127.0.0.1:3000
//   API_URL=http://127.0.0.1:3300 PORT=5175 bun run debug-ui/serve.ts
const PORT = Number(process.env.PORT ?? 5174);
const API_URL = (process.env.API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const page = Bun.file(new URL("./index.html", import.meta.url));

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0, // keep the proxied SSE stream open
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("origin");
    try {
      const res = await fetch(API_URL + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        signal: req.signal,
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch (err) {
      return Response.json({ error: "orchestrator_unreachable", detail: `${API_URL}: ${String(err)}` }, { status: 502 });
    }
  },
});
console.log(`debug UI on http://127.0.0.1:${PORT} -> API ${API_URL}`);
