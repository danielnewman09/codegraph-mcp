"""Setup handler — bootstrap, config, indexing, backend lifecycle.

These actions drive the ``doxygen-index`` and ``codegraph-db`` CLIs as
subprocesses (``sys.executable -m <module>``) so their stdout/stderr and
``sys.exit`` behaviour can never corrupt this bridge's JSON framing channel.
They run in the same interpreter/venv as the bridge, so the CLIs are
guaranteed to be importable once the environment is bootstrapped.

The default backend is SQLite (a plain file — no Docker).  Pass
``backend="neo4j"`` to opt into the Neo4j/Docker flow; the ``db_*``
actions remain available for that backend.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

from .explore import handle_explore
from .stats import handle_stats

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
    if html:
        lines.append("")
        lines.append("[codegraph-html]")
        lines.append('output_dir = "codegraph"')
        lines.append('size = "large"')
    return "\n".join(lines) + "\n"


# ── Setup ─────────────────────────────────────────────────────────────────


def _apply_backend(params: dict) -> None:
    """Honour an optional ``backend`` param ("sqlite" | "neo4j") by setting
    CODEGRAPH_BACKEND for CLI subprocesses.  Without it, the codegraph
    default applies (SQLite)."""
    backend = (params.get("backend") or "").strip().lower()
    if backend in ("sqlite", "neo4j"):
        os.environ["CODEGRAPH_BACKEND"] = backend


def _active_sqlite_path() -> str | None:
    """Absolute path of the SQLite database actually opened by the backend.

    Reads the active backend's config (the bridge child inherits an absolute
    ``SQLITE_PATH`` from the TypeScript runtime, so the backend config and
    this env var agree by construction).  Falls back to the env var when the
    backend isn't constructed yet.  Never reconstructs the path from
    ``project_dir``.
    """
    try:
        from codegraph import get_backend

        backend = get_backend()
        cfg = getattr(backend, "_config", None)
        path = getattr(cfg, "path", None)
        if isinstance(path, str) and path and path != ":memory:":
            return os.path.abspath(path)
    except Exception:
        pass
    env_path = (os.environ.get("SQLITE_PATH") or "").strip()
    if env_path:
        return os.path.abspath(env_path)
    return None


def _sqlite_counts(path: str) -> tuple[int | None, int | None]:
    """(nodes, edges) counts for a SQLite file, or (None, None) if it is not
    a codegraph database."""
    import sqlite3

    try:
        con = sqlite3.connect(path)
        try:
            nodes = con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
            edges = con.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
            return int(nodes), int(edges)
        finally:
            con.close()
    except sqlite3.Error:
        return None, None


def _handle_migrate_database(params: dict) -> dict:
    """Explicit migration of a legacy database into a new location.

    - Inspects the legacy database (nodes + edges tables).
    - Refuses to overwrite a populated destination without ``force``.
    - Copies with SQLite's backup API so WAL state is handled correctly.
    - Preserves the original and any pre-existing destination file.
    - Validates source, node, and edge counts at the destination.
    """
    import shutil
    import sqlite3

    src = (params.get("legacy_path") or "").strip()
    if not src:
        raise ValueError("migrate_database requires legacy_path")
    src_abs = os.path.abspath(src)
    if not os.path.isfile(src_abs):
        return {"ok": False, "error": f"legacy database not found: {src_abs}"}

    dest = (params.get("to_path") or "").strip() or (os.environ.get("SQLITE_PATH") or "").strip()
    if not dest:
        return {"ok": False,
                "error": "migrate_database needs a destination (to_path, or an active project SQLITE_PATH)"}
    dest_abs = os.path.abspath(dest)
    if src_abs == dest_abs:
        return {"ok": False, "error": "source and destination are the same file"}

    src_nodes, src_edges = _sqlite_counts(src_abs)
    if src_nodes is None:
        return {"ok": False, "error": f"{src_abs} is not a codegraph database (no nodes table)"}

    # Refuse to overwrite a populated destination without explicit
    # destructive authorization.
    preserved = None
    if os.path.exists(dest_abs):
        dn, de = _sqlite_counts(dest_abs)
        if (dn or 0) > 0 or (de or 0) > 0:
            if not params.get("force"):
                return {"ok": False,
                        "error": (f"destination {dest_abs} already contains {dn} nodes — "
                                  f"pass force=true to overwrite (the original is preserved)")}
        preserved = dest_abs + ".pre-migrate"
        shutil.copy2(dest_abs, preserved)
        for suffix in ("-wal", "-shm"):
            side = dest_abs + suffix
            if os.path.exists(side):
                shutil.copy2(side, preserved + suffix)

    os.makedirs(os.path.dirname(dest_abs) or ".", exist_ok=True)
    src_con = sqlite3.connect(src_abs)
    dst_con = sqlite3.connect(dest_abs)
    try:
        src_con.backup(dst_con)
        dst_con.commit()
    finally:
        dst_con.close()
        src_con.close()

    dn, de = _sqlite_counts(dest_abs)
    return {
        "ok": True,
        "source": src_abs,
        "source_size_bytes": os.path.getsize(src_abs),
        "destination": dest_abs,
        "source_nodes": src_nodes,
        "source_edges": src_edges,
        "destination_nodes": dn,
        "destination_edges": de,
        "preserved_original": preserved,
        "validated": dn == src_nodes and de == src_edges,
    }


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
        _apply_backend(params)
        # Database targets are explicit: SQLite is the default, while Neo4j
        # is retained as a deprecated legacy backend. JSON writes a file.
        backend = os.environ.get("CODEGRAPH_BACKEND", "sqlite")
        fmt = params.get("format") or backend
        timeout = float(params.get("timeout", 600))
        args = ["project", pd, "--format", fmt]
        # Default clear=False so an inadvertent agent call can't wipe an
        # existing source. Pass clear=true explicitly to replace data.
        if params.get("clear", False):
            # --yes skips the CLI's interactive "Proceed? [y/N]" prompt, which
            # would otherwise block (or EOFError) in this non-interactive
            # subprocess.
            args += ["--clear", "--yes"]
        if params.get("output_dir"):
            args += ["--output-dir", params["output_dir"]]
        if params.get("source"):
            args += ["--source", params["source"]]
        if params.get("test_paths"):
            args += ["--test-paths", *params["test_paths"]]
        res = _run_cli("doxygen_index.cli", args, cwd=pd, timeout=timeout)
        res["format"] = fmt
        res["backend"] = os.environ.get("CODEGRAPH_BACKEND", "sqlite")
        return res

    if action == "migrate_database":
        return _handle_migrate_database(params)

    if action in ("db_start", "db_stop", "db_restart", "db_status"):
        cmd = action.split("_", 1)[1]
        timeout = float(params.get("timeout", 120))
        res = _run_cli("codegraph.persistence.db_cli", [cmd, "--project-dir", pd],
                       cwd=pd, timeout=timeout)
        res["container_action"] = cmd
        return res

    if action == "db_backup":
        mode = params.get("mode", "dump")
        keep = params.get("keep")
        timeout = float(params.get("timeout", 300))
        args = ["backup", "--project-dir", pd, "--mode", mode]
        if keep is not None:
            args += ["--keep", str(int(keep))]
        res = _run_cli("codegraph.persistence.db_cli", args, cwd=pd, timeout=timeout)
        res["backup_mode"] = mode
        return res

    if action == "db_restore":
        backup_file = params.get("backup_file", "")
        timeout = float(params.get("timeout", 300))
        args = ["restore", "--project-dir", pd]
        if backup_file:
            args.append(backup_file)
        res = _run_cli("codegraph.persistence.db_cli", args, cwd=pd, timeout=timeout)
        return res

    if action == "db_backups":
        timeout = float(params.get("timeout", 30))
        args = ["backups", "--project-dir", pd]
        res = _run_cli("codegraph.persistence.db_cli", args, cwd=pd, timeout=timeout)
        return res

    if action == "bootstrap":
        # One-shot: init_config → (db_start only for explicit Neo4j) → index.
        # With the default SQLite backend there is no Docker step at all.
        _apply_backend(params)
        backend = os.environ.get("CODEGRAPH_BACKEND", "sqlite")
        steps = []
        cfg_res = handle_setup({**params, "action": "init_config"})
        steps.append({"step": "init_config", "result": cfg_res})
        fmt = params.get("format") or backend
        if fmt == "neo4j" and backend == "neo4j":
            db_res = handle_setup({**params, "action": "db_start", "timeout": 120})
            steps.append({"step": "db_start", "result": db_res})
        idx_res = handle_setup({**params, "action": "index", "format": fmt,
                                "clear": True,
                                "timeout": params.get("timeout", 600)})
        steps.append({"step": "index", "result": idx_res})
        return {"bootstrapped": True, "backend": backend, "steps": steps}

    if action == "status":
        out = {"bridge": True}
        try:
            import codegraph
            out["codegraph_version"] = getattr(codegraph, "__version__", "unknown")
        except Exception as e:
            out["codegraph_version"] = f"import error: {e}"
        try:
            from codegraph import get_backend
            backend = get_backend()
            out["backend"] = type(backend).__name__.replace("Backend", "").lower()
            out["backend_reachable"] = bool(backend.verify_connectivity())
        except Exception as e:
            backend = None
            out["backend"] = "unknown"
            out["backend_reachable"] = False
            out["backend_error"] = str(e)

        if out.get("backend") == "neo4j" and params.get("project_dir"):
            out["docker"] = _run_cli("codegraph.persistence.db_cli", ["status", "--project-dir", pd],
                                      cwd=pd, timeout=30)
        elif out.get("backend") == "sqlite":
            # Report the database path from the active backend configuration,
            # never reconstructed from project_dir.
            db_path = _active_sqlite_path()
            out["database"] = {
                "path": db_path,
                "exists": bool(db_path and os.path.isfile(db_path)),
                "size_bytes": os.path.getsize(db_path) if db_path and os.path.isfile(db_path) else 0,
                "total_nodes": None,
                "total_relationships": None,
            }
            try:
                stats = handle_stats()
                out["database"]["total_nodes"] = stats.get("total_nodes")
                out["database"]["total_relationships"] = stats.get("total_relationships")
                out["sources"] = stats.get("by_source", [])
            except Exception as e:
                out["stats_error"] = str(e)
                try:
                    out["sources"] = json.loads(handle_explore({"action": "sources"}))
                except Exception:
                    out["sources"] = []
        else:
            # Backend unknown/unavailable: still report the configured
            # SQLite database path and any source rollup we can obtain.
            db_path = _active_sqlite_path()
            if db_path:
                out["database"] = {
                    "path": db_path,
                    "exists": bool(os.path.isfile(db_path)),
                    "size_bytes": os.path.getsize(db_path) if os.path.isfile(db_path) else 0,
                    "total_nodes": None,
                    "total_relationships": None,
                }
            try:
                parsed = json.loads(handle_explore({"action": "sources"}))
                out["sources"] = parsed.get("sources", {}) if isinstance(parsed, dict) else parsed
            except Exception:
                out["sources"] = []
        try:
            out["tags"] = json.loads(handle_explore({"action": "tags"}))
        except Exception as e:
            out["tags_error"] = str(e)
        try:
            import codegraph_memory  # noqa: F401
            out["memory_available"] = True
        except Exception as e:
            out["memory_available"] = False
            out["memory_error"] = str(e)
        return out

    raise ValueError(
        f"Unknown setup action {action!r}. Valid: bootstrap_env, init_config, "
        f"index, index_all, migrate_database, db_start, db_stop, db_restart, "
        f"db_status, db_backup, db_restore, db_backups, bootstrap, status"
    )
