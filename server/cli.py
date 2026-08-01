"""opencode-dashboard-server CLI: interactive configure + serve.

Run:  uv tool install opencode-dashboard-server
      opencode-dashboard-server configure
      opencode-dashboard-server serve [--port N] [--host H] [--config PATH]
"""

import argparse
import os
import sys
from pathlib import Path

import yaml
from platformdirs import user_config_path

from app import create_app


def config_path() -> Path:
    # Force XDG semantics so the backend shares ~/.config/opencode-dashboard
    # with the front end; platformdirs would otherwise use ~/Library/Application
    # Support on macOS. setdefault keeps a user-set XDG_CONFIG_HOME intact.
    os.environ.setdefault("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    return user_config_path("opencode-dashboard") / "server.yaml"


def load_config(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def _prompt(label: str, current, default) -> str:
    hint = current if current != "" else default
    try:
        value = input(f"{label} [{hint}]: ").strip()
    except EOFError:
        return hint
    return value if value else hint


def _prompt_num(label: str, current, default, conv):
    while True:
        try:
            return conv(_prompt(label, current, default))
        except ValueError:
            print(f"Invalid {label}; enter a number.")


def cmd_configure(args) -> None:
    path = config_path()
    existing = load_config(path)
    cur = {
        "port": existing.get("port", 8791),
        "host": existing.get("host", "0.0.0.0"),
        "cors_origins": existing.get("cors_origins", ""),
        "poll_seconds": existing.get("poll_seconds", 5),
        "opencode_bin": existing.get("opencode_bin", "opencode"),
    }
    if existing:
        print(f"Current config at {path}:")
        print(yaml.safe_dump(cur, sort_keys=False).rstrip())
        print()
    cur["port"] = _prompt_num("port", cur["port"], 8791, int)
    cur["host"] = _prompt("host", cur["host"], "0.0.0.0")
    cur["cors_origins"] = _prompt(
        "cors_origins (comma-separated; empty = built-in loopback whitelist)",
        cur["cors_origins"], "",
    )
    cur["poll_seconds"] = _prompt_num("poll_seconds", cur["poll_seconds"], 5, float)
    cur["opencode_bin"] = _prompt("opencode_bin", cur["opencode_bin"], "opencode")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(cur, sort_keys=False))
    print(f"Wrote {path}")


def cmd_serve(args) -> None:
    path = args.config or config_path()
    cfg = load_config(path)
    try:
        port = args.port or int(os.environ.get("PORT") or cfg.get("port") or 8791)
    except ValueError:
        print(f"invalid port: {os.environ.get('PORT') or cfg.get('port')!r}")
        sys.exit(2)
    host = args.host or os.environ.get("HOST") or cfg.get("host") or "0.0.0.0"

    import uvicorn

    # cors_origins is stored comma-separated; create_app expects a list.
    cors = [o.strip() for o in str(cfg.get("cors_origins", "")).split(",") if o.strip()]

    uvicorn.run(
        create_app(
            cors_origins=cors or None,
            poll_seconds=cfg.get("poll_seconds"),
            opencode_bin=cfg.get("opencode_bin") or None,
        ),
        host=host,
        port=port,
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="opencode-dashboard-server",
        description="opencode token dashboard aggregation backend",
    )
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("configure", help="interactively write the XDG config file")
    serve = sub.add_parser("serve", help="run the server (FastAPI + uvicorn)")
    serve.add_argument("--config", metavar="PATH", help="config file (default: XDG server.yaml)")
    serve.add_argument("--port", type=int, help="listen port")
    serve.add_argument("--host", help="bind host")
    args = parser.parse_args(argv)
    if args.cmd == "configure":
        cmd_configure(args)
    elif args.cmd == "serve":
        cmd_serve(args)
    else:
        parser.print_usage()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
