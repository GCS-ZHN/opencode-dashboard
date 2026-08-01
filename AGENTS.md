# AGENTS.md

Dashboard that visualizes opencode token usage — drill-down across server → project → session → model, showing input/output/reasoning/cache tokens and cost. Server (`server/`) + client (`client/`) are built and working against the contract in `API.md`. This file records the verified data-source facts and conventions so future sessions build against reality, not assumptions.

## Data source: opencode's SQLite storage

The source of truth is opencode's local DB, queried via the `opencode db` CLI:

```
opencode db "<SQL>" --format json   # or --format tsv
```

- Storage lives at `~/.local/share/opencode/opencode.db` (SQLite, WAL mode; can be 300MB+). **Always use the `opencode db` wrapper** — never open the file directly while opencode is running (WAL/locking).
- Seed/reference logic: `~/Downloads/export_token_usage.py` — per-message aggregation + parent/child session tree. The server's SQL was migrated from it (`server/aggregate.py`).

### Verified schema (opencode 1.18.10)

- `project(id, worktree, name, time_created, ...)` — display name = `basename(worktree)`.
- `session(id, project_id, parent_id, title, version, time_created, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, metadata, ...)` — has denormalized per-session token/cost columns (recent addition); good for session-level rollups.
- `message(id, session_id, time_created, data)` — `data` is JSON. Per-message granularity (needed when a session switches models mid-conversation):
  - `data.role == 'assistant'`, `data.modelID`, `data.providerID`, `data.mode`
  - `data.tokens = {input, output, reasoning, cache:{read, write}}`, `data.cost`
- `session.parent_id` links subagent/fork sessions → build the session tree; roots have `parent_id IS NULL`.

### Gotchas

- Token/cost values can legitimately be `0` (e.g. some models report nothing) — don't treat zeros as data errors.
- `message` grows to tens of thousands of rows; aggregate in SQL with `json_extract(data,'$....')` and use `--format tsv` for big pulls (JSON output blows up, per the reference script).
- Sessions accumulate across all projects in one DB; filter by `project_id` or the parent tree.

## Architecture decision

Both designs were verified hands-on (opencode 1.18.10; local `opencode serve` + curl). Both are feasible — the tradeoff is stability vs. build effort. **Decision is still OPEN.**

- **思路二 (serve API only)** — VERIFIED FEASIBLE. Serve exposes everything the dashboard needs, but half of it rides undocumented routes:
  - Documented: `GET /session` (**current project only** — cannot be switched read-only), `GET /session/:id/message` (per-message `tokens`+`cost`+`modelID`/`providerID`/`mode` — covers mid-conversation model switches), `GET /session/:id/children`, `GET /event` SSE (events carry full Message/step token payloads → live counting without polling), `GET /project`. Requires HTTP Basic auth (`OPENCODE_SERVER_PASSWORD`; `--cors <origin>` for browser clients).
  - **Fragility**: full-history enumeration across projects needs **undocumented** routes — `GET /api/session?limit=500` (cursor-paginated, inline session `tokens`/`cost`/`parentID`) or `GET /experimental/session?limit=500` (plain list, `project` joined). Both are internal; an opencode upgrade can silently break them → pin the opencode version, wrap both behind one adapter, re-verify against `/doc` after upgrades.
  - N+1: per-model breakdown = one `GET /session/:id/message` per session; full scan ≈ 19s/86MB at ~192 sessions → do it **lazily** per drill-down (only ~4% of sessions switch models mid-conversation).
  - Escape hatch: if enumeration regresses, one `opencode db` call for the session list alone covers the gap (serve API handles the rest).
- **思路一 (own aggregator over `opencode db`)** — VERIFIED FEASIBLE, more code but a stable surface. Thin FastAPI server per opencode host shells out to `opencode db "<SQL>"` (WAL-safe; ~0.4s/query spawn cost), aggregates in SQL + Python, pushes SSE. Full aggregation ≈ 0.5s at current scale.

If 思路二 is chosen, the per-host "server" shrinks to a thin proxy/aggregator for auth + CORS (or none if the client is non-browser); if 思路一, build the server per the layout below.

## Layout & stack

- `API.md` — the shared server↔client contract (endpoints, JSON shapes, SSE). Both sides implement exactly this; change it first, then both sides.
- `server/` — Python 3.10+, `uv`, FastAPI, `pytest`. 思路一 aggregator: reads opencode storage via `opencode db` (never the file directly), exposes the `API.md` endpoints + SSE stream. `app.py:create_app(runner)` takes a runner so tests inject an in-memory SQLite fixture (`SqliteRunner`) while production shells out (`CliRunner`). CORS is wide-open (local tool). Run: `uv run uvicorn app:app --reload` (default port 8791).
- `client/` — Node ≥22, `bun`, TypeScript, Vite (vanilla TS, no UI/chart libs). Configuration lives in `dashboard.yaml` (servers, front-end server host/port, ui options) — never hardcode addresses/ports in code. Run: `bun install`, `bun run dev` (vite), `bun run build` (typecheck + bundle). `bun mock-server.ts` serves canned `API.md` JSON for frontend-only work.
- **Front-end server = single entry point.** The browser never reaches real backends directly (they may be unreachable from the client's network). It only talks to the front-end server, which proxies `/api/s/{i}/*` → the servers from `dashboard.yaml` and exposes `GET /api/config` (resolved servers + ui options, fetched by the SPA at startup). Dev uses the Vite dev server (`vite.config.ts` generates the proxy + `/api/config` from `dashboard.yaml`); prod uses `bun server.ts` (serves `dist/` + same routes; env overrides: `DASHBOARD_CONFIG`, `PORT`, `HOST`). Both share the same route scheme, so switching is transparent. (Client src uses relative `/api/s/{i}` paths — no backend URLs in the browser.)
- Backend env switches: `DASHBOARD_CORS_ORIGINS` (CORS allow-list, default loopback dev origins), `DASHBOARD_POLL_SECONDS` (SSE poll, default 5), `OPENCODE_BIN` (opencode CLI path).
- Run `pytest` inside `server/` (uv-managed); `bun run` scripts inside `client/`.

## Workflow

- Before touching aggregation logic, re-verify schema with `opencode db` — table columns change across opencode versions.
- Keep the server's SQL close to the reference script's proven queries; write `assert`-based checks or small `pytest` tests for aggregation against a seeded fixture DB (in-memory SQLite replicating the schema above).
