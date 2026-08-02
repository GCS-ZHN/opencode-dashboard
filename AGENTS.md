# AGENTS.md

Dashboard that visualizes opencode token usage — drill-down across server → project → session → model (input/output/reasoning/cache tokens + cost). Both packages are **built, published, and deployed as CLIs** (v0.3.0): npm `opencode-dashboard-client` → `opencode-dashboard`, PyPI `opencode-dashboard-server` → `opencode-dashboard-server`. This file records the verified facts and conventions so future sessions build against reality, not assumptions.

## Data source: opencode's SQLite storage

Source of truth is opencode's local DB, queried only via the CLI:

```
opencode db "<SQL>" --format json   # or --format tsv for big pulls
```

- Storage: `~/.local/share/opencode/opencode.db` (SQLite, WAL mode, can be 300MB+). **Always use the `opencode db` wrapper — never open the file directly** while opencode runs (WAL/locking).
- Reference logic: `~/Downloads/export_token_usage.py` (per-message aggregation + parent/child session tree); the server's SQL was migrated from it (`server/aggregate.py`).

### Verified schema (opencode 1.18.10)

- `project(id, worktree, name, ...)` — display name = `basename(worktree)`.
- `session(id, project_id, parent_id, title, time_created, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, ...)` — denormalized per-session token/cost columns (recent addition); good for session-level rollups.
- `message(id, session_id, time_created, data)` — `data` is JSON, per-message granularity (needed when a session switches models mid-conversation): `data.role=='assistant'`, `data.modelID`, `data.providerID`, `data.mode`; `data.tokens={input,output,reasoning,cache:{read,write}}`, `data.cost`.
- `session.parent_id` builds the subagent/fork tree; roots have `parent_id IS NULL`. `mainSessionCount` (in `/overview` + `/projects`) = roots *or* orphans (parent_id NULL **or** pointing at a session not in the DB) — `aggregate.py:46-48`.

### Gotchas

- Token/cost values can legitimately be `0` (some models report nothing) — not data errors.
- `message` grows to tens of thousands of rows; aggregate in SQL with `json_extract(data,'$....')`; use `--format tsv` for big pulls (JSON output blows up).
- Directory-grouped ("global" worktree `/`) sessions use ids `'dir:' + lower(hex(directory))` so ids are URL-safe — raw paths would break `/projects/{id}` routes (`aggregate.py:32-36`).

## Architecture (settled)

思路一 (own aggregator over `opencode db`) was chosen; 思路二 (opencode `serve` API) was rejected because full-history enumeration rides undocumented routes (`/api/session`, `/experimental/session`) that break on upgrades.

- **Per-host backend** = FastAPI aggregator (`server/`). Reads storage via `opencode db`, exposes `API.md` endpoints + SSE `/stream`.
- **Front-end server = single entry point.** The browser only talks to the front-end server (never real backends — they may be unreachable from the client's network). It proxies `/api/s/{i}/*` → the i-th configured backend and exposes `GET /api/config` (servers + ui options), which the SPA fetches at startup — **no backend URLs are ever bundled into the browser**.
- Both `server.ts`/CLI serve and the Vite dev server share the same `/api/s/{i}` route scheme, so dev↔prod switching is transparent.

## MCP server (on the front-end server, at `/mcp`)

- `client/mcp.ts` exposes a **read-only MCP server on the same process as the front-end server** (`cli.ts` `serve`), reachable at `/mcp` and `/mcp/` (both work; `/mcp/<sub>` also routes there). Uses `@modelcontextprotocol/sdk@^1.30.0` `StreamableHTTPServerTransport`.
- Tools: `list_servers`, `overview`, `projects`, `project_detail`, `session_detail` — each takes a `server` index and GETs the backend exactly like the `/api/s/{i}` proxy. **MCP clients never talk to real backends directly** (same trust boundary as the SPA).
- Per-request lifecycle is SDK-mandated: the SDK throws on reusing a stateless transport, so each request gets a fresh `Server` + transport. Version string is imported from `package.json` (`pkg.version`) — keep it in sync with the release bump.
- SPA shows the endpoint URL + copy in the app header (`#mcp-box`), built from `location.origin` — **never a hardcoded host/port**.
- Vite dev parity: `vite.config.ts` mounts `/mcp` via connect middleware, but **the dev-server MCP handshake is unreliable with opencode's client** (seen: `SSE error: Unable to connect`). For real opencode integration testing, run the **prod CLI serve** (`node dist-cli/cli.mjs serve`) — that's the supported path.

### MCP server auth (HTTP basic auth)

`/mcp` is protected by the same basic auth as the rest of the front-end server (when `auth.username`/`auth.password` are set). A 401 + `WWW-Authenticate: Basic` on `/mcp` is correct. opencode MCP clients must send the credentials as a header — **the URL-userinfo form does NOT work**: opencode reports "needs authentication" for `http://user:password@host:port/mcp` and never sends URL userinfo as basic auth. Use the config `headers` field instead:
```jsonc
// .opencode/config.jsonc
{ "mcp": { "opencode-dashboard": { "type": "remote", "url": "http://127.0.0.1:5180/mcp",
    "headers": { "Authorization": "Basic <base64(user:pass)>" } } } }
```
- Compute `<base64(user:pass)>` with e.g. `printf 'user:pass' | base64`.
- In the browser, basic-auth credentials are cached per-realm, so after the single initial prompt the SPA's same-origin fetches AND EventSource carry them automatically — no cookie/bearer logic needed in the SPA (there is none).

### Verifying the MCP server with `opencode run` (manual smoke test)

1. Start the front-end server in prod mode with the backend configured: `cd client && bun run build && node dist-cli/cli.mjs serve --port 5180` (or `DASHBOARD_CONFIG=<yaml>` for a custom backend set).
2. Add a **project-level** MCP entry pointing at it (config file location per opencode docs; remove after testing — never commit a test-only MCP pointing at a running dev server):
   ```jsonc
   // .opencode/config.jsonc
   { "mcp": { "opencode-dashboard": { "type": "remote", "url": "http://127.0.0.1:5180/mcp" } } }
   ```
   Load it explicitly: `OPENCODE_CONFIG=.opencode/config.jsonc opencode mcp list` → expect `✓ connected`.
3. Run a tool-calling prompt (note the model needs its provider prefix, e.g. `deepseek/deepseek-v4-flash`):
   ```bash
   OPENCODE_CONFIG=.opencode/config.jsonc opencode run \
     "使用 opencode-dashboard 的 MCP 工具: overview(server 0) + projects(server 0), 报告数字" \
     --model deepseek/deepseek-v4-flash
   ```
   Expect `opencode-dashboard_overview` / `opencode-dashboard_projects` to fire and return real numbers.

## CLI & configuration (XDG — never edit installed package files)

Installed packages are configured via interactive `configure`, writing to the **shared XDG dir** `~/.config/opencode-dashboard/` — front-end `config.yaml`, back-end `server.yaml`. There is deliberately **no in-package config file**; do not edit files inside `node_modules`/venv to configure.

- Front-end `opencode-dashboard`: `configure` (interactive wizard) + `serve [--port] [--host]`. Config precedence: `DASHBOARD_CONFIG` env > repo `client/dashboard.yaml` (dev only, not shipped) > XDG `config.yaml` > defaults (port 5173, host 0.0.0.0, sessionPage 30). Optional auth via `auth.username`/`auth.password` (env: `DASHBOARD_AUTH_USERNAME`, `DASHBOARD_AUTH_PASSWORD`; basic enabled only when both set). Auth is enforced in `cli.ts` serve + Vite dev middleware (`client/auth.ts`, constant-time compare). Policy: basic auth guards **all** routes — SPA static files, `/api/config`, `/api/s/{i}` proxy, and `/mcp`. The SPA has no auth-specific code: the browser caches credentials per-realm, so fetches and EventSource carry them automatically.
- Back-end `opencode-dashboard-server`: `configure` + `serve [--port] [--host] [--config PATH]`. Precedence: `--config` > XDG `server.yaml` > env > defaults. Env switches: `DASHBOARD_CORS_ORIGINS` (comma-separated, default = loopback whitelist), `DASHBOARD_POLL_SECONDS` (default 5), `OPENCODE_BIN`, `PORT`, `HOST`.
- `configure` must work from a **piped stdin** (EOF → use default), not just interactive TTY.

## Layout & stack

- `API.md` — the server↔client contract (endpoints, JSON shapes camelCase, epoch-ms timestamps, SSE format). Change it first, then both sides.
- `server/` — Python ≥3.10, `uv`, FastAPI, `pytest`. `app.py:create_app(runner=None, cors_origins=None, poll_seconds=None, opencode_bin=None)` — tests inject an in-memory SQLite fixture (`SqliteRunner`) while prod shells out (`CliRunner`); every param resolves explicit > env > default. `cli.py` is the console-script entry. Dev run: `uv run uvicorn app:app --reload` (port 8791).
- `client/` — Node ≥22, `bun`, TypeScript, Vite (vanilla TS, no UI/chart libs). `cli.ts` is pure Node, bundled to `dist-cli/cli.mjs` (bun build, node shebang) — **the CLI runs on node, not bun**. Repo `dashboard.yaml` is dev-only (vite dev proxy + `/api/config` via `vite.config.ts`). Build order: `tsc && tsc -p tsconfig.node.json && vite build && bun build cli.ts --target=node`. Client tests: `bun test mcp.test.mjs export.test.ts` (Node ≥22 `node:test`, no framework; test files live at `client/*.test.*`, outside `src/` so the app tsconfig doesn't typecheck them).
- Vite proxy keys are **regex** (`^/api/s/${i}(?=/|$)`) — string prefixes let `/api/s/1` swallow `/api/s/10` (`vite.config.ts`). `xlsx` is a **devDependency** (build-time only; the browser code lazy-imports it via `await import("xlsx")` so it loads as a separate chunk only on export).

## Publishing & CI

- Tag `v*` → GitHub Actions `publish.yml`: npm (`opencode-dashboard-client`) + PyPI (`opencode-dashboard-server`) + GitHub Release (wheel/sdist/client-dist.zip). Secrets: `NPM_TOKEN`, `PYPI_API_TOKEN` (set via `gh secret set`).
- `ci.yml` runs on push/PR: server `uv sync && uv run pytest -q && uvx ruff check .`; client `bun install --frozen-lockfile && bun run build`.
- One-time repo secrets (already set; re-set only if they rotate): `gh secret set NPM_TOKEN` (Automation, publish scope), `gh secret set PYPI_API_TOKEN` (project-scoped).
- Release flow: bump version in **both** `client/package.json` and `server/pyproject.toml` (must equal the tag); **then `cd server && uv lock`** — `uv.lock` records the project version and a stale lock fails `uv build` in CI. Commit → `git tag vX.Y.Z && git push origin vX.Y.Z` → verify the run (`gh run watch`) and refresh the release notes.
- Packages keep registry metadata in code: `package.json` `homepage`/`repository`/`bugs`; `pyproject.toml` `[project.urls]` + `[project.scripts]`.

## Workflow

- Verify commands before claiming success: server = `uv run pytest -q` + `uvx ruff check .`; client = `bun run build` (tsc + node tsc + vite + cli bundle).
- Before touching aggregation logic, re-verify the schema with `opencode db` — table columns change across opencode versions. Keep SQL close to the reference script's proven queries; test aggregation against the seeded in-memory fixture (`server/tests/conftest.py`).
- Local macOS deployment uses LaunchAgents (`~/Library/LaunchAgents/com.opencode-dashboard*.plist`, user-level, `KeepAlive`). If you change serve behavior, the plists just call `... serve` — restart via `launchctl kickstart -k gui/$(id -u)/com.opencode-dashboard`.
