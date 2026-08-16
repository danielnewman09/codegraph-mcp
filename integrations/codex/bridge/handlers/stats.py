# ── Stats: compact summary to avoid blowing context windows ────────────
#
# Backend-agnostic: uses only the portable Backend / GraphRepository API
# (no raw Cypher), so it works identically against SQLite (the default)
# and Neo4j.


def handle_stats():
    """Return compact high-level statistics — node/rel counts, description
    coverage, test summary — so agents can troubleshoot without pulling
    thousands of nodes (as ``scope=kind, kind=test`` would)."""
    import os

    from codegraph import get_backend
    from codegraph.constants import NODE_KINDS, PREDICATE_TO_REL_TYPE, TAGS
    from codegraph.models.test import (
        AssertionNode, TestFixtureNode, TestNode, TestStepNode,
    )

    backend = get_backend()
    graph = backend.graph

    # Known relationship types: graph predicates + memory/requirements rels.
    _MEMORY_RELS = {
        "MOTIVATES", "CONSTRAINS", "EXPLAINS", "ASSUMES", "TRADES_OFF",
        "INSIGHT_INTO", "SUPERSEDES", "REFINES", "CONTRADICTS",
    }
    _REL_TYPES = sorted(set(PREDICATE_TO_REL_TYPE.values()) | _MEMORY_RELS)

    rel_counts: dict[str, int] = {}
    for rt in _REL_TYPES:
        try:
            c = graph.count_relationships([rt])
        except Exception:
            c = 0
        if c:
            rel_counts[rt] = c
    total_relationships = sum(rel_counts.values())
    total_nodes = graph.count_all_nodes()

    # Per-kind pass: counts, description/LLM coverage, and source rollup.
    by_kind: list[dict] = []
    property_coverage: list[dict] = []
    sources: dict[str, int] = {}
    for kind, _display in NODE_KINDS:
        try:
            nodes = graph.find_all_by_kind(kind)
        except Exception:
            continue
        if not nodes:
            continue
        described = sum(1 for n in nodes if getattr(n, "description", None))
        enriched = sum(1 for n in nodes if getattr(n, "llm_enriched", None))
        for n in nodes:
            src = getattr(n, "source", None)
            if src:
                sources[src] = sources.get(src, 0) + 1
        by_kind.append({"kind": kind, "count": len(nodes)})
        property_coverage.append({
            "kind": kind,
            "total": len(nodes),
            "with_description": described,
            "llm_enriched": enriched,
        })

    by_source = [
        {"source": s, "count": c}
        for s, c in sorted(sources.items(), key=lambda kv: -kv[1])
    ]

    by_tag = []
    for tag in sorted(TAGS):
        try:
            count = len(graph.find_uids_by_tag(tag))
        except Exception:
            count = 0
        if count:
            by_tag.append({"tag": tag, "count": count})

    # Test summary (test / test_step / test_fixture / assertion + VERIFIES).
    try:
        tests = backend.find_all(TestNode)
        test_steps = backend.find_all(TestStepNode)
        test_fixtures = backend.find_all(TestFixtureNode)
        assertions = backend.find_all(AssertionNode)
        described_tests = sum(
            1 for t in tests if getattr(t, "description", None)
        )
        verifies_targets: set[str] = set()
        for t in tests:
            for edge in backend.get_all_edges(t):
                if edge.relation_type == "VERIFIES" and edge.is_outgoing:
                    verifies_targets.add(edge.target_uid)
        test_summary = {
            "test_count": len(tests),
            "step_count": len(test_steps),
            "fixture_count": len(test_fixtures),
            "assertion_count": len(assertions),
            "verifies_count": len(verifies_targets),
            "described_tests": described_tests,
        }
    except Exception:
        test_summary = {}

    # Memory node summary.
    memory_summary: dict = {"total_memory_nodes": 0, "by_type": {}}
    try:
        from codegraph_memory.models import (
            AssumptionNode, ConstraintNode, DecisionNode,
            InsightNode, RationaleNode, TradeoffNode,
        )

        for cls in (
            DecisionNode, ConstraintNode, RationaleNode,
            AssumptionNode, TradeoffNode, InsightNode,
        ):
            try:
                nodes = backend.find_all(cls)
            except Exception:
                continue
            if nodes:
                memory_summary["by_type"][cls.__name__] = len(nodes)
                memory_summary["total_memory_nodes"] += len(nodes)
    except Exception:
        pass

    return {
        "project_id": os.environ.get("CODEGRAPH_PROJECT_ID"),
        "database_path": _active_backend_database_path(backend),
        "total_nodes": total_nodes,
        "total_relationships": total_relationships,
        "by_kind": by_kind,
        "by_source": by_source,
        "by_tag": by_tag,
        "property_coverage": property_coverage,
        "relationships": [
            {"rel_type": rt, "count": c}
            for rt, c in sorted(rel_counts.items(), key=lambda kv: -kv[1])
        ],
        "test_summary": test_summary,
        "memory_summary": memory_summary,
    }


def _active_backend_database_path(backend) -> str | None:
    """Absolute path of the active backend's database (SQLite), or None."""
    try:
        cfg = getattr(backend, "_config", None)
        path = getattr(cfg, "path", None)
        if isinstance(path, str) and path and path != ":memory:":
            import os
            return os.path.abspath(path)
    except Exception:
        pass
    try:
        import os
        env_path = (os.environ.get("SQLITE_PATH") or "").strip()
        return os.path.abspath(env_path) if env_path else None
    except Exception:
        return None
