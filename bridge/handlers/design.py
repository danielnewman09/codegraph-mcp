def _export_design_artifacts(hlr_uid: str, output_dir: str = "") -> dict:
    """Export design markdown, PlantUML, and rendered PNG for an HLR.

    Loads the HLR and its design subtree from Neo4j, builds a LayerGraph,
    and writes three artifacts to ``<output_dir>/<slug>/``:

    * ``design.md`` — Markdown via :class:`~codegraph.export.markdown.MarkdownExporter`
    * ``diagrams/architecture_class_diagram.puml`` — PlantUML via :class:`~codegraph.export.plantuml.PlantUMLExporter`
    * ``diagrams/architecture_class_diagram.png`` — Rendered PNG (requires ``plantuml``)

    Returns a dict with paths to the written files.
    """
    import os
    import subprocess
    import tempfile
    from pathlib import Path

    from codegraph.graph import LayerGraph
    from codegraph.export.markdown import MarkdownExporter
    from codegraph.export.plantuml import PlantUMLExporter
    from codegraph.models.tags import CodeGraphNode
    from codegraph_requirements.models import HLR

    hlr = HLR.nodes.get_or_none(uid=hlr_uid)
    if not hlr:
        hlr = HLR.nodes.get_or_none(refid=hlr_uid)
    if not hlr:
        return {"error": f"HLR {hlr_uid} not found"}

    # ── Derive slug from HLR name ────────────────────────────────────
    title_line = (hlr.name or "").strip().rstrip(".")
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
    for ch in " \\:?*<>|\"'/—–—–":
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

    # ── Find namespace from HLR's design compounds ─────────────────
    # Load namespace subtree from Neo4j — simpler than walking the full
    # HLR/LLR chain and avoids including requirement nodes in the diagram.
    NamespaceNode = CodeGraphNode._registry.get("NamespaceNode")
    namespace_qn: str | None = None

    for dc in hlr.design_compounds.all():
        qn = getattr(dc, "qualified_name", None)
        if not qn:
            continue
        parts = qn.rsplit(".", 1)
        if len(parts) == 2:
            namespace_qn = parts[0]
            break

    if not namespace_qn or not NamespaceNode:
        return {"error": "No namespace found for HLR design compounds"}

    ns = NamespaceNode.nodes.get_or_none(qualified_name=namespace_qn)
    if not ns:
        return {"error": f"Namespace {namespace_qn} not found in Neo4j"}

    # Serialize namespace with COMPOSES children + DEPENDS_ON edges
    ns_dict = ns.serialize(fields="llm")
    ns_dict["type"] = "NamespaceNode"

    edges: list[dict] = []
    try:
        walked = ns.walk_edges()
    except Exception:
        walked = []
    for edge in walked:
        rt = edge.get("relation_type", "")
        out = edge.get("is_outgoing", True)
        if rt == "COMPOSES" and out:
            edges.append({
                "relation_type": "COMPOSES",
                "target_uid": edge.get("target_uid", ""),
                "target_type": edge.get("target_type", ""),
            })
        elif rt == "DEPENDS_ON" and out:
            edges.append({
                "relation_type": "DEPENDS_ON",
                "target_uid": edge.get("target_uid", ""),
                "target_type": edge.get("target_type", ""),
            })
    if edges:
        ns_dict["edges"] = edges

    try:
        graph = LayerGraph.deserialize([ns_dict], create_missing=True)
    except Exception as exc:
        return {"error": f"Failed to deserialize namespace subtree: {exc}"}

    if not graph.entries:
        return {"error": f"Namespace {namespace_qn} has no children"}

    # ── Export markdown ──────────────────────────────────────────────
    md = MarkdownExporter(graph, fields="llm", public_only=False).export()
    md_path = dir_path / "design.md"
    md_path.write_text(md, encoding="utf-8")

    # ── Export PlantUML ──────────────────────────────────────────────
    diagrams_dir = dir_path / "diagrams"
    diagrams_dir.mkdir(parents=True, exist_ok=True)
    puml = PlantUMLExporter(graph, fields="llm").export()
    puml_path = diagrams_dir / "architecture_class_diagram.puml"
    puml_path.write_text(puml, encoding="utf-8")

    # ── Render PNG ───────────────────────────────────────────────────
    png_path = diagrams_dir / "architecture_class_diagram.png"
    png_ok = False

    # Try homebrew plantuml first, then jar fallback
    plantuml_bin = os.environ.get("PLANTUML_BIN", "")
    candidates = [
        plantuml_bin,
        "/opt/homebrew/bin/plantuml",
        "/usr/local/bin/plantuml",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            try:
                subprocess.run(
                    [candidate, "-tpng", str(puml_path)],
                    capture_output=True, text=True, timeout=60, cwd=str(dir_path),
                )
                png_ok = png_path.exists()
                break
            except Exception:
                continue

    # Fall back to java -jar
    if not png_ok:
        plantuml_jar = os.environ.get("PLANTUML_JAR", "/tmp/plantuml.jar")
        if Path(plantuml_jar).exists():
            try:
                subprocess.run(
                    ["java", "-jar", plantuml_jar, "-tpng", str(puml_path)],
                    capture_output=True, text=True, timeout=60, cwd=str(dir_path),
                )
                png_ok = png_path.exists()
            except Exception:
                pass

    if not png_ok:
        png_path = None

    return {
        "markdown": str(md_path),
        "plantuml": str(puml_path),
        "png": str(png_path) if png_path and png_path.exists() else None,
    }


def handle_design_run(params: dict):
    """Run the design_oo agent on an HLR (requires pre-existing LLRs).

    Accepts ``hlr_uid`` (string, required).  Loads HLR + LLRs from Neo4j,
    runs the design + verification tool loop, persists the result.

    Automatically exports design artifacts to
    ``codegraph/requirements/<hlr-slug>/`` (design.md,
    diagrams/architecture_class_diagram.puml, diagrams/architecture_class_diagram.png).
    """
    hlr_uid = params.get("hlr_uid")
    if not hlr_uid:
        raise ValueError("design_run requires 'hlr_uid'")

    from codegraph_design.agents.design_oo import design_and_persist_hlr
    result = design_and_persist_hlr(
        hlr_uid=hlr_uid,
        log_dir=params.get("log_dir") or "",
    )

    # Auto-export design artifacts
    output_dir = params.get("output_dir") or ""
    try:
        artifacts = _export_design_artifacts(hlr_uid, output_dir=output_dir)
        result["_artifacts"] = artifacts
    except Exception as exc:
        result["_artifacts_error"] = str(exc)

    return result


def handle_decompose_prompt(params: dict) -> dict:
    """Return the decompose agent's system prompt and tool schema.

    Useful for Pi subagent definitions.
    """
    from codegraph_design.agents.decompose_hlr import SYSTEM_PROMPT, TOOL_DEFINITION
    return {
        "system_prompt": SYSTEM_PROMPT,
        "tool_definition": TOOL_DEFINITION,
    }


def handle_design_prompt(params: dict) -> dict:
    """Return the design agent's system prompt, context sections, and tool schemas.

    Accepts optional context parameters:
    - ``component_namespace``: required namespace for this component.
    - ``intercomponent_classes``: list of inter-component boundary class dicts.
    - ``existing_classes``: list of existing design class dicts.

    Returns the formatted system prompt plus the combined tool schemas
    from both DesignToolDispatcher and VerificationDispatcher.
    """
    from codegraph_design.agents.design_oo_prompt import (
        build_namespace_section, build_intercomponent_section,
        build_existing_classes_section,
    )
    from codegraph_design.agents.design_oo import SYSTEM_PROMPT
    from codegraph_design.tools.dispatcher import (
        DesignToolDispatcher, VerificationDispatcher,
    )

    component_namespace = params.get("component_namespace") or ""
    intercomponent_classes = params.get("intercomponent_classes") or []
    existing_classes = params.get("existing_classes") or []

    ns_section = build_namespace_section(component_namespace) if component_namespace else ""
    inter_section = build_intercomponent_section(intercomponent_classes) if intercomponent_classes else ""
    existing_section = build_existing_classes_section(existing_classes) if existing_classes else ""

    system = SYSTEM_PROMPT.format(
        specializations_section="",
        namespace_section=ns_section,
        as_built_section="",
        existing_classes_section=existing_section,
        intercomponent_section=inter_section,
    )

    # Build dispatchers to collect tool schemas
    design_disp = DesignToolDispatcher()
    verif_disp = VerificationDispatcher(design_dispatcher=design_disp)

    return {
        "system_prompt": system,
        "tool_schemas": design_disp.all_tool_schemas + verif_disp.all_tool_schemas,
    }

