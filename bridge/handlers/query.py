#!/usr/bin/env python3
"""Codegraph bridge — stdio JSON-RPC daemon for the codegraph Pi extension.

The Pi extension (TypeScript) spawns this process once per session and
keeps it alive.  It speaks newline-delimited JSON over stdin/stdout:

    request:  {"id": <int>, "method": <str>, "params": <object>}
    response: {"id": <int>, "ok": true,  "result": <any>}
             {"id": <int>, "ok": false, "error": <str>}

Only JSON lines are written to stdout — all diagnostics go to stderr so
the framing channel stays clean.

Two methods mirror the extension's two-tool surface:

* ``query``  — fetch a subgraph (scoped by tag / namespace / compound /
  neighborhood / source / kind / cached) and return it formatted as
  markdown, plantuml, json, or an interactive HTML visualisation.
* ``explore`` — lightweight lookups (search, get_compound, get_member,
  browse_namespace, list_sources, list_tags, inheritance,
  callers/callees) returning slim JSON.

Both reuse the existing :class:`codegraph.tools.CodeGraphDispatcher`,
which caches the last fetched graph in ``current_graph`` so that
``scope=cached`` re-exports and ``format=html`` renders can reuse it
without re-querying Neo4j.

The Neo4j connection is configured from environment variables
(``NEO4J_URI``, ``NEO4J_USER``, ``NEO4J_PASSWORD``) by
:mod:`codegraph.config` at import time; the child process inherits the
host environment.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile

# ── Dispatcher singleton (lazy) ────────────────────────────────────────────

_dispatcher = None


def get_dispatcher():
    """Lazily construct the CodeGraphDispatcher (imports codegraph)."""
    global _dispatcher
    if _dispatcher is None:
        from codegraph.tools import CodeGraphDispatcher

        _dispatcher = CodeGraphDispatcher()
    return _dispatcher


# ── Scope → graph construction (for HTML rendering + caching) ──────────────


def _build_graph(disp, scope: str, params: dict):
    """Return a LayerGraph for the requested scope.

    Used by the HTML path (which needs a live graph object) and to seed
    ``current_graph`` so ``scope=cached`` works afterwards.
    """
    repo = disp.repo
    if scope == "tag":
        tag = params.get("tag")
        if not tag:
            raise ValueError("scope='tag' requires 'tag'")
        return repo.get_by_tag(tag)
    if scope == "namespace":
        qn = params.get("qualified_name")
        if not qn:
            raise ValueError("scope='namespace' requires 'qualified_name'")
        return repo.get_by_namespace(qn)
    if scope == "compound":
        qn = params.get("qualified_name")
        if not qn:
            raise ValueError("scope='compound' requires 'qualified_name'")
        return repo.get_by_compound(qn)
    if scope == "neighborhood":
        qn = params.get("qualified_name")
        if not qn:
            raise ValueError("scope='neighborhood' requires 'qualified_name'")
        return repo.get_by_neighbourhood(qn)
    if scope == "source":
        src = params.get("source")
        if not src:
            raise ValueError("scope='source' requires 'source'")
        return repo.get_by_source(src)
    if scope == "kind":
        kind = params.get("kind")
        if not kind:
            raise ValueError("scope='kind' requires 'kind'")
        return repo.get_by_kind(kind, tag=params.get("tag"))
    if scope == "cached":
        if disp.current_graph is None:
            raise ValueError(
                "scope='cached' has no graph cached yet. Run a fetch "
                "query (e.g. scope='tag') first."
            )
        return disp.current_graph
    raise ValueError(f"Unknown scope: {scope!r}")


# ── Scope → dispatcher tool (text formats reuse existing handlers) ───────

_SCOPE_TO_TOOL = {
    "tag": ("graph_fetch", ("tag", "format", "public_only")),
    "namespace": ("graph_fetch_namespace", ("qualified_name", "format")),
    "compound": ("graph_fetch_compound", ("qualified_name", "format")),
    "neighborhood": ("graph_fetch_neighborhood", ("qualified_name", "format")),
    "source": ("graph_fetch_by_source", ("source", "format")),
    "kind": ("graph_fetch_by_kind", ("kind", "tag", "format")),
    "cached": ("graph_format_export", ("format",)),
}


def _pick(params: dict, keys) -> dict:
    """Build a sub-dict of non-None params for the given keys."""
    return {k: params[k] for k in keys if k in params and params[k] is not None}


# ── HTML rendering helpers ────────────────────────────────────────────────


def _title_for(scope: str, params: dict) -> str:
    for key in ("qualified_name", "tag", "source", "kind"):
        v = params.get(key)
        if v:
            return str(v)
    return scope


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:120] or "graph"


def _default_html_path(title: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"codegraph_{_sanitize(title)}.html")


# ── Method handlers ───────────────────────────────────────────────────────


def handle_ping() -> dict:
    """Health check — report codegraph availability + version."""
    try:
        import codegraph  # noqa: F401
        from codegraph.tools import CodeGraphDispatcher  # noqa: F401

        version = getattr(codegraph, "__version__", "unknown")
        return {"ok": True, "version": version, "methods": ["ping", "query", "explore", "tests", "stats", "setup", "discover", "memory", "decompose_run", "decompose_validate", "design_run", "decompose_prompt", "design_prompt", "debug_env"]}
    except Exception as exc:  # codegraph not importable
        return {"ok": False, "error": f"codegraph import failed: {exc}"}


def handle_debug_env() -> dict:
    """Debug endpoint — dump LLM config for troubleshooting."""
    import os as _os
    return {
        "cwd": _os.getcwd(),
        "llm_vars": {k: _os.environ.get(k) for k in sorted(_os.environ) if k.startswith("LLM_")},
        "neo4j_vars": {k: _os.environ.get(k) for k in sorted(_os.environ) if k.startswith("NEO4J_")},
    }


def handle_query(params: dict):
    disp = get_dispatcher()
    scope = params.get("scope")
    if scope not in _SCOPE_TO_TOOL:
        raise ValueError(
            f"Unknown scope {scope!r}. Valid: {sorted(_SCOPE_TO_TOOL)}"
        )
    fmt = params.get("format", "markdown")

    if fmt == "html":
        graph = _build_graph(disp, scope, params)
        disp.current_graph = graph  # cache for scope=cached / re-renders
        from codegraph.viz.api import _render_html

        size = params.get("size", "large")
        title = _title_for(scope, params)
        out = params.get("output") or _default_html_path(title)
        path = _render_html(graph, title, out, size=size)
        return {"html_path": path, "title": title, "scope": scope, "size": size}

    if fmt == "component_plantuml":
        graph = _build_graph(disp, scope, params)
        disp.current_graph = graph
        from codegraph.export.component_decomposition import (
            ComponentDecomposition, export_component_plantuml,
        )
        detail = params.get("detail_level", "high")
        min_size = int(params.get("min_component_size", 2))
        dec = ComponentDecomposition(graph, min_component_size=min_size)
        dec.decompose()
        return export_component_plantuml(graph, decomposition=dec, detail_level=detail)

    # text formats — reuse the dispatcher's existing fetch/export handlers
    tool_name, keys = _SCOPE_TO_TOOL[scope]
    return disp.dispatch(tool_name, _pick(params, keys))


# explore action → dispatcher tool
