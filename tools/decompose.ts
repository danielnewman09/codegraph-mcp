/**
 * codegraph_decompose — Pi wrapper for the canonical catalog definition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCatalogTool } from "../src/harnesses/pi.js";
import { decomposeTool } from "../src/core/tool-catalog.js";
import type { CodegraphRuntime } from "../src/core/runtime.js";

export function registerDecomposeTool(pi: ExtensionAPI, runtime: CodegraphRuntime): void {
  registerCatalogTool(pi, decomposeTool, runtime, {
    renderCall(args, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const hlr = (args as { hlr_uid?: string; description?: string });
      const uid = hlr.hlr_uid;
      const target = uid ? `HLR ${uid.slice(0, 8)}` : hlr.description ? hlr.description.slice(0, 60) : "";
      text.setText(`codegraph_decompose  ${target}`);
      return text;
    },
  });
}
