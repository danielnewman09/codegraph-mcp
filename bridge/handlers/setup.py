"""Setup handler — bootstrap, config, indexing, Neo4j/Docker lifecycle.

These actions drive the ``doxygen-index`` and ``codegraph-db`` CLIs as
subprocesses (``sys.executable -m <module>``) so their stdout/stderr and
``sys.exit`` behaviour can never corrupt this bridge's JSON framing channel.
They run in the same interpreter/venv as the bridge, so the CLIs are
guaranteed to be importable once the environment is bootstrapped.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

from .explore import handle_explore

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

# ── Setup ─────────────────────────────────────────────────────────────────


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
        # Default clear=False so an inadvertent agent call can't wipe an
        # existing source. Pass clear=true explicitly to replace data.
        if params.get("clear", False):
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
        # One-shot: init_config → db_start → index(neo4j)
        steps = []
        cfg_res = handle_setup({**params, "action": "init_config"})
        steps.append({"step": "init_config", "result": cfg_res})
        fmt = params.get("format", "neo4j")
        if fmt == "neo4j":
            db_res = handle_setup({**params, "action": "db_start", "timeout": 120})
            steps.append({"step": "db_start", "result": db_res})
        idx_res = handle_setup({**params, "action": "index", "format": fmt,
                                "clear": True,
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
            from codegraph.persistence.connection import verify_connectivity
            out["neo4j_reachable"] = bool(verify_connectivity())
        except Exception as e:
            out["neo4j_reachable"] = False
            out["neo4j_error"] = str(e)
        if params.get("project_dir"):
            out["docker"] = _run_cli("codegraph.persistence.db_cli", ["status", "--project-dir", pd],
                                     cwd=pd, timeout=30)
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
        f"index, db_start, db_stop, db_restart, db_status, db_backup, "
        f"db_restore, db_backups, bootstrap, status"
    )

