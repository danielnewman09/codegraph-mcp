/**
 * codegraph_tests — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { testsTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerTestsTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, testsTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; qualified_name?: string; source?: string };
      const target = p.qualified_name ?? p.source ?? "";
      text.setText(["codegraph_tests", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
  });
}
