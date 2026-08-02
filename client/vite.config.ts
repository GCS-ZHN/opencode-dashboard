import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { loadDashboardConfig } from "./config";

// Front-end server (dev): browser only talks to this dev server. Requests to
// /api/s/{i}/* are proxied to the configured backends, and /api/config serves
// the resolved server list + ui options from dashboard.yaml.
const cfg = loadDashboardConfig();

// Regex-like keys (string, "^" prefix) avoid prefix-shadowing: /api/s/1 must
// not swallow /api/s/10 (vite matches string keys via startsWith in insertion
// order). Built with string keys, not Object.fromEntries — that would coerce
// RegExp instances into "/^.../" strings that vite can't recognize as regexes.
const proxy: Record<string, ProxyOptions> = {};
cfg.servers.forEach((s, i) => {
  proxy[`^/api/s/${i}(?=/|$)`] = {
    target: s.url,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/s\/\d+/, ""),
  };
});

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
