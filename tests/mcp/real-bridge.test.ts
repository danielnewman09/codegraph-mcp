/**
 * Phase 3 opt-in test — end-to-end MCP session against the REAL Python
 * bridge with real graph data.
 *
 * Skipped unless CODEGRAPH_TEST_REAL=1.  Configure the interpreter and
 * database via CODEGRAPH_PYTHON and SQLITE_PATH (both optional):
 *   CODEGRAPH_TEST_REAL=1 CODEGRAPH_PYTHON=<python> SQLITE_PATH=<db> \
 *     node --import tsx --test tests/mcp/real-bridge.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers.js";

const REAL = process.env.CODEGRAPH_TEST_REAL === "1";

test("MCP (real bridge): same-session query → cached re-export works", { skip: !REAL }, async (t) => {
  if (!REAL) {
    t.skip("set CODEGRAPH_TEST_REAL=1 to run the real-bridge end-to-end test");
    return;
  }
  const env: Record<string, string> = {};
  if (process.env.CODEGRAPH_PYTHON) env.CODEGRAPH_PYTHON = process.env.CODEGRAPH_PYTHON;
  if (process.env.SQLITE_PATH) env.SQLITE_PATH = process.env.SQLITE_PATH;

  const { client, transport } = await startServer(env);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);

    const stats = await client.callTool({ name: "codegraph_stats", arguments: {} });
    assert.equal(stats.isError, false);
    const statsText = (stats.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.match(statsText, /total_nodes/);

    // The real bridge caches the last fetched graph; scope=cached re-exports it.
    const first = await client.callTool({
      name: "codegraph_query",
      arguments: { scope: "neighborhood", qualified_name: "codegraph.graph.LayerGraph", format: "markdown" },
    });
    assert.equal(first.isError, false);

    const cached = await client.callTool({
      name: "codegraph_query",
      arguments: { scope: "cached", format: "json" },
    });
    assert.equal(cached.isError, false);
    const cachedText = (cached.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.ok(cachedText.length > 0, "cached re-export should return graph JSON");
  } finally {
    await client.close();
    await transport.waitForExit(8_000);
  }
});
