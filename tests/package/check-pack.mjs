/**
 * Pack verification — assert `npm pack --dry-run` contains everything the
 * Pi and Codex adapters need and excludes runtime/generated data.
 *
 * Runnable directly (`node tests/package/check-pack.mjs`) or imported by
 * the package contents test.  Exits non-zero with a clear message when a
 * required file is missing or a forbidden file would be shipped.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Everything both harnesses need when installed.
const REQUIRED = [
  "package.json",
  "dist/codegraph-mcp.js",
  "integrations/pi/index.ts",
  "integrations/pi/shared.ts",
  "integrations/pi/pi.ts",
  "integrations/codex/mcp.ts",
  "integrations/codex/dist/codegraph-mcp.js",
  "integrations/codex/bridge/codegraph_bridge.py",
  "integrations/codex/.codex-plugin/plugin.json",
  "integrations/codex/.mcp.json",
  "integrations/codex/skills/codegraph/SKILL.md",
  "tools/query.ts",
  "tools/setup.ts",
  "src/core/tool-catalog.ts",
  "src/core/runtime.ts",
  "bridge/codegraph_bridge.py",
  "README.md",
  "LICENSE",
];

// Database files, logs, venvs, and generated artifacts must never ship.
const FORBIDDEN_PATTERNS = [
  /^codegraph\.sqlite3/,
  /\.sqlite3(-wal|-shm)?$/,
  /(^|\/)\.env$/,
  /\.doxygen-index\.toml$/,
  /(^|\/)logs?\//,
  /(^|\/)(\.venv|venv)\//,
  /__pycache__/,
  /\.pyc$/,
  /(^|\/)node_modules\//,
  /(^|\/)tests\//,
  /\.test\.(ts|js|mjs|cjs)$/,
  /\.map$/,
];

export async function runPackCheck(opts = {}) {
  if (opts.build !== false) {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  }
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(tmpdir(), "codegraph-mcp-npm-cache") },
  });
  const parsed = JSON.parse(out);
  const pkg = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (pkg.files ?? []).map((f) => f.path);

  const missing = REQUIRED.filter((r) => !files.includes(r));
  const forbidden = files.filter((f) => FORBIDDEN_PATTERNS.some((re) => re.test(f)));

  return { files, missing, forbidden, pkgName: pkg.name, pkgVersion: pkg.version };
}

// CLI entry: `node tests/package/check-pack.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file://"))) {
  runPackCheck()
    .then(({ files, missing, forbidden }) => {
      if (missing.length > 0) {
        console.error(`✖ MISSING required files:\n  ${missing.join("\n  ")}`);
        process.exit(1);
      }
      if (forbidden.length > 0) {
        console.error(`✖ FORBIDDEN files would be packed:\n  ${forbidden.join("\n  ")}`);
        process.exit(1);
      }
      console.log(`✔ pack contents OK (${files.length} files)`);
    })
    .catch((e) => {
      console.error("✖ pack check failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
