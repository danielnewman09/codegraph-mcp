/**
 * codegraph_query — fetch scoped subgraph from the Neo4j knowledge graph.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err, openPath } from "../shared.js";

export function registerQueryTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_query",
    label: "Codegraph Query",
    description:
      "Retrieve codebase knowledge-graph context from the codegraph Neo4j store and return it formatted for analysis. " +
      "Use the `scope` field to steer retrieval: 'tag' for an entire design view (design/as-built/dependency), " +
      "'namespace' for a module + everything it composes, 'compound' for a single class/interface/enum, " +
      "'neighborhood' for any node + its 1-hop relationships (the deep-inspection mode), 'source' for a whole " +
      "indexed project, 'kind' to list all nodes of a kind (e.g. all classes), or 'cached' to re-export the last " +
      "fetched graph in a different format without re-querying. " +
      "`format` selects markdown (default, human-readable public API + relationships), plantuml (class diagram), " +
      "component_plantuml (high-level component diagram with requirement annotations), " +
      "json (raw serialized graph), or html (interactive Cytoscape.js visualisation of the neighborhood, opened " +
      "in the browser). Results are cached server-side, so follow an expensive fetch with scope='cached' to switch " +
      "formats for free.",
    promptSnippet: "Fetch codegraph context (by tag/namespace/compound/neighborhood/source/kind) as markdown, plantuml, component_plantuml, json, or interactive HTML",
    promptGuidelines: [
      "Prefer codegraph_query to pull structured codebase context from the graph instead of grepping source.",
      "Start broad with scope='tag' to load an entire view, then scope='neighborhood' + a qualified_name to drill into one symbol.",
      "Use scope='cached' + a different format to re-export the last fetched graph without re-querying Neo4j.",
      "Use format='html' when the user wants to *see* the graph of a code object's neighborhood — it opens an interactive visualisation.",
      "scope='neighborhood' requires a fully-qualified name; use codegraph_explore action='search' first if you don't know it.",
      "For overview/troubleshooting queries (e.g. 'how many tests?'), use codegraph_stats instead of scope='kind' — stats is always compact and won't blow the context window.",
    ],
    parameters: Type.Object({
      scope: StringEnum(
        ["tag", "namespace", "compound", "neighborhood", "source", "kind", "cached"] as const,
        {
          description:
            "How to select the subgraph. 'tag' (needs tag), 'namespace'/'compound'/'neighborhood' (need qualified_name), " +
            "'source' (needs source), 'kind' (needs kind, optional tag), 'cached' (reuses the last fetched graph).",
        },
      ),
      format: StringEnum(
        ["markdown", "plantuml", "component_plantuml", "json", "html"] as const,
        {
          description: "Output format. 'markdown' (default): human-readable public API + relationships. 'plantuml': class diagram. 'component_plantuml': high-level component diagram with business-requirement annotations. 'json': raw serialized graph. 'html': interactive Cytoscape visualisation opened in the browser.",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Fully-qualified name; required for scope=namespace/compound/neighborhood (e.g. 'calc::CalculatorEngine', 'codegraph.graph.LayerGraph').",
      })),
      tag: Type.Optional(Type.String({
        description: "Provenance tag: 'design', 'as-built', 'dependency'. Required for scope=tag; optional filter for scope=kind.",
      })),
      source: Type.Optional(Type.String({
        description: "Source project name (e.g. 'codegraph', 'llvm'). Required for scope=source.",
      })),
      kind: Type.Optional(Type.String({
        description: "Node kind for scope=kind: 'class','struct','interface','enum','union','module','concept','method','attribute','enumvalue','function','define','namespace'.",
      })),
      detail_level: Type.Optional(StringEnum(["high", "medium"] as const, {
        description: "component_plantuml only: 'high' shows component packages + requirement notes only; 'medium' also shows key class names inside packages (default 'high').",
      })),
      min_component_size: Type.Optional(Type.Number({
        description: "component_plantuml only: minimum entities a namespace must contain to be treated as a component (default 2).",
      })),
      public_only: Type.Optional(Type.Boolean({
        description: "markdown only: show only public API members (default true). Set false to include private/protected members.",
      })),
      size: Type.Optional(StringEnum(["large", "small"] as const, {
        description: "html only: layout size. 'large' (default) full-page, 'small' compact.",
      })),
      output: Type.Optional(Type.String({
        description: "html only: custom output HTML path. Defaults to a temp file.",
      })),
      open: Type.Optional(Type.Boolean({
        description: "html only: open the rendered HTML in the default browser (default true).",
      })),
    }),
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { scope?: string; qualified_name?: string; tag?: string; format?: string };
      const parts = ["codegraph_query", p.scope ?? "", p.qualified_name ?? p.tag ?? "", p.format ? `(${p.format})` : ""].filter(Boolean);
      text.setText(parts.join("  "));
      return text;
    },
    async execute(_id, params, signal) {
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_query aborted before dispatch");
        const res = await b.call("query", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph error: ${res.error}`, { error: res.error });

        const r = res.result;
        if (r && typeof r === "object" && "html_path" in (r as Record<string, unknown>)) {
          const info = r as { html_path: string; title: string; scope: string; size?: string };
          let opened = false;
          if (params.open !== false) {
            try { await openPath(pi, info.html_path); opened = true; }
            catch (e) { /* still return the path */ }
          }
          const msg = `Rendered codegraph HTML (${info.scope}${info.title ? `: ${info.title}` : ""}) → ${info.html_path}${opened ? " (opened in browser)" : " (open the file manually)"}`;
          return ok(msg, { opened, ...info });
        }
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        const scopeVal = params.scope as string;
        let resultText = text;
        if (scopeVal === "kind" && text.length > 30_000) {
          const kindVal = params.kind ?? "?";
          resultText =
            `⚠️  LARGE RESULT (${text.length.toLocaleString()} chars, kind=${kindVal}). ` +
            `Use codegraph_stats for a compact overview instead of fetching all ${kindVal} nodes. ` +
            `Result follows (truncated to first 10KB):\n\n` +
            text.slice(0, 10_240);
        }
        return ok(resultText, { format: params.format ?? "markdown", scope: scopeVal });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_query failed: ${msg}`, { error: msg });
      }
    },
  });
}
