# API Contract — opencode token dashboard (思路一)

Shared contract between `server/` (FastAPI aggregator over `opencode db`) and `client/` (bun/TS visualizer). Both sides MUST implement exactly this. Server implements the API; client consumes it. Field names are camelCase JSON. All token/cost numbers are integers/floats (never null; missing = 0).

## Conventions

- Base path: none (routes at root).
- Time: epoch milliseconds (integer).
- Ordering: descending by `cost` at every level (ties: by name/id).
- `tokens` object shape (identical everywhere):
  ```json
  "tokens": {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  ```
  `total` = input + output + reasoning + cacheRead + cacheWrite.
- Cost: USD float.
- Server binds loopback; no auth for MVP (client and server on same host, or trusted network).

## Endpoints

### `GET /health`
```json
{"status": "ok", "version": "1.18.10"}
```
`version` = the opencode version the host runs.

### `GET /overview`
Whole-host aggregate.
```json
{
  "host": "my-machine",
  "opencodeVersion": "1.18.10",
  "dashboardVersion": "0.4.1",
  "projectCount": 8,
  "sessionCount": 191,
  "mainSessionCount": 157,
  "tokens": {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
  "cost": 12.34,
  "updatedAt": 1785571208048
}
```
`updatedAt` = max `time_updated` across `session`/`message` (poll signal for the client). `dashboardVersion` = the opencode-dashboard-server release running the backend (`importlib.metadata`, falls back to `"unknown"` when uninstalled).
`sessionCount` = all sessions; `mainSessionCount` = main (root) sessions only — sessions whose `parent_id` is NULL or points at a session not in the DB (i.e. the count of tree roots). Subagent/fork sessions are excluded from `mainSessionCount`.

### `GET /projects`
Array of per-project rollups.
```json
[
  {
    "id": "3beb136201707db9a316eb2f8c855fc4a4f86815",
    "name": "cli-tools-registry",
    "worktree": "/Users/gcszhn/Documents/project/cli-tools-registry",
    "sessionCount": 63,
    "mainSessionCount": 48,
    "tokens": {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    "cost": 5.23
  }
]
```
`name` = basename of `worktree`. `sessionCount`/`mainSessionCount` as in `/overview`.

### `GET /models`
Whole-host per-model rollup (per-message aggregation across all sessions; covers mid-conversation model switches).
```json
[
  {"model": "claude-sonnet-4-5", "provider": "anthropic", "mode": "build",
   "messageCount": 29, "tokens": {...}, "cost": 5.21},
  {"model": "deepseek-v4-flash", "provider": "deepseek", "mode": "build",
   "messageCount": 17, "tokens": {...}, "cost": 0.013}
]
```
Same entry shape as `models` in `/sessions/{sessionId}`, but aggregated host-wide. Rows are grouped by `(model_id, provider, mode)` then merged by display model name (so prefixed/unprefixed ids like `deepseek/deepseek-v4-flash` and `deepseek-v4-flash` don't duplicate; on merge the higher-cost row keeps its provider/mode label). `messageCount` = assistant messages contributing tokens for that model. Ordered by `cost` desc (ties by model name). Empty array if no assistant token-bearing messages.

### `GET /projects/{projectId}`
Project detail + its full session list (flat, with `parentId`; client builds the tree; roots have `parentId: null`).
```json
{
  "project": {"id": "...", "name": "libshell", "worktree": "/...", "sessionCount": 3, "tokens": {...}, "cost": 0.5},
  "sessions": [
    {
      "id": "ses_...",
      "parentId": null,
      "projectId": "...",
      "title": "fix foo",
      "agent": "build",
      "model": "deepseek-v4-flash",
      "timeCreated": 1785571208048,
      "timeUpdated": 1785571656477,
      "tokens": {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
      "cost": 0.014
    }
  ]
}
```
`model` = the session's model id as a plain string (strip provider prefix if present, e.g. `deepseek/deepseek-v4-flash` → `deepseek-v4-flash`).

### `GET /sessions/{sessionId}`
Session detail + per-model breakdown (per-message aggregation; covers mid-conversation model switches).
```json
{
  "session": {"id": "ses_...", "parentId": null, "projectId": "...", "title": "fix foo", "agent": "build",
              "model": "deepseek-v4-flash", "version": "local",
              "timeCreated": 1785571208048, "timeUpdated": 1785571656477,
              "tokens": {...}, "cost": 0.014},
  "models": [
    {"model": "deepseek-v4-flash", "provider": "deepseek", "mode": "build",
     "messageCount": 17, "tokens": {...}, "cost": 0.013}
  ]
}
```
`messageCount` = assistant messages contributing tokens for that model. `models` ordered by `cost` desc. Empty array if no assistant token-bearing messages.

### `GET /stream`
Server-Sent Events. Server polls the DB internally (≈5s) for changes via `time_updated`; on change it broadcasts:
```
data: {"type":"updated","at":1785571656477,"scope":"overview"}

data: {"type":"updated","at":1785571656477,"scope":"project","id":"3beb..."}

data: {"type":"updated","at":1785571656477,"scope":"session","id":"ses_..."}
```
Plus a heartbeat every 15s: `data: {"type":"heartbeat"}`. `scope` tells the client which resource to refetch: `overview` → `/overview` + `/projects`; `project` → also `/projects/{id}`; `session` → also `/sessions/{id}`. Event format: `event: update\ndata: {...}` with `id` field optional.

## Server data sources (server-side only, not exposed)

- All data read via `opencode db "<SQL>" --format json|tsv` (never direct file open). Schema + gotchas in `AGENTS.md`.
- Project/session rollups come from `session` table columns (`cost`, `tokens_input/output/reasoning/cache_read/cache_write`).
- Per-model breakdown from `message.data` JSON (`role='assistant'`, `tokens` not null), grouped by `(session_id, model_id, provider_id, mode)`.
- Host-wide `/models` aggregates the same rows grouped by `(model_id, provider, mode)`, then merges by display name.
- 404 JSON for unknown project/session ids: `{"detail": "..."}` (FastAPI default).

## Error handling
- Non-200: FastAPI `{"detail": "..."}`. Client treats non-200 as server error.
- Server must not fail the whole request if one aggregation subquery errors; return 500 `{"detail": ...}` only on real failures.
