/**
 * Phase 5 test — npm package contents.
 *
 * Asserts `npm pack --dry-run` ships everything both adapters need and
 * excludes database files, logs, venvs, and generated artifacts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runPackCheck } from "./check-pack.mjs";

test("npm pack contains required files and excludes runtime/generated data", async () => {
  const { files, missing, forbidden } = await runPackCheck();

  assert.deepEqual(
    missing,
    [],
    `missing required files in package: ${missing.join(", ")}`,
  );
  assert.deepEqual(
    forbidden,
    [],
    `forbidden files would be packed: ${forbidden.join(", ")}`,
  );
  assert.ok(files.includes("dist/codegraph-mcp.js"), "bundled MCP server must ship");
  assert.ok(files.includes("bridge/codegraph_bridge.py"), "Python bridge must ship");
});
