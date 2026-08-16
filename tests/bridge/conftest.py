"""Hermetic backend isolation for bridge handler tests.

The codegraph backend is a process-global singleton auto-configured from
``CODEGRAPH_BACKEND`` / ``SQLITE_PATH``.  A handler test that calls
``get_backend()`` can therefore leak state (or the Neo4j default in shared
environments) into later tests.  This autouse fixture forces a fresh SQLite
backend at a per-test temporary path and resets the singleton around every
test, so tests are order-independent under any interpreter that has codegraph
installed (and degrade cleanly when it is not).
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _hermetic_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEGRAPH_BACKEND", "sqlite")
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "codegraph-test.sqlite3"))

    backends = None
    try:
        import codegraph.backends as backends
    except Exception:
        backends = None

    def _reset() -> None:
        if backends is not None:
            backends._current_backend = None
            backends._force_configured = False

    _reset()
    yield
    _reset()
