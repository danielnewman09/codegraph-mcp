/**
 * Phase 6 test — Codex plugin manifest.
 *
 * Runs the hermetic plugin validator (mirrors the Codex CLI's rules) and
 * asserts the .mcp.json declares exactly the codegraph stdio server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("plugin:validate passes (hermetic mirror of the Codex validator)", () => {
  const out = execFileSync("node", ["scripts/validate-plugin.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /plugin validation OK/);
});

test(".mcp.json declares exactly the codegraph stdio server", () => {
  const mcp = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
  const names = Object.keys(mcp.mcpServers ?? {});
  assert.deepEqual(names, ["codegraph"]);
  const server = mcp.mcpServers.codegraph;
  assert.equal(typeof server.command, "string");
  assert.equal(server.command, "codegraph-mcp");
});

test("plugin.json version matches package.json version", () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
});
