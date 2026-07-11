/**
 * Config — venv management, interpreter resolution, and bootstrap helpers.
 */

import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodegraphBridge } from "./bridge.js";

const WIN = platform() === "win32";
export const DEFAULT_VENV = join(homedir(), ".pi", "agent", "codegraph", "venv");
export const CONFIG_DIR = join(homedir(), ".pi", "agent", "codegraph");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const DEFAULT_BRIDGE = join(
  dirname(new URL(import.meta.url).pathname),
  "..", "bridge", "codegraph_bridge.py",
);

// ── Tool result helpers ───────────────────────────────────────────────────

export function ok(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
export function err(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}
export function tail(s: string, limit = 6000): string {
  if (!s) return "";
  return s.length <= limit ? s : "…(truncated)…\n" + s.slice(-limit);
}

// ── Cross-platform "open path" helper ─────────────────────────────────────

export async function openPath(pi: ExtensionAPI, target: string): Promise<void> {
  const os = platform();
  let cmd: string;
  let args: string[];
  if (os === "darwin") { cmd = "open"; args = [target]; }
  else if (os === "win32") { cmd = "cmd"; args = ["/c", "start", "", target]; }
  else { cmd = "xdg-open"; args = [target]; }
  const result = await pi.exec(cmd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open ${target} (exit ${result.code})`);
  }
}

// ── Venv helpers ──────────────────────────────────────────────────────────

export function makeVenvHelpers(pi: ExtensionAPI, venvDirOverride?: string) {
  const DEFAULT = DEFAULT_VENV;

  function venvDir(): string {
    const f = pi.getFlag("codegraph-venv");
    return (typeof f === "string" && f.trim()) ? f : (venvDirOverride ?? DEFAULT);
  }
  function venvBin(name: string): string {
    return join(venvDir(), WIN ? "Scripts" : "bin", WIN ? `${name}.exe` : name);
  }
  function venvPython(): string { return venvBin("python"); }
  function venvExists(): boolean { return existsSync(join(venvDir(), "pyvenv.cfg")); }

  return { venvDir, venvBin, venvPython, venvExists };
}

// ── Persistent config ─────────────────────────────────────────────────────

interface CgConfig { python?: string }

export function readConfig(): CgConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj as CgConfig : {};
  } catch { return {}; }
}

export function writeConfig(patch: CgConfig): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cur = readConfig();
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
  } catch { /* best-effort */ }
}

// ── Python resolution ─────────────────────────────────────────────────────

export function makePythonResolution(pi: ExtensionAPI) {
  const { venvDir, venvPython, venvExists } = makeVenvHelpers(pi);

  function pythonSource(): string {
    const f = pi.getFlag("codegraph-python");
    if (typeof f === "string" && f.trim()) return "flag(--codegraph-python)";
    if (process.env.CODEGRAPH_PYTHON) return "$CODEGRAPH_PYTHON";
    const cfg = readConfig().python;
    if (cfg && cfg.trim()) return `config(${CONFIG_FILE})`;
    if (venvExists()) return `venv(${venvPython()})`;
    return "python3 (fallback)";
  }

  function resolvePython(): string {
    const f = pi.getFlag("codegraph-python");
    if (typeof f === "string" && f.trim()) return f;
    if (process.env.CODEGRAPH_PYTHON) return process.env.CODEGRAPH_PYTHON;
    const cfg = readConfig().python;
    if (cfg && cfg.trim()) return cfg;
    if (venvExists()) return venvPython();
    return "python3";
  }

  function resolveBridgePath(): string {
    const f = pi.getFlag("codegraph-bridge");
    if (typeof f === "string" && f.trim()) return f;
    return DEFAULT_BRIDGE;
  }

  function resolveBasePython(): string {
    const f = pi.getFlag("codegraph-python-base");
    if (typeof f === "string" && f.trim()) return f;
    return process.env.CODEGRAPH_PYTHON_BASE || "python3";
  }

  function resolveSource(flagName: string, fallback: string): string {
    const f = pi.getFlag(flagName);
    return (typeof f === "string" && f.trim()) ? f : fallback;
  }

  return { pythonSource, resolvePython, resolveBridgePath, resolveBasePython, resolveSource };
}

// ── Bridge singleton ──────────────────────────────────────────────────────

export function createBridgeManager(
  resolvePython: () => string,
  resolveBridgePath: () => string,
) {
  let bridge: CodegraphBridge | null = null;

  async function ensureBridge(): Promise<CodegraphBridge> {
    if (bridge && bridge.isRunning()) return bridge;
    if (!bridge) {
      bridge = new CodegraphBridge(resolvePython(), resolveBridgePath());
    }
    await bridge.start();
    return bridge;
  }

  function getBridge(): CodegraphBridge | null { return bridge; }
  function setBridge(b: CodegraphBridge | null) { bridge = b; }

  return { ensureBridge, getBridge, setBridge };
}

// ── bootstrap_env ─────────────────────────────────────────────────────────
//
// Done TypeScript-side because the bridge cannot run until the venv + its
// packages exist.  Returns ok/err tuples.

export async function bootstrapEnv(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  venv: ReturnType<typeof makeVenvHelpers>,
  resolve: ReturnType<typeof makePythonResolution>,
  bridgeManager: ReturnType<typeof createBridgeManager>,
  SETUP_TIMEOUT_MS: number,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const dir = venv.venvDir();
  const pyExe = venv.venvPython();
  const pipExe = venv.venvBin("pip");
  const base = resolve.resolveBasePython();
  const steps: Array<Record<string, unknown>> = [];
  const codegraphSpec = (params.codegraph_source as string | undefined)
    ?? resolve.resolveSource("codegraph-source", "codegraph");
  const doxySpec = (params.doxygen_index_source as string | undefined)
    ?? resolve.resolveSource("doxygen-index-source", "doxygen-index");
  const cgArgs = existsSync(codegraphSpec) ? ["-e", codegraphSpec] : [codegraphSpec];
  const dxArgs = existsSync(doxySpec) ? ["-e", doxySpec] : [doxySpec];

  // 1. Create the venv if missing.
  if (!venv.venvExists()) {
    const r = await pi.exec(base, ["-m", "venv", "--upgrade-deps", dir],
      { timeout: 180_000 });
    steps.push({ step: "venv_create", exit_code: r.code, killed: r.killed, stderr: tail(r.stderr) });
    if (r.code !== 0) {
      return err(`Failed to create venv at ${dir} (using ${base}): ${r.stderr || 'exit ' + r.code}`,
        { venv_path: dir, steps });
    }
  } else {
    steps.push({ step: "venv_create", skipped: true, venv_path: dir });
  }

  // 2. Install / upgrade the two packages.
  const installArgs = ["install", "-U", ...cgArgs, ...dxArgs];
  const r2 = await pi.exec(pipExe, installArgs, { timeout: SETUP_TIMEOUT_MS });
  steps.push({ step: "pip_install", exit_code: r2.code, killed: r2.killed,
    stdout: tail(r2.stdout), stderr: tail(r2.stderr) });
  if (r2.code !== 0) {
    return err(`pip install failed (exit ${r2.code}): ${tail(r2.stderr) || tail(r2.stdout)}`,
      { venv_path: dir, steps, install_args: installArgs });
  }

  // 3. Verify both packages import.
  const r3 = await pi.exec(pyExe,
    ["-c", "import codegraph, doxygen_index; print(getattr(codegraph,'__version__','?'))"],
    { timeout: 30_000 });
  const verified = r3.code === 0;
  steps.push({ step: "verify_import", exit_code: r3.code, stdout: tail(r3.stdout), stderr: tail(r3.stderr) });

  // 4. Restart the bridge so it runs under the new venv python.
  const b = bridgeManager.getBridge();
  await b?.stop().catch(() => {});
  bridgeManager.setBridge(null);

  const version = (r3.stdout || "").trim() || "unknown";
  const msg = `Bootstrapped codegraph venv at ${dir} (python ${pyExe}) — codegraph ${version}, import ${verified ? "OK" : "FAILED"}`;
  return ok(msg, { venv_path: dir, python: pyExe, codegraph_version: version, verified, steps });
}
