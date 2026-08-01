// Front-end server: single entry point for clients. Serves dist/ and proxies
// /api/s/{i}/* to the configured backends — same route scheme as vite.config.ts,
// so clients never reach the real backends (they may be unreachable from the
// client's network). Configuration comes from dashboard.yaml (env overrides:
// DASHBOARD_CONFIG, PORT, HOST). Run: bun server.ts
import { serve } from "bun";
import { join } from "node:path";
import { loadDashboardConfig } from "./config";

const cfg = loadDashboardConfig();
const DIST = join(import.meta.dir, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

const file = async (path: string) => {
  const f = Bun.file(join(DIST, path));
  return (await f.exists()) ? f : null;
};

serve({
  hostname: cfg.host,
  port: cfg.port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/config") {
      return Response.json({ servers: cfg.servers, ui: cfg.ui });
    }

    const m = url.pathname.match(/^\/api\/s\/(\d+)(\/.*)?$/);
    if (m) {
      const target = cfg.servers[Number(m[1])];
      if (!target) return new Response("unknown server", { status: 404 });
      const res = await fetch(target.url + (m[2] ?? "") + url.search, req);
      return new Response(res.body, { status: res.status, headers: res.headers });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const f = await file(path);
    if (f) {
      const ext = path.slice(path.lastIndexOf("."));
      return new Response(f, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
    }
    const idx = await file("index.html"); // SPA fallback
    if (idx) return new Response(idx, { headers: { "content-type": MIME[".html"] } });
    return new Response("not found", { status: 404 });
  },
});

console.log(`front-end server http://${cfg.host}:${cfg.port} (${cfg.servers.length} backends proxied)`);
