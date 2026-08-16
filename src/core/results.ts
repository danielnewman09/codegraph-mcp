/**
 * Host-neutral result helpers.
 *
 * `ok` / `err` / `tail` preserve the shapes the Pi tools already return
 * (an object with `content`, optional `details`, and optional `isError`),
 * so existing tool code keeps working unchanged.  `fromBridgeResponse`
 * converts a raw bridge response into the canonical `ToolResult`.
 */

import type { BridgeCallResult, ToolResult } from "./types.js";

export interface ToolMessageResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}

export function ok(text: string, details?: unknown): ToolMessageResult {
  return { content: [{ type: "text", text }], details };
}

export function err(text: string, details?: unknown): ToolMessageResult {
  return { content: [{ type: "text", text }], details, isError: true };
}

export function tail(s: string, limit = 6000): string {
  if (!s) return "";
  return s.length <= limit ? s : "…(truncated)…\n" + s.slice(-limit);
}

/** Serialise a bridge result to text: strings pass through, objects are pretty-printed. */
export function resultText(r: unknown): string {
  return typeof r === "string" ? r : JSON.stringify(r, null, 2);
}

/** Normalise a raw bridge response into a canonical ToolResult. */
export function fromBridgeResponse(
  res: { ok: boolean; result?: unknown; error?: string },
  details?: unknown,
): ToolResult {
  if (!res.ok) {
    return { ok: false, text: res.error ?? "codegraph error", details };
  }
  return { ok: true, text: resultText(res.result), details };
}

/** A BridgeCallResult for an already-formatted bridge response. */
export function bridgeResultFromResponse(
  res: { ok: boolean; result?: unknown; error?: string },
  details?: unknown,
): BridgeCallResult {
  if (!res.ok) {
    return { ok: false, text: res.error ?? "codegraph error", details, error: res.error, raw: res.result };
  }
  return { ok: true, text: resultText(res.result), details, raw: res.result };
}
