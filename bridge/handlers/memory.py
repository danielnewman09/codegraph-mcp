# ── Memory: design rationale, constraints, tradeoffs ──────────────────────


def handle_memory(params: dict):
    """Dispatch memory tool actions — design rationale, constraints, tradeoffs,
    decisions, assumptions, and insights linked to codebase knowledge graphs.

    Actions:
    - ``record``: create or update a memory node (decision/constraint/rationale/
      assumption/tradeoff/insight) and link it to code nodes.
    - ``context``: fetch all design memory relevant to a code node, including
      inherited memories from COMPOSES ancestors.
    - ``lookup``: targeted lookups (memory_of, constraints_for, decision_chain,
      insights_for, rationales_for, assumptions_for, tradeoffs_for,
      affected_decisions).
    - ``search``: full-text search across all memory content.
    - ``search_semantic``: vector similarity search across memory embeddings.
    """
    from codegraph_memory.tools.record import record_memory
    from codegraph_memory.tools.context import memory_context
    from codegraph_memory.tools.lookup import (
        memory_of, constraints_for, decision_chain,
        insights_for, rationales_for, assumptions_for, tradeoffs_for,
        affected_decisions,
    )
    from codegraph_memory.tools.search import search_memory, search_memory_semantic

    action = params.get("action")

    if action == "record":
        return record_memory(
            type=params["memory_type"],
            qualified_name=params["qualified_name"],
            content=params["content"],
            tags=params.get("tags"),
            confidence=params.get("confidence"),
            source=params.get("source"),
            links_to=params.get("links_to"),
            supersedes=params.get("supersedes"),
            refines=params.get("refines"),
            contradicts=params.get("contradicts"),
            mode=params.get("mode", "upsert"),
            uid=params.get("uid"),
        )

    if action == "context":
        return memory_context(
            qualified_name=params["qualified_name"],
            traverse_parents=params.get("traverse_parents", True),
            max_depth=params.get("max_depth", 5),
            include_superseded=params.get("include_superseded", False),
        )

    if action == "lookup":
        lookup_type = params.get("lookup_type")
        qname = params.get("qualified_name")
        if not qname:
            raise ValueError("lookup requires 'qualified_name'")

        lookups: dict = {
            "memory_of": memory_of,
            "constraints_for": constraints_for,
            "decision_chain": decision_chain,
            "insights_for": insights_for,
            "rationales_for": rationales_for,
            "assumptions_for": assumptions_for,
            "tradeoffs_for": tradeoffs_for,
            "affected_decisions": affected_decisions,
        }

        fn = lookups.get(lookup_type or "")
        if fn is None:
            raise ValueError(
                f"Unknown lookup_type {lookup_type!r}. "
                f"Valid: {sorted(lookups)}"
            )
        return fn(qname)

    if action == "search":
        return search_memory(
            query=params["query"],
            limit=params.get("limit", 20),
            tag=params.get("tag"),
        )

    if action == "search_semantic":
        return search_memory_semantic(
            embedding=params["embedding"],
            limit=params.get("limit", 10),
            tag=params.get("tag"),
        )

    raise ValueError(
        f"Unknown memory action {action!r}. "
        f"Valid: record, context, lookup, search, search_semantic"
    )

