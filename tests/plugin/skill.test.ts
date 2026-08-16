/**
 * Phase 7 test — harness-neutral usage skill.
 *
 * Asserts the skill exists with valid frontmatter and that every tool it
 * references is one of the nine public tool names (no internal bridge
 * methods leak into agent guidance).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL = join(ROOT, "integrations", "codex", "skills", "codegraph", "SKILL.md");

const PUBLIC_TOOLS = new Set([
  "codegraph_query",
  "codegraph_explore",
  "codegraph_tests",
  "codegraph_stats",
  "codegraph_setup",
  "codegraph_discover",
  "codegraph_decompose",
  "codegraph_design",
  "codegraph_memory",
]);

test("skill exists with name + description frontmatter", () => {
  const raw = readFileSync(SKILL, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "SKILL.md must start with YAML frontmatter");
  assert.match(m[1], /^name:\s*codegraph$/m);
  assert.match(m[1], /^description:\s*\S+/m, "description must be non-empty");
});

test("skill references only public tool names", () => {
  const raw = readFileSync(SKILL, "utf8");
  const refs = [...raw.matchAll(/codegraph_[a-z_]+/g)].map((m) => m[0]);
  assert.ok(refs.length > 0, "skill should reference codegraph tools");
  const unknown = [...new Set(refs)].filter((r) => !PUBLIC_TOOLS.has(r));
  assert.deepEqual(unknown, [], `internal/unknown tool names in skill: ${unknown.join(", ")}`);
});

test("skill covers the required guidance points", () => {
  const raw = readFileSync(SKILL, "utf8");
  const checks = [
    /codegraph_explore/,             // explore before source reads
    /codegraph_query/,               // neighborhoods / formatted context
    /codegraph_tests/,               // coverage
    /codegraph_stats/,               // compact overviews
    /do not index or bootstrap unless/i, // avoid implicit indexing
    /destructive/i,                  // destructive ops flagged
    /format: "html"/i,               // html only when useful
    /as-built/,                      // normal indexed tag
  ];
  for (const re of checks) {
    assert.match(raw, re, `skill missing: ${re}`);
  }
});
