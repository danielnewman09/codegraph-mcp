# ── Decompose / Design agent pipelines ────────────────────────────────────
#
# These bridge methods run full agent pipelines internally using llm_caller.
# They are long-running (they involve LLM API calls) and should be given
# generous timeouts on the TS side (300-600s).
def handle_decompose_run(params: dict):
    """Run the decompose_hlr agent on an HLR.

    Accepts either:
    - ``hlr_uid`` (string): load the HLR from Neo4j, decompose, and persist.
    - ``description`` (string): decompose a raw description (no persistence).

    Automatically exports the result to
    ``codegraph/requirements/<hlr-slug>/requirements.md``.
    """
    hlr_uid = params.get("hlr_uid")
    description = params.get("description")
    component = params.get("component") or ""
    model = params.get("model") or ""
    output_dir = params.get("output_dir") or ""
    from pathlib import Path
    default_log_dir = str(Path.cwd() / "codegraph" / "logs")

    if hlr_uid:
        from codegraph_design.agents.decompose_hlr import decompose_and_persist_hlr
        result = decompose_and_persist_hlr(
            hlr_uid=hlr_uid,
            model=model,
            log_dir=params.get("log_dir") or default_log_dir,
        )
        # Derive title from HLR name in Neo4j (try uid first, then refid)
        from codegraph_requirements.models import HLR
        hlr = HLR.nodes.get_or_none(uid=hlr_uid)
        if not hlr:
            hlr = HLR.nodes.get_or_none(refid=hlr_uid)
        hlr_title = hlr.name if hlr else f"HLR-{hlr_uid[:8]}"
        hlr_description = hlr.description if hlr else ""
        # Re-derive component from graph
        comp_nodes = hlr.component.all() if hlr else []
        hlr_component = comp_nodes[0].name if comp_nodes else component
        return result
    elif description:
        from codegraph_design.agents.decompose_hlr import decompose, serialize_decomposition_to_markdown
        from datetime import datetime, timezone
        prompt_log = params.get("prompt_log_file") or ""
        if not prompt_log:
            Path(default_log_dir).mkdir(parents=True, exist_ok=True)
            prompt_log = str(Path(default_log_dir) / f"decompose_description_{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.md")
        result = decompose(
            description=description,
            component=component,
            model=model,
            prompt_log_file=prompt_log,
            hlr_name=params.get("qualified_name", ""),
        )
        # Auto-export markdown using the library's serializer
        # (sets qualified_name, uses name/qualified_name for COMPOSES
        # target_uid, and exports with fields="all" for round-trip
        # stability)
        hlr_title = params.get("qualified_name") or params.get("component") or description.split("\n")[0].strip()
        md_path = serialize_decomposition_to_markdown(
            decomposed=result,
            output_dir=output_dir,
            hlr_name=hlr_title,
        )
        dumped = result.model_dump()
        dumped["_markdown_path"] = md_path
        return dumped
    else:
        raise ValueError("decompose_run requires either 'hlr_uid' or 'description'")


def handle_decompose_validate(params: dict) -> dict:
    """Validate a decomposition's flat node list against the 8 hard rules.

    Accepts ``nodes`` (list of dicts).  Returns validation results without
    persisting anything.
    """
    nodes = params.get("nodes", [])
    if not nodes:
        return {"valid": False, "errors": ["No nodes provided"]}

    from codegraph_design.agents.decompose_hlr import validate_decomposition
    violations = validate_decomposition(list(nodes))
    return {
        "valid": len(violations) == 0,
        "violations": [
            {"rule": v.rule, "message": v.message, "context": v.context}
            for v in violations
        ],
    }


