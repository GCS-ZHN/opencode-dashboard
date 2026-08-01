import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

// Standard XDG config home; the CLI writes config.yaml under <configHome>/opencode-dashboard/.
export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export function xdgConfigPath(): string {
  return join(xdgConfigHome(), "opencode-dashboard", "config.yaml");
}

// Priority: DASHBOARD_CONFIG env > repo client/dashboard.yaml (dev) > XDG config.
function resolveConfigPath(): string {
  if (process.env.DASHBOARD_CONFIG) return process.env.DASHBOARD_CONFIG;
  const repo = join(baseDir(), "dashboard.yaml");
  if (existsSync(repo)) return repo;
  return xdgConfigPath();
}

// Node-only module (CLI / vite config / mock server). The browser never imports
// this — the SPA fetches the resolved values from /api/config.
export function loadDashboardConfig(path: string = resolveConfigPath()): DashboardConfig {
  let doc: DashboardConfig = { servers: [] };
  if (existsSync(path)) {
    doc = (YAML.parse(readFileSync(path, "utf8")) ?? {}) as DashboardConfig;
  }
  const port = Number(process.env.PORT ?? doc.port ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port in ${path}: ${String(doc.port)}`);
  }
  const sessionPage = Number(doc.ui?.sessionPage ?? 30);
  return {
    host: process.env.HOST ?? doc.host ?? "0.0.0.0",
    port,
    servers: doc.servers ?? [],
    ui: { sessionPage: Number.isInteger(sessionPage) && sessionPage > 0 ? sessionPage : 30 },
  };
}
