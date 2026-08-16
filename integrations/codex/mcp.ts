/**
 * MCP harness — a stdio MCP server exposing the canonical codegraph tools.
 *
 * Codex consumes this as a standard MCP stdio server; no Codex-specific
 * APIs are used inside this file.  It derives every tool from the
 * canonical catalog (src/core/tool-catalog.ts), exposes tool schemas as
 * standards-compliant JSON Schema (converted from the TypeBox catalog),
 * shares one CodegraphRuntime (one bridge instance, preserving the graph
 * cache across calls), and writes diagnostics only to stderr — stdout is
 * reserved for MCP protocol framing.
 *
 * We use the protocol-level `Server` (not `McpServer.registerTool`)
 * because the current SDK only accepts Zod schemas for `inputSchema`;
 * the catalog is TypeBox-canonical, so the harness validates arguments
 * against the JSON Schema form with `validateAgainstSchema` instead of
 * maintaining parallel Zod schemas.
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { CodegraphRuntime } from "../../src/core/runtime.js";
import { packageVersion, resolveConfig } from "../../src/core/config.js";
import { ALL_TOOLS, findTool, toolInputJsonSchema } from "../../src/core/tool-catalog.js";
import { validateAgainstSchema } from "../../src/core/validate.js";
import type { JsonObject } from "../../src/core/types.js";

const PKG_VERSION: string = packageVersion();

/**
 * Start the MCP stdio server, optionally with an injected runtime (for
 * tests).  Resolves once connected; the process runs until stdin closes
 * or a termination signal arrives.
 */
export async function runMcpServer(runtime?: CodegraphRuntime): Promise<void> {
  const rt = runtime ?? new CodegraphRuntime(resolveConfig({}, process.env, process.cwd()));
  const server = new Server(
    { name: "codegraph", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: toolInputJsonSchema(def),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = findTool(name);
    if (!def) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    const args = (request.params.arguments ?? {}) as JsonObject;
    const invalid = validateAgainstSchema(toolInputJsonSchema(def), args);
    if (invalid !== null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool ${name}: ${invalid}`,
      );
    }
    const r = await def.execute(rt, args, { allowOpenPath: false });
    return {
      content: [{ type: "text" as const, text: r.text }],
      isError: !r.ok,
    };
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await server.close(); } catch { /* already closed */ }
    try { await rt.stopBridge(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.stdin.on("close", () => { void shutdown(); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const require = createRequire(import.meta.url);
const requireResolve = require.resolve.bind(require);

// Direct execution: `node dist/codegraph-mcp.js` or `tsx integrations/codex/mcp.ts`
const isEntry = process.argv[1] != null
  && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(requireResolve(process.argv[1])));
if (isEntry) {
  runMcpServer().catch((e) => {
    process.stderr.write(`[codegraph-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
