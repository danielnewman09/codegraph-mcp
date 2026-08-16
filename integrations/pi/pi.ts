/**
 * Pi harness — adapts canonical catalog definitions to Pi tool
 * registration.  This is the only Pi-specific glue for tool registration:
 * renderCall implementations live in the Pi wrapper files (tools/*.ts);
 * everything else comes from the catalog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  CodegraphRuntimeLike,
  CodegraphToolDefinition,
  ToolResult,
} from "../../src/core/types.js";

export interface PiToolRegistrationOptions {
  /** Pi-specific call rendering (TUI). */
  renderCall?: (args: unknown, theme: unknown, context: {
    lastComponent?: unknown;
  }) => Component;
}

/** Convert the canonical ToolResult to the Pi result shape. */
function toPiResult(r: ToolResult) {
  if (r.ok) {
    return { content: [{ type: "text" as const, text: r.text }], details: r.details ?? {} };
  }
  return { content: [{ type: "text" as const, text: r.text }], details: r.details ?? {}, isError: true };
}

export function registerCatalogTool(
  pi: ExtensionAPI,
  def: CodegraphToolDefinition,
  runtime: CodegraphRuntimeLike,
  opts: PiToolRegistrationOptions = {},
): void {
  pi.registerTool({
    name: def.name,
    label: def.label,
    description: def.description,
    promptSnippet: def.promptSnippet,
    promptGuidelines: def.promptGuidelines,
    parameters: def.inputSchema as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
    renderCall: opts.renderCall,
    async execute(id, params, signal, onUpdate) {
      const r = await def.execute(runtime, params as Parameters<NonNullable<typeof def.execute>>[1], {
        signal,
        allowOpenPath: true,
        onProgress: onUpdate
          ? (msg, details) => onUpdate({ content: [{ type: "text", text: msg }], details })
          : undefined,
      });
      return toPiResult(r);
    },
  });
}
