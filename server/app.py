"""FastAPI app implementing the API.md contract over the opencode aggregator.

Aggregation runs against a large DB, so results are cached in memory and
refreshed on a fixed poll interval instead of being recomputed per request.

Run:  uv run uvicorn app:app --reload
"""

import asyncio
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

from fastapi import FastAPI, HTTPException
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


class Cache:
    """In-memory result cache keyed by (kind, id) where kind is the endpoint
    and id is the project/session id (None for whole-dataset endpoints).

    Values fill lazily on first request. Whole-dataset kinds (overview,
    projects, models) are refreshed by the background poll loop; per-id kinds
    (project, session) are refreshed only when a request finds them older than
    ttl, so the heavy session_detail SQL runs at most once per ttl per session
    and _values stays bounded. A failed refresh keeps the previous value
    (stale-serve); a failed first fill propagates to the caller (500 — nothing
    cached yet).
    """

    _WHOLE = frozenset({"overview", "projects", "models"})
    _MAX_PER_KIND = 512  # per-id kinds: evict oldest beyond this cap

    def __init__(self, ttl=None):
        self._lock = threading.Lock()
        self._loaders: dict[str, Callable] = {}
        self._values: dict[tuple, tuple] = {}
        self._ttl = ttl  # per-id kinds refresh on request when older than this

    def register(self, kind: str, loader):
        self._loaders[kind] = loader

    def get(self, kind: str, key=None):
        full = (kind, key)
        with self._lock:
            entry = self._values.get(full)  # None = never cached
        if entry is not None:
            value, stored_at = entry
            if kind in self._WHOLE or self._ttl is None \
                    or time.monotonic() - stored_at < self._ttl:
                return value
            try:  # stale per-id entry: refresh on request, keep stale on failure
                value = self._loaders[kind](key)
            except Exception:
                logger.exception("stale cache refresh failed for %s; serving stale", full)
                return value
            with self._lock:
                self._values[full] = (value, time.monotonic())
            return value
        value = self._loaders[kind](key)
        with self._lock:
            self._values[full] = (value, time.monotonic())
            self._evict_if_grown(kind)
        return value

    def refresh(self, full: tuple):
        kind, key = full
        value = self._loaders[kind](key)
        with self._lock:
            self._values[full] = (value, time.monotonic())
            self._evict_if_grown(kind)

    def _evict_if_grown(self, kind):
        """Bound per-id kinds so _values can't grow unbounded; the poll loop
        never refreshes them, so drop the least-recently-stored entry."""
        if kind in self._WHOLE:
            return
        entries = [k for k in self._values if k[0] == kind]
        if len(entries) > self._MAX_PER_KIND:
            del self._values[min(entries, key=lambda k: self._values[k][1])]

    def poll_keys(self):
        """(kind, id) keys the background loop refreshes: whole-dataset kinds
        only — per-id entries are handled lazily in get()."""
        with self._lock:
            return [(kind, None) for kind in self._loaders if kind in self._WHOLE]

    def overview(self):
        with self._lock:
            entry = self._values.get(("overview", None))
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

    cache.register("overview", lambda key: (
        aggregate.overview(runner)
        | {"host": socket.gethostname(), "opencodeVersion": opencode_version(bin)}
    ))
    cache.register("projects", lambda key: aggregate.projects(runner))
    cache.register("models", lambda key: aggregate.models(runner))

    def load_project(key):
        res = aggregate.project_detail(runner, key)
        if res is None:
            return None
        proj, sessions = res
        return {"project": proj, "sessions": sessions}

    def load_session(key):
        res = aggregate.session_detail(runner, key)
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
            # Only whole-dataset kinds refresh on the clock; per-id entries are
            # refreshed lazily in Cache.get, so session_detail's heavy SQL runs
            # once per ttl per session and _values stays bounded.
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
    def overview():
        return handle(lambda: cache.get("overview"))

    @app.get("/projects")
    def projects():
        return handle(lambda: cache.get("projects"))

    @app.get("/models")
    def models():
        return handle(lambda: cache.get("models"))

    @app.get("/projects/{project_id}")
    def project(project_id: str):
        def run():
            res = cache.get("project", project_id)
            if res is None:
                raise HTTPException(404, detail=f"project {project_id} not found")
            return res

        return handle(run)

    @app.get("/sessions/{session_id}")
    def session(session_id: str):
        def run():
            res = cache.get("session", session_id)
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
