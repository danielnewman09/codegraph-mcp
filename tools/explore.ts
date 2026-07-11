/**
 * codegraph_explore — lightweight lookups returning slim JSON.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err } from "../shared.js";

export function registerExploreTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_explore",
    label: "Codegraph Explore",
    description:
      "Lightweight lookups against the codegraph store that return slim JSON (not a full serialized graph). " +
      "Use this to *find* symbols and inspect relationships before fetching full context with codegraph_query. " +
      "`action` selects the lookup: 'search' (find compounds by qualified-name substring), 'compound' (a class + its " +
      "member list), 'member' (a single method/attribute), 'namespace' (list compounds under a namespace prefix), " +
      "'namespaces' (list all namespace nodes with entity counts — discover which namespaces are large enough to be components), " +
      "'sources' (list indexed source projects), 'tags' (list available provenance tags + node counts), " +
      "'inheritance' (parents + children of a compound), 'callers_callees' (what calls / is called by a member).",
    promptSnippet: "Look up codegraph symbols & relationships (search, compound, member, namespace, namespaces, inheritance, callers/callees, hlr_subtree, tags, sources)",
    promptGuidelines: [
      "Use codegraph_explore action='search' to find relevant classes by name when you don't yet know the qualified name.",
      "Use action='tags' or 'sources' first to discover what views/projects are indexed before fetching.",
      "Use action='namespaces' to list all namespaces with entity counts — find components without pulling the full graph.",
      "Use action='inheritance' / 'callers_callees' for relationship-specific lookups, then codegraph_query scope='neighborhood' for full context.",
      "Use action='hlr_subtree' with an HLR refid to retrieve the complete requirements tree (HLR → LLRs → tests → scaffold nodes) before decomposing or designing.",
      "These return compact JSON; follow up with codegraph_query to retrieve formatted, complete context for the symbols you found.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["search", "compound", "member", "namespace", "namespaces", "sources", "tags", "inheritance", "callers_callees", "hlr_subtree"] as const,
        {
          description:
            "search (needs query): find compounds by name substring. compound/member/inheritance/callers_callees (need qualified_name). " +
            "namespace (needs namespace): list compounds under a prefix. sources / tags: list indexed projects / provenance tags. " +
            "hlr_subtree (needs refid): fetch the full requirements subtree (HLR→LLRs→tests→scaffolds).",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Fully-qualified name; required for action=compound/member/inheritance/callers_callees.",
      })),
      query: Type.Optional(Type.String({
        description: "Substring to search for in compound qualified names (action=search).",
      })),
      namespace: Type.Optional(Type.String({
        description: "Namespace prefix to browse (action=namespace), e.g. 'std', 'codegraph.graph'.",
      })),
      source: Type.Optional(Type.String({
        description: "Filter search results by source project (action=search).",
      })),
      kind: Type.Optional(Type.String({
        description: "Filter search results by node kind, e.g. 'class','interface','enum' (action=search).",
      })),
      tag: Type.Optional(Type.String({
        description: "Optional tag filter (currently unused by explore actions but accepted for forward-compat).",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum results for search/namespace (default 30 / 50).",
      })),
      refid: Type.Optional(Type.String({
        description: "HLR refid for action=hlr_subtree.",
      })),
    }),
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; query?: string; qualified_name?: string; namespace?: string };
      const target = p.query ?? p.qualified_name ?? p.namespace ?? "";
      text.setText(["codegraph_explore", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
    async execute(_id, params, signal) {
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_explore aborted before dispatch");
        const res = await b.call("explore", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_explore failed: ${msg}`, { error: msg });
      }
    },
  });
}
