/**
 * codegraph_memory — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { memoryTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerMemoryTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, memoryTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; memory_type?: string; qualified_name?: string; query?: string; lookup_type?: string };
      const target = p.memory_type ?? p.lookup_type ?? p.qualified_name ?? p.query ?? "";
      text.setText(["codegraph_memory", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
  });
}
