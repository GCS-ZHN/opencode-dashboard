# opencode-dashboard-server

FastAPI aggregation backend for the [opencode-dashboard](https://github.com/GCS-ZHN/opencode-dashboard)
project. Reads opencode's local SQLite storage via the `opencode db` CLI and exposes a JSON + SSE
API for the dashboard front end.

## Install (PyPI)

```bash
pip install opencode-dashboard-server
# or with uv:
uv tool install opencode-dashboard-server
```

Requires:

- **Python ≥ 3.10**
- **`opencode` CLI** on the same host — the server shells out to `opencode db "<SQL>"` and never
  opens the SQLite file directly (it's WAL-mode and actively written while opencode runs).

## Quick start

Configure once (interactive; writes `~/.config/opencode-dashboard/server.yaml`), then serve:

```bash
opencode-dashboard-server configure
opencode-dashboard-server serve
```

`configure` walks you through `port` (default `8791`), `host` (default `0.0.0.0`),
`cors_origins` (comma-separated; empty = built-in loopback whitelist), `poll_seconds`
(default `5`), and `opencode_bin` (default `opencode`). Empty input keeps the default.

`serve` accepts overrides: `--port N`, `--host H`, `--config PATH` (instead of the XDG file).
Precedence for port/host: CLI flag > env `PORT`/`HOST` > config file > default.

Run one aggregator per opencode host:

```bash
uvicorn app:app --port 8791
```

or directly with uvicorn (still works — reads env/defaults only). Run on more hosts with
different ports (`8792`, `8793`, …) and list each in the front end's config (`opencode-dashboard configure`).
Environment switches (used when no config file value is set):

- `DASHBOARD_CORS_ORIGINS` — comma-separated CORS allow-list (defaults to the loopback dev origins `localhost/127.0.0.1:5173` and `:4173`; tighten or widen for your deployment).
- `DASHBOARD_POLL_SECONDS` — SSE poll interval in seconds (default `5`).
- `OPENCODE_BIN` — path to the `opencode` binary if it's not on `PATH`.

## API

- `GET /health` — liveness
- `GET /overview` — whole-host aggregate (tokens by type + cost, session counts, `updatedAt`)
- `GET /projects` — per-project rollups
- `GET /projects/{id}` — one project's sessions (parent/child tree)
- `GET /sessions/{id}` — per-model breakdown for one session (handles mid-conversation model switches)
- `GET /stream` — SSE: `updated` events when the DB changes (polled ~5s)

JSON is camelCase, timestamps are epoch-ms. Full contract in the repo's `API.md`.

## From source (development)

```bash
git clone https://github.com/GCS-ZHN/opencode-dashboard
cd opencode-dashboard/server
uv sync          # install deps (fastapi, uvicorn) + dev (pytest, httpx)
uv run pytest    # run tests
uvx ruff check . # lint
```
