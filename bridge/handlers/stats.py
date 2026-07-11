# ── Stats: compact summary to avoid blowing context windows ────────────


def handle_stats():
    """Return compact high-level statistics — node/rel counts, description
    coverage, test summary — so agents can troubleshoot without pulling
    thousands of nodes (as ``scope=kind, kind=test`` would)."""
    from codegraph.persistence.connection import get_session

    with get_session() as s:
        total = s.run("MATCH (n) RETURN count(n) AS total").data()[0]["total"]

        by_kind = s.run(
            "MATCH (n) RETURN n.kind AS kind, count(n) AS count ORDER BY count DESC"
        ).data()

        by_source = s.run(
            "MATCH (n) WHERE n.source IS NOT NULL "
            "RETURN n.source AS source, count(n) AS count ORDER BY count DESC"
        ).data()

        tags_data = s.run(
            "MATCH (n) WHERE n.tags IS NOT NULL UNWIND n.tags AS tag "
            "RETURN tag, count(n) AS count ORDER BY count DESC"
        ).data()

        prop = s.run(
            "MATCH (n) "
            "WHERE n.kind IN ['class','method','function','test','test_step','test_fixture','assertion'] "
            "RETURN n.kind AS kind, count(n) AS total, "
            "count(CASE WHEN n.description IS NOT NULL AND n.description <> '' THEN 1 END) AS with_description, "
            "count(CASE WHEN n.llm_enriched IS NOT NULL AND n.llm_enriched THEN 1 END) AS llm_enriched "
            "ORDER BY kind"
        ).data()

        rels = s.run(
            "MATCH ()-[r]->() RETURN type(r) AS rel_type, count(r) AS count ORDER BY count DESC LIMIT 20"
        ).data()
        total_rels = sum(r["count"] for r in rels)

        test_summary = s.run(
            "MATCH (t) WHERE t.kind = 'test' "
            "OPTIONAL MATCH (t)-[:COMPOSES]->(step) WHERE step.kind = 'test_step' "
            "OPTIONAL MATCH (t)-[:VERIFIES]->(code) "
            "RETURN count(DISTINCT t) AS test_count, "
            "count(DISTINCT step) AS step_count, "
            "count(DISTINCT code) AS verifies_count, "
            "count(DISTINCT CASE WHEN t.description IS NOT NULL AND t.description <> '' THEN t END) AS described_tests"
        ).data()[0]

        # Memory node summary
        memory_labels = [
            "DecisionNode", "ConstraintNode", "RationaleNode",
            "AssumptionNode", "TradeoffNode", "InsightNode",
        ]
        memory_counts: dict[str, int] = {}
        memory_total = 0
        for label in memory_labels:
            count = s.run(
                f"MATCH (n:`{label}`) RETURN count(n) AS c"
            ).data()[0]["c"]
            if count > 0:
                memory_counts[label] = count
                memory_total += count

        memory_rels = [
            "MOTIVATES", "CONSTRAINS", "EXPLAINS", "ASSUMES",
            "TRADES_OFF", "INSIGHT_INTO", "SUPERSEDES", "REFINES",
            "CONTRADICTS",
        ]
        memory_rel_counts: dict[str, int] = {}
        for rel in memory_rels:
            count = s.run(
                f"MATCH ()-[r:`{rel}`]->() RETURN count(r) AS c"
            ).data()[0]["c"]
            if count > 0:
                memory_rel_counts[rel] = count

        return {
            "total_nodes": total,
            "total_relationships": total_rels,
            "by_kind": by_kind,
            "by_source": by_source,
            "by_tag": tags_data,
            "property_coverage": prop,
            "relationships": rels,
            "test_summary": test_summary,
            "memory_summary": {
                "total_memory_nodes": memory_total,
                "by_type": memory_counts,
                "relationships": memory_rel_counts,
            },
        }

