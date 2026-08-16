/**
 * Host-neutral types for the codegraph extension core.
 *
 * These types intentionally contain no Pi or MCP types, so any agent
 * harness (Pi, Codex/MCP, ...) can adapt to the same canonical contract.
 */

/** A JSON-serialisable object. */
export type JsonObject = Record<string, unknown>;

/** Per-call execution context supplied by the harness. */
export interface ToolExecutionContext {
  /** Abort the underlying work when signalled. */
  signal?: AbortSignal;
  /** Report human-readable progress (long-running tools). */
  onProgress?: (message: string, details?: JsonObject) => void;
  /** Whether the harness allows opening a rendered HTML path. */
  allowOpenPath?: boolean;
}

export interface ToolSuccess {
  ok: true;
  text: string;
  details?: unknown;
}

export interface ToolFailure {
  ok: false;
  text: string;
  details?: unknown;
}

export type ToolResult = ToolSuccess | ToolFailure;

/** Rough cost class used to pick a default timeout. */
export type TimeoutClass = "normal" | "setup" | "agent";

/** A bridge method result, before conversion to ToolResult. */
export interface BridgeCallResult {
  ok: boolean;
  text: string;
  details?: unknown;
  error?: string;
}

/**
 * Canonical tool definition. One instance per public tool; both the Pi
 * harness and the MCP harness derive their registrations from these.
 */
export interface CodegraphToolDefinition {
  /** Public tool name, e.g. "codegraph_query". */
  name: string;
  label: string;
  description: string;
  /** JSON Schema-compatible input schema. */
  inputSchema: JsonObject;
  promptSnippet?: string;
  promptGuidelines?: string[];
  /** Internal bridge method, e.g. "query". */
  bridgeMethod: string;
  timeoutClass: TimeoutClass;
  mutability: "read" | "write" | "mixed";
  /**
   * Execute the tool. `params` are already validated against
   * `inputSchema`; the implementation maps them onto bridge calls.
   */
  execute(
    runtime: CodegraphRuntimeLike,
    params: JsonObject,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

/** The subset of the runtime the tool executor needs. */
export interface CodegraphRuntimeLike {
  ensureBridge(): Promise<unknown>;
  call(method: string, params: JsonObject, timeoutMs?: number): Promise<BridgeCallResult>;
}
