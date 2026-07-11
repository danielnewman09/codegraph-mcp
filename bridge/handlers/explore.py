"""Explore handler — lightweight lookups against the codegraph store."""
from __future__ import annotations

from .query import get_dispatcher, _pick

_ACTION_TO_TOOL = {
    "search": ("search_symbols", ("query", "source", "kind", "limit")),
    "compound": ("get_compound", ("qualified_name",)),
    "member": ("get_member", ("qualified_name",)),
    "namespace": ("browse_namespace", ("namespace", "limit")),
    "namespaces": ("list_namespaces", ()),
    "sources": ("list_sources", ()),
    "tags": ("graph_list_tags", ()),
    "inheritance": ("find_inheritance", ("qualified_name",)),
    "callers_callees": ("find_callers_and_callees", ("qualified_name",)),
    "hlr_subtree": ("get_hlr_subtree", ("refid",)),
}


def handle_explore(params: dict):
    disp = get_dispatcher()
    action = params.get("action")
    if action not in _ACTION_TO_TOOL:
        raise ValueError(
            f"Unknown action {action!r}. Valid: {sorted(_ACTION_TO_TOOL)}"
        )
    tool_name, keys = _ACTION_TO_TOOL[action]
    return disp.dispatch(tool_name, _pick(params, keys))

