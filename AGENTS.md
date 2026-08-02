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

## CLI & configuration (XDG — never edit installed package files)

Installed packages are configured via interactive `configure`, writing to the **shared XDG dir** `~/.config/opencode-dashboard/` — front-end `config.yaml`, back-end `server.yaml`. There is deliberately **no in-package config file**; do not edit files inside `node_modules`/venv to configure.

- Front-end `opencode-dashboard`: `configure` (interactive wizard) + `serve [--port] [--host]`. Config precedence: `DASHBOARD_CONFIG` env > repo `client/dashboard.yaml` (dev only, not shipped) > XDG `config.yaml` > defaults (port 5173, host 0.0.0.0, sessionPage 30).
- Back-end `opencode-dashboard-server`: `configure` + `serve [--port] [--host] [--config PATH]`. Precedence: `--config` > XDG `server.yaml` > env > defaults. Env switches: `DASHBOARD_CORS_ORIGINS` (comma-separated, default = loopback whitelist), `DASHBOARD_POLL_SECONDS` (default 5), `OPENCODE_BIN`, `PORT`, `HOST`.
- `configure` must work from a **piped stdin** (EOF → use default), not just interactive TTY.

## Layout & stack

- `API.md` — the server↔client contract (endpoints, JSON shapes camelCase, epoch-ms timestamps, SSE format). Change it first, then both sides.
- `server/` — Python ≥3.10, `uv`, FastAPI, `pytest`. `app.py:create_app(runner=None, cors_origins=None, poll_seconds=None, opencode_bin=None)` — tests inject an in-memory SQLite fixture (`SqliteRunner`) while prod shells out (`CliRunner`); every param resolves explicit > env > default. `cli.py` is the console-script entry. Dev run: `uv run uvicorn app:app --reload` (port 8791).
- `client/` — Node ≥22, `bun`, TypeScript, Vite (vanilla TS, no UI/chart libs). `cli.ts` is pure Node, bundled to `dist-cli/cli.mjs` (bun build, node shebang) — **the CLI runs on node, not bun**. Repo `dashboard.yaml` is dev-only (vite dev proxy + `/api/config` via `vite.config.ts`). Build order: `tsc && tsc -p tsconfig.node.json && vite build && bun build cli.ts --target=node`.
- Vite proxy keys are **regex** (`^/api/s/${i}(?=/|$)`) — string prefixes let `/api/s/1` swallow `/api/s/10` (`vite.config.ts`).

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
