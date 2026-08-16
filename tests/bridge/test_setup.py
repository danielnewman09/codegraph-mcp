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


# ── Status: database path from the active backend configuration ───────────


def test_status_reports_backend_database_path(monkeypatch):
    """The status handler must report the backend's database path — never a
    path reconstructed from project_dir."""
    monkeypatch.setattr("bridge.handlers.setup._active_sqlite_path",
                        lambda: "/abs/backend/project/codegraph.sqlite3")
    result = handle_setup({"action": "status", "project_dir": "/elsewhere"})
    assert result["bridge"] is True
    db = result.get("database")
    assert db is not None, "status must include a database block for sqlite"
    assert db["path"] == "/abs/backend/project/codegraph.sqlite3"


def test_status_database_reports_existence_and_size(monkeypatch, tmp_path):
    db = tmp_path / "codegraph.sqlite3"
    db.write_bytes(b"x" * 1234)
    monkeypatch.setattr("bridge.handlers.setup._active_sqlite_path",
                        lambda: str(db))
    result = handle_setup({"action": "status"})
    assert result["database"]["exists"] is True
    assert result["database"]["size_bytes"] == 1234


def test_status_degraded_without_backend_or_path(monkeypatch):
    """Without a configured backend the handler still emits sources and a
    tags/errors diagnostic instead of crashing."""
    monkeypatch.setattr("bridge.handlers.setup._active_sqlite_path", lambda: None)
    result = handle_setup({"action": "status"})
    assert "sources" in result
    assert "tags" in result or "tags_error" in result


def test_status_keeps_legacy_actions_working():
    result = handle_setup({"action": "status"})
    assert "bridge" in result


# ── migrate_database ───────────────────────────────────────────────────────


def _make_codegraph_db(path, nodes=5, edges=3):
    """Create a minimal codegraph SQLite database (nodes/edges tables)."""
    import sqlite3

    con = sqlite3.connect(path)
    try:
        con.execute("CREATE TABLE nodes (id INTEGER PRIMARY KEY, uid TEXT, kind TEXT)")
        con.execute("CREATE TABLE edges (id INTEGER PRIMARY KEY, source_id INT, target_id INT)")
        con.executemany("INSERT INTO nodes (uid, kind) VALUES (?, ?)",
                        [(f"uid{i}", "class") for i in range(nodes)])
        con.executemany("INSERT INTO edges (source_id, target_id) VALUES (?, ?)",
                        [(i, i + 1) for i in range(edges)])
        con.commit()
    finally:
        con.close()


def test_migrate_database_copies_with_counts_validated(tmp_path):
    src = tmp_path / "legacy.sqlite3"
    dest = tmp_path / "project" / "codegraph.sqlite3"
    _make_codegraph_db(str(src), nodes=7, edges=4)
    result = handle_setup({"action": "migrate_database", "legacy_path": str(src), "to_path": str(dest)})
    assert result["ok"] is True
    assert result["source_nodes"] == 7
    assert result["destination_nodes"] == 7
    assert result["source_edges"] == 4
    assert result["destination_edges"] == 4
    assert result["validated"] is True
    # The original must be preserved as a recoverable backup.
    assert src.exists()
    assert dest.exists()


def test_migrate_database_preserves_wal_state(tmp_path):
    """SQLite's backup API copies a WAL-mode database without data loss."""
    import sqlite3

    src = tmp_path / "wal.sqlite3"
    dest = tmp_path / "dest.sqlite3"
    _make_codegraph_db(str(src), nodes=3, edges=2)
    con = sqlite3.connect(str(src))
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE extra (v INT)")
    con.execute("INSERT INTO extra VALUES (42)")
    con.commit()
    con.close()
    # A wal file may exist after close; backup must capture committed data.
    result = handle_setup({"action": "migrate_database", "legacy_path": str(src), "to_path": str(dest)})
    assert result["ok"] is True
    con = sqlite3.connect(str(dest))
    try:
        extra = con.execute("SELECT v FROM extra").fetchone()[0]
    finally:
        con.close()
    assert extra == 42


def test_migrate_database_refuses_populated_destination_without_force(tmp_path):
    src = tmp_path / "legacy.sqlite3"
    dest = tmp_path / "existing.sqlite3"
    _make_codegraph_db(str(src), nodes=5, edges=2)
    _make_codegraph_db(str(dest), nodes=99, edges=99)
    result = handle_setup({"action": "migrate_database", "legacy_path": str(src), "to_path": str(dest)})
    assert result["ok"] is False
    assert "force" in result["error"]
    # Destination untouched.
    con = sqlite3_connect(str(dest))
    try:
        assert con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 99
    finally:
        con.close()


def sqlite3_connect(path):
    import sqlite3
    return sqlite3.connect(path)


def test_migrate_database_force_preserves_destination_backup(tmp_path):
    src = tmp_path / "legacy.sqlite3"
    dest = tmp_path / "existing.sqlite3"
    _make_codegraph_db(str(src), nodes=5, edges=2)
    _make_codegraph_db(str(dest), nodes=99, edges=99)
    result = handle_setup({"action": "migrate_database", "legacy_path": str(src),
                           "to_path": str(dest), "force": True})
    assert result["ok"] is True
    assert result["preserved_original"] is not None
    assert (tmp_path / "existing.sqlite3.pre-migrate").exists()
    assert result["destination_nodes"] == 5


def test_migrate_database_missing_source_errors(tmp_path):
    result = handle_setup({"action": "migrate_database",
                           "legacy_path": str(tmp_path / "nope.sqlite3"),
                           "to_path": str(tmp_path / "dest.sqlite3")})
    assert result["ok"] is False
    assert "not found" in result["error"]


def test_migrate_database_non_codegraph_source_errors(tmp_path):
    src = tmp_path / "not-a-db.sqlite3"
    src.write_bytes(b"not a real database")
    result = handle_setup({"action": "migrate_database", "legacy_path": str(src),
                           "to_path": str(tmp_path / "dest.sqlite3")})
    assert result["ok"] is False
    assert "not a codegraph database" in result["error"]
