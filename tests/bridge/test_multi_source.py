"""Real-SQLite multi-source contract and isolation tests.

These exercise the actual codegraph SQLite backend and the doxygen-index
write/clear path (not the fake JS bridge):

- the ``explore action=sources`` response contract (JSON string with an
  object map), and
- the central data-safety guarantee: two repositories written into one
  database with distinct source labels, then re-indexing one with
  ``clear=true`` must leave the other source and its node count untouched,
  while project-wide and source-filtered queries agree.

Requires codegraph + doxygen_index + sqlalchemy (e.g. the shared
``~/dev/.venv``); skipped when unavailable.  The ``conftest.py`` autouse
fixture forces ``CODEGRAPH_BACKEND=sqlite`` with a per-test temporary
``SQLITE_PATH`` and resets the process-global backend singleton.
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("codegraph")
pytest.importorskip("sqlalchemy")
dox_backend = pytest.importorskip("doxygen_index.neo4j_backend")

from codegraph import ClassNode  # noqa: E402
from codegraph import get_backend  # noqa: E402
from doxygen_index.parser.model import ParseResult  # noqa: E402

from bridge.handlers.explore import handle_explore  # noqa: E402
from bridge.handlers.stats import handle_stats  # noqa: E402


def _parse_result(prefix: str, count: int = 2) -> ParseResult:
    """A tiny ParseResult with `count` classes under `prefix`."""
    return ParseResult(classes=[
        ClassNode(
            qualified_name=f"pkg::{prefix}Class{i}",
            name=f"{prefix}Class{i}",
            source=prefix,
            tags=["as-built"],
        )
        for i in range(count)
    ])


def _list_sources() -> dict[str, int]:
    return get_backend().graph.list_sources()


def _source_counts() -> dict[str, int]:
    return {row["source"]: row["count"] for row in _list_sources()}


# ── explore sources contract ───────────────────────────────────────────────


def test_explore_sources_returns_string_map():
    """The real explore handler returns a JSON *string* with an object map —
    the shape the TypeScript ``sourceNodeCount`` normalizer must parse."""
    dox_backend.write_result(_parse_result("alpha"), source="alpha")
    raw = handle_explore({"action": "sources"})
    assert isinstance(raw, str), "explore sources must be a JSON string"
    parsed = json.loads(raw)
    assert isinstance(parsed["sources"], dict)
    assert parsed["sources"]["alpha"] == 2


# ── clear-one-source isolation ─────────────────────────────────────────────


def test_clear_one_source_leaves_the_other_intact():
    # 1. Index two repositories into one database with distinct sources.
    dox_backend.write_result(_parse_result("alpha"), source="alpha")
    dox_backend.write_result(_parse_result("beta"), source="beta")
    counts = _source_counts()
    assert counts == {"alpha": 2, "beta": 2}

    # 2. Re-index the first repository with clear=true (the exact call the
    #    doxygen-index CLI makes for --clear --source).
    dox_backend.clear_source("alpha")
    dox_backend.write_result(_parse_result("alpha", count=3), source="alpha")

    counts_after = _source_counts()
    assert counts_after["alpha"] == 3, "cleared source is replaced at its new size"
    assert counts_after["beta"] == 2, "the other repository's source must be untouched"

    # 3. Project-wide query sees every source.
    stats = handle_stats()
    assert {row["source"] for row in stats["by_source"]} == {"alpha", "beta"}
    assert stats["total_nodes"] == 5

    # 4. Source-filtered queries isolate one repository.
    alpha_nodes = get_backend().graph.find_all_by_source("alpha")
    beta_nodes = get_backend().graph.find_all_by_source("beta")
    assert len(alpha_nodes) == 3
    assert len(beta_nodes) == 2
    assert {n.qualified_name for n in beta_nodes} == {
        "pkg::betaClass0", "pkg::betaClass1",
    }


def test_clear_source_removes_only_that_source():
    dox_backend.write_result(_parse_result("alpha"), source="alpha")
    dox_backend.write_result(_parse_result("beta"), source="beta")
    dox_backend.clear_source("alpha")
    counts = _source_counts()
    assert "alpha" not in counts
    assert counts["beta"] == 2
