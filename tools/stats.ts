/**
 * codegraph_stats — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { statsTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerStatsTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, statsTool, runtime, {
    renderCall(_args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText("codegraph_stats");
      return text;
    },
  });
}
