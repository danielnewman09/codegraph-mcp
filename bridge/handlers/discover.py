# ── Discover: design discovery tools (requirements + context) ───────────

_discovery_dispatcher = None


def get_discovery_dispatcher():
    """Lazily construct the DesignDiscoveryDispatcher."""
    global _discovery_dispatcher
    if _discovery_dispatcher is None:
        from codegraph_design.tools.dispatcher import DesignDiscoveryDispatcher
        _discovery_dispatcher = DesignDiscoveryDispatcher()
    return _discovery_dispatcher


_DISCOVERY_ACTIONS = {
    "search_requirements": ("query", "scope", "limit"),
    "get_hlr_dependencies": ("refid", "direction"),
    "list_requirements": ("component_name", "tag"),
    "get_requirement_traces": ("refid",),
    "build_design_context": ("feature_description", "component_name"),
    # Workflow tools (ported from scripts/)
    "ingest_design": ("file_path", "tag"),
    "generate_hlr_docs": ("output_dir",),
    "generate_feedback_docs": ("output_dir",),
    "evaluate_coverage": ("output_path",),
    "verify_callee_granularity": (),
}


def handle_discover(params: dict):
    """Dispatch design discovery tools.

    The ``action`` parameter selects the specific discovery tool.
    Parameters are passed through to the underlying tool handler.
    """
    action = params.get("action")
    if action not in _DISCOVERY_ACTIONS:
        raise ValueError(
            f"Unknown discover action {action!r}. Valid: {sorted(_DISCOVERY_ACTIONS)}"
        )
    disp = get_discovery_dispatcher()
    keys = _DISCOVERY_ACTIONS[action]
    tool_input = {k: params[k] for k in keys if k in params and params[k] is not None}
    return disp.dispatch(action, tool_input)

