#!/usr/bin/env node
// opencode-dashboard CLI — pure node (no bun API).
//   serve:     front-end server (static dist/ + /api/config + /api/s/{i}/* proxy)
//   configure: interactive wizard that writes the XDG config file.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { basicAuthChallenge, checkBasicAuth } from "./auth";
import pkg from "./package.json" with { type: "json" };
import { loadDashboardConfig, xdgConfigPath, type DashboardConfig } from "./config";
import { createMcpHandler } from "./mcp";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const HAS_DIST = existsSync(DIST);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function asNumber(raw: string | undefined, def: number, label: string): number {
  const s = raw?.trim() ?? "";
  if (!s) return def;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`invalid ${label}: ${s}`);
    process.exit(1);
  }
  return n;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length || req.method === "GET" || req.method === "HEAD") return undefined;
  return Buffer.concat(chunks);
}

// Forward to a backend preserving method/headers/body and streaming the response
// (SSE flows through without buffering).
async function proxy(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.toLowerCase() === "host" || HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  const body = await readBody(req);
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
  } catch {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("proxy error");
    return;
  }
  const out: Record<string, string | string[]> = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  if (!HAS_DIST) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("dist not found — run the build first");
    return;
  }
  const rel = (pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  const filePath = resolve(DIST, rel);
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  let data: Buffer;
  try {
    data = await readFile(filePath);
    const ext = rel.slice(rel.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    try {
      data = await readFile(join(DIST, "index.html")); // SPA fallback
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }
}

function serve(argv: string[]): void {
  let cfg = loadDashboardConfig();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--port") {
      const v = argv[++i];
      if (v === undefined) return usage("--port requires a value");
      cfg = { ...cfg, port: asNumber(v, cfg.port ?? 5173, "port") };
    } else if (flag === "--host") {
      const v = argv[++i];
      if (v === undefined) return usage("--host requires a value");
      cfg = { ...cfg, host: v };
    } else {
      return usage(`unknown option: ${flag}`);
    }
  }
  const mcpHandler = createMcpHandler(cfg);
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isMcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
    // Auth gate: basic auth guards every route (SPA, /api/config, /api/s/{i}
    // proxy, and /mcp). The browser caches credentials per-realm, so after the
    // first prompt same-origin fetches and EventSource carry them automatically.
    if (cfg.auth && !checkBasicAuth(req, cfg.auth)) {
      basicAuthChallenge(res);
      return;
    }

    // /mcp, /mcp/, and any /mcp/<sub> all reach the MCP handler (matches vite's
    // connect use("/mcp", ...) prefix semantics so dev and prod stay aligned).
    if (isMcp) {
      void mcpHandler(req, res);
      return;
    }

    if (url.pathname === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: pkg.version, servers: cfg.servers, ui: cfg.ui }));
      return;
    }

    const m = url.pathname.match(/^\/api\/s\/(\d+)(\/.*)?$/);
    if (m) {
      const target = cfg.servers[Number(m[1])];
      if (!target) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unknown server");
        return;
      }
      void proxy(req, res, target.url + (m[2] ?? "") + url.search);
      return;
    }

    void serveStatic(res, url.pathname);
  }).listen(cfg.port ?? 5173, cfg.host ?? "0.0.0.0", () => {
    console.log(`front-end server http://${cfg.host ?? "0.0.0.0"}:${cfg.port ?? 5173} (${cfg.servers.length} backends proxied)`);
  });
}

function readExisting(path: string): DashboardConfig | null {
  if (!existsSync(path)) return null;
  try {
    return (YAML.parse(readFileSync(path, "utf8")) ?? {}) as DashboardConfig;
  } catch {
    console.error(`could not parse ${path}; starting from defaults`);
    return null;
  }
}

async function configure(): Promise<void> {
  const path = xdgConfigPath();
  const existing = readExisting(path);
  if (existing) {
    console.log("current config:");
    console.log(
      `  servers: ${existing.servers?.map((s) => `${s.name} (${s.url})`).join(", ") || "(none)"}`,
    );
    console.log(
      `  port: ${existing.port ?? 5173}, host: ${existing.host ?? "0.0.0.0"}, ui.sessionPage: ${existing.ui?.sessionPage ?? 30}`,
    );
    console.log(
      `  auth: ${existing?.auth?.username && existing?.auth?.password ? `basic (user: ${existing.auth.username})` : "basic disabled"}`,
    );
  }

  const servers: DashboardConfig["servers"] = existing?.servers ?? [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const next = rl[Symbol.asyncIterator]();
  const ask = async (q: string): Promise<string> => {
    process.stdout.write(q);
    const { value } = await next.next();
    return value ?? "";
  };
  // Password prompt without echo on a TTY; falls back to ask when piped
  // (automation) since hidden input is impossible there.
  const askHidden = async (q: string): Promise<string> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return ask(q);
    const rlInternal = rl as unknown as { _writeToOutput: (s: string) => void };
    if (typeof rlInternal._writeToOutput !== "function") return ask(q);
    const orig = rlInternal._writeToOutput.bind(rlInternal);
    rlInternal._writeToOutput = () => {};
    process.stdout.write(q);
    const { value } = await next.next();
    rlInternal._writeToOutput = orig;
    process.stdout.write("\n");
    return value ?? "";
  };

  while (true) {
    const name = (await ask(`backend name${servers.length ? " (empty to stop)" : ""}: `)).trim();
    if (!name) break;
    const url = (await ask("backend url: ")).trim();
    if (!url) break;
    servers.push({ name, url });
    if (!/^y(es)?$/i.test((await ask("add another backend? [y/N] ")).trim())) break;
  }

  const port = asNumber(await ask(`front-end port [${existing?.port ?? 5173}]: `), existing?.port ?? 5173, "port");
  const host = (await ask(`front-end host [${existing?.host ?? "0.0.0.0"}]: `)).trim() || existing?.host || "0.0.0.0";
  const sessionPage = asNumber(
    await ask(`ui.sessionPage [${existing?.ui?.sessionPage ?? 30}]: `),
    existing?.ui?.sessionPage ?? 30,
    "sessionPage",
  );
  const curUser = existing?.auth?.username ?? "";
  const curPass = existing?.auth?.password ?? "";
  const authEnabled = Boolean(curUser && curPass);
  const rawUser = (await ask(`HTTP Basic auth username [${curUser}]: `)).trim();
  let username: string;
  let password: string;
  let disableAuth = false;
  if (rawUser) {
    username = rawUser;
    password = (await askHidden(`HTTP Basic auth password [${curPass ? "••••••" : ""}]: `)).trim() || curPass;
  } else if (authEnabled && /^y(es)?$/i.test((await ask("disable auth? [y/N] ")).trim())) {
    username = "";
    password = "";
    disableAuth = true;
  } else {
    username = curUser;
    password = curPass;
  }
  const auth = username && password ? { username, password } : undefined;
  rl.close();

  const out: Record<string, unknown> = { host, port, servers, ui: { sessionPage } };
  if (auth) out.auth = auth;
  else if (disableAuth) out.auth = { username: "", password: "" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(out), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`wrote ${path}`);
}

function usage(error?: string): void {
  const msg = `opencode-dashboard — front-end for the opencode token-usage dashboard

usage: opencode-dashboard <command>

commands:
  serve [--port N] [--host H]   start the front-end server (serves dist/, proxies /api/s/{i}/*)
  configure                     interactively write ${xdgConfigPath()}`;
  if (error) {
    console.error(`${error}\n\n${msg}`);
    process.exit(1);
  }
  console.log(msg);
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "serve":
      serve(process.argv.slice(3));
      break;
    case "configure":
      await configure();
      break;
    case undefined:
    case "-h":
    case "--help":
      usage();
      break;
    default:
      usage(`unknown command: ${process.argv[2]}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
