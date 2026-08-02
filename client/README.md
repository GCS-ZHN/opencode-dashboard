# opencode-dashboard-client

Front end for [opencode-dashboard](https://github.com/GCS-ZHN/opencode-dashboard) — a live, hierarchical
view of opencode token usage (server → project → session → model), with input / output / reasoning /
cache tokens and cost at every level.

Installs as a CLI (`opencode-dashboard`): its `serve` command runs the **front-end server**, the single
entry point for browsers — it serves the built SPA and proxies `/api/s/{i}/*` to the configured
aggregation backends. Real backends stay hidden from the client's network.

## Install (npm)

```bash
npm install -g opencode-dashboard-client
```

Requires Node ≥ 22. Works anywhere with `npx opencode-dashboard ...` too.

## Configure

Write the config interactively to the standard XDG path
(`$XDG_CONFIG_HOME/opencode-dashboard/config.yaml`, `~/.config/...` by default):

```bash
opencode-dashboard configure
```

Add one backend per prompt (`name` + `url`, e.g. `main` / `http://127.0.0.1:8791`), then set the
front-end port, host, and `ui.sessionPage`. Re-run it any time to preview and extend the existing
config. You can also hand-edit the file — the SPA fetches the server list + UI options from
`GET /api/config` at startup, so there is nothing to rebuild after a change.

### Optional HTTP Basic Auth

Protect the whole front-end server — the SPA, `/api/config`, the `/api/s/{i}` proxy, and `/mcp` —
with standard HTTP Basic Auth:

```yaml
auth:
  username: admin
  password: secret
```

Set it via the `configure` wizard, by hand-editing the YAML, or with the `DASHBOARD_AUTH_USERNAME` /
`DASHBOARD_AUTH_PASSWORD` env vars (which override the file). Auth is **off by default** and is only
enforced when **both** fields are set. The browser prompts once and caches the credentials per-realm,
so subsequent fetches and the SSE stream carry them automatically — no front-end code involved. MCP
clients (e.g. opencode) must send the credentials as a header — `headers: { "Authorization": "Basic
<base64(user:pass)>" }` (`printf 'user:pass' | base64`); the `http://user:password@host:port/mcp` URL
form does **not** work with opencode. See "MCP server auth" in the main README for details.

## Run

```bash
opencode-dashboard serve [--port N] [--host H]
```

Serves the SPA on the configured host/port (default `0.0.0.0:5173`) and proxies `/api/s/{i}/*` to the
configured backends. CLI flags beat env vars (`PORT`, `HOST`), which beat the config file. Open
http://localhost:5173/.

Each configured backend is one tab (with an **Overall** tab showing all of them in a grid). Sessions
render as parent/child trees — subagents are collapsed by default and a parent's totals include all
descendants. Live updates come over SSE, so the page refreshes itself as opencode writes.

## From source (development)

```bash
git clone https://github.com/GCS-ZHN/opencode-dashboard
cd opencode-dashboard/client
bun install        # install dev deps (typescript, vite, yaml)
bun run dev        # Vite dev server (reads repo dashboard.yaml) → :5173
bun run build      # typecheck (tsc) + bundle (vite + CLI)
bun run serve      # run the built CLI: node dist-cli/cli.mjs serve
bun mock-server.ts # serve canned API data for frontend-only work (PORT env, default 8791)
bun run mock-backend.ts # large slow dataset backend for loading-state/caching work (PORT env, default 8899)
bun run test:e2e   # Playwright: boots mock-backend + built front-end, runs client/e2e/ specs
```

During dev the repo `dashboard.yaml` is used; the published package never ships it — runtime
configuration lives in the XDG file written by `opencode-dashboard configure`.

Full project docs (architecture, API contract, publishing) live in the repo
[README](https://github.com/GCS-ZHN/opencode-dashboard).
