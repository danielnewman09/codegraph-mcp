/**
 * Phase 6 test — Codex plugin manifest.
 *
 * Runs the hermetic plugin validator (mirrors the Codex CLI's rules) and
 * asserts the .mcp.json declares exactly the codegraph stdio server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { SpawnedStdioTransport } from "../mcp/helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODEX_ROOT = join(ROOT, "integrations", "codex");

test("plugin:validate passes (hermetic mirror of the Codex validator)", () => {
  const out = execFileSync("node", ["scripts/validate-plugin.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /plugin validation OK/);
});

test(".mcp.json declares exactly the codegraph stdio server", () => {
  const mcp = JSON.parse(readFileSync(join(CODEX_ROOT, ".mcp.json"), "utf8"));
  const names = Object.keys(mcp.mcpServers ?? {});
  assert.deepEqual(names, ["codegraph"]);
  const server = mcp.mcpServers.codegraph;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./dist/codegraph-mcp.js"]);
  assert.equal(server.cwd, ".");
});

test("plugin.json base version matches package.json version", () => {
  const plugin = JSON.parse(readFileSync(join(CODEX_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(plugin.version.split("+", 1)[0], pkg.version.split("+", 1)[0]);
});

test("installed plugin layout launches its bundled MCP server", async () => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
  const installedRoot = mkdtempSync(join(tmpdir(), "codegraph-plugin-"));
  cpSync(CODEX_ROOT, installedRoot, { recursive: true });

  const mcp = JSON.parse(readFileSync(join(installedRoot, ".mcp.json"), "utf8"));
  const server = mcp.mcpServers.codegraph;
  const child = spawn(server.command, server.args, {
    cwd: join(installedRoot, server.cwd),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const transport = new SpawnedStdioTransport(child);
  const client = new Client({ name: "installed-codegraph-test", version: "0.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    assert.ok(tools.tools.some((tool) => tool.name === "codegraph_setup"));
  } finally {
    await client.close().catch(() => {});
    await transport.waitForExit(5_000);
    rmSync(installedRoot, { recursive: true, force: true });
  }
});
