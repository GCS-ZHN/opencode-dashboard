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
# `{time_filter}` ("" or a WHERE on s.time_created) is filled in per request for
# the since/until window.
ROLLUP_SQL = """
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
           {eff_sql} AS gid,
           CASE WHEN p.worktree IS NOT NULL AND p.worktree != '/' THEN p.worktree
                ELSE s.directory END AS worktree
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
    {time_filter}
) AS eff
"""

SESSIONS_SQL = """
SELECT id, parent_id, project_id, title, agent, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
       tokens_cache_write, time_created, time_updated
FROM session
"""

PROJECT_SESSIONS_SQL = """
SELECT s.id, s.parent_id, s.project_id, s.title, s.agent, s.model, s.cost,
       s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
       s.tokens_cache_write, s.time_created, s.time_updated
FROM session s
LEFT JOIN project p ON p.id = s.project_id
WHERE {eff_sql} = ?{time_filter}
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


def _time_fragment(col: str, since, until) -> tuple[str, tuple]:
    """Half-open [since, until) filter on `col`. Fragment starts with ' AND '
    so it appends after an existing WHERE; callers with no WHERE strip it.
    Returns ("", ()) when neither bound is given."""
    conds, params = [], []
    if since is not None:
        conds.append(f"{col} >= ?")
        params.append(since)
    if until is not None:
        conds.append(f"{col} < ?")
        params.append(until)
    if not conds:
        return "", ()
    return " AND " + " AND ".join(conds), tuple(params)


def _rollup(since=None, until=None) -> tuple[str, tuple]:
    tf, tp = _time_fragment("s.time_created", since, until)
    if tf:
        tf = "WHERE " + tf[5:]
    return ROLLUP_SQL.format(eff_sql=EFF_SQL, time_filter=tf), tp


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


def overview(runner, since=None, until=None) -> dict:
    sql, tp = _rollup(since, until)
    r = runner.query(sql, tp)[0]
    return {
        "projectCount": int(r["project_count"] or 0),
        "sessionCount": int(r["session_count"] or 0),
        "mainSessionCount": int(r["main_session_count"] or 0),
        "tokens": tokens(r),
        "cost": round(float(r["cost"] or 0), 6),
        "updatedAt": updated_at(runner),
    }


def projects(runner, since=None, until=None) -> list[dict]:
    sql, tp = _rollup(since, until)
    rows = runner.query(
        sql + " GROUP BY id, worktree"
        " ORDER BY cost DESC, id ASC",
        tp,
    )
    return [_project(r) for r in rows]


def project_detail(runner, project_id, since=None, until=None) -> tuple[dict, list[dict]] | None:
    sql, tp = _rollup(since, until)
    rows = runner.query(
        sql + " GROUP BY id, worktree HAVING id = ?",
        tp + (project_id,),
    )
    if not rows:
        return None
    tf, tps = _time_fragment("s.time_created", since, until)
    sessions = runner.query(
        PROJECT_SESSIONS_SQL.format(eff_sql=EFF_SQL, time_filter=tf),
        (project_id,) + tps,
    )
    return _project(rows[0]), [_session(r) for r in sessions]


def _model_entry(d: dict) -> dict:
    return {
        "model": normalize_model(d["model_id"]),
        "provider": d["provider"],
        "mode": d["mode"],
        "messageCount": int(d["message_count"] or 0),
        "tokens": tokens(d),
        "cost": round(float(d["cost"] or 0), 6),
    }


def session_detail(runner, session_id, since=None, until=None) -> tuple[dict, list[dict]] | None:
    tf, tp = _time_fragment("time_created", since, until)
    rows = runner.query(SESSIONS_SQL + " WHERE id = ?" + tf, (session_id,) + tp)
    if not rows:
        return None
    mf, mp = _time_fragment("message.time_created", since, until)
    msg_rows = runner.query_tsv(
        MESSAGES_SQL + " AND session_id = ?" + mf + " GROUP BY model_id, provider, mode",
        (session_id,) + mp,
    )
    models = [_model_entry(dict(zip(_MSG_KEYS, row))) for row in msg_rows]
    models.sort(key=lambda m: (-m["cost"], m["model"] or ""))
    return _session(rows[0]), models


def models(runner, since=None, until=None) -> list[dict]:
    """Whole-host per-model rollup from message.data (same shape as the
    per-session model breakdown, but aggregated across all sessions).

    Rows are grouped by (model_id, provider, mode) so provider/mode labels are
    accurate, then merged by display name so prefixed/unprefixed ids (e.g.
    deepseek/deepseek-v4-flash vs deepseek-v4-flash) don't create duplicate
    slices. On merge, the higher-cost row keeps its provider/mode label.
    """
    mf, mp = _time_fragment("message.time_created", since, until)
    msg_rows = runner.query_tsv(
        MESSAGES_SQL + mf + " GROUP BY model_id, provider, mode", mp
    )
    merged: dict[str, dict] = {}
    for row in msg_rows:
        e = _model_entry(dict(zip(_MSG_KEYS, row)))
        key = e["model"] or ""
        cur = merged.get(key)
        if cur is None:
            merged[key] = e
        else:
            if e["cost"] > cur["cost"]:
                cur["provider"] = e["provider"]
                cur["mode"] = e["mode"]
            cur["messageCount"] += e["messageCount"]
            for k in ("input", "output", "reasoning", "cacheRead", "cacheWrite", "total"):
                cur["tokens"][k] += e["tokens"][k]
            cur["cost"] = round(cur["cost"] + e["cost"], 6)
    ms = list(merged.values())
    ms.sort(key=lambda m: (-m["cost"], m["model"] or ""))
    return ms
