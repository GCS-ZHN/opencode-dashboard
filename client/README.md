# opencode-dashboard-client

Front end for [opencode-dashboard](https://github.com/GCS-ZHN/opencode-dashboard) — a live, hierarchical
view of opencode token usage (server → project → session → model), with input / output / reasoning /
cache tokens and cost at every level.

The npm package ships the **built SPA** plus the **front-end server**, which is the single entry point
for browsers: it serves the SPA and proxies `/api/s/{i}/*` to the configured aggregation backends.
Real backends stay hidden from the client's network.

## Install (npm)

```bash
npm install opencode-dashboard-client
```

Requires Node ≥ 22 and [bun](https://bun.sh) (the front-end server runs on bun).

## Quick start

```bash
cd node_modules/opencode-dashboard-client   # or wherever npm installed the package
```

1. **Point it at your backends** — edit `dashboard.yaml`:
   ```yaml
   servers:
     - name: main
       url: http://127.0.0.1:8791
     - name: backup
       url: http://127.0.0.1:8792
   ui:
     sessionPage: 30   # sessions loaded per page when a project is expanded
   ```
   `dashboard.yaml` is the single file you edit — the SPA fetches the server list + UI options from
   `GET /api/config` at startup, so there is nothing to rebuild after a change.

2. **Run the front-end server** (serves the built SPA + proxies `/api/s/{i}/*`):
   ```bash
   bun server.ts
   ```
   Env overrides: `PORT` (default 5173), `HOST` (default 0.0.0.0), `DASHBOARD_CONFIG` (config file
   path). Open http://localhost:5173/.

Each configured backend is one tab (with an **Overall** tab showing all of them in a grid). Sessions
render as parent/child trees — subagents are collapsed by default and a parent's totals include all
descendants. Live updates come over SSE, so the page refreshes itself as opencode writes.

## From source (development)

```bash
git clone https://github.com/GCS-ZHN/opencode-dashboard
cd opencode-dashboard/client
bun install        # install dev deps (typescript, vite, yaml)
bun run dev        # Vite dev server (same /api/s/{i} proxy + /api/config from dashboard.yaml) → :5173
bun run build      # typecheck (tsc) + bundle (vite)
bun mock-server.ts # serve canned API data for frontend-only work (PORT env, default 8791)
```

Full project docs (architecture, API contract, publishing) live in the repo
[README](https://github.com/GCS-ZHN/opencode-dashboard).
