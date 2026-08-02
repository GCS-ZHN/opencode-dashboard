"""FastAPI app implementing the API.md contract over the opencode aggregator.

Aggregation runs against a large DB, so results are cached in memory and
refreshed on a fixed poll interval instead of being recomputed per request.

Run:  uv run uvicorn app:app --reload
"""

import asyncio
import importlib.metadata
import json
import logging
import os
import socket
import subprocess
import threading
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import aggregate
from db import CliRunner

logger = logging.getLogger("dashboard")

# Comma-separated CORS allow-list; defaults to the loopback dev origins. Tight
# by default so a random webpage can't exfiltrate local project/session data.
def default_cors_origins() -> list[str]:
    env = os.environ.get("DASHBOARD_CORS_ORIGINS", "").strip()
    if env:
        return [o.strip() for o in env.split(",") if o.strip()]
    return [
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:4173", "http://127.0.0.1:4173",
    ]


@lru_cache(maxsize=8)
def opencode_version(executable: str = "opencode") -> str:
    try:
        return subprocess.run(
            [executable, "--version"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"  # e.g. CI without the opencode CLI; don't fail the request


def dashboard_version() -> str:
    try:
        return importlib.metadata.version("opencode-dashboard-server")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"  # e.g. pytest from a plain checkout; don't fail the request


class Cache:
    """In-memory result cache keyed by (kind, id, since, until) where kind is
    the endpoint, id the project/session id (None for whole-dataset endpoints),
    and since/until the time-range query params (None = unbounded) — so
    `/overview?since=A` and `/overview?since=B` are distinct entries and never
    collide with each other or with the all-time result.

    Values fill lazily on first request. Whole-dataset kinds (overview,
    projects, models) are refreshed by the background poll loop across every
    observed range variant (bounded); per-id kinds (project, session) are
    refreshed only when a request finds them older than ttl, so the heavy
    session_detail SQL runs at most once per ttl per session and _values stays
    bounded. A failed refresh keeps the previous value (stale-serve); a failed
    first fill propagates to the caller (500 — nothing cached yet).
    """

    _WHOLE = frozenset({"overview", "projects", "models"})
    _MAX_PER_KIND = 512  # per-id kinds: evict oldest beyond this cap
    _MAX_RANGE_VARIANTS = 16  # whole kinds: bound distinct since/until combos

    def __init__(self, ttl=None):
        self._lock = threading.Lock()
        self._loaders: dict[str, Callable] = {}
        self._values: dict[tuple, tuple] = {}
        self._ranges: dict[str, list[tuple]] = {}  # whole kind -> observed (since, until), oldest first
        self._ttl = ttl  # per-id kinds refresh on request when older than this

    def register(self, kind: str, loader):
        self._loaders[kind] = loader

    def get(self, kind: str, key=None, since=None, until=None):
        full = (kind, key, since, until)
        with self._lock:
            entry = self._values.get(full)  # None = never cached
        if entry is not None:
            value, stored_at = entry
            if kind in self._WHOLE or self._ttl is None \
                    or time.monotonic() - stored_at < self._ttl:
                return value
            try:  # stale per-id entry: refresh on request, keep stale on failure
                value = self._loaders[kind](key, since, until)
            except Exception:
                logger.exception("stale cache refresh failed for %s; serving stale", full)
                return value
            with self._lock:
                self._values[full] = (value, time.monotonic())
            return value
        value = self._loaders[kind](key, since, until)
        with self._lock:
            self._values[full] = (value, time.monotonic())
            self._evict_if_grown(kind, full)
        return value

    def refresh(self, full: tuple):
        kind, key, since, until = full
        value = self._loaders[kind](key, since, until)
        with self._lock:
            self._values[full] = (value, time.monotonic())
            self._evict_if_grown(kind, full)

    def _evict_if_grown(self, kind, full):
        """Bound _values: whole kinds by distinct range-variant count, per-id
        kinds by entry count. Drop the least-recently-stored entry."""
        if kind in self._WHOLE:
            ranges = self._ranges.setdefault(kind, [])
            variant = full[2:]
            if variant not in ranges:
                ranges.append(variant)
                if len(ranges) > self._MAX_RANGE_VARIANTS:
                    self._values.pop((kind, None) + ranges.pop(0), None)
            return
        entries = [k for k in self._values if k[0] == kind]
        if len(entries) > self._MAX_PER_KIND:
            del self._values[min(entries, key=lambda k: self._values[k][1])]

    def poll_keys(self):
        """Keys the background loop refreshes: whole-dataset kinds across every
        observed range variant, plus the all-time variant (always included, so
        pre-warm and the stream's updatedAt signal never depend on a prior
        request); per-id entries are handled lazily in get()."""
        with self._lock:
            keys = []
            for kind in self._loaders:
                if kind not in self._WHOLE:
                    continue
                variants = set(self._ranges.get(kind) or [])
                variants.add((None, None))  # all-time variant always refreshed
                keys += [(kind, None, since, until) for since, until in variants]
            return keys

    def overview(self):
        """All-time overview (stream signal). updatedAt is a DB-wide max and
        range-independent, so the all-time entry drives /stream correctly."""
        with self._lock:
            entry = self._values.get(("overview", None, None, None))
            return entry[0] if entry else None


class StreamHub:
    """Fan-out for /stream subscribers. The poll loop broadcasts to every
    connected SSE client; clients never query the DB themselves."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._subs: set[asyncio.Queue] = set()

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        async with self._lock:
            self._subs.add(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        async with self._lock:
            self._subs.discard(q)

    async def broadcast(self, payload) -> None:
        async with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put_nowait(payload)


def poll_event(overview, last_updated, ticks):
    """Stream event for one cache-refresh tick. Emits `updated` only when the
    overview's updatedAt advances; otherwise a heartbeat every 3rd tick (None
    between). Returns (payload | None, new_last_updated)."""
    if overview and overview.get("updatedAt") and overview["updatedAt"] != last_updated:
        return {"type": "updated", "at": overview["updatedAt"], "scope": "overview"}, \
            overview["updatedAt"]
    if ticks % 3 == 0:
        return {"type": "heartbeat"}, last_updated
    return None, last_updated


def create_app(runner=None, cors_origins=None, poll_seconds=None, opencode_bin=None) -> FastAPI:
    bin = opencode_bin or os.environ.get("OPENCODE_BIN") or "opencode"
    if runner is None:
        runner = CliRunner(executable=bin)
    origins = cors_origins if cors_origins is not None else default_cors_origins()
    if poll_seconds is None:
        try:
            poll_seconds = float(os.environ.get("DASHBOARD_POLL_SECONDS", "5"))
        except ValueError:
            poll_seconds = 5.0

    cache = Cache(ttl=poll_seconds)
    hub = StreamHub()

    cache.register("overview", lambda key, since, until: (
        aggregate.overview(runner, since, until)
        | {"host": socket.gethostname(), "opencodeVersion": opencode_version(bin),
           "dashboardVersion": dashboard_version()}
    ))
    cache.register("projects", lambda key, since, until: aggregate.projects(runner, since, until))
    cache.register("models", lambda key, since, until: aggregate.models(runner, since, until))

    def load_project(key, since, until):
        res = aggregate.project_detail(runner, key, since, until)
        if res is None:
            return None
        proj, sessions = res
        return {"project": proj, "sessions": sessions}

    def load_session(key, since, until):
        res = aggregate.session_detail(runner, key, since, until)
        if res is None:
            return None
        sess, models = res
        return {"session": sess, "models": models}

    cache.register("project", load_project)
    cache.register("session", load_session)

    async def poll():
        loop = asyncio.get_running_loop()
        last_updated = None
        ticks = 0
        while True:
            # Only whole-dataset kinds refresh on the clock, across every
            # observed range variant; per-id entries are refreshed lazily in
            # Cache.get, so session_detail's heavy SQL runs once per ttl per
            # session and _values stays bounded.
            for full in cache.poll_keys():
                try:
                    await loop.run_in_executor(None, cache.refresh, full)
                except Exception:
                    logger.exception("cache refresh failed for %s; serving stale", full)
            ticks += 1
            event, last_updated = poll_event(cache.overview(), last_updated, ticks)
            if event is not None:
                await hub.broadcast(event)
            # True period is refresh-time + poll_seconds (refresh is synchronous
            # on the executor above, so this sleep starts only after it).
            await asyncio.sleep(poll_seconds)

    @asynccontextmanager
    async def lifespan(app):
        loop = asyncio.get_running_loop()
        # Pre-warm whole-dataset keys so /stream's first updated event (and the
        # first request) don't depend on someone GETting /overview first.
        for full in cache.poll_keys():
            try:
                await loop.run_in_executor(None, cache.refresh, full)
            except Exception:
                logger.exception("initial cache fill failed for %s; will retry on request", full)
        task = asyncio.create_task(poll())
        try:
            yield
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="opencode token dashboard", lifespan=lifespan)
    app.state.cache = cache
    # Loopback-only API; restrict origins so a random webpage can't exfiltrate
    # local project/session data from the browser (the client runs from Vite).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def handle(fn):
        try:
            return fn()
        except HTTPException:
            raise
        except Exception:
            logger.exception("aggregation failed")
            raise HTTPException(500, detail="aggregation failed")

    @app.get("/health")
    def health():
        return {"status": "ok", "version": opencode_version(bin)}

    @app.get("/overview")
    def overview(since: int | None = Query(None), until: int | None = Query(None)):
        return handle(lambda: cache.get("overview", since=since, until=until))

    @app.get("/projects")
    def projects(since: int | None = Query(None), until: int | None = Query(None)):
        return handle(lambda: cache.get("projects", since=since, until=until))

    @app.get("/models")
    def models(since: int | None = Query(None), until: int | None = Query(None)):
        return handle(lambda: cache.get("models", since=since, until=until))

    @app.get("/projects/{project_id}")
    def project(project_id: str, since: int | None = Query(None), until: int | None = Query(None)):
        def run():
            res = cache.get("project", project_id, since, until)
            if res is None:
                raise HTTPException(404, detail=f"project {project_id} not found")
            return res

        return handle(run)

    @app.get("/sessions/{session_id}")
    def session(session_id: str, since: int | None = Query(None), until: int | None = Query(None)):
        def run():
            res = cache.get("session", session_id, since, until)
            if res is None:
                raise HTTPException(404, detail=f"session {session_id} not found")
            return res

        return handle(run)

    @app.get("/stream")
    async def stream():
        q = await hub.subscribe()
        await q.put({"type": "heartbeat"})

        async def gen():
            try:
                while True:
                    payload = await q.get()
                    data = json.dumps(payload)
                    if payload["type"] == "updated":
                        yield f"event: update\ndata: {data}\n\n"
                    else:
                        yield f"data: {data}\n\n"
            finally:
                await hub.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream")

    return app


app = create_app()
