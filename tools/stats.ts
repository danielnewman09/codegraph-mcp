/**
 * codegraph_stats — compact high-level graph statistics.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { CodegraphBridge } from "../shared.js";
import { ok, err } from "../shared.js";

export function registerStatsTool(
  pi: ExtensionAPI,
  deps: { ensureBridge: () => Promise<CodegraphBridge> },
): void {
  pi.registerTool({
    name: "codegraph_stats",
    label: "Codegraph Statistics",
    description:
      "Returns compact, high-level statistics about the codegraph store: total node/relationship counts, " +
      "node counts by kind, source, and tag, description coverage per kind, relationship type breakdown, " +
      "and a test summary. Use this instead of ``codegraph_query scope='kind'`` or ``codegraph_explore action='tags'`` " +
      "when you need a quick overview or are troubleshooting — it's always a few hundred bytes regardless of " +
      "graph size, and will never blow the context window.",
    promptSnippet: "Get high-level graph statistics (counts by kind/source/tag, description coverage, test summary)",
    promptGuidelines: [
      "Use codegraph_stats to get an overview before diving into specific queries. It's always compact.",
      "When troubleshooting (e.g. 'why are test descriptions empty?'), run codegraph_stats first to get the big picture.",
      "codegraph_stats replaces ad-hoc 'show me everything of kind X' queries that can blow context windows.",
    ],
    parameters: Type.Object({}),
    renderCall(_args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText("codegraph_stats");
      return text;
    },
    async execute(_id, _params, signal) {
      try {
        const b = await deps.ensureBridge();
        if (signal?.aborted) return err("codegraph_stats aborted before dispatch");
        const res = await b.call("stats", {});
        if (!res.ok) return err(`stats error: ${res.error}`, { error: res.error });
        const r = res.result;
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return ok(text, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`codegraph_stats failed: ${msg}`, { error: msg });
      }
    },
  });
}
