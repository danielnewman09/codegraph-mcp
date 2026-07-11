/**
 * codegraph_discover — discover existing requirements and code before designing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err } from "../shared.js";

export function registerDiscoverTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_discover",
    label: "Codegraph Discover",
    description:
      "Discover existing requirements (HLRs/LLRs) and related code before designing a new feature. " +
      "Actions: search_requirements (keyword search), get_hlr_dependencies (DEPENDS_ON traversal), " +
      "list_requirements (browse by component/tag), get_requirement_traces (requirement → code links), " +
      "build_design_context (assemble full context document for design agent). " +
      "Use this BEFORE designing to understand what already exists.",
    promptSnippet: "Discover existing requirements & code before designing (search_requirements, get_hlr_dependencies, list_requirements, get_requirement_traces, build_design_context)",
    promptGuidelines: [
      "Call codegraph_discover action='build_design_context' with a feature description to get a structured context document for design.",
      "Use action='search_requirements' to find related HLRs/LLRs by keyword before designing a new feature.",
      "Use action='get_hlr_dependencies' to find which HLRs a requirement depends on (DEPENDS_ON edges).",
      "codegraph_discover complements codegraph_query and codegraph_explore: discover finds requirements, query/explore find code.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["search_requirements", "get_hlr_dependencies", "list_requirements", "get_requirement_traces", "build_design_context", "ingest_design", "generate_hlr_docs", "generate_feedback_docs", "evaluate_coverage", "verify_callee_granularity"] as const,
        {
          description:
            "search_requirements (needs query): keyword search across HLR/LLR descriptions. " +
            "get_hlr_dependencies (needs refid): traverse DEPENDS_ON edges from an HLR. " +
            "list_requirements (optional component_name/tag): browse all HLRs. " +
            "get_requirement_traces (needs refid): requirement → design node COMPOSES edges. " +
            "build_design_context (needs feature_description): assemble full context document. " +
            "ingest_design (needs file_path): ingest a design/tests markdown file into Neo4j. " +
            "generate_hlr_docs: generate per-HLR documents from Neo4j. " +
            "generate_feedback_docs: generate feedback review documents. " +
            "evaluate_coverage: evaluate test coverage and design smells. " +
            "verify_callee_granularity: verify CALLEE edges target correct level.",
        },
      ),
      query: Type.Optional(Type.String({
        description: "Search text for action=search_requirements.",
      })),
      scope: Type.Optional(Type.String({
        description: "Search scope for action=search_requirements: 'hlr', 'llr', or 'both' (default both).",
      })),
      limit: Type.Optional(Type.Number({
        description: "Max results for action=search_requirements (default 20).",
      })),
      refid: Type.Optional(Type.String({
        description: "HLR or LLR refid for action=get_hlr_dependencies or action=get_requirement_traces.",
      })),
      direction: Type.Optional(Type.String({
        description: "Traversal direction for action=get_hlr_dependencies: 'outgoing', 'incoming', or 'both' (default outgoing).",
      })),
      component_name: Type.Optional(Type.String({
        description: "Component name filter for action=list_requirements or action=build_design_context.",
      })),
      tag: Type.Optional(Type.String({
        description: "Tag filter for action=list_requirements (e.g. 'design', 'as-built').",
      })),
      feature_description: Type.Optional(Type.String({
        description: "Feature description for action=build_design_context.",
      })),
      file_path: Type.Optional(Type.String({
        description: "Path to markdown file for action=ingest_design.",
      })),
      output_path: Type.Optional(Type.String({
        description: "Output path for action=evaluate_coverage (JSON report).",
      })),
    }),
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; query?: string; refid?: string; feature_description?: string };
      const target = p.query ?? p.refid ?? p.feature_description?.slice(0, 50) ?? "";
      text.setText(["codegraph_discover", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
    async execute(_id, params, signal) {
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_discover aborted before dispatch");
        const res = await b.call("discover", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph_discover error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_discover failed: ${msg}`, { error: msg });
      }
    },
  });
}
