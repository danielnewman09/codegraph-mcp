#!/usr/bin/env python3
"""Codegraph bridge — stdio JSON-RPC daemon for the codegraph Pi extension.

The Pi extension (TypeScript) spawns this process once per session and
keeps it alive.  It speaks newline-delimited JSON over stdin/stdout:

    request:  {"id": <int>, "method": <str>, "params": <object>}
    response: {"id": <int>, "ok": true,  "result": <any>}
             {"id": <int>, "ok": false, "error": <str>}

Only JSON lines are written to stdout — all diagnostics go to stderr so
the framing channel stays clean.

Two methods mirror the extension's two-tool surface:

* ``query``  — fetch a subgraph (scoped by tag / namespace / compound /
  neighborhood / source / kind / cached) and return it formatted as
  markdown, plantuml, json, or an interactive HTML visualisation.
* ``explore`` — lightweight lookups (search, get_compound, get_member,
  browse_namespace, list_sources, list_tags, inheritance,
  callers/callees) returning slim JSON.

Both reuse the existing :class:`codegraph.tools.CodeGraphDispatcher`,
which caches the last fetched graph in ``current_graph`` so that
``scope=cached`` re-exports and ``format=html`` renders can reuse it
without re-querying Neo4j.

The Neo4j connection is configured from environment variables
(``NEO4J_URI``, ``NEO4J_USER``, ``NEO4J_PASSWORD``) by
:mod:`codegraph.config` at import time; the child process inherits the
host environment.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile

# ── Dispatcher singleton (lazy) ────────────────────────────────────────────

_dispatcher = None


def get_dispatcher():
    """Lazily construct the CodeGraphDispatcher (imports codegraph)."""
    global _dispatcher
    if _dispatcher is None:
        from codegraph.tools import CodeGraphDispatcher

        _dispatcher = CodeGraphDispatcher()
    return _dispatcher


# ── Scope → graph construction (for HTML rendering + caching) ──────────────


def _build_graph(disp, scope: str, params: dict):
    """Return a LayerGraph for the requested scope.

    Used by the HTML path (which needs a live graph object) and to seed
    ``current_graph`` so ``scope=cached`` works afterwards.
    """
    repo = disp.repo
    if scope == "tag":
        tag = params.get("tag")
        if not tag:
            raise ValueError("scope='tag' requires 'tag'")
        return repo.get_by_tag(tag)
    if scope == "namespace":
        qn = params.get("qualified_name")
        if not qn:
            raise ValueError("scope='namespace' requires 'qualified_name'")
        return repo.get_by_namespace(qn)
    if scope == "compound":
        qn = params.get("qualified_name")
        if not qn:
            raise ValueError("scope='compound' requires 'qualified_name'")
        return repo.get_by_compound(qn)
    if scope == "neighborhood":
        qn = params.get("qualified_name")
        if not qn:
            raise ValueError("scope='neighborhood' requires 'qualified_name'")
        return repo.get_by_neighbourhood(qn)
    if scope == "source":
        src = params.get("source")
        if not src:
            raise ValueError("scope='source' requires 'source'")
        return repo.get_by_source(src)
    if scope == "kind":
        kind = params.get("kind")
        if not kind:
            raise ValueError("scope='kind' requires 'kind'")
        return repo.get_by_kind(kind, tag=params.get("tag"))
    if scope == "cached":
        if disp.current_graph is None:
            raise ValueError(
                "scope='cached' has no graph cached yet. Run a fetch "
                "query (e.g. scope='tag') first."
            )
        return disp.current_graph
    raise ValueError(f"Unknown scope: {scope!r}")


# ── Scope → dispatcher tool (text formats reuse existing handlers) ───────

_SCOPE_TO_TOOL = {
    "tag": ("graph_fetch", ("tag", "format", "public_only")),
    "namespace": ("graph_fetch_namespace", ("qualified_name", "format")),
    "compound": ("graph_fetch_compound", ("qualified_name", "format")),
    "neighborhood": ("graph_fetch_neighborhood", ("qualified_name", "format")),
    "source": ("graph_fetch_by_source", ("source", "format")),
    "kind": ("graph_fetch_by_kind", ("kind", "tag", "format")),
    "cached": ("graph_format_export", ("format",)),
}


def _pick(params: dict, keys) -> dict:
    """Build a sub-dict of non-None params for the given keys."""
    return {k: params[k] for k in keys if k in params and params[k] is not None}


# ── HTML rendering helpers ────────────────────────────────────────────────


def _title_for(scope: str, params: dict) -> str:
    for key in ("qualified_name", "tag", "source", "kind"):
        v = params.get(key)
        if v:
            return str(v)
    return scope


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:120] or "graph"


def _default_html_path(title: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"codegraph_{_sanitize(title)}.html")


# ── Method handlers ───────────────────────────────────────────────────────


def handle_ping() -> dict:
    """Health check — report codegraph availability + version."""
    try:
        import codegraph  # noqa: F401
        from codegraph.tools import CodeGraphDispatcher  # noqa: F401

        version = getattr(codegraph, "__version__", "unknown")
        return {"ok": True, "version": version, "methods": ["ping", "query", "explore"]}
    except Exception as exc:  # codegraph not importable
        return {"ok": False, "error": f"codegraph import failed: {exc}"}


def handle_query(params: dict):
    disp = get_dispatcher()
    scope = params.get("scope")
    if scope not in _SCOPE_TO_TOOL:
        raise ValueError(
            f"Unknown scope {scope!r}. Valid: {sorted(_SCOPE_TO_TOOL)}"
        )
    fmt = params.get("format", "markdown")

    if fmt == "html":
        graph = _build_graph(disp, scope, params)
        disp.current_graph = graph  # cache for scope=cached / re-renders
        from codegraph.viz.api import _render_html

        size = params.get("size", "large")
        title = _title_for(scope, params)
        out = params.get("output") or _default_html_path(title)
        path = _render_html(graph, title, out, size=size)
        return {"html_path": path, "title": title, "scope": scope, "size": size}

    # text formats — reuse the dispatcher's existing fetch/export handlers
    tool_name, keys = _SCOPE_TO_TOOL[scope]
    return disp.dispatch(tool_name, _pick(params, keys))


# explore action → dispatcher tool
_ACTION_TO_TOOL = {
    "search": ("search_symbols", ("query", "source", "kind", "limit")),
    "compound": ("get_compound", ("qualified_name",)),
    "member": ("get_member", ("qualified_name",)),
    "namespace": ("browse_namespace", ("namespace", "limit")),
    "sources": ("list_sources", ()),
    "tags": ("graph_list_tags", ()),
    "inheritance": ("find_inheritance", ("qualified_name",)),
    "callers_callees": ("find_callers_and_callees", ("qualified_name",)),
}


def handle_explore(params: dict):
    disp = get_dispatcher()
    action = params.get("action")
    if action not in _ACTION_TO_TOOL:
        raise ValueError(
            f"Unknown action {action!r}. Valid: {sorted(_ACTION_TO_TOOL)}"
        )
    tool_name, keys = _ACTION_TO_TOOL[action]
    return disp.dispatch(tool_name, _pick(params, keys))


# ── Setup: bootstrap, config, indexing, Neo4j/Docker lifecycle ─────────────
#
# These actions drive the ``doxygen-index`` and ``codegraph-db`` CLIs as
# subprocesses (``sys.executable -m <module>``) so their stdout/stderr and
# ``sys.exit`` behaviour can never corrupt this bridge's JSON framing channel.
# They run in the same interpreter/venv as the bridge, so the CLIs are
# guaranteed to be importable once the environment is bootstrapped.

import shutil
import subprocess

_TAIL = 12_000  # max chars of captured stdout/stderr we return per command


def _tail(text: str, limit: int = _TAIL) -> str:
    if len(text) <= limit:
        return text
    return "…(truncated head)…\n" + text[-limit:]


def _run_cli(module: str, args: list[str], *, cwd: str, timeout: float) -> dict:
    """Run ``python -m <module> <args>`` capturing output."""
    cmd = [sys.executable, "-m", module, *args]
    try:
        cp = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
            env={**os.environ},
        )
        return {
            "command": cmd,
            "exit_code": cp.returncode,
            "stdout": _tail(cp.stdout or ""),
            "stderr": _tail(cp.stderr or ""),
        }
    except subprocess.TimeoutExpired as e:
        return {
            "command": cmd,
            "exit_code": -1,
            "stdout": _tail((e.stdout or "") if isinstance(e.stdout, str) else ""),
            "stderr": _tail((e.stderr or "") if isinstance(e.stderr, str) else "")
                      + f"\nTimed out after {timeout}s",
            "timed_out": True,
        }
    except FileNotFoundError as e:
        return {"command": cmd, "exit_code": -1, "stdout": "", "stderr": str(e)}


def _detect_project(project_dir: str) -> dict:
    """Auto-detect language / input_paths / test_paths / name from a repo."""
    from pathlib import Path

    p = Path(project_dir).resolve()
    name = p.name

    # Try to read a project name from pyproject.toml
    pyproject = p / "pyproject.toml"
    if pyproject.exists():
        try:
            import tomllib
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
            proj = data.get("project", {})
            if proj.get("name"):
                name = proj["name"]
        except Exception:
            pass

    def has(dirnames):
        return any((p / d).is_dir() for d in dirnames)

    def any_glob(patterns):
        return any(p.glob(pat) for pat in patterns)

    py_signals = (
        pyproject.exists()
        or (p / "setup.py").exists()
        or (p / "src").is_dir() and any((p / "src").rglob("*.py"))
        or any_glob(("*.py",))
    )
    cpp_signals = (
        (p / "CMakeLists.txt").exists()
        or (p / "conanfile.py").exists()
        or (p / "conanfile.txt").exists()
        or (p / "include").is_dir()
        or any_glob(("*.h", "*.hpp", "*.cpp", "*.cxx", "*.cc"))
    )

    if py_signals and not cpp_signals:
        language = "python"
    elif cpp_signals and not py_signals:
        language = "cpp"
    elif py_signals and cpp_signals:
        # Both present — prefer python if there's a src/ package, else cpp.
        language = "python" if (p / "src").is_dir() and any((p / "src").rglob("*.py")) else "cpp"
    else:
        language = "python"  # safe default

    if language == "python":
        inputs = ["src"] if (p / "src").is_dir() else (["lib"] if (p / "lib").is_dir() else ["."])
        tests = []
        for t in ("tests", "test"):
            if (p / t).is_dir():
                tests = [t]
                break
    else:
        inputs = [d for d in ("include", "src", "lib") if (p / d).is_dir()] or ["."]
        tests = []

    return {"name": name, "language": language, "input_paths": inputs, "test_paths": tests}


def _render_doxygen_toml(cfg: dict, html: bool) -> str:
    lines = [
        "[project]",
        f'name = "{cfg["name"]}"',
        f'language = "{cfg["language"]}"',
        'input_paths = ' + json.dumps(cfg["input_paths"]),
    ]
    if cfg.get("test_paths"):
        lines.append('test_paths = ' + json.dumps(cfg["test_paths"]))
    lines.append('')
    if html:
        lines += [
            "[codegraph-html]",
            'output_dir = "codegraph"',
            'size = "large"',
            "",
        ]
    return "\n".join(lines) + "\n"


def handle_setup(params: dict):
    action = params.get("action")
    project_dir = params.get("project_dir") or os.getcwd()
    pd = os.path.abspath(project_dir)

    if action == "init_config":
        from pathlib import Path
        cfg = _detect_project(pd)
        # explicit overrides
        for k in ("name", "language", "input_paths", "test_paths"):
            if params.get(k):
                cfg[k] = params[k]
        html = params.get("html", True)
        force = params.get("force", False)
        path = Path(pd) / ".doxygen-index.toml"
        existed = path.exists()
        if existed and not force:
            return {"path": str(path), "existed": True, "overwritten": False,
                    "detected": cfg, "current": path.read_text(encoding="utf-8")}
        path.write_text(_render_doxygen_toml(cfg, html=html), encoding="utf-8")
        return {"path": str(path), "existed": existed, "overwritten": existed,
                "written": True, "config": cfg, "html": html,
                "toml": _render_doxygen_toml(cfg, html=html)}

    if action == "index":
        fmt = params.get("format", "neo4j")
        timeout = float(params.get("timeout", 600))
        args = ["project", pd, "--format", fmt]
        if params.get("clear", True):
            args.append("--clear")
        if params.get("output_dir"):
            args += ["--output-dir", params["output_dir"]]
        if params.get("source"):
            args += ["--source", params["source"]]
        if params.get("test_paths"):
            args += ["--test-paths", *params["test_paths"]]
        res = _run_cli("doxygen_index.cli", args, cwd=pd, timeout=timeout)
        res["format"] = fmt
        return res

    if action in ("db_start", "db_stop", "db_restart", "db_status"):
        cmd = action.split("_", 1)[1]
        timeout = float(params.get("timeout", 120))
        res = _run_cli("codegraph.db_cli", [cmd, "--project-dir", pd],
                       cwd=pd, timeout=timeout)
        res["container_action"] = cmd
        return res

    if action == "bootstrap":
        # One-shot: init_config → db_start → index(neo4j)
        steps = []
        cfg_res = handle_setup({**params, "action": "init_config"})
        steps.append({"step": "init_config", "result": cfg_res})
        fmt = params.get("format", "neo4j")
        if fmt == "neo4j":
            db_res = handle_setup({**params, "action": "db_start", "timeout": 120})
            steps.append({"step": "db_start", "result": db_res})
        idx_res = handle_setup({**params, "action": "index", "format": fmt,
                                "timeout": params.get("timeout", 600)})
        steps.append({"step": "index", "result": idx_res})
        return {"bootstrapped": True, "steps": steps}

    if action == "status":
        out = {"bridge": True}
        try:
            import codegraph
            out["codegraph_version"] = getattr(codegraph, "__version__", "unknown")
        except Exception as e:
            out["codegraph_version"] = f"import error: {e}"
        try:
            from codegraph.connection import verify_connectivity
            out["neo4j_reachable"] = bool(verify_connectivity())
        except Exception as e:
            out["neo4j_reachable"] = False
            out["neo4j_error"] = str(e)
        if params.get("project_dir"):
            out["docker"] = _run_cli("codegraph.db_cli", ["status", "--project-dir", pd],
                                     cwd=pd, timeout=30)
        try:
            out["tags"] = json.loads(handle_explore({"action": "tags"}))
        except Exception as e:
            out["tags_error"] = str(e)
        return out

    raise ValueError(
        f"Unknown setup action {action!r}. Valid: bootstrap_env, init_config, "
        f"index, db_start, db_stop, db_restart, db_status, bootstrap, status"
    )


# ── Main loop ──────────────────────────────────────────────────────────────


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
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
            except Exception:
                pass
            return


def main() -> None:
    # Line-buffer stderr so diagnostics appear promptly.
    try:
        sys.stderr.reconfigure(line_buffering=True)  # py3.7+
    except Exception:
        pass

    # Silence noisy DBMS notifications (e.g. "relationship type `RETURNS` does
    # not exist") emitted by the neo4j driver / neomodel when walking edges
    # for relationship types not present in the current schema.  These are
    # harmless warnings that would otherwise flood the extension's stderr.
    import logging
    for noisy in ("neo4j", "neomodel", "py2neo"):
        logging.getLogger(noisy).setLevel(logging.ERROR)

    # Auto-load a .env from the cwd (or nearest parent) so NEO4J_URI / NEO4J_USER /
    # NEO4J_PASSWORD are picked up without manual exporting — mirroring
    # doxygen-index's behaviour. Real environment variables always win.
    _load_dotenv()

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
            elif method == "setup":
                result = handle_setup(params)
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