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
 * Project selection: after connecting, the server asks the client for its
 * workspace roots (`roots/list` when the client advertises the capability)
 * and resolves the active project manifest before the Python bridge ever
 * starts.  Root-change notifications invalidate the current resolution:
 * the running bridge is stopped (never silently switched), the project is
 * re-resolved, and a new bridge starts on the next tool call.
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
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CodegraphRuntime } from "../../src/core/runtime.js";
import { dataDir, packageVersion, resolveConfig } from "../../src/core/config.js";
import { resolveProjectContext, type WorkspaceRoot } from "../../src/core/project.js";
import { ALL_TOOLS, findTool, toolInputJsonSchema } from "../../src/core/tool-catalog.js";
import { validateAgainstSchema } from "../../src/core/validate.js";
import type { JsonObject } from "../../src/core/types.js";

const PKG_VERSION: string = packageVersion();

/** Fetch workspace roots from the client (empty when unsupported). */
async function fetchWorkspaceRoots(server: Server): Promise<WorkspaceRoot[]> {
  try {
    const capabilities = await waitForClientCapabilities(server);
    if (!capabilities?.roots) return [];
    const res = await server.listRoots();
    return (res.roots ?? []).map((r) => ({ uri: r.uri, name: r.name }));
  } catch {
    // Clients without the roots capability (or that reject the request)
    // simply fall through to explicit config / the central fallback.
    return [];
  }
}

/**
 * `server.connect()` resolves when the transport starts, before the client's
 * initialize handshake is processed — client capabilities may not be set yet.
 * Poll briefly so roots/list is only attempted once the handshake landed.
 */
async function waitForClientCapabilities(
  server: Server,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const caps = server.getClientCapabilities();
    if (caps) return caps as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  return server.getClientCapabilities() as Record<string, unknown> | undefined;
}

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

  // ── Project resolution (lazily awaited before the first bridge call) ────
  let projectReady: Promise<void> | null = null;

  async function resolveProjectForRoots(roots: WorkspaceRoot[], reason = "project"): Promise<void> {
    const project = resolveProjectContext({
      env: process.env,
      cwd: process.cwd(),
      workspaceRoots: roots,
      pluginDataDir: dataDir(process.env),
    });
    // Stop any active bridge (never switch a bridge with active work),
    // then re-resolve; the next call starts a fresh bridge.
    await rt.updateProject(project);
    process.stderr.write(
      `[codegraph-mcp] ${reason} '${project.id}' (${project.discoverySource}) database ${project.databasePath}\n`,
    );
  }

  /** Resolve the project exactly once, before any bridge call. */
  function ensureProjectResolved(): Promise<void> {
    if (!projectReady) {
      projectReady = (async () => {
        const roots = await fetchWorkspaceRoots(server);
        try {
          await resolveProjectForRoots(roots);
        } catch (e) {
          // Ambiguous/invalid manifests are actionable: fail loudly before
          // the bridge starts and never create a database.
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[codegraph-mcp] project resolution failed: ${msg}\n`);
          await shutdown(1);
          throw e;
        }
      })();
    }
    return projectReady;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: toolInputJsonSchema(def),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Project selection happens before the Python bridge starts — the
    // first tool call awaits resolution (or a hard failure on ambiguity).
    await ensureProjectResolved();
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
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await server.close(); } catch { /* already closed */ }
    try { await rt.stopBridge(); } catch { /* ignore */ }
    process.exit(code);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.stdin.on("close", () => { void shutdown(); });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ── Root-change handling ────────────────────────────────────────────────
  // Registered unconditionally: `connect()` may resolve before the client's
  // initialize handshake populates capabilities, and a client that never
  // sends the notification is simply unaffected.
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      try {
        // Invalidate the resolved project; re-resolve from the new roots.
        // The running bridge is stopped (never silently switched) and a new
        // bridge starts on the next tool call.
        projectReady = null;
        const roots = await fetchWorkspaceRoots(server);
        await resolveProjectForRoots(roots, "roots changed → project");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[codegraph-mcp] project re-resolution after roots change failed: ${msg}\n`);
      }
  });
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
