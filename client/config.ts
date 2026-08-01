import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export interface ServerConfig {
  name: string;
  url: string;
}

export interface DashboardConfig {
  host?: string;
  port?: number;
  servers: ServerConfig[];
  ui?: { sessionPage?: number };
}

// Works under bun (import.meta.dir) and vite's config loader (import.meta.url).
function baseDir(): string {
  try {
    return import.meta.dir ?? dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

// Node-only module (front-end server / vite config / mock server). The browser
// never imports this — the SPA fetches the resolved values from /api/config.
export function loadDashboardConfig(
  path: string = process.env.DASHBOARD_CONFIG ?? join(baseDir(), "dashboard.yaml"),
): DashboardConfig {
  const doc = YAML.parse(readFileSync(path, "utf8")) as DashboardConfig;
  return {
    host: process.env.HOST ?? doc.host ?? "0.0.0.0",
    port: Number(process.env.PORT ?? doc.port ?? 5173),
    servers: doc.servers ?? [],
    ui: { sessionPage: doc.ui?.sessionPage ?? 30 },
  };
}

