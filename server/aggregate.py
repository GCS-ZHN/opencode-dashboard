"""SQL + aggregation over the opencode storage, mirroring the proven logic in
~/Downloads/export_token_usage.py.

Project/session rollups come from the `session` table's denormalized token/cost
columns; per-model breakdowns aggregate `message.data` JSON. All values are
returned as integers/floats, never null (missing = 0).
"""

import json
from pathlib import Path

# token keys as emitted in API output -> session table column
TOKEN_COLS = ("input", "output", "reasoning", "cache_read", "cache_write")
SESS_COL = {
    "input": "tokens_input",
    "output": "tokens_output",
    "reasoning": "tokens_reasoning",
    "cache_read": "tokens_cache_read",
    "cache_write": "tokens_cache_write",
}

# column order of the per-message TSV pull (must match MESSAGES_SQL select list)
_MSG_KEYS = [
    "model_id", "provider", "mode", "message_count",
    "tokens_input", "tokens_output", "tokens_reasoning",
    "tokens_cache_read", "tokens_cache_write", "cost",
]

# Effective grouping key: real projects (worktree != "/") group by project_id;
# the catch-all "global" project (worktree "/") holds sessions from many folders,
# so split it by session.directory — otherwise unrelated sessions get misattributed.
# Directory groups use hex(directory) so the id is URL-safe (a raw path contains
# "/" which would split the FastAPI route segment and 404).
EFF_SQL = """
CASE WHEN p.worktree IS NOT NULL AND p.worktree != '/' THEN s.project_id
     ELSE 'dir:' || lower(hex(COALESCE(s.directory, ''))) END
"""

# Join + effective-key mapping live in a derived table so `id`/`worktree` are
# unambiguous result columns (s.id and p.id would otherwise clash in GROUP BY).
ROLLUP_SQL = f"""
SELECT gid AS id,
       MAX(worktree) AS worktree,
       COUNT(*) AS session_count,
       COUNT(DISTINCT CASE
           WHEN eff.parent_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM session p2 WHERE p2.id = eff.parent_id)
           THEN eff.sid END) AS main_session_count,
       COUNT(DISTINCT gid) AS project_count,
       COALESCE(SUM(cost), 0) AS cost,
       COALESCE(SUM(tokens_input), 0) AS tokens_input,
       COALESCE(SUM(tokens_output), 0) AS tokens_output,
       COALESCE(SUM(tokens_reasoning), 0) AS tokens_reasoning,
       COALESCE(SUM(tokens_cache_read), 0) AS tokens_cache_read,
       COALESCE(SUM(tokens_cache_write), 0) AS tokens_cache_write
FROM (
    SELECT s.project_id, s.id AS sid, s.parent_id, s.cost, s.tokens_input,
           s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
           s.tokens_cache_write,
           {EFF_SQL} AS gid,
           CASE WHEN p.worktree IS NOT NULL AND p.worktree != '/' THEN p.worktree
                ELSE s.directory END AS worktree
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
) AS eff
"""

SESSIONS_SQL = """
SELECT id, parent_id, project_id, title, agent, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
       tokens_cache_write, time_created, time_updated
FROM session
"""

PROJECT_SESSIONS_SQL = f"""
SELECT s.id, s.parent_id, s.project_id, s.title, s.agent, s.model, s.cost,
       s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
       s.tokens_cache_write, s.time_created, s.time_updated
FROM session s
LEFT JOIN project p ON p.id = s.project_id
WHERE {EFF_SQL} = ?
ORDER BY s.cost DESC, s.id ASC
"""

MESSAGES_SQL = """
SELECT json_extract(data, '$.modelID') AS model_id,
       json_extract(data, '$.providerID') AS provider,
       json_extract(data, '$.mode') AS mode,
       COUNT(*) AS message_count,
       COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS tokens_input,
       COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_output,
       COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS tokens_reasoning,
       COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS tokens_cache_read,
       COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS tokens_cache_write,
       COALESCE(SUM(json_extract(data, '$.cost')), 0) AS cost
FROM message
WHERE json_extract(data, '$.role') = 'assistant'
  AND json_extract(data, '$.tokens') IS NOT NULL
"""


def normalize_model(mid) -> str | None:
    """Strip a provider prefix if present: deepseek/deepseek-v4-flash -> deepseek-v4-flash."""
    if not mid:
        return mid
    return str(mid).rsplit("/", 1)[-1]


def session_model_id(raw) -> str | None:
    """`session.model` is a JSON object string like
    {"id":"deepseek-v4-flash","providerID":"deepseek",...} — extract the id.
    Falls back to the raw string (older/plain values) with the prefix stripped."""
    if not raw:
        return None
    s = str(raw).strip()
    if s.startswith("{"):
        try:
            return normalize_model(json.loads(s).get("id") or None)
        except ValueError:
            pass
    return normalize_model(s)


def tokens(row) -> dict:
    """Build the API tokens object from a row carrying tokens_* columns."""
    t = {k: int(row.get(SESS_COL[k]) or 0) for k in TOKEN_COLS}
    return {
        "input": t["input"],
        "output": t["output"],
        "reasoning": t["reasoning"],
        "cacheRead": t["cache_read"],
        "cacheWrite": t["cache_write"],
        "total": sum(t.values()),
    }


def _project(r) -> dict:
    worktree = r["worktree"] or ""
    name = Path(worktree).name or "(unknown)"
    return {
        "id": r["id"],
        "name": name,
        "worktree": worktree,
        "sessionCount": int(r["session_count"] or 0),
        "mainSessionCount": int(r["main_session_count"] or 0),
        "tokens": tokens(r),
        "cost": round(float(r["cost"] or 0), 6),
    }


def _session(r) -> dict:
    return {
        "id": r["id"],
        "parentId": r["parent_id"],
        "projectId": r["project_id"],
        "title": r["title"],
        "agent": r["agent"],
        "model": session_model_id(r["model"]),
        "timeCreated": int(r["time_created"] or 0),
        "timeUpdated": int(r["time_updated"] or 0),
        "tokens": tokens(r),
        "cost": round(float(r["cost"] or 0), 6),
    }


def updated_at(runner) -> int:
    """max time_updated across session + message (stream poll signal)."""
    row = runner.query(
        "SELECT MAX(m) AS m FROM ("
        "  SELECT MAX(time_updated) AS m FROM session"
        "  UNION ALL"
        "  SELECT MAX(time_updated) AS m FROM message)"
    )[0]
    return int(row["m"] or 0)


def overview(runner) -> dict:
    r = runner.query(ROLLUP_SQL)[0]
    return {
        "projectCount": int(r["project_count"] or 0),
        "sessionCount": int(r["session_count"] or 0),
        "mainSessionCount": int(r["main_session_count"] or 0),
        "tokens": tokens(r),
        "cost": round(float(r["cost"] or 0), 6),
        "updatedAt": updated_at(runner),
    }


def projects(runner) -> list[dict]:
    rows = runner.query(
        ROLLUP_SQL + " GROUP BY id, worktree"
        " ORDER BY cost DESC, id ASC"
    )
    return [_project(r) for r in rows]


def project_detail(runner, project_id) -> tuple[dict, list[dict]] | None:
    rows = runner.query(
        ROLLUP_SQL + " GROUP BY id, worktree HAVING id = ?",
        (project_id,),
    )
    if not rows:
        return None
    sessions = runner.query(PROJECT_SESSIONS_SQL, (project_id,))
    return _project(rows[0]), [_session(r) for r in sessions]


def session_detail(runner, session_id) -> tuple[dict, list[dict]] | None:
    rows = runner.query(SESSIONS_SQL + " WHERE id = ?", (session_id,))
    if not rows:
        return None
    msg_rows = runner.query_tsv(
        MESSAGES_SQL + " AND session_id = ? GROUP BY model_id, provider, mode",
        (session_id,),
    )
    models = []
    for row in msg_rows:
        d = dict(zip(_MSG_KEYS, row))
        models.append({
            "model": normalize_model(d["model_id"]),
            "provider": d["provider"],
            "mode": d["mode"],
            "messageCount": int(d["message_count"] or 0),
            "tokens": tokens(d),
            "cost": round(float(d["cost"] or 0), 6),
        })
    models.sort(key=lambda m: (-m["cost"], m["model"] or ""))
    return _session(rows[0]), models
