/**
 * codegraph_setup — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../integrations/pi/pi.js";
import { setupTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerSetupTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, setupTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; project_dir?: string; repository?: string };
      const target = p.repository ?? p.project_dir ?? "";
      text.setText(["codegraph_setup", p.action ?? "", target].filter(Boolean).join("  "));
      return text;
    },
  });
}
