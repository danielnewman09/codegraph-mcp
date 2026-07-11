# ── Tests: test-focused exploration via direct Cypher ──────────────────────
#
# The dispatcher has no test tools, so we query the test subgraph directly:
# test / test_step / test_fixture / assertion nodes and the VERIFIES / COMPOSES
# / CALLEE edges connecting them to the code under test. Relationship types are
# stored uppercased by neomodel. Returns slim JSON (like `explore`); for a
# visual graph of a test's neighbourhood use `query` scope=neighborhood.

_TEST_KINDS = ("test", "test_step", "test_fixture", "assertion")


def _test_filters(node_var: str, source, test_module, tag):
    clauses = [f"{node_var}.kind = 'test'"]
    binds: dict = {}
    if source:
        clauses.append(f"{node_var}.source = $source"); binds["source"] = source
    if test_module:
        clauses.append(f"{node_var}.test_module = $test_module"); binds["test_module"] = test_module
    if tag:
        clauses.append(f"$tag IN {node_var}.tags"); binds["tag"] = tag
    return " AND ".join(clauses), binds


def handle_tests(params: dict):
    action = params.get("action", "list")
    qn = params.get("qualified_name")
    source = params.get("source")
    test_module = params.get("test_module")
    tag = params.get("tag")
    limit = int(params.get("limit", 100) or 100)

    if action in ("detail", "verifies", "covered_by") and not qn:
        raise ValueError(f"action={action!r} requires 'qualified_name'")

    from codegraph.persistence.connection import get_session

    with get_session() as s:
        if action == "list":
            where, binds = _test_filters("n", source, test_module, tag)
            q = (
                f"MATCH (n) WHERE {where} "
                "OPTIONAL MATCH (n)-[:VERIFIES]->(c) "
                "WITH n, collect(DISTINCT {kind: c.kind, qualified_name: c.qualified_name}) AS verifies "
                "RETURN n.qualified_name AS qualified_name, n.test_name AS test_name, "
                "n.test_module AS test_module, n.source AS source, n.tags AS tags, verifies "
                "ORDER BY n.test_module, n.test_name LIMIT $limit"
            )
            binds["limit"] = limit
            rows = s.run(q, binds).data()
            return {"tests": rows, "count": len(rows), "filters": {
                "source": source, "test_module": test_module, "tag": tag}}

        if action == "modules":
            where, binds = _test_filters("n", source, test_module, tag)
            q = (
                f"MATCH (n) WHERE {where} "
                "WITH n.test_module AS module, n.source AS source, "
                "collect(n.qualified_name) AS tests, count(n) AS test_count "
                "RETURN module, source, test_count, tests ORDER BY module"
            )
            rows = s.run(q, binds).data()
            return {"modules": rows, "count": len(rows)}

        if action == "verifies":
            q = (
                "MATCH (t) WHERE t.kind = 'test' AND t.qualified_name = $qn "
                "OPTIONAL MATCH (t)-[:VERIFIES]->(c) "
                "RETURN t.qualified_name AS test, t.test_name AS test_name, "
                "t.test_module AS test_module, t.source AS source, "
                "collect(DISTINCT {kind: c.kind, qualified_name: c.qualified_name}) AS verifies"
            )
            rows = s.run(q, {"qn": qn}).data()
            if not rows:
                raise ValueError(f"no test found with qualified_name={qn!r}")
            return rows[0]

        if action == "covered_by":
            detail = params.get("detail") in (True, "true", "True", 1, "1")
            # Direct VERIFIES edges + tests verifying COMPOSES members (e.g. a
            # class's methods), so asking about a class surfaces its method tests.
            q = (
                "MATCH (c) WHERE c.qualified_name = $qn "
                "OPTIONAL MATCH (t)-[:VERIFIES]->(c) WHERE t.kind = 'test' "
                "WITH c, collect(DISTINCT {test: t.qualified_name, test_module: t.test_module, "
                "target: c.qualified_name}) AS direct "
                "OPTIONAL MATCH (c)-[:COMPOSES]->(m)<-[:VERIFIES]-(t2) WHERE t2.kind = 'test' "
                "RETURN c.qualified_name AS code, c.kind AS kind, direct, "
                "collect(DISTINCT {test: t2.qualified_name, test_module: t2.test_module, "
                "target: m.qualified_name}) AS member_tests"
            )
            rows = s.run(q, {"qn": qn}).data()
            if not rows:
                raise ValueError(f"no code node found with qualified_name={qn!r}")
            r = rows[0]
            r["covered_by"] = (r.get("direct") or []) + (r.get("member_tests") or [])

            if detail:
                # Batch-fetch descriptions + counts for all covering tests
                all_qnames = [t["test"] for t in r["covered_by"] if t.get("test")]
                if all_qnames:
                    detail_rows = s.run(
                        "MATCH (t) WHERE t.kind = 'test' AND t.qualified_name IN $qnames "
                        "OPTIONAL MATCH (t)-[:COMPOSES]->(s) WHERE s.kind = 'test_step' "
                        "OPTIONAL MATCH (t)-[:COMPOSES]->(f) WHERE f.kind = 'test_fixture' "
                        "OPTIONAL MATCH (t)-[:COMPOSES]->(a) WHERE a.kind = 'assertion' "
                        "RETURN t.qualified_name AS qn, t.description AS description, "
                        "count(DISTINCT s) AS steps, count(DISTINCT f) AS fixtures, "
                        "count(DISTINCT a) AS assertions",
                        {"qnames": all_qnames},
                    ).data()
                    details_map = {d["qn"]: d for d in detail_rows}
                    for entry in r["covered_by"]:
                        d = details_map.get(entry["test"])
                        if d:
                            entry["description"] = d["description"]
                            entry["steps"] = d["steps"]
                            entry["fixtures"] = d["fixtures"]
                            entry["assertions"] = d["assertions"]
            return r

        if action == "uncovered":
            # Negative-coverage query: classes/interfaces/enums/unions/structs
            # with zero VERIFIES edges from any test.  Accepts a namespace
            # prefix via qualified_name or a source filter.
            prefix = params.get("qualified_name")
            source_filter = params.get("source")
            clauses = ["c.kind IN ['class', 'interface', 'enum', 'union', 'struct']"]
            binds = {}
            if prefix:
                clauses.append("c.qualified_name STARTS WITH $prefix")
                binds["prefix"] = prefix
            if source_filter:
                clauses.append("c.source = $source")
                binds["source"] = source_filter
            where = " AND ".join(clauses)
            q = (
                f"MATCH (c) WHERE {where} "
                "OPTIONAL MATCH (t)-[:VERIFIES]->(c) WHERE t.kind = 'test' "
                "WITH c, count(DISTINCT t) AS test_count "
                "WHERE test_count = 0 "
                "RETURN c.qualified_name AS qualified_name, c.kind AS kind, "
                "c.source AS source "
                "ORDER BY c.kind, c.qualified_name "
                "LIMIT $limit"
            )
            binds["limit"] = limit
            rows = s.run(q, binds).data()
            return {
                "uncovered": rows, "count": len(rows),
                "filters": {"prefix": prefix, "source": source_filter},
            }

        if action == "detail":
            base = (
                "MATCH (t) WHERE t.kind = 'test' AND t.qualified_name = $qn "
                "RETURN t.qualified_name AS qualified_name, t.test_name AS test_name, "
                "t.test_module AS test_module, t.source AS source, t.tags AS tags, t.name AS name, "
                "t.description AS description, t.llm_enriched AS llm_enriched"
            )
            info = s.run(base, {"qn": qn}).data()
            if not info:
                raise ValueError(f"no test found with qualified_name={qn!r}")
            verifies = s.run(
                "MATCH (t)-[:VERIFIES]->(c) WHERE t.qualified_name = $qn "
                "RETURN c.kind AS kind, c.qualified_name AS qualified_name", {"qn": qn}).data()
            steps = s.run(
                "MATCH (t)-[:COMPOSES]->(st) WHERE t.qualified_name = $qn AND st.kind = 'test_step' "
                "OPTIONAL MATCH (st)-[:CALLEE]->(c) "
                "WITH st, collect(DISTINCT {kind: c.kind, qualified_name: c.qualified_name}) AS callees "
                "RETURN st.qualified_name AS qualified_name, st.name AS name, callees "
                "ORDER BY st.qualified_name", {"qn": qn}).data()
            fixtures = s.run(
                "MATCH (t)-[:COMPOSES]->(f) WHERE t.qualified_name = $qn AND f.kind = 'test_fixture' "
                "RETURN f.qualified_name AS qualified_name, f.name AS name "
                "ORDER BY f.qualified_name", {"qn": qn}).data()
            assertions = s.run(
                "MATCH (t)-[:COMPOSES]->(a) WHERE t.qualified_name = $qn AND a.kind = 'assertion' "
                "RETURN a.qualified_name AS qualified_name, a.name AS name "
                "ORDER BY a.qualified_name", {"qn": qn}).data()
            return {
                "test": info[0], "verifies": verifies, "steps": steps,
                "fixtures": fixtures, "assertions": assertions,
                "counts": {"verifies": len(verifies), "steps": len(steps),
                            "fixtures": len(fixtures), "assertions": len(assertions)},
            }

    raise ValueError(
        f"Unknown tests action {action!r}. Valid: {sorted(('list', 'detail', 'verifies', 'covered_by', 'modules', 'uncovered'))}"
    )

