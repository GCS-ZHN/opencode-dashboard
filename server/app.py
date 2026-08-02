"""FastAPI app implementing the API.md contract over the opencode aggregator.

Run:  uv run uvicorn app:app --reload
"""

import asyncio
import importlib.metadata
import json
import logging
import os
import socket
import subprocess
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
    app = FastAPI(title="opencode token dashboard")
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
        def run():
            data = aggregate.overview(runner, since, until)
            data["host"] = socket.gethostname()
            data["opencodeVersion"] = opencode_version(bin)
            data["dashboardVersion"] = dashboard_version()
            return data

        return handle(run)

    @app.get("/projects")
    def projects(since: int | None = Query(None), until: int | None = Query(None)):
        return handle(lambda: aggregate.projects(runner, since, until))

    @app.get("/models")
    def models(since: int | None = Query(None), until: int | None = Query(None)):
        return handle(lambda: aggregate.models(runner, since, until))

    @app.get("/projects/{project_id}")
    def project(project_id: str, since: int | None = Query(None), until: int | None = Query(None)):
        def run():
            res = aggregate.project_detail(runner, project_id, since, until)
            if res is None:
                raise HTTPException(404, detail=f"project {project_id} not found")
            proj, sessions = res
            return {"project": proj, "sessions": sessions}

        return handle(run)

    @app.get("/sessions/{session_id}")
    def session(session_id: str, since: int | None = Query(None), until: int | None = Query(None)):
        def run():
            res = aggregate.session_detail(runner, session_id, since, until)
            if res is None:
                raise HTTPException(404, detail=f"session {session_id} not found")
            sess, models = res
            return {"session": sess, "models": models}

        return handle(run)

    @app.get("/stream")
    async def stream():
        q: asyncio.Queue = asyncio.Queue()
        stop = asyncio.Event()

        async def poll():
            loop = asyncio.get_running_loop()
            last = None
            ticks = 0
            while not stop.is_set():
                try:
                    ts = await loop.run_in_executor(None, aggregate.updated_at, runner)
                    if ts and ts != last:
                        last = ts
                        await q.put({"type": "updated", "at": ts, "scope": "overview"})
                    else:
                        ticks += 1
                        if ticks % 3 == 0:  # heartbeat every ~15s (poll = 5s)
                            await q.put({"type": "heartbeat"})
                except Exception:
                    logger.exception("stream poll failed")
                try:
                    await asyncio.wait_for(stop.wait(), poll_seconds)
                except asyncio.TimeoutError:
                    pass

        task = asyncio.create_task(poll())
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
                stop.set()
                task.cancel()

        return StreamingResponse(gen(), media_type="text/event-stream")

    return app


app = create_app()
