/**
 * codegraph_memory — manage design memory nodes linked to codebase knowledge graphs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err } from "../shared.js";

export function registerMemoryTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_memory",
    label: "Codegraph Memory",
    description:
      "Manage design memory nodes (decisions, constraints, rationales, assumptions, " +
      "tradeoffs, insights) linked to codebase knowledge graphs. " +
      "Actions: 'record' to create/update memory nodes and link them to code; " +
      "'context' to fetch all design memory relevant to a code node (including inherited " +
      "context from COMPOSES ancestors); 'lookup' for targeted queries (memory_of, " +
      "constraints_for, decision_chain, insights_for, rationales_for, assumptions_for, " +
      "tradeoffs_for, affected_decisions); 'search' for full-text search across all " +
      "memory content; 'search_semantic' for vector similarity search.",
    promptSnippet: "Manage design memory — record decisions/constraints/rationales and query design rationale linked to code nodes",
    promptGuidelines: [
      "Use action='record' to create or update memory nodes — decisions, constraints, rationales, assumptions, tradeoffs, insights.",
      "Use action='context' before modifying code to see all design rationale, constraints, and decisions affecting a code node.",
      "Use action='lookup' with lookup_type='constraints_for' or 'decision_chain' for targeted queries.",
      "Use action='search' to find memories by keyword across the full store.",
      "When recording a decision, use 'supersedes' to mark older decisions as replaced.",
      "Use 'links_to' to associate memories with code nodes by qualified_name.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["record", "context", "lookup", "search", "search_semantic"] as const,
        {
          description: "Which memory operation to perform. 'record': create/update a memory node. 'context': fetch all design memory relevant to a code node. 'lookup': targeted queries (needs lookup_type). 'search': full-text search. 'search_semantic': vector similarity search.",
        },
      ),
      qualified_name: Type.Optional(Type.String({
        description: "Qualified name of the target entity. For 'record': the memory node's qualified_name (e.g. 'memory::db-choice'). For 'context'/'lookup': the code node's qualified_name.",
      })),
      memory_type: Type.Optional(StringEnum(
        ["decision", "constraint", "rationale", "assumption", "tradeoff", "insight"] as const,
        {
          description: "Memory node type (action='record'). One of: decision, constraint, rationale, assumption, tradeoff, insight.",
        },
      )),
      content: Type.Optional(Type.String({
        description: "Free-text body of the memory (action='record').",
      })),
      tags: Type.Optional(Type.Array(Type.String(), {
        description: "Provenance tags (action='record'), e.g. ['design', 'as-built']. Replaces existing tags on update.",
      })),
      confidence: Type.Optional(Type.Number({
        description: "Confidence 0.0–1.0 (action='record').",
      })),
      source: Type.Optional(Type.String({
        description: "Source project name (action='record').",
      })),
      links_to: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "qualified_name(s) of code nodes to link this memory to (action='record'). Additive — adds new links.",
      })),
      supersedes: Type.Optional(Type.String({
        description: "qualified_name of an older DecisionNode to supersede (action='record', memory_type='decision' only).",
      })),
      refines: Type.Optional(Type.String({
        description: "qualified_name of a DecisionNode this Rationale elaborates (action='record', memory_type='rationale' only).",
      })),
      contradicts: Type.Optional(Type.String({
        description: "qualified_name of an AssumptionNode this contradicts (action='record', memory_type='assumption' only).",
      })),
      mode: Type.Optional(StringEnum(
        ["create", "update", "upsert"] as const,
        {
          description: "Creation mode (action='record'). 'upsert' (default): update if exists, create if not. 'create': always create new. 'update': error if not found.",
        },
      )),
      uid: Type.Optional(Type.String({
        description: "Precise targeting by UID (action='record'). Overrides qualified_name lookup.",
      })),
      traverse_parents: Type.Optional(Type.Boolean({
        description: "If true (default), walk COMPOSES upward to include memories from parent nodes (action='context').",
      })),
      max_depth: Type.Optional(Type.Number({
        description: "Maximum COMPOSES traversal depth (action='context'). Default 5.",
      })),
      include_superseded: Type.Optional(Type.Boolean({
        description: "If true, include superseded decisions in results (action='context'). Default false.",
      })),
      lookup_type: Type.Optional(StringEnum(
        ["memory_of", "constraints_for", "decision_chain", "insights_for",
         "rationales_for", "assumptions_for", "tradeoffs_for", "affected_decisions"] as const,
        {
          description: "Specific lookup type (action='lookup'). memory_of: all memories for a code node. constraints_for: constraints governing a node. decision_chain: decisions + SUPERSEDES chain. insights_for/rationales_for/assumptions_for/tradeoffs_for: filtered lookups. affected_decisions: memories for a node and all its COMPOSES descendants.",
        },
      )),
      query: Type.Optional(Type.String({
        description: "Search query string (action='search'). Searches memory content and qualified_names.",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum results to return (action='search' default 20, action='search_semantic' default 10).",
      })),
      tag: Type.Optional(Type.String({
        description: "Optional tag filter for search (action='search'/'search_semantic'), e.g. 'design'.",
      })),
      embedding: Type.Optional(Type.Array(Type.Number(), {
        description: "1536-dimensional embedding vector for semantic search (action='search_semantic').",
      })),
    }),
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; memory_type?: string; qualified_name?: string; query?: string; lookup_type?: string };
      const target = p.memory_type ?? p.lookup_type ?? p.qualified_name ?? p.query ?? "";
      text.setText(["codegraph_memory", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
    async execute(_id, params, signal) {
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_memory aborted before dispatch");
        const res = await b.call("memory", params as Record<string, unknown>);
        if (!res.ok) return err(`codegraph_memory error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, { action: params.action });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_memory failed: ${msg}`, { error: msg });
      }
    },
  });
}
