"""HTTP-level smoke tests + the SQL-inlining boundary (CliRunner's only injection
surface). Driven via create_app(SqliteRunner) over the in-memory fixture, so no
`opencode db` CLI spawn happens."""

import sqlite3

from fastapi.testclient import TestClient

import app as appmod
from db import SqliteRunner, _inline
from tests.conftest import SCHEMA, seed


def make_client() -> TestClient:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript(SCHEMA)
    seed(conn)
    return TestClient(appmod.create_app(SqliteRunner(conn))), conn


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
    assert {"host", "opencodeVersion", "dashboardVersion", "projectCount", "sessionCount",
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
