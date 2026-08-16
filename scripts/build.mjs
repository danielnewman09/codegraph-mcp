#!/usr/bin/env node
/** Build both the npm executable and the self-contained Codex plugin. */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(ROOT, "integrations", "codex", "mcp.ts");
const npmBundle = join(ROOT, "dist", "codegraph-mcp.js");
const pluginRoot = join(ROOT, "integrations", "codex");
const pluginBundle = join(pluginRoot, "dist", "codegraph-mcp.js");

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: npmBundle,
  banner: { js: "#!/usr/bin/env node" },
});

mkdirSync(dirname(pluginBundle), { recursive: true });
cpSync(npmBundle, pluginBundle);
rmSync(join(pluginRoot, "bridge"), { recursive: true, force: true });
cpSync(join(ROOT, "bridge"), join(pluginRoot, "bridge"), {
  recursive: true,
  filter: (source) => !source.includes("__pycache__") && !source.endsWith(".pyc"),
});

console.log(`Built npm MCP server: ${npmBundle}`);
console.log(`Built Codex plugin MCP server: ${pluginBundle}`);
