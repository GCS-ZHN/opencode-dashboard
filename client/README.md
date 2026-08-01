# opencode-dashboard-client

Front end for [opencode-dashboard](https://github.com/GCS-ZHN/opencode-dashboard) — a live, hierarchical
view of opencode token usage (server → project → session → model), with input / output / reasoning /
cache tokens and cost at every level.

The npm package ships the **built SPA** plus the **front-end server**, which is the single entry point
for browsers: it serves the SPA and proxies `/api/s/{i}/*` to the configured aggregation backends.
Real backends stay hidden from the client's network.

## Install

```bash
npm install opencode-dashboard-client
```

Requires Node ≥ 22 and [bun](https://bun.sh) (the front-end server runs on bun).

## Usage

1. Point the front-end server at your backends — edit `src/config.ts`:
   ```ts
   export const servers = [
     { name: "main", url: "http://127.0.0.1:8791" },
     { name: "backup", url: "http://127.0.0.1:8792" },
   ];
   ```
2. Run the front-end server (serves the built SPA + proxies `/api/s/{i}/*`):
   ```bash
   bun server.ts        # PORT env, default 5173 → open http://localhost:5173/
   ```

Each configured backend is one tab (with an **Overall** tab showing all of them in a grid). Sessions
render as parent/child trees — subagents are collapsed by default and a parent's totals include all
descendants. Live updates come over SSE, so the page refreshes itself as opencode writes.

## Development

```bash
bun install       # install dev deps (typescript, vite)
bun run dev       # Vite dev server (same /api/s/{i} proxy from config.ts) → :5173
bun run build     # typecheck (tsc) + bundle (vite)
bun mock-server.ts  # serve canned API data for frontend-only work
```

Full project docs (architecture, API contract, publishing) live in the repo
[README](https://github.com/GCS-ZHN/opencode-dashboard).
