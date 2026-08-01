import { defineConfig, type Plugin } from "vite";
import { loadDashboardConfig } from "./config";

// Front-end server (dev): browser only talks to this dev server. Requests to
// /api/s/{i}/* are proxied to the configured backends, and /api/config serves
// the resolved server list + ui options from dashboard.yaml.
const cfg = loadDashboardConfig();

// Regex keys avoid prefix-shadowing: /api/s/1 must not swallow /api/s/10
// (vite matches string keys via startsWith in insertion order).
const proxy = Object.fromEntries(
  cfg.servers.map((s, i) => [
    new RegExp(`^/api/s/${i}(?=/|$)`),
    {
      target: s.url,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/s\/\d+/, ""),
    },
  ]),
);

function apiConfigPlugin(): Plugin {
  return {
    name: "api-config",
    configureServer(server) {
      server.middlewares.use("/api/config", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ servers: cfg.servers, ui: cfg.ui }));
      });
    },
  };
}

export default defineConfig({
  plugins: [apiConfigPlugin()],
  server: { port: cfg.port, proxy },
});
