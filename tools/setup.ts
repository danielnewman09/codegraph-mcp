/**
 * codegraph_setup — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { setupTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerSetupTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, setupTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as { action?: string; project_dir?: string };
      text.setText(["codegraph_setup", p.action ?? "", p.project_dir ?? ""].filter(Boolean).join("  "));
      return text;
    },
  });
}
