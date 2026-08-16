/**
 * Phase 2 tests — canonical tool catalog validation.
 *
 * Asserts the single-source-of-truth properties the plan requires:
 * no duplicate names, missing descriptions, missing object input schemas,
 * missing executors, unexpected tool count, or undocumented mutability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_TOOLS,
  findTool,
  toolInputJsonSchema,
} from "../../src/core/tool-catalog.js";

const EXPECTED_NAMES = [
  "codegraph_query",
  "codegraph_explore",
  "codegraph_tests",
  "codegraph_stats",
  "codegraph_setup",
  "codegraph_discover",
  "codegraph_decompose",
  "codegraph_design",
  "codegraph_memory",
];

test("catalog contains exactly the nine public tools", () => {
  assert.equal(ALL_TOOLS.length, 9);
  const names = ALL_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_NAMES].sort());
});

test("no duplicate tool names", () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
});

test("every tool has a non-empty description and label", () => {
  for (const t of ALL_TOOLS) {
    assert.ok(t.description && t.description.trim().length > 10, `${t.name}: description`);
    assert.ok(t.label && t.label.trim(), `${t.name}: label`);
  }
});

test("every tool has an object input schema with properties", () => {
  for (const t of ALL_TOOLS) {
    const s = toolInputJsonSchema(t);
    assert.equal(s.type, "object", `${t.name}: schema type`);
    assert.ok(s.properties && typeof s.properties === "object", `${t.name}: schema properties`);
  }
});

test("every tool has a callable executor", () => {
  for (const t of ALL_TOOLS) {
    assert.equal(typeof t.execute, "function", `${t.name}: executor`);
  }
});

test("every tool documents its mutability", () => {
  const allowed = new Set(["read", "write", "mixed"]);
  for (const t of ALL_TOOLS) {
    assert.ok(allowed.has(t.mutability), `${t.name}: mutability ${t.mutability}`);
  }
});

test("bridge method mapping matches the expected matrix", () => {
  const expected: Record<string, string> = {
    codegraph_query: "query",
    codegraph_explore: "explore",
    codegraph_tests: "tests",
    codegraph_stats: "stats",
    codegraph_setup: "setup",
    codegraph_discover: "discover",
    codegraph_decompose: "decompose_run",
    codegraph_design: "design_run",
    codegraph_memory: "memory",
  };
  for (const t of ALL_TOOLS) {
    assert.equal(t.bridgeMethod, expected[t.name], `${t.name}: bridge method`);
  }
});

test("timeout class and mutability are documented per tool", () => {
  for (const t of ALL_TOOLS) {
    assert.ok(["normal", "setup", "agent"].includes(t.timeoutClass), `${t.name}: timeout class`);
  }
  // Mutating tools must not look read-only (safety metadata preserved).
  assert.equal(findTool("codegraph_setup")!.mutability, "mixed");
  assert.equal(findTool("codegraph_decompose")!.mutability, "write");
  assert.equal(findTool("codegraph_design")!.mutability, "write");
  assert.equal(findTool("codegraph_memory")!.mutability, "mixed");
});

test("prompt snippet and guidelines exist for every tool", () => {
  for (const t of ALL_TOOLS) {
    assert.ok(t.promptSnippet && t.promptSnippet.trim(), `${t.name}: promptSnippet`);
    assert.ok(Array.isArray(t.promptGuidelines) && t.promptGuidelines.length > 0, `${t.name}: promptGuidelines`);
  }
});

test("findTool resolves every name and rejects unknown names", () => {
  for (const name of EXPECTED_NAMES) {
    assert.ok(findTool(name), `findTool(${name})`);
  }
  assert.equal(findTool("nonexistent"), undefined);
});

test("schemas are standards-compliant JSON Schema (deep-copy round-trips cleanly)", () => {
  for (const t of ALL_TOOLS) {
    const s = toolInputJsonSchema(t);
    // JSON round-trip must be lossless (no functions/symbols in the schema).
    const again = JSON.parse(JSON.stringify(s));
    assert.deepEqual(again, s, `${t.name}: schema serialises cleanly`);
  }
});
