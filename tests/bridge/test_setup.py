"""Regression tests for backend-specific setup command construction."""

from unittest.mock import patch

from bridge.handlers.setup import handle_setup


def _capture_index_args(params):
    with patch("bridge.handlers.setup._run_cli") as run:
        run.return_value = {"exit_code": 0, "stdout": "", "stderr": ""}
        result = handle_setup({"action": "index", "project_dir": "/tmp/project", **params})
    return run.call_args.args[1], result


def test_index_defaults_to_sqlite_format(monkeypatch):
    monkeypatch.delenv("CODEGRAPH_BACKEND", raising=False)
    args, result = _capture_index_args({})
    assert args == ["project", "/tmp/project", "--format", "sqlite"]
    assert result["backend"] == "sqlite"
    assert result["format"] == "sqlite"


def test_legacy_neo4j_backend_uses_neo4j_format(monkeypatch):
    monkeypatch.delenv("CODEGRAPH_BACKEND", raising=False)
    args, result = _capture_index_args({"backend": "neo4j"})
    assert args == ["project", "/tmp/project", "--format", "neo4j"]
    assert result["backend"] == "neo4j"
    assert result["format"] == "neo4j"
