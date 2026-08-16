/**
 * Phase 3 tests — MCP stdio server integration over a spawned child.
 *
 * Uses the official MCP SDK client over a manually-spawned server process
 * (so we can assert the child exits cleanly).  The server is pointed at
 * the fake bridge so the tests are hermetic (no Python required).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { FAKE_BRIDGE, MCP_ENTRY, SpawnedStdioTransport, startServer } from "./helpers.js";

const FAKE_ENV = { CODEGRAPH_PYTHON: "node", CODEGRAPH_BRIDGE: FAKE_BRIDGE };

test("MCP: initialize + list tools exposes exactly the nine codegraph tools", async () => {
  const { client, transport } = await startServer(FAKE_ENV);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "codegraph_decompose", "codegraph_design", "codegraph_discover",
      "codegraph_explore", "codegraph_memory", "codegraph_query",
      "codegraph_setup", "codegraph_stats", "codegraph_tests",
    ]);
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: every listed tool has a description and object input schema", async () => {
  const { client, transport } = await startServer(FAKE_ENV);
  try {
    const tools = await client.listTools();
    for (const t of tools.tools) {
      assert.ok(t.description && t.description.length > 10, `${t.name}: description`);
      assert.equal(t.inputSchema?.type, "object", `${t.name}: object schema`);
      assert.ok(t.inputSchema?.properties, `${t.name}: properties`);
    }
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: call codegraph_stats returns a text result", async () => {
  const { client, transport } = await startServer(FAKE_ENV);
  try {
    const res = await client.callTool({ name: "codegraph_stats", arguments: {} });
    assert.equal(res.isError, false);
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    assert.ok(text.length > 0, "stats should return text content");
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: call codegraph_explore with a safe action works", async () => {
  const { client, transport } = await startServer(FAKE_ENV);
  try {
    const res = await client.callTool({ name: "codegraph_explore", arguments: { action: "tags" } });
    assert.equal(res.isError, false);
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    assert.match(text, /"method": "explore"/);
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: unknown tool name returns an error", async () => {
  const { client, transport } = await startServer(FAKE_ENV);
  try {
    await assert.rejects(
      client.callTool({ name: "does_not_exist", arguments: {} }),
      /not found|Unknown|does_not_exist/i,
    );
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: invalid parameters return an error without killing the server", async () => {
  const { client, transport } = await startServer(FAKE_ENV);
  try {
    // scope='bogus' violates the enum in the query schema.
    await assert.rejects(
      client.callTool({ name: "codegraph_query", arguments: { scope: "bogus" } }),
      /invalid|scope/i,
    );
    // The server must still answer a subsequent valid call.
    const res = await client.callTool({ name: "codegraph_stats", arguments: {} });
    assert.equal(res.isError, false);
  } finally {
    await client.close();
    await transport.waitForExit(5_000);
  }
});

test("MCP: shutdown exits the child process cleanly without hanging", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...FAKE_ENV },
  });
  const transport = new SpawnedStdioTransport(child);
  const client = new Client({ name: "codegraph-test-client", version: "0.0.0" });
  await client.connect(transport);

  // Exercise a call so the bridge is started, then shut down.
  await client.callTool({ name: "codegraph_stats", arguments: {} });
  await client.close();

  const code = await transport.waitForExit(5_000);
  assert.equal(code, 0, "server child should exit 0 after client disconnect");
});
