/**
 * codegraph_discover — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { discoverTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerDiscoverTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, discoverTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; query?: string; uid?: string; feature_description?: string };
      const target = p.query ?? p.uid ?? p.feature_description?.slice(0, 50) ?? "";
      text.setText(["codegraph_discover", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
  });
}
