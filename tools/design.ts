/**
 * codegraph_design — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../integrations/pi/pi.js";
import { designTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerDesignTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, designTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const uid = (args as { hlr_uid?: string }).hlr_uid;
      text.setText(`codegraph_design  ${uid ? `HLR ${uid.slice(0, 8)}` : ""}`);
      return text;
    },
  });
}
