#!/usr/bin/env python3
"""Codegraph bridge — stdio JSON-RPC daemon for the codegraph Pi extension.

The Pi extension (TypeScript) spawns this process once per session and
keeps it alive.  It speaks newline-delimited JSON over stdin/stdout:

    request:  {"id": <int>, "method": <str>, "params": <object>}
    response: {"id": <int>, "ok": true,  "result": <any>}
              {"id": <int>, "ok": false, "error": <str>}

Only JSON lines are written to stdout — all diagnostics go to stderr so
the framing channel stays clean.

Handler modules live in ``handlers/`` — one per functional group
(query, explore, tests, stats, setup, discover, decompose, design, memory).
The bridge dispatches incoming JSON-RPC methods to the appropriate handler.

The Neo4j connection is configured from environment variables
(``NEO4J_URI``, ``NEO4J_USER``, ``NEO4J_PASSWORD``) by
:mod:`codegraph.config` at import time; the child process inherits the
host environment.
"""

from __future__ import annotations

import json
import logging
import os
import sys

# Ensure the bridge's own directory is on sys.path so handler imports work
# regardless of cwd (the TS side spawns this script directly).
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

# ── dotenv loader ──────────────────────────────────────────────────────────
# Must run BEFORE any handler imports so NEO4J_URI / NEO4J_USER /
# NEO4J_PASSWORD are in os.environ when codegraph.persistence.config
# is loaded at import time.

def _load_dotenv() -> None:
    """Load a .env from the cwd or nearest parent (real env vars win)."""
    from pathlib import Path
    d = Path.cwd()
    for cand in [d, *d.parents]:
        env_file = cand / ".env"
        if env_file.is_file():
            try:
                for line in env_file.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    # Strip inline comments (# after value)
                    if "#" in line:
                        eq_idx = line.index("=")
                        comment_idx = line.index("#", eq_idx)
                        if comment_idx > eq_idx:
                            line = line[:comment_idx].rstrip()
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
                    elif key and key in os.environ and (key.startswith("LLM") or key == "ENRICH_LOG_DIR"):
                        # .env is authoritative for LLM config — always override
                        os.environ[key] = val
            except Exception:
                pass
            return

_load_dotenv()

from handlers.query import handle_ping, handle_query, handle_debug_env  # noqa: E402
from handlers.explore import handle_explore  # noqa: E402
from handlers.tests import handle_tests  # noqa: E402
from handlers.stats import handle_stats  # noqa: E402
from handlers.setup import handle_setup  # noqa: E402
from handlers.discover import handle_discover  # noqa: E402
from handlers.decompose import (  # noqa: E402
    handle_decompose_run, handle_decompose_validate,
)
from handlers.design import (  # noqa: E402
    handle_design_run, handle_design_prompt, handle_decompose_prompt,
)
from handlers.memory import handle_memory  # noqa: E402


# ── Main loop ──────────────────────────────────────────────────────────────

def main() -> None:
    # Line-buffer stderr so diagnostics appear promptly.
    try:
        sys.stderr.reconfigure(line_buffering=True)  # py3.7+
    except Exception:
        pass

    # Silence noisy DBMS notifications (e.g. "relationship type `RETURNS` does
    # not exist") emitted by the neo4j driver / neomodel when walking edges
    # for relationship types not present in the current schema.
    for noisy in ("neo4j", "neomodel", "py2neo"):
        logging.getLogger(noisy).setLevel(logging.ERROR)

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        rid = None
        try:
            req = json.loads(raw)
            rid = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}

            if method == "ping":
                result = handle_ping()
            elif method == "query":
                result = handle_query(params)
            elif method == "explore":
                result = handle_explore(params)
            elif method == "tests":
                result = handle_tests(params)
            elif method == "stats":
                result = handle_stats()
            elif method == "setup":
                result = handle_setup(params)
            elif method == "discover":
                result = handle_discover(params)
            elif method == "memory":
                result = handle_memory(params)
            elif method == "decompose_run":
                result = handle_decompose_run(params)
            elif method == "decompose_validate":
                result = handle_decompose_validate(params)
            elif method == "design_run":
                result = handle_design_run(params)
            elif method == "decompose_prompt":
                result = handle_decompose_prompt(params)
            elif method == "design_prompt":
                result = handle_design_prompt(params)
            elif method == "debug_env":
                result = handle_debug_env()
            elif method == "shutdown":
                break
            else:
                raise ValueError(f"unknown method: {method!r}")

            sys.stdout.write(json.dumps({"id": rid, "ok": True, "result": result}) + "\n")
        except Exception as exc:
            sys.stdout.write(
                json.dumps({"id": rid, "ok": False, "error": str(exc)}) + "\n"
            )
        sys.stdout.flush()


if __name__ == "__main__":
    main()
