/**
 * codegraph_explore — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../integrations/pi/pi.js";
import { exploreTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerExploreTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, exploreTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; query?: string; qualified_name?: string; namespace?: string; uid?: string };
      const target = p.query ?? p.qualified_name ?? p.namespace ?? p.uid ?? "";
      text.setText(["codegraph_explore", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
  });
}
