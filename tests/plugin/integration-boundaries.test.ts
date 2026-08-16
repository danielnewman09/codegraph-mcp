/**
 * The Codex and Pi adapters intentionally share only the host-neutral core
 * and canonical tool catalog.  Guard against future cross-host imports that
 * would make either integration require the other's runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

test("Codex MCP harness does not depend on the Pi integration", () => {
  const codex = source("integrations", "codex", "mcp.ts");
  assert.doesNotMatch(codex, /integrations\/pi|pi-coding-agent|pi-tui/);
});

test("Pi integration does not depend on the Codex plugin package", () => {
  for (const name of ["index.ts", "pi.ts", "shared.ts"]) {
    assert.doesNotMatch(
      source("integrations", "pi", name),
      /integrations\/codex|\.codex-plugin|\.mcp\.json/,
      `${name} must not import or inspect Codex plugin files`,
    );
  }
});
