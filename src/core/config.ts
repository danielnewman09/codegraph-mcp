/**
 * Host-neutral configuration resolver.
 *
 * Resolves the Python interpreter and storage paths for the codegraph
 * extension without referencing any harness.  Precedence (highest first):
 *
 *   1. Harness-provided explicit overrides.
 *   2. Environment variables (CODEGRAPH_*).
 *   3. Project-local `.venv` interpreter, when present.
 *   4. Persisted configuration.
 *   5. Plugin-managed bootstrapped virtual environment.
 *   6. System `python3` fallback.
 *
 * Writable state prefers `PLUGIN_DATA` when set (Codex-style hosts);
 * otherwise it falls back to the documented Pi-compatible location
 * `~/.pi/agent/codegraph/` — never the repository directory and never
 * the plugin installation directory.  `PLUGIN_ROOT` is treated as
 * read-only (it may be used to resolve bundled bridge files).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

export const WIN = platform() === "win32";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from the module directory to the package root (the first
 * directory containing package.json).  Works from both the source layout
 * (src/core/config.ts) and the bundled layout (dist/codex-mcp.js).
 */
function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return __dirname;
}

/** Bundled bridge script, resolved relative to the package root. */
export const DEFAULT_BRIDGE = join(packageRoot(), "bridge", "codegraph_bridge.py");

/** Package version from the nearest package.json (works in source + dist). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Timeouts (kept here so shared.ts can re-export them unchanged) ────────

export const CALL_TIMEOUT_MS = 120_000; // large graph fetches can be slow
export const SETUP_TIMEOUT_MS = 600_000; // indexing / pip install can take minutes

// ── Storage paths ─────────────────────────────────────────────────────────

/**
 * Writable data directory.  `PLUGIN_DATA` wins when set; otherwise the
 * documented Pi-compatible default.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim()) return env.PLUGIN_DATA;
  return join(homedir(), ".pi", "agent", "codegraph");
}

export function defaultVenvDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "venv");
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataDir(env);
}

export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultConfigDir(env), "config.json");
}

// ── Persisted configuration ───────────────────────────────────────────────

export interface CgConfig { python?: string }

export function readConfig(configFile: string): CgConfig {
  try {
    const raw = readFileSync(configFile, "utf8");
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj as CgConfig : {};
  } catch { return {}; }
}

export function writeConfig(configFile: string, patch: CgConfig): void {
  try {
    mkdirSync(dirname(configFile), { recursive: true });
    const cur = readConfig(configFile);
    writeFileSync(configFile, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** Load env vars from a .env file (simple KEY=VALUE parser, no shell expansion). */
export function loadEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
  } catch { /* .env not found or unreadable — no-op */ }
  return vars;
}

// ── Resolved configuration ────────────────────────────────────────────────

export interface ConfigOverrides {
  python?: string;
  bridgePath?: string;
  venvDir?: string;
  pythonBase?: string;
  codegraphSource?: string;
  doxygenIndexSource?: string;
}

export interface RuntimeConfig {
  python: string;
  /** Human-readable description of where `python` came from. */
  pythonSource: string;
  bridgePath: string;
  venvDir: string;
  pythonBase: string;
  codegraphSource: string;
  doxygenIndexSource: string;
  dataDir: string;
  configDir: string;
  configFile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function venvBin(venvDir: string, name: string): string {
  return join(venvDir, WIN ? "Scripts" : "bin", WIN ? `${name}.exe` : name);
}

function venvPython(venvDir: string): string { return venvBin(venvDir, "python"); }

function venvExists(venvDir: string): boolean {
  return existsSync(join(venvDir, "pyvenv.cfg"));
}

function cwdVenvPython(cwd: string): string | null {
  const venv = join(cwd, ".venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python");
  return existsSync(venv) ? venv : null;
}

export function resolveConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeConfig {
  const configDir = defaultConfigDir(env);
  const configFile = defaultConfigFile(env);
  const venvDir = overrides.venvDir?.trim()
    ? overrides.venvDir
    : env.CODEGRAPH_VENV?.trim()
      ? env.CODEGRAPH_VENV
      : defaultVenvDir(env);

  const pythonFlag = overrides.python?.trim();
  const envPython = env.CODEGRAPH_PYTHON?.trim();

  let python: string;
  let pythonSource: string;
  if (pythonFlag) {
    python = pythonFlag;
    pythonSource = "flag(override)";
  } else if (envPython) {
    python = envPython;
    pythonSource = "$CODEGRAPH_PYTHON";
  } else {
    const cwdVenv = cwdVenvPython(cwd);
    if (cwdVenv) {
      python = cwdVenv;
      pythonSource = "cwd(.venv)";
    } else {
      const cfg = readConfig(configFile).python;
      if (cfg && cfg.trim()) {
        python = cfg;
        pythonSource = `config(${configFile})`;
      } else if (venvExists(venvDir)) {
        python = venvPython(venvDir);
        pythonSource = `venv(${venvPython(venvDir)})`;
      } else {
        python = "python3";
        pythonSource = "python3 (fallback)";
      }
    }
  }

  const bridgePath = overrides.bridgePath?.trim() ?? env.CODEGRAPH_BRIDGE?.trim() ?? DEFAULT_BRIDGE;
  const pythonBase = overrides.pythonBase?.trim() ?? env.CODEGRAPH_PYTHON_BASE?.trim() ?? "python3";
  const codegraphSource = overrides.codegraphSource?.trim() ?? env.CODEGRAPH_SOURCE?.trim() ?? "codegraph";
  const doxygenIndexSource = overrides.doxygenIndexSource?.trim() ?? env.DOXYGEN_INDEX_SOURCE?.trim() ?? "doxygen-index";

  return {
    python,
    pythonSource,
    bridgePath,
    venvDir,
    pythonBase,
    codegraphSource,
    doxygenIndexSource,
    dataDir: dataDir(env),
    configDir,
    configFile,
    cwd,
    env,
  };
}

// ── Venv helpers exposed for the runtime ──────────────────────────────────

export function venvBinPath(venvDir: string, name: string): string {
  return venvBin(venvDir, name);
}

export function venvPythonPath(venvDir: string): string {
  return venvPython(venvDir);
}

export function venvPresent(venvDir: string): boolean {
  return venvExists(venvDir);
}
