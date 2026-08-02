"""In-memory SQLite fixture replicating the opencode schema (verified on
opencode 1.18.10) and seeded with realistic data."""

import json
import sqlite3

import pytest

from db import SqliteRunner

SCHEMA = """
CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
    icon_url TEXT, icon_color TEXT, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_initialized INTEGER,
    sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT
);
CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
    version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER,
    summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT,
    revert TEXT, permission TEXT, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER,
    workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
    cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL, metadata TEXT
);
CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
"""


def add_session(conn, sid, project_id, title, model, cost,
                tin, tout, tre, tcr, tcw, tc, tu, parent=None, agent="build",
                version="local", directory=None):
    conn.execute(
        "INSERT INTO session (id, project_id, parent_id, slug, directory, title,"
        " version, time_created, time_updated, agent, model, cost, tokens_input,"
        " tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, project_id, parent, sid, directory or "/work/" + sid, title, version, tc, tu,
         agent, model, cost, tin, tout, tre, tcr, tcw),
    )


def add_msg(conn, mid, session_id, role, model_id, provider_id, mode,
            tokens, cost, tc, tu):
    data = {
        "role": role,
        "modelID": model_id,
        "providerID": provider_id,
        "mode": mode,
        "tokens": tokens,
        "cost": cost,
    }
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, time_updated, data)"
        " VALUES (?, ?, ?, ?, ?)",
        (mid, session_id, tc, tu, json.dumps(data)),
    )


def seed(conn):
    conn.execute("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)"
                 " VALUES ('proj-aaa', '/Users/test/projects/dash', 1, 1, '[]')")
    conn.execute("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)"
                 " VALUES ('proj-bbb', '/Users/test/projects/srv', 1, 1, '[]')")
    conn.execute("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)"
                 " VALUES ('proj-ccc', '/Users/test/projects/emptyish', 1, 1, '[]')")
    conn.execute("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)"
                 " VALUES ('proj-global', '/', 1, 1, '[]')")

    # project dash: 3 sessions incl. a parent->child pair (s1 -> s3)
    add_session(conn, "s1", "proj-aaa", "main build",
                '{"id":"deepseek-v4-flash","providerID":"deepseek"}',
                2.00, 1000, 500, 200, 100, 50, 100000, 110000)
    add_session(conn, "s2", "proj-aaa", "code review",
                '{"id":"claude-opus-5","providerID":"opencode"}',
                0.50, 300, 100, 50, 10, 5, 120000, 130000)
    add_session(conn, "s3", "proj-aaa", "subagent help",
                '{"id":"deepseek-v4-flash","providerID":"deepseek"}',
                0.20, 100, 50, 20, 5, 2, 115000, 125000, parent="s1")

    # project srv: multi-model session (s4) + all-zero-token session (s5)
    add_session(conn, "s4", "proj-bbb", "multi model session",
                '{"id":"deepseek-v4-flash","providerID":"deepseek"}',
                0.90, 400, 200, 100, 20, 10, 140000, 160000)
    add_session(conn, "s5", "proj-bbb", "zero tokens",
                '{"id":"kimi-k3","providerID":"opencode"}',
                0.00, 0, 0, 0, 0, 0, 150000, 170000, agent="general")

    # project emptyish: model id with a provider prefix, no messages
    add_session(conn, "s6", "proj-ccc", "big model",
                "deepseek/deepseek-v4-pro",
                3.50, 2000, 1000, 500, 200, 100, 160000, 180000)

    # global catch-all (worktree "/"): sessions split by directory into per-folder groups
    add_session(conn, "s7", "proj-global", "old tmp session", None,
                0.10, 100, 50, 10, 5, 2, 90000, 100000, directory="/private/tmp")
    add_session(conn, "s8", "proj-global", "latest dashboard session", None,
                0.20, 200, 80, 20, 10, 4, 170000, 190000,
                directory="/Users/test/projects/opencode-dashboard")

    # s4 messages split across two models (mid-conversation switch)
    add_msg(conn, "m1", "s4", "assistant", "deepseek-v4-flash", "deepseek", "build",
            {"input": 100, "output": 50, "reasoning": 25, "cache": {"read": 10, "write": 5}},
            0.30, 141000, 165000)
    add_msg(conn, "m2", "s4", "assistant", "deepseek-v4-flash", "deepseek", "build",
            {"input": 100, "output": 50, "reasoning": 25, "cache": {"read": 10, "write": 5}},
            0.30, 142000, 165000)
    add_msg(conn, "m3", "s4", "assistant", "claude-sonnet-4.5", "opencode", "plan",
            {"input": 200, "output": 100, "reasoning": 50, "cache": {"read": 0, "write": 0}},
            0.30, 143000, 165000)

    # m6: same model id under a different provider/mode (host-wide merge case)
    add_msg(conn, "m6", "s4", "assistant", "deepseek-v4-flash", "openrouter", "plan",
            {"input": 50, "output": 20, "reasoning": 10, "cache": {"read": 5, "write": 2}},
            0.10, 144000, 165000)

    # s5: assistant message with all-zero tokens + a user message (filtered out)
    add_msg(conn, "m4", "s5", "assistant", "kimi-k3", "opencode", "general",
            {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
            0.0, 151000, 175000)
    add_msg(conn, "m5", "s5", "user", "kimi-k3", "opencode", "general",
            {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
            0.0, 152000, 176000)


@pytest.fixture
def runner():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    seed(conn)
    yield SqliteRunner(conn)
    conn.close()
