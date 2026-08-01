"""DB access layer for the opencode storage.

Two interchangeable runners over the same SQL surface:

- `CliRunner`: shells out to `opencode db "<SQL>" --format json|tsv`. JSON mode
  yields typed numbers; TSV is used for the big `message` pulls (JSON output
  blows up on tens of thousands of rows). Never opens the sqlite file directly
  (opencode keeps it in WAL mode).
- `SqliteRunner`: executes the same SQL on a `sqlite3.Connection` — used by
  tests against an in-memory fixture replicating the opencode schema.
"""

import json
import os
import subprocess

# opencode CLI binary; override for a non-PATH install (e.g. a brew cellar path).
OPENCODE_BIN = os.environ.get("OPENCODE_BIN", "opencode")


def _inline(sql: str, params: tuple) -> str:
    """Inline bound params into SQL as safely-quoted literals (CliRunner has no
    parameter binding; ids come from URL paths)."""
    for p in params:
        if p is None:
            rep = "NULL"
        elif isinstance(p, (int, float)):
            rep = repr(p)
        else:
            rep = "'" + str(p).replace("'", "''") + "'"
        sql = sql.replace("?", rep, 1)
    return sql


class CliRunner:
    def __init__(self, executable: str | None = None):
        self._cmd = [executable or OPENCODE_BIN, "db"]

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        raw = subprocess.run(
            [*self._cmd, _inline(sql, params), "--format", "json"],
            capture_output=True, text=True, check=True,
        ).stdout
        return json.loads(raw) if raw.strip() else []

    def query_tsv(self, sql: str, params: tuple = ()) -> list[list[str]]:
        raw = subprocess.run(
            [*self._cmd, _inline(sql, params), "--format", "tsv"],
            capture_output=True, text=True, check=True,
        ).stdout
        lines = raw.strip().split("\n")
        return [line.split("\t") for line in lines[1:]]  # skip header row


class SqliteRunner:
    def __init__(self, conn):
        self._conn = conn

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        cur = self._conn.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def query_tsv(self, sql: str, params: tuple = ()) -> list[list[str]]:
        cur = self._conn.execute(sql, params)
        return [
            ["" if v is None else v if isinstance(v, str) else str(v) for v in row]
            for row in cur.fetchall()
        ]
