# ── Decompose / Design agent pipelines ────────────────────────────────────
#
# These bridge methods run full agent pipelines internally using llm_caller.
# They are long-running (they involve LLM API calls) and should be given
# generous timeouts on the TS side (300-600s).


def _export_decomposition_markdown(hlr_title: str, description: str, component: str, nodes: list[dict], output_dir: str = "") -> str:
    """Export a decomposition result to a markdown file using codegraph's
    :class:`~codegraph.export.markdown.MarkdownExporter`.

    Writes to ``<output_dir>/<slug>/requirements.md`` where slug is derived
    from the HLR title.  Returns the absolute path to the written file.
    """
    from pathlib import Path

    from codegraph.export.markdown import MarkdownExporter
    from codegraph.graph import LayerGraph

    # Ensure LLR / HLR types are registered in CodeGraphNode
    try:
        import codegraph_requirements  # noqa: F401
    except ImportError:
        pass

    # Derive a short slug from the title
    title_line = hlr_title.split("\n")[0].strip().rstrip(".")
    stop_words = {"shall", "must", "will", "should", "provides", "provide",
                  "exposes", "expose", "generates", "generate", "produces",
                  "produce", "supports", "support", "renders", "render",
                  "accepts", "accept", "returns", "return", "queries", "query"}
    words = title_line.split()
    if words and words[0].lower() in ("the", "a", "an"):
        words = words[1:]
    slug_words = []
    for w in words:
        if w.lower() in stop_words:
            break
        if any(ch in w for ch in ",;:"):
            slug_words.append(w.rstrip(",;:"))
            break
        slug_words.append(w)
    slug = "-".join(slug_words).lower() if slug_words else title_line[:48].lower().replace(" ", "-")
    for ch in " \\:?*<>|\"'/—––—":
        slug = slug.replace(ch, "-")
    slug = slug.strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    if len(slug) > 64:
        slug = slug[:64].rstrip("-")

    if output_dir:
        dir_path = Path(output_dir) / slug
    else:
        dir_path = Path.cwd() / "codegraph" / "requirements" / slug
    dir_path.mkdir(parents=True, exist_ok=True)

    # ── Build a synthetic HLR node so the exporter has a root ──────────
    hlr_name = " ".join(slug_words).title() if slug_words else title_line
    hlr_uid = f"hlr::{slug}"
    llr_nodes = [n for n in nodes if n.get("type") == "LLR"]

    hlr_node = {
        "type": "HLR",
        "name": hlr_name,
        "description": description.strip(),
        "tags": ["design"],
        "refid": hlr_uid,
        "edges": [
            {"relation_type": "COMPOSES", "target_uid": llr.get("refid", ""),
             "target_type": "LLR"}
            for llr in llr_nodes
            if llr.get("refid")
        ],
    }

    # ── Deserialize → LayerGraph → MarkdownExporter ────────────────────
    all_nodes = [hlr_node] + list(nodes)
    graph = LayerGraph.deserialize(all_nodes, create_missing=True)
    md = MarkdownExporter(graph, fields="llm", public_only=False).export()

    out_path = dir_path / "requirements.md"
    out_path.write_text(md, encoding="utf-8")
    return str(out_path)


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

    if hlr_uid:
        from codegraph_design.agents.decompose_hlr import decompose_and_persist_hlr
        result = decompose_and_persist_hlr(
            hlr_uid=hlr_uid,
            model=model,
            log_dir=params.get("log_dir") or "",
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
        from codegraph_design.agents.decompose_hlr import decompose
        result = decompose(
            description=description,
            component=component,
            model=model,
            prompt_log_file=params.get("prompt_log_file") or "",
        )
        # Auto-export markdown
        hlr_title = description.split("\n")[0].strip()
        md_path = _export_decomposition_markdown(
            hlr_title=hlr_title,
            description=description,
            component=component,
            nodes=list(result.nodes),
            output_dir=output_dir,
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


