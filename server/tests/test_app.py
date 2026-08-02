"""HTTP-level smoke tests + the SQL-inlining boundary (CliRunner's only injection
surface). Driven via create_app(SqliteRunner) over the in-memory fixture, so no
`opencode db` CLI spawn happens."""

import asyncio
import sqlite3

import pytest
from fastapi.testclient import TestClient

import app as appmod
from db import SqliteRunner, _inline
from tests.conftest import SCHEMA, seed


def make_client() -> TestClient:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript(SCHEMA)
    seed(conn)
    return TestClient(appmod.create_app(SqliteRunner(conn))), conn


class CountingRunner:
    """Wraps a SqliteRunner and counts query calls (proves cache hits)."""

    def __init__(self, inner):
        self._inner = inner
        self.queries = 0

    def query(self, sql, params=()):
        self.queries += 1
        return self._inner.query(sql, params)

    def query_tsv(self, sql, params=()):
        self.queries += 1
        return self._inner.query_tsv(sql, params)


def test_inline_quotes_and_escapes():
    sql = _inline("WHERE id = ? AND cost > ?", ("a'b\";\nDROP", 5))
    assert sql == "WHERE id = 'a''b\";\nDROP' AND cost > 5"
    assert 'DROP' in sql  # payload stays inside one quoted literal


def test_unknown_project_404():
    c, _ = make_client()
    r = c.get("/projects/nope")
    assert r.status_code == 404
    assert r.json() == {"detail": "project nope not found"}


def test_overview_keys():
    c, _ = make_client()
    r = c.get("/overview")
    assert r.status_code == 200
    assert {"host", "opencodeVersion", "projectCount", "sessionCount",
            "tokens", "cost", "updatedAt"} <= set(r.json())


def test_models_keys():
    c, _ = make_client()
    r = c.get("/models")
    assert r.status_code == 200
    rows = r.json()
    assert rows  # fixture seeds assistant token-bearing messages
    assert {"model", "provider", "mode", "messageCount", "tokens", "cost"} <= set(rows[0])
    assert rows == sorted(rows, key=lambda m: (-m["cost"], m["model"] or ""))


def test_foreign_origin_not_allowed_by_cors():
    c, _ = make_client()
    r = c.options("/projects", headers={
        "Origin": "https://evil.example",
        "Access-Control-Request-Method": "GET",
    })
    assert "access-control-allow-origin" not in r.headers


def test_cors_origins_injection():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript(SCHEMA)
    seed(conn)
    app = appmod.create_app(SqliteRunner(conn), cors_origins=["http://a.com"])
    c = TestClient(app)
    ok = c.options("/projects", headers={"Origin": "http://a.com", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://a.com"
    nope = c.options("/projects", headers={"Origin": "http://a.co", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in nope.headers


def make_cached_client():
    """App over a counting runner so cache behavior is observable via query count.

    Note: TestClient is used WITHOUT a context manager, so lifespan (background
    poll + pre-warm) never runs — cache state is driven purely by the requests
    below. The one lifespan-driven test is test_lifespan_prewarms_whole_dataset.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript(SCHEMA)
    seed(conn)
    counter = CountingRunner(SqliteRunner(conn))
    return TestClient(appmod.create_app(counter)), conn, counter


def test_repeated_overview_served_from_cache():
    c, _, counter = make_cached_client()
    first = c.get("/overview")
    assert first.status_code == 200
    after_first = counter.queries
    assert after_first > 0
    second = c.get("/overview")
    assert second.json() == first.json()
    assert counter.queries == after_first  # cache hit: no re-aggregation


def test_refresh_recomputes_overview_after_db_change():
    c, conn, counter = make_cached_client()
    before = c.get("/overview").json()
    assert before["sessionCount"] == 8
    c.get("/overview")  # warm the cache
    c.get("/overview")
    counter.queries = 0
    conn.execute(
        "INSERT INTO session (id, project_id, slug, directory, title, version,"
        " time_created, time_updated) VALUES ('s9','proj-aaa','s9','/x','new',"
        " 'local', 200000, 200000)"
    )
    appmod.Cache.refresh(c.app.state.cache, ("overview", None))
    counter.queries = 0
    after = c.get("/overview").json()
    assert after["sessionCount"] == 9
    assert after["updatedAt"] == 200000
    assert counter.queries == 0  # served from the refreshed cache, no request-time query


def test_failed_refresh_serves_stale_value():
    c, _, counter = make_cached_client()
    before = c.get("/overview").json()
    c.get("/overview")
    orig_query = counter._inner.query
    def boom(sql, params=()):
        raise RuntimeError("db down")
    counter._inner.query = boom
    with pytest.raises(RuntimeError):
        appmod.Cache.refresh(c.app.state.cache, ("overview", None))  # refresh fails...
    counter._inner.query = orig_query
    after = c.get("/overview").json()
    assert after == before  # ...but the stale value is still served


def test_unknown_project_404_cached():
    c, _, counter = make_cached_client()
    assert c.get("/projects/nope").status_code == 404
    after_first = counter.queries
    assert after_first > 0
    assert c.get("/projects/nope").status_code == 404
    assert counter.queries == after_first  # 404s are cached too, no re-scan


def test_first_fill_failure_returns_500():
    c, _, counter = make_cached_client()
    def boom(sql, params=()):
        raise RuntimeError("db down")
    counter._inner.query = boom
    r = c.get("/overview")  # nothing cached yet, so the fill failure must surface
    assert r.status_code == 500
    assert r.json() == {"detail": "aggregation failed"}


def test_lifespan_prewarms_whole_dataset_kinds():
    """with TestClient(...) runs lifespan: whole-dataset keys are pre-warmed (no
    request needed) and poll_seconds is huge so the background loop just idles."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript(SCHEMA)
    seed(conn)
    counter = CountingRunner(SqliteRunner(conn))
    app = appmod.create_app(counter, poll_seconds=3600)
    with TestClient(app) as c:
        assert counter.queries > 0  # pre-warm queried the DB with no request
        assert c.app.state.cache.overview()["sessionCount"] == 8
        assert {("projects", None), ("models", None)} <= set(c.app.state.cache._values)
        first = c.get("/overview")
        assert first.status_code == 200
        assert first.json()["sessionCount"] == 8


def test_poll_event_emits_updated_on_change_only():
    payload, last = appmod.poll_event({"updatedAt": 100}, None, 1)
    assert payload == {"type": "updated", "at": 100, "scope": "overview"}
    assert last == 100
    # no change, not a heartbeat tick -> nothing
    assert appmod.poll_event({"updatedAt": 100}, 100, 2) == (None, 100)
    # no change on a heartbeat tick (every 3rd) -> heartbeat
    assert appmod.poll_event({"updatedAt": 100}, 100, 3) == ({"type": "heartbeat"}, 100)
    # uncached overview -> nothing
    assert appmod.poll_event(None, None, 3) == ({"type": "heartbeat"}, None)


def test_stream_hub_fans_out_to_subscribers():
    async def scenario():
        hub = appmod.StreamHub()
        q1, q2 = await hub.subscribe(), await hub.subscribe()
        await hub.broadcast({"type": "updated", "at": 1, "scope": "overview"})
        return await q1.get(), await q2.get()

    e1, e2 = asyncio.run(scenario())
    assert e1 == e2 == {"type": "updated", "at": 1, "scope": "overview"}
