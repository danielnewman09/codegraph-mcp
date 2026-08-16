/**
 * codegraph_query — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { queryTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerQueryTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, queryTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { scope?: string; qualified_name?: string; tag?: string; format?: string };
      const parts = ["codegraph_query", p.scope ?? "", p.qualified_name ?? p.tag ?? "", p.format ? `(${p.format})` : ""].filter(Boolean);
      text.setText(parts.join("  "));
      return text;
    },
  });
}
