# ── Tests: test-focused exploration via the portable backend API ──────────
#
# The dispatcher has no test tools, so we query the test subgraph directly
# through the Backend ABC (find_all + edge walks) — no raw Cypher, so it
# works identically against SQLite (the default) and Neo4j.
#
# Graph shape: TestNode -[:COMPOSES]-> TestStep/TestFixture/Assertion,
# TestNode -[:VERIFIES]-> code node, TestStepNode -[:CALLEE]-> code node.

from __future__ import annotations

_COMPOUND_KINDS = ("class", "interface", "enum", "union", "struct")


def _backend():
    from codegraph import get_backend

    return get_backend()


def _all_tests(source=None, test_module=None, tag=None, limit=0):
    """All TestNodes matching the optional filters (Python-side filtering —
    portable across backends)."""
    from codegraph.models.test import TestNode

    tests = []
    for t in _backend().find_all(TestNode):
        if source and getattr(t, "source", None) != source:
            continue
        if test_module and getattr(t, "test_module", None) != test_module:
            continue
        if tag and tag not in (getattr(t, "tags", None) or []):
            continue
        tests.append(t)
        if limit and len(tests) >= limit:
            break
    return tests


def _node_by_qname(qn):
    """Resolve a qualified_name to its node via the graph repository."""
    return _backend().graph.find_by_qualified_name(qn)


def _verifies_targets(test) -> list[dict]:
    """Code nodes verified by *test* (outgoing VERIFIES edges)."""
    backend = _backend()
    out: list[dict] = []
    for edge in backend.get_all_edges(test):
        if edge.relation_type == "VERIFIES" and edge.is_outgoing:
            node = backend.graph.find_by_uid(edge.target_uid)
            if node is not None:
                out.append({
                    "kind": getattr(node, "kind", None),
                    "qualified_name": getattr(node, "qualified_name", None),
                })
    return out


def _children_kind(test, kinds: set[str]):
    """Composed children of *test* whose kind is in *kinds*."""
    backend = _backend()
    return [
        c for c in backend.get_composed_children(test)
        if getattr(c, "kind", None) in kinds
    ]


def _incoming_tests(node):
    """Test nodes with a VERIFIES edge into *node*."""
    backend = _backend()
    tests = []
    for edge in backend.get_all_edges(node):
        if edge.relation_type == "VERIFIES" and not edge.is_outgoing:
            t = backend.graph.find_by_uid(edge.target_uid)
            if t is not None and getattr(t, "kind", None) == "test":
                tests.append(t)
    return tests


def _test_counts(test) -> dict:
    steps = _children_kind(test, {"test_step"})
    fixtures = _children_kind(test, {"test_fixture"})
    assertions = _children_kind(test, {"assertion"})
    return {
        "steps": len(steps),
        "fixtures": len(fixtures),
        "assertions": len(assertions),
    }


def handle_tests(params: dict):
    action = params.get("action", "list")
    qn = params.get("qualified_name")
    source = params.get("source")
    test_module = params.get("test_module")
    tag = params.get("tag")
    limit = int(params.get("limit", 100) or 100)

    if action in ("detail", "verifies", "covered_by") and not qn:
        raise ValueError(f"action={action!r} requires 'qualified_name'")

    if action == "list":
        tests = _all_tests(source, test_module, tag)
        rows = []
        for t in sorted(tests, key=lambda x: (getattr(x, "test_module", "") or "",
                                              getattr(x, "test_name", "") or "")):
            rows.append({
                "qualified_name": getattr(t, "qualified_name", None),
                "test_name": getattr(t, "test_name", None),
                "test_module": getattr(t, "test_module", None),
                "source": getattr(t, "source", None),
                "tags": getattr(t, "tags", None) or [],
                "verifies": _verifies_targets(t),
            })
        return {"tests": rows, "count": len(rows), "filters": {
            "source": source, "test_module": test_module, "tag": tag}}

    if action == "modules":
        tests = _all_tests(source, test_module, tag)
        grouped: dict[tuple, dict] = {}
        for t in tests:
            key = (getattr(t, "test_module", None), getattr(t, "source", None))
            g = grouped.setdefault(key, {"module": key[0], "source": key[1],
                                          "tests": [], "test_count": 0})
            g["tests"].append(getattr(t, "qualified_name", None))
            g["test_count"] += 1
        rows = sorted(grouped.values(), key=lambda g: g["module"] or "")
        return {"modules": rows, "count": len(rows)}

    if action == "verifies":
        node = _node_by_qname(qn)
        if node is None or getattr(node, "kind", None) != "test":
            raise ValueError(f"no test found with qualified_name={qn!r}")
        return {
            "test": getattr(node, "qualified_name", None),
            "test_name": getattr(node, "test_name", None),
            "test_module": getattr(node, "test_module", None),
            "source": getattr(node, "source", None),
            "verifies": _verifies_targets(node),
        }

    if action == "covered_by":
        detail = params.get("detail") in (True, "true", "True", 1, "1")
        node = _node_by_qname(qn)
        if node is None:
            raise ValueError(f"no code node found with qualified_name={qn!r}")

        covered: dict[str, dict] = {}
        for t in _incoming_tests(node):
            covered[getattr(t, "qualified_name", None)] = {
                "test": getattr(t, "qualified_name", None),
                "test_module": getattr(t, "test_module", None),
                "target": qn,
            }
        member_tests = []
        for child in _backend().get_composed_children(node):
            for t in _incoming_tests(child):
                entry = {
                    "test": getattr(t, "qualified_name", None),
                    "test_module": getattr(t, "test_module", None),
                    "target": getattr(child, "qualified_name", None),
                }
                covered.setdefault(entry["test"], entry)
                member_tests.append(entry)

        r = {
            "code": qn,
            "kind": getattr(node, "kind", None),
            "covered_by": list(covered.values()),
        }

        if detail:
            for entry in r["covered_by"]:
                t = _node_by_qname(entry["test"])
                if t is None:
                    continue
                entry["description"] = getattr(t, "description", None)
                entry.update(_test_counts(t))
        return r

    if action == "uncovered":
        prefix = params.get("qualified_name")
        source_filter = params.get("source")
        backend = _backend()
        rows = []
        for kind in _COMPOUND_KINDS:
            for c in backend.graph.find_all_by_kind(kind):
                qname = getattr(c, "qualified_name", None)
                if prefix and not (qname or "").startswith(prefix):
                    continue
                if source_filter and getattr(c, "source", None) != source_filter:
                    continue
                if not _incoming_tests(c):
                    rows.append({
                        "qualified_name": qname,
                        "kind": getattr(c, "kind", None),
                        "source": getattr(c, "source", None),
                    })
        rows.sort(key=lambda r: (r["kind"] or "", r["qualified_name"] or ""))
        rows = rows[:limit]
        return {
            "uncovered": rows, "count": len(rows),
            "filters": {"prefix": prefix, "source": source_filter},
        }

    if action == "detail":
        t = _node_by_qname(qn)
        if t is None or getattr(t, "kind", None) != "test":
            raise ValueError(f"no test found with qualified_name={qn!r}")

        steps = []
        for st in _children_kind(t, {"test_step"}):
            callees = []
            for edge in _backend().get_all_edges(st):
                if edge.relation_type == "CALLEE" and edge.is_outgoing:
                    cnode = _backend().graph.find_by_uid(edge.target_uid)
                    if cnode is not None:
                        callees.append({
                            "kind": getattr(cnode, "kind", None),
                            "qualified_name": getattr(cnode, "qualified_name", None),
                        })
            steps.append({
                "qualified_name": getattr(st, "qualified_name", None),
                "name": getattr(st, "name", None),
                "callees": callees,
            })
        fixtures = [{
            "qualified_name": getattr(f, "qualified_name", None),
            "name": getattr(f, "name", None),
        } for f in _children_kind(t, {"test_fixture"})]
        assertions = [{
            "qualified_name": getattr(a, "qualified_name", None),
            "name": getattr(a, "name", None),
        } for a in _children_kind(t, {"assertion"})]
        verifies = _verifies_targets(t)

        return {
            "test": {
                "qualified_name": getattr(t, "qualified_name", None),
                "test_name": getattr(t, "test_name", None),
                "test_module": getattr(t, "test_module", None),
                "source": getattr(t, "source", None),
                "tags": getattr(t, "tags", None) or [],
                "name": getattr(t, "name", None),
                "description": getattr(t, "description", None),
                "llm_enriched": getattr(t, "llm_enriched", None),
            },
            "verifies": verifies,
            "steps": steps,
            "fixtures": fixtures,
            "assertions": assertions,
            "counts": {
                "verifies": len(verifies),
                "steps": len(steps),
                "fixtures": len(fixtures),
                "assertions": len(assertions),
            },
        }

    raise ValueError(
        f"Unknown tests action {action!r}. Valid: "
        f"{sorted(('list', 'detail', 'verifies', 'covered_by', 'modules', 'uncovered'))}"
    )
