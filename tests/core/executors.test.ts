/**
 * Phase 2 tests — catalog executors against a fake bridge.
 *
 * Exercises every bridge-method branch, the query HTML path and
 * large-result guard, setup bootstrap-vs-bridge routing, decompose/design
 * routing, and cancellation before dispatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CodegraphRuntime } from "../../src/core/runtime.js";
import { resolveConfig } from "../../src/core/config.js";
import {
  queryTool, exploreTool, testsTool, statsTool, setupTool,
  discoverTool, decomposeTool, designTool, memoryTool,
} from "../../src/core/tool-catalog.js";
import type { CodegraphToolDefinition, ToolResult } from "../../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BRIDGE = join(__dirname, "..", "fixtures", "fake-bridge.mjs");

function fakeRuntime(extra: Record<string, string> = {}): CodegraphRuntime {
  const config = resolveConfig({
    python: "node",
    bridgePath: FAKE_BRIDGE,
    ...extra,
  }, {}, process.cwd());
  return new CodegraphRuntime(config);
}

async function runOk(
  def: CodegraphToolDefinition,
  params: Record<string, unknown>,
  opts: { runtime?: CodegraphRuntime; allowOpenPath?: boolean } = {},
): Promise<ToolResult> {
  const rt = opts.runtime ?? fakeRuntime();
  try {
    return await def.execute(rt, params, {
      allowOpenPath: opts.allowOpenPath ?? false,
    });
  } finally {
    await rt.stopBridge().catch(() => {});
  }
}

// ── Bridge-method routing ─────────────────────────────────────────────────

test("stats executor routes to bridge method 'stats'", async () => {
  const r = await runOk(statsTool, {});
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "stats"/);
});

test("explore executor routes to bridge method 'explore' with details", async () => {
  const r = await runOk(exploreTool, { action: "tags" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "explore"/);
  assert.deepEqual((r as { details: unknown }).details, { action: "tags" });
});

test("tests executor routes to bridge method 'tests'", async () => {
  const r = await runOk(testsTool, { action: "list" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "tests"/);
});

test("discover executor routes to bridge method 'discover'", async () => {
  const r = await runOk(discoverTool, { action: "search_requirements", query: "x" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "discover"/);
});

test("memory executor routes to bridge method 'memory'", async () => {
  const r = await runOk(memoryTool, { action: "search", query: "x" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "memory"/);
});

test("decompose executor routes to bridge method 'decompose_run'", async () => {
  const r = await runOk(decomposeTool, { hlr_uid: "abc123" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "decompose_run"/);
});

test("design executor routes to bridge method 'design_run'", async () => {
  const r = await runOk(designTool, { hlr_uid: "abc123" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"method": "design_run"/);
});

// ── query HTML path ───────────────────────────────────────────────────────

test("query executor returns the HTML path without opening when disallowed", async () => {
  const r = await runOk(queryTool, { scope: "neighborhood", qualified_name: "x", format: "html", open: false }, { allowOpenPath: false });
  assert.equal(r.ok, true);
  assert.match(r.text, /Rendered codegraph HTML/);
  assert.match(r.text, /\/tmp\/fake-render\.html/);
  assert.equal((r as { details: { opened: boolean } }).details.opened, false);
});

// ── query large-result guard ──────────────────────────────────────────────

test("query executor applies the large-result guard for scope=kind", async () => {
  const r = await runOk(queryTool, { scope: "kind", kind: "class" });
  assert.equal(r.ok, true);
  assert.match(r.text, /LARGE RESULT/);
  assert.ok(r.text.length < 12_000, "large result should be truncated");
});

// ── setup routing ─────────────────────────────────────────────────────────

test("setup executor routes bootstrap_env to the runtime, not the bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-boot-test-"));
  const rt = fakeRuntime({ pythonBase: "/nonexistent/python-xyz", venvDir: join(dir, "venv") });
  try {
    const r = await setupTool.execute(rt, { action: "bootstrap_env" }, {});
    assert.equal(r.ok, false);
    assert.match(r.text, /Failed to create venv/);
  } finally {
    await rt.stopBridge().catch(() => {});
  }
});

test("setup executor routes non-bootstrap actions to the bridge", async () => {
  const r = await runOk(setupTool, { action: "status" });
  assert.equal(r.ok, true);
  assert.match(r.text, /"backend": "fake"/);
  const details = (r as { details: { action: unknown; raw?: unknown } }).details;
  assert.equal(details.action, "status");
  assert.ok(details.raw, "setup details should include the raw result");
});

// ── cancellation before dispatch ──────────────────────────────────────────

test("executors abort cleanly before dispatch when signalled", async () => {
  const ac = new AbortController();
  ac.abort();
  for (const def of [statsTool, queryTool, setupTool, decomposeTool, designTool]) {
    const rt = fakeRuntime();
    const r = await def.execute(rt, {}, { signal: ac.signal });
    assert.equal(r.ok, false, `${def.name}: should abort`);
    assert.match(r.text, /aborted before dispatch/);
    await rt.stopBridge().catch(() => {});
  }
});
